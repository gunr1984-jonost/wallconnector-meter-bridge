import { describe, expect, it } from "vitest";
import { loadState, runCycle } from "../src/bridge";
import { demoSessions } from "../src/demo";
import worker from "../src/index";
import { DEMO_API_KEY, MOCK_PATH } from "../src/meronrg";
import { mockReceiver } from "../src/mock";
import { parseChargeHistory, teslaSessions } from "../src/tesla";
import type { Env, Session } from "../src/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T09:00:00Z");

function fakeKV() {
  const data = new Map<string, string>();
  let writes = 0;
  const kv = {
    async get(key: string, type?: string) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      writes++;
      data.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, writes: () => writes };
}

function env(overrides: Partial<Env> = {}): Env & { writes: () => number } {
  const { kv, writes } = fakeKV();
  return { STATE: kv, MODE: "demo", CHARGER_ID: "TEST-1", TIME_ZONE: "Asia/Jerusalem", writes, ...overrides };
}

const session = (startIso: string, hours: number, wh: number): Session => ({
  started_at: new Date(startIso).toISOString(),
  ended_at: new Date(Date.parse(startIso) + hours * 3_600_000).toISOString(),
  energy_wh: wh,
});

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
    const e = env();
    const sent: Request[] = [];
    const source = async () => [session("2026-11-11T18:00:00Z", 2, 15_000), session("2026-11-12T18:00:00Z", 1, 8_000)];
    const send = async (r: Request) => (sent.push(r), new Response(null, { status: 201 }));

    const state = await runCycle(e, NOW, { source, send });
    expect(sent).toHaveLength(2);
    expect(state.meter_total_wh).toBe(23_000);
    expect(state.cursor).toBe("2026-11-12T18:00:00.000Z");

    const first = (await sent[0].json()) as { reading_id: string; meter_total_wh: number };
    expect(first).toMatchObject({ reading_id: "TEST-1-000001", meter_total_wh: 15_000 });
    expect(sent[0].headers.get("idempotency-key")).toBe("TEST-1-000001");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${DEMO_API_KEY}`);

    // Next hour, same sessions on offer: nothing is sent and nothing is written.
    const writes = e.writes();
    await runCycle(e, NOW + 3_600_000, { source, send });
    expect(sent).toHaveLength(2);
    expect(e.writes()).toBe(writes);
  });

  it("retries a refused reading with the same id and does not skip ahead", async () => {
    const e = env();
    const ids: string[] = [];
    const source = async () => [session("2026-11-11T18:00:00Z", 2, 15_000), session("2026-11-12T18:00:00Z", 1, 8_000)];
    let fail = true;
    const send = async (r: Request) => {
      ids.push(r.headers.get("idempotency-key")!);
      return new Response(null, { status: fail ? 503 : 201 });
    };

    let state = await runCycle(e, NOW, { source, send });
    expect(state.seq).toBe(0);
    expect(state.meter_total_wh).toBe(0);
    expect(state.last_error).toContain("503");

    fail = false;
    state = await runCycle(e, NOW + 3_600_000, { source, send });
    expect(ids).toEqual(["TEST-1-000001", "TEST-1-000001", "TEST-1-000002"]);
    expect(state.meter_total_wh).toBe(23_000);
    expect(state.last_error).toBeNull();
  });

  it("holds back a session that has only just ended", async () => {
    const e = env();
    const justEnded = session(new Date(NOW - 65 * 60_000).toISOString(), 1, 9_000); // ended 5 min ago
    const send = async () => new Response(null, { status: 201 });
    expect((await runCycle(e, NOW, { source: async () => [justEnded], send })).seq).toBe(0);
    expect((await runCycle(e, NOW + 3_600_000, { source: async () => [justEnded], send })).seq).toBe(1);
  });

  it("runs end to end in demo mode against the stand-in receiver", async () => {
    const e = env();
    const state = await runCycle(e, NOW);
    expect(state.deliveries.length).toBeGreaterThan(2);
    expect(state.deliveries.every((d) => d.http_status === 201)).toBe(true);
    expect(state.last_error).toBeNull();
    expect((await loadState(e)).seq).toBe(state.deliveries.length);
  });
});

describe("stand-in receiver", () => {
  const post = (body: unknown, key = DEMO_API_KEY) =>
    new Request(`https://x${MOCK_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const reading = {
    reading_id: "A-000001",
    charger_id: "A",
    session: session("2026-11-12T18:00:00Z", 1, 8_000),
    meter_total_wh: 8_000,
    source: "demo",
  };

  it("accepts once, then reports a repeat", async () => {
    const e = env();
    expect((await mockReceiver(post(reading), e, true)).status).toBe(201);
    const again = await mockReceiver(post(reading), e, true);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "duplicate" });
  });

  it("rejects a wrong key and a broken body", async () => {
    const e = env();
    expect((await mockReceiver(post(reading, "nope"), e, true)).status).toBe(401);
    expect((await mockReceiver(post({ ...reading, meter_total_wh: "8" }), e, true)).status).toBe(422);
  });

  it("does not store requests that arrive over the public URL", async () => {
    const e = env();
    const res = await worker.fetch!(post(reading) as never, e);
    expect(res.status).toBe(201);
    expect(e.writes()).toBe(0);
  });
});

describe("worker routes", () => {
  const get = (e: Env, path: string, headers: Record<string, string> = {}) =>
    worker.fetch!(new Request(`https://x${path}`, { headers }) as never, e);

  it("serves the demo page with the delivered sessions", async () => {
    const e = env();
    await runCycle(e, NOW);
    const html = await (await get(e, "/")).text();
    expect(html).toContain("TEST-1-000001");
    expect(html).toContain("Idempotency-Key");
  });

  it("shows nothing in live mode without the status token", async () => {
    const e = env({ MODE: "live", STATUS_TOKEN: "s3" });
    expect(await (await get(e, "/")).text()).toBe("wallconnector-meter-bridge: running\n");
    expect((await get(e, "/api/status")).status).toBe(401);
    expect((await get(e, "/api/status", { authorization: "Bearer s3" })).status).toBe(200);
    expect((await get(e, MOCK_PATH)).status).toBe(404);
  });
});

describe("manual run", () => {
  const run = (e: Env, token?: string) =>
    worker.fetch!(
      new Request("https://x/run", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }) as never,
      e,
    );

  it("needs the status token", async () => {
    expect((await run(env())).status).toBe(404); // no token configured
    const e = env({ STATUS_TOKEN: "s3" });
    expect((await run(e, "wrong")).status).toBe(404);
    const res = await run(e, "s3");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered_total: number }).delivered_total).toBeGreaterThan(0);
  });
});

describe("tesla source", () => {
  it("parses charge history rows", () => {
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
  });

  it("refreshes the token, stores the rotated one, and asks for the charge history", async () => {
    const e = env({ MODE: "live", TESLA_CLIENT_ID: "cid", TESLA_ENERGY_SITE_ID: "42", TESLA_REFRESH_TOKEN: "seed" });
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

    expect(await teslaSessions(e, NOW - DAY, NOW, fetchFn, NOW)).toEqual([]);
    expect(calls[1]).toContain("/api/1/energy_sites/42/telemetry_history?kind=charge");
    expect(await e.STATE.get("tesla_token", "json")).toMatchObject({ refresh_token: "rotated" });

    // Second call inside the token's lifetime: no new refresh.
    await teslaSessions(e, NOW - DAY, NOW, fetchFn, NOW + 3_600_000);
    expect(calls.filter((u) => u.includes("/token"))).toHaveLength(1);
  });
});
