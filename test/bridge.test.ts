import { describe, expect, it } from "vitest";
import { HEALTHY_WITHIN_MS, isHealthy, loadState, runCycle } from "../src/bridge";
import { demoSessions } from "../src/demo";
import worker, { BridgeState, type Env } from "../src/index";
import { buildDeliveryRequest, DEMO_API_KEY, MOCK_PATH, readingId } from "../src/meronrg";
import { mockReceiver } from "../src/mock";
import { statusPage } from "../src/page";
import { parseChargeHistory, teslaSessions } from "../src/tesla";
import type { Config, Reading, Session, State, Store } from "../src/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-13T09:00:00Z");

function fakeStore() {
  const data = new Map<string, unknown>();
  let writes = 0;
  const store: Store = {
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key, value) {
      writes++;
      data.set(key, structuredClone(value));
    },
  };
  return { store, writes: () => writes };
}

const cfg = (overrides: Partial<Config> = {}): Config => ({
  MODE: "demo",
  CHARGER_ID: "TEST-1",
  TIME_ZONE: "Asia/Jerusalem",
  ...overrides,
});

/** A Worker env whose Durable Object runs in-process on a fake store. */
function workerEnv(overrides: Partial<Config> = {}) {
  const { store, writes } = fakeStore();
  const env = { ...cfg(overrides) } as Env;
  const instance = new BridgeState({ storage: store } as never, env);
  env.BRIDGE = { idFromName: () => "id", get: () => instance } as never;
  return { env, instance, writes };
}

const session = (startIso: string, hours: number, wh: number): Session => ({
  started_at: new Date(startIso).toISOString(),
  ended_at: new Date(Date.parse(startIso) + hours * HOUR).toISOString(),
  energy_wh: wh,
});
const ok = async () => new Response(null, { status: 201 });
const A = session("2026-11-11T18:00:00Z", 2, 15_000);
const B = session("2026-11-12T18:00:00Z", 1, 8_000);

describe("demo charger", () => {
  it("gives the same sessions every time, inside the window", () => {
    const a = demoSessions(NOW - 30 * DAY, NOW);
    expect(a).toEqual(demoSessions(NOW - 30 * DAY, NOW));
    expect(a.length).toBeGreaterThan(15);
    for (const s of a) {
      expect(Date.parse(s.started_at)).toBeGreaterThan(NOW - 30 * DAY);
      expect(Date.parse(s.ended_at)).toBeLessThanOrEqual(NOW);
      expect(s.energy_wh).toBeGreaterThan(0);
      expect(s.energy_wh).toBeLessThanOrEqual(44_000);
    }
  });
});

describe("bridge cycle", () => {
  it("delivers each new session once and keeps a running meter total", async () => {
    const { store } = fakeStore();
    const sent: Request[] = [];
    const send = async (r: Request) => (sent.push(r), new Response(null, { status: 201 }));

    const state = await runCycle(cfg(), store, NOW, { source: async () => [A, B], send });
    expect(sent).toHaveLength(2);
    expect(state.meter_total_wh).toBe(23_000);
    expect(state.delivered_count).toBe(2);
    expect(state.last_error).toBeNull();
    expect(state.last_success_at).toBe(new Date(NOW).toISOString());

    const first = (await sent[0].json()) as Reading;
    expect(first).toMatchObject({ reading_id: "TEST-1-20261111T180000Z", meter_total_wh: 15_000 });
    expect(sent[0].headers.get("idempotency-key")).toBe("TEST-1-20261111T180000Z");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${DEMO_API_KEY}`);
    expect(sent[0].redirect).toBe("manual");

    // Next hour, the same sessions are listed again (look-back window): nothing is re-sent.
    await runCycle(cfg(), store, NOW + HOUR, { source: async () => [A, B], send });
    expect(sent).toHaveLength(2);
  });

  it("retries a refused reading with the same id and does not skip ahead", async () => {
    const { store } = fakeStore();
    const ids: string[] = [];
    let fail = true;
    const send = async (r: Request) => {
      ids.push(r.headers.get("idempotency-key")!);
      return new Response(null, { status: fail ? 503 : 201 });
    };
    const source = async () => [A, B];

    let state = await runCycle(cfg(), store, NOW, { source, send });
    expect(state.delivered_count).toBe(0);
    expect(state.meter_total_wh).toBe(0);
    expect(state.watermark).toBeNull();
    expect(state.last_error).toContain("503");
    expect(state.consecutive_failures).toBe(1);

    fail = false;
    state = await runCycle(cfg(), store, NOW + HOUR, { source, send });
    expect(ids).toEqual(["TEST-1-20261111T180000Z", "TEST-1-20261111T180000Z", "TEST-1-20261112T180000Z"]);
    expect(state.meter_total_wh).toBe(23_000);
    expect(state.last_error).toBeNull();
    expect(state.consecutive_failures).toBe(0);
  });

  it("does not treat a redirect as accepted", async () => {
    const { store } = fakeStore();
    const send = async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } });
    const state = await runCycle(cfg(), store, NOW, { source: async () => [A], send });
    expect(state.delivered_count).toBe(0);
    expect(state.last_error).toContain("302");
  });

  it("keeps what was accepted when a later reading fails", async () => {
    const { store } = fakeStore();
    let n = 0;
    const send = async () => new Response(null, { status: ++n === 1 ? 201 : 500 });
    const state = await runCycle(cfg(), store, NOW, { source: async () => [A, B], send });
    expect(state.delivered_count).toBe(1);
    expect(state.meter_total_wh).toBe(15_000);
    expect((await loadState(store)).meter_total_wh).toBe(15_000);

    const sent: string[] = [];
    await runCycle(cfg(), store, NOW + HOUR, {
      source: async () => [A, B],
      send: async (r) => (sent.push(r.headers.get("idempotency-key")!), new Response(null, { status: 201 })),
    });
    expect(sent).toEqual(["TEST-1-20261112T180000Z"]); // A is not sent twice
  });

  it("holds back a session that has only just ended", async () => {
    const { store } = fakeStore();
    const justEnded = session(new Date(NOW - 65 * 60_000).toISOString(), 1, 9_000); // ended 5 min ago
    expect((await runCycle(cfg(), store, NOW, { source: async () => [justEnded], send: ok })).delivered_count).toBe(0);
    expect(
      (await runCycle(cfg(), store, NOW + HOUR, { source: async () => [justEnded], send: ok })).delivered_count,
    ).toBe(1);
  });

  it("delivers a session the charger service lists late", async () => {
    const { store } = fakeStore();
    await runCycle(cfg(), store, NOW, { source: async () => [B], send: ok });
    // A is older than B and only appears now: it must still be delivered, once.
    const state = await runCycle(cfg(), store, NOW + HOUR, { source: async () => [A, B], send: ok });
    expect(state.delivered_count).toBe(2);
    expect(state.meter_total_wh).toBe(23_000);
  });

  it("asks the source from before the watermark, however long it was down", async () => {
    const { store } = fakeStore();
    await runCycle(cfg(), store, NOW, { source: async () => [], send: ok });
    const asked: number[] = [];
    const source = async (from: number) => (asked.push(from), []);
    await runCycle(cfg(), store, NOW + 10 * DAY, { source, send: ok }); // ten days of failed runs later
    expect(asked[0]).toBeLessThanOrEqual(NOW - 2 * DAY);
  });

  it("skips empty sessions and refuses impossible ones", async () => {
    const { store } = fakeStore();
    const empty = session("2026-11-12T10:00:00Z", 1, 0);
    let state = await runCycle(cfg(), store, NOW, { source: async () => [empty, B], send: ok });
    expect(state.delivered_count).toBe(1);

    const impossible = session("2026-11-12T22:00:00Z", 1, 90_000); // 90 kWh in one hour
    let sent = 0;
    state = await runCycle(cfg(), store, NOW + HOUR, {
      source: async () => [impossible],
      send: async () => (sent++, new Response(null, { status: 201 })),
    });
    expect(sent).toBe(0);
    expect(state.last_error).toContain("more energy than the charger can deliver");
  });

  it("never reports sessions from before REPORT_FROM", async () => {
    const { store } = fakeStore();
    const state = await runCycle(cfg({ REPORT_FROM: "2026-11-12T00:00:00Z" }), store, NOW, {
      source: async () => [A, B],
      send: ok,
    });
    expect(state.deliveries.map((d) => d.reading.session.started_at)).toEqual([B.started_at]);
  });

  it("refuses to send the key anywhere but https", async () => {
    const { store } = fakeStore();
    const c = cfg({ MODE: "live", MERONRG_API_URL: "http://api.example/readings", MERONRG_API_KEY: "k" });
    const state = await runCycle(c, store, NOW, { source: async () => [A], send: ok });
    expect(state.last_error).toContain("https://");
    expect(state.delivered_count).toBe(0);
  });

  it("alerts when deliveries start failing and when they recover", async () => {
    const { store } = fakeStore();
    const alerts: { status: string }[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      alerts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const c = cfg({ ALERT_WEBHOOK_URL: "https://alerts.example/hook" });
    const down = async () => new Response(null, { status: 500 });

    await runCycle(c, store, NOW, { source: async () => [A], send: down, fetch: fetchFn });
    await runCycle(c, store, NOW + HOUR, { source: async () => [A], send: down, fetch: fetchFn });
    expect(alerts.map((a) => a.status)).toEqual(["failing"]); // once, not every hour
    await runCycle(c, store, NOW + 2 * HOUR, { source: async () => [A], send: ok, fetch: fetchFn });
    expect(alerts.map((a) => a.status)).toEqual(["failing", "recovered"]);
  });

  it("does not lose early sessions when the first good run comes weeks late", async () => {
    const start = Date.parse("2026-12-01T00:00:00Z");
    const early = session("2026-12-01T18:00:00Z", 2, 12_000);
    for (const c of [cfg({ REPORT_FROM: "2026-12-01T00:00:00Z" }), cfg()]) {
      const { store } = fakeStore();
      const broken = async () => {
        throw new Error("Tesla charge history failed: HTTP 500");
      };
      for (let h = 0; h < 24 * 20; h += 24) await runCycle(c, store, start + h * HOUR, { source: broken, send: ok });
      const asked: number[] = [];
      const state = await runCycle(c, store, start + 20 * DAY, {
        source: async (from) => (asked.push(from), [early]),
        send: ok,
      });
      expect(asked[0]).toBeLessThanOrEqual(start); // still asks from the very beginning
      expect(state.delivered_count).toBe(1);
    }
  });

  it("delivers a session longer than the look-back window, and one that began before it", async () => {
    const { store } = fakeStore();
    await runCycle(cfg(), store, NOW - 9 * DAY, { source: async () => [], send: ok });
    const long = session(new Date(NOW - 8.5 * DAY).toISOString(), 8 * 24, 60_000); // 8 days, ends 12 h ago
    const state = await runCycle(cfg(), store, NOW, { source: async () => [long], send: ok });
    expect(state.delivered_count).toBe(1);
  });

  it("resends an unconfirmed reading unchanged, so one id never carries two totals", async () => {
    const { store } = fakeStore();
    const bodies: Reading[] = [];
    let timeout = true;
    const send = async (r: Request) => {
      bodies.push((await r.json()) as Reading);
      if (timeout) throw new Error("The operation was aborted due to timeout");
      return new Response(null, { status: 201 });
    };
    // Run 1: B is sent, the operator stores it, but the answer never arrives.
    let state = await runCycle(cfg(), store, NOW, { source: async () => [B], send });
    expect(state.last_error).toBe("operator did not answer for TEST-1-20261112T180000Z (timeout or network error)");
    expect(state.delivered_count).toBe(0);
    // Run 2: the older session A is now listed too.
    timeout = false;
    state = await runCycle(cfg(), store, NOW + HOUR, { source: async () => [A, B], send });
    expect(bodies.map((b) => [b.reading_id, b.meter_total_wh])).toEqual([
      ["TEST-1-20261112T180000Z", 8_000],
      ["TEST-1-20261112T180000Z", 8_000], // identical resend
      ["TEST-1-20261111T180000Z", 23_000],
    ]);
    expect(state.meter_total_wh).toBe(23_000);
    expect(state.pending).toBeNull();
  });

  it("lets the owner skip a session that blocks delivery", async () => {
    const { store } = fakeStore();
    const impossible = session("2026-11-12T22:00:00Z", 1, 90_000);
    let state = await runCycle(cfg(), store, NOW, { source: async () => [impossible, B], send: ok });
    expect(state.delivered_count).toBe(0);
    expect(state.last_error).toContain("2026-11-12T22:00:00.000Z");
    state = await runCycle(cfg({ SKIP_SESSIONS: "2026-11-12T22:00:00Z" }), store, NOW + HOUR, {
      source: async () => [impossible, B],
      send: ok,
    });
    expect(state.last_error).toBeNull();
    expect(state.deliveries.map((d) => d.reading.session.started_at)).toEqual([B.started_at]);

    // The same switch drops a reading the operator keeps refusing.
    const s2 = fakeStore().store;
    const refuse = async () => new Response(null, { status: 422 });
    await runCycle(cfg(), s2, NOW, { source: async () => [A, B], send: refuse });
    state = await runCycle(cfg({ SKIP_SESSIONS: A.started_at }), s2, NOW + HOUR, { source: async () => [A, B], send: ok });
    expect(state.deliveries.map((d) => d.reading.session.started_at)).toEqual([B.started_at]);
    expect(state.meter_total_wh).toBe(8_000);
  });

  it("fails loudly on a half-configured bridge instead of guessing", async () => {
    const source = async () => [A];
    let sent = 0;
    const send = async () => (sent++, new Response(null, { status: 201 }));
    // Live without an address must not quietly deliver to the stand-in.
    let state = await runCycle(cfg({ MODE: "live" }), fakeStore().store, NOW, { source, send });
    expect(state.last_error).toContain("MERONRG_API_URL is not set");
    expect(state.watermark).toBeNull();
    // A misspelt mode is an error, not the demo.
    state = await runCycle(cfg({ MODE: "Live" }), fakeStore().store, NOW, { source, send });
    expect(state.last_error).toContain("MODE must be");
    expect(sent).toBe(0);
  });

  it("waits quietly when REPORT_FROM is still in the future", async () => {
    let asked = 0;
    const state = await runCycle(cfg({ REPORT_FROM: "2027-01-01T00:00:00Z" }), fakeStore().store, NOW, {
      source: async () => (asked++, []),
      send: ok,
    });
    expect(asked).toBe(0);
    expect(state.last_error).toBeNull();
  });

  it("delivers every session exactly once over weeks of random failures and late listings", async () => {
    // Deterministic pseudo-random numbers, so a failure can be reproduced.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    const all = Array.from({ length: 60 }, (_, d) => session(new Date(t0 + d * DAY + 18 * HOUR).toISOString(), 2, 10_000 + d));
    const visibleAt = new Map(all.map((s) => [s.started_at, Date.parse(s.ended_at) + rnd() * 5 * DAY])); // listed up to 5 days late
    const { store } = fakeStore();
    const received = new Map<string, number>();
    const totals: number[] = [];
    let state!: State;
    for (let now = t0 + 7 * DAY; now <= t0 + 75 * DAY; now += HOUR) {
      const sourceDown = rnd() < 0.15;
      state = await runCycle(cfg(), store, now, {
        source: async (from, to) => {
          if (sourceDown) throw new Error("Tesla charge history failed: HTTP 500");
          return all.filter((s) => visibleAt.get(s.started_at)! <= now && Date.parse(s.ended_at) >= from - DAY && Date.parse(s.started_at) <= to);
        },
        send: async (r) => {
          const lost = rnd() < 0.1; // accepted, but the answer is lost
          if (rnd() < 0.15) return new Response(null, { status: 503 });
          const b = (await r.json()) as Reading;
          if (!received.has(b.reading_id)) totals.push(b.meter_total_wh);
          received.set(b.reading_id, b.meter_total_wh);
          if (lost) throw new Error("timeout");
          return new Response(null, { status: 201 });
        },
      });
    }
    expect(received.size).toBe(60);
    expect(state.delivered_count).toBe(60);
    expect(state.meter_total_wh).toBe(all.reduce((sum, s) => sum + s.energy_wh, 0));
    expect([...totals].sort((a, b) => a - b)).toEqual(totals); // the register only ever goes up
    expect(state.recent.length).toBeLessThan(20); // old ids are forgotten
  });

  it("repeats the alert about once a day and survives a broken alert address", async () => {
    const { store } = fakeStore();
    let alerts = 0;
    const fetchFn = (async () => (alerts++, new Response(null, { status: 204 }))) as unknown as typeof fetch;
    const down = async () => new Response(null, { status: 500 });
    const c = cfg({ ALERT_WEBHOOK_URL: "https://alerts.example/hook" });
    for (let h = 0; h < 25; h++) await runCycle(c, store, NOW + h * HOUR, { source: async () => [A], send: down, fetch: fetchFn });
    expect(alerts).toBe(2); // first failure, then the 24th

    const never = (async () => {
      throw new Error("alert address is down");
    }) as unknown as typeof fetch;
    const state = await runCycle(c, fakeStore().store, NOW, { source: async () => [A], send: down, fetch: never });
    expect(state.last_error).toContain("500"); // the run still records its own error
    let called = 0;
    const plain = cfg({ ALERT_WEBHOOK_URL: "http://alerts.example/hook" });
    await runCycle(plain, fakeStore().store, NOW, {
      source: async () => [A],
      send: down,
      fetch: (async () => (called++, new Response(null))) as unknown as typeof fetch,
    });
    expect(called).toBe(0); // never over plain http
  });

  it("runs end to end in demo mode against the stand-in receiver", async () => {
    const { store } = fakeStore();
    const state = await runCycle(cfg(), store, NOW);
    expect(state.deliveries.length).toBeGreaterThan(2);
    expect(state.deliveries.every((d) => d.http_status === 201)).toBe(true);
    expect(state.last_error).toBeNull();
    expect((await loadState(store)).delivered_count).toBe(state.deliveries.length);
  });

  it("turns unhealthy when runs stop succeeding", async () => {
    const { store } = fakeStore();
    const state = await runCycle(cfg(), store, NOW, { source: async () => [], send: ok });
    expect(isHealthy(state, NOW + HOUR)).toBe(true);
    expect(isHealthy(state, NOW + HEALTHY_WITHIN_MS + 1)).toBe(false);
  });
});

describe("message to the operator", () => {
  it("has an id that depends only on the charger and the session start", () => {
    expect(readingId("WC3-0001", "2026-11-12T17:00:00.000Z")).toBe("WC3-0001-20261112T170000Z");
    expect(readingId("WC3-0001", "2026-11-12T19:00:00+02:00")).toBe("WC3-0001-20261112T170000Z");
  });

  it("needs a key for a real endpoint", () => {
    const reading = { reading_id: "x", charger_id: "x", session: A, meter_total_wh: 1, source: "demo" } as Reading;
    const live = { MODE: "live", MERONRG_API_URL: "https://api.example/r" };
    expect(() => buildDeliveryRequest(reading, cfg(live))).toThrow(/API_KEY/);
    expect(() => buildDeliveryRequest(reading, cfg({ MODE: "live" }))).toThrow(/API_URL/);
    // Demo never uses a real address or key, even if they are configured.
    const demo = buildDeliveryRequest(reading, cfg({ MERONRG_API_URL: "https://api.example/r", MERONRG_API_KEY: "real" }));
    expect(new URL(demo.url).hostname).toBe("bridge.invalid");
    expect(demo.headers.get("authorization")).toBe(`Bearer ${DEMO_API_KEY}`);
  });
});

describe("stand-in receiver", () => {
  const post = (body: unknown, key = DEMO_API_KEY) =>
    new Request(`https://x${MOCK_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const reading = { reading_id: "A-1", charger_id: "A", session: B, meter_total_wh: 8_000, source: "demo" };

  it("accepts once, then reports a repeat", async () => {
    const { store } = fakeStore();
    expect((await mockReceiver(post(reading), store)).status).toBe(201);
    const again = await mockReceiver(post(reading), store);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "duplicate" });
  });

  it("rejects a wrong key, a broken body and an oversized body", async () => {
    const { store } = fakeStore();
    expect((await mockReceiver(post(reading, "nope"), store)).status).toBe(401);
    expect((await mockReceiver(post({ ...reading, meter_total_wh: "8" }), store)).status).toBe(422);
    expect((await mockReceiver(post("{not json"), store)).status).toBe(400);
    expect((await mockReceiver(post("x".repeat(5000)), store)).status).toBe(413);
  });

  it("does not store requests that arrive over the public URL", async () => {
    const { env, writes } = workerEnv();
    const res = await worker.fetch!(post(reading) as never, env);
    expect(res.status).toBe(201);
    expect(writes()).toBe(0);
  });
});

describe("worker routes", () => {
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    worker.fetch!(new Request(`https://x${path}`, init) as never, env);
  const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  it("serves the demo page with security headers", async () => {
    const { env, instance } = workerEnv();
    await instance.run();
    const res = await call(env, "/");
    const html = await res.text();
    expect(html).toContain("Idempotency-Key");
    expect(html).toContain("adapts to the API MeronRG already has");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call(env, "/", { method: "POST" })).status).toBe(404);
  });

  it("sends plain http to https and never accepts a write over it", async () => {
    const { env } = workerEnv();
    const get = await worker.fetch!(new Request("http://bridge.example/") as never, env);
    expect(get.status).toBe(301);
    expect(get.headers.get("location")).toBe("https://bridge.example/");
    const post = await worker.fetch!(new Request("http://bridge.example/run", { method: "POST" }) as never, env);
    expect(post.status).toBe(400);
  });

  it("shows nothing in live mode without the status token", async () => {
    const { env } = workerEnv({ MODE: "live", STATUS_TOKEN: "s3" });
    expect(await (await call(env, "/")).text()).toBe("wallconnector-meter-bridge: running\n");
    expect((await call(env, "/api/status")).status).toBe(401);
    expect((await call(env, "/api/status", auth("wrong"))).status).toBe(401);
    expect((await call(env, "/api/status", auth("s3"))).status).toBe(200);
    expect((await call(env, MOCK_PATH, { method: "POST" })).status).toBe(404);
  });

  it("treats a misspelt mode as private, not as the demo", async () => {
    const { env } = workerEnv({ MODE: "Live", STATUS_TOKEN: "s3" });
    expect(await (await call(env, "/")).text()).toBe("wallconnector-meter-bridge: running\n");
    expect((await call(env, "/api/status")).status).toBe(401);
    expect((await call(env, "/run", { method: "POST" })).status).toBe(404);
    expect((await call(env, "/test-alert", { method: "POST" })).status).toBe(404);
  });

  it("reports health without revealing data", async () => {
    const { env, instance } = workerEnv();
    expect((await call(env, "/health")).status).toBe(503); // no run yet
    await instance.run();
    const res = await call(env, "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  it("runs on demand only with the status token", async () => {
    const run = (env: Env, token?: string) => call(env, "/run", { method: "POST", ...(token ? auth(token) : {}) });
    expect((await run(workerEnv().env)).status).toBe(404); // no token configured
    const { env } = workerEnv({ STATUS_TOKEN: "s3" });
    expect((await run(env, "wrong")).status).toBe(404);
    const res = await run(env, "s3");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered_count: number }).delivered_count).toBeGreaterThan(0);
  });

  it("joins a run already in progress instead of starting a second one", async () => {
    const { instance } = workerEnv();
    const first = instance.run();
    expect(instance.run()).toBe(first);
    await first;
  });
});

describe("demo page", () => {
  it("escapes everything it prints", () => {
    const evil = '<script>alert(1)</script>"';
    const state: State = {
      delivered_count: 1,
      meter_total_wh: 1,
      origin: null,
      watermark: null,
      recent: [],
      pending: null,
      deliveries: [
        {
          reading: { reading_id: evil, charger_id: evil, session: A, meter_total_wh: 1, source: "demo" },
          sent_at: A.ended_at,
          http_status: 201,
        },
      ],
      last_attempt_at: null,
      last_success_at: null,
      last_error: evil,
      consecutive_failures: 1,
    };
    const html = statusPage(state, cfg({ CHARGER_ID: evil }), "https://x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("tesla source", () => {
  it("parses charge history rows and refuses surprises without echoing values", () => {
    const body = {
      response: {
        charge_history: [
          { charge_start_time: { seconds: 1_794_500_000 }, charge_duration: { seconds: 7_200 }, energy_added_wh: 15_250.4 },
        ],
      },
    };
    expect(parseChargeHistory(body)).toEqual([
      { started_at: "2026-11-12T16:13:20.000Z", ended_at: "2026-11-12T18:13:20.000Z", energy_wh: 15_250 },
    ]);
    expect(() => parseChargeHistory({ response: {} })).toThrow(/unexpected response shape/);
    const bad = { response: { charge_history: [{ start: "secret-value", energy_added_wh: 1 }] } };
    expect(() => parseChargeHistory(bad)).toThrow(/fields \[start, energy_added_wh\]/);
    expect(() => parseChargeHistory(bad)).not.toThrow(/secret-value/);
  });

  it("refreshes the token, stores the rotated one, and asks for the charge history", async () => {
    const { store } = fakeStore();
    const c = cfg({ MODE: "live", TESLA_CLIENT_ID: "cid", TESLA_ENERGY_SITE_ID: "42", TESLA_REFRESH_TOKEN: "seed" });
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/oauth2/v3/token")) {
        expect(String(init?.body)).toContain("refresh_token=seed");
        return Response.json({ access_token: "at", refresh_token: "rotated", expires_in: 28_800 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer at");
      return Response.json({ response: { charge_history: [] } });
    }) as typeof fetch;

    expect(await teslaSessions(c, store, NOW - DAY, NOW, fetchFn, NOW)).toEqual([]);
    expect(calls[1]).toContain("/api/1/energy_sites/42/telemetry_history?kind=charge");
    expect(await store.get("tesla_token")).toMatchObject({ refresh_token: "rotated" });

    // Second call inside the token's lifetime: no new refresh.
    await teslaSessions(c, store, NOW - DAY, NOW, fetchFn, NOW + HOUR);
    expect(calls.filter((u) => u.includes("/token"))).toHaveLength(1);
  });

  it("uses the rotated token on expiry, and a newly configured one when the owner authorises again", async () => {
    const { store } = fakeStore();
    const base = { MODE: "live", TESLA_CLIENT_ID: "cid", TESLA_ENERGY_SITE_ID: "42" };
    const used: string[] = [];
    let n = 0;
    let refuse = false;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/oauth2/v3/token")) {
        used.push(new URLSearchParams(String(init?.body)).get("refresh_token")!);
        if (refuse) return new Response(null, { status: 401 });
        return Response.json({ access_token: `at${++n}`, refresh_token: `rotated${n}`, expires_in: 3_600 });
      }
      return Response.json({ response: { charge_history: [] } });
    }) as typeof fetch;
    const seed1 = cfg({ ...base, TESLA_REFRESH_TOKEN: "seed-1" });

    await teslaSessions(seed1, store, 0, 1, fetchFn, NOW);
    await teslaSessions(seed1, store, 0, 1, fetchFn, NOW + 2 * HOUR); // expired: rotated token, not the seed
    expect(used).toEqual(["seed-1", "rotated1"]);

    // Tesla now refuses the stored token: the error is visible and nothing is overwritten.
    refuse = true;
    await expect(teslaSessions(seed1, store, 0, 1, fetchFn, NOW + 4 * HOUR)).rejects.toThrow(/token refresh failed: HTTP 401/);
    // The owner authorises again and sets a new seed: it must win over the dead stored token.
    refuse = false;
    await teslaSessions(cfg({ ...base, TESLA_REFRESH_TOKEN: "seed-2" }), store, 0, 1, fetchFn, NOW + 5 * HOUR);
    expect(used.at(-1)).toBe("seed-2");
  });

  it("only ever talks to Tesla, with a numeric site id", async () => {
    const { store } = fakeStore();
    const base = { MODE: "live", TESLA_CLIENT_ID: "cid", TESLA_REFRESH_TOKEN: "seed" };
    const never = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await expect(
      teslaSessions(cfg({ ...base, TESLA_ENERGY_SITE_ID: "42", TESLA_API_BASE: "https://evil.example" }), store, 0, 1, never),
    ).rejects.toThrow(/Tesla address/);
    await expect(teslaSessions(cfg({ ...base, TESLA_ENERGY_SITE_ID: "42/../x" }), store, 0, 1, never)).rejects.toThrow(
      /must be a number/,
    );
  });
});
