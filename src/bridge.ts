// The whole job: find charging sessions the operator has not seen yet, post each one,
// and remember how far we got. Runs once an hour, one run at a time.

import { demoSessions } from "./demo";
import { accepted, buildDeliveryRequest, readingId } from "./meronrg";
import { mockReceiver } from "./mock";
import { teslaSessions } from "./tesla";
import type { Config, Delivery, Reading, Session, SessionSource, State, Store } from "./types";

const STATE_KEY = "state";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A session is only reported once it has been over for this long. */
const SETTLE_MS = 10 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 7 * DAY;
/** Each run looks this far behind the watermark, to catch a session Tesla listed late. */
const OVERLAP_MS = 7 * DAY;
const MAX_PER_RUN = 20;
const KEEP_DELIVERIES = 20;
/** A Wall Connector cannot deliver more than 22 kW. Anything above this is bad data, not a bill. */
const MAX_PLAUSIBLE_W = 25_000;
/** /health turns unhealthy when no run has succeeded for this long. */
export const HEALTHY_WITHIN_MS = 3 * HOUR;
const ALERT_REPEAT_EVERY = 24; // failed runs, about once a day

const iso = (ms: number) => new Date(ms).toISOString();

export const emptyState = (): State => ({
  delivered_count: 0,
  meter_total_wh: 0,
  origin: null,
  watermark: null,
  recent: [],
  pending: null,
  deliveries: [],
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  consecutive_failures: 0,
});

export async function loadState(store: Store): Promise<State> {
  const state = { ...emptyState(), ...((await store.get<State>(STATE_KEY)) ?? {}) };
  // Older versions kept only the start time.
  state.recent = (state.recent as unknown[]).map((r) =>
    typeof r === "string" ? { s: r, e: r } : (r as { s: string; e: string }),
  );
  return state;
}

/** Anything that is not exactly "demo" is treated as live by the public routes: private by default. */
export function isDemo(cfg: Config): boolean {
  return cfg.MODE === "demo";
}

function modeOf(cfg: Config): "demo" | "live" {
  if (cfg.MODE === "demo" || cfg.MODE === "live") return cfg.MODE;
  throw new Error('MODE must be "demo" or "live"');
}

export function isHealthy(state: State, now: number = Date.now()): boolean {
  return state.last_success_at !== null && now - Date.parse(state.last_success_at) <= HEALTHY_WITHIN_MS;
}

export interface Deps {
  source?: SessionSource;
  send?: (request: Request) => Promise<Response>;
  /** Used for the alert webhook only. */
  fetch?: typeof fetch;
}

/** Sessions the owner has told the bridge to leave out, after checking them by hand. */
function skipSet(cfg: Config): Set<string> {
  const out = new Set<string>();
  for (const raw of (cfg.SKIP_SESSIONS ?? "").split(",")) {
    const t = Date.parse(raw.trim());
    if (raw.trim() && Number.isNaN(t)) throw new Error("SKIP_SESSIONS has an invalid date");
    if (!Number.isNaN(t)) out.add(iso(t));
  }
  return out;
}

/** Refuses data that should never reach a bill. Throws; the run stops and raises an alert. */
function check(session: Session): void {
  const start = Date.parse(session.started_at);
  const end = Date.parse(session.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new Error("charger data: a session has an invalid start or end time");
  }
  if (!Number.isFinite(session.energy_wh) || session.energy_wh < 0) {
    throw new Error(`charger data: the session starting ${session.started_at} has an invalid energy value`);
  }
  const hours = (end - start) / HOUR;
  if (session.energy_wh > hours * MAX_PLAUSIBLE_W + 1_000) {
    throw new Error(
      `charger data: the session starting ${session.started_at} reports more energy than the charger can deliver`,
    );
  }
}

/** Tells the owner's alert address something. Never throws; returns whether it was accepted. */
export async function notify(
  cfg: Config,
  fetchFn: typeof fetch,
  status: "failing" | "recovered" | "test",
  state: State | null,
): Promise<boolean> {
  if (!cfg.ALERT_WEBHOOK_URL) return false;
  try {
    const url = new URL(cfg.ALERT_WEBHOOK_URL);
    if (url.protocol !== "https:") return false;
    const res = await fetchFn(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "wallconnector-meter-bridge",
        charger_id: cfg.CHARGER_ID,
        status,
        error: state?.last_error ?? null,
        consecutive_failures: state?.consecutive_failures ?? 0,
        last_success_at: state?.last_success_at ?? null,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    // An alert that cannot be sent must not break the run. /health still shows the problem.
    return false;
  }
}

export async function runCycle(
  cfg: Config,
  store: Store,
  now: number = Date.now(),
  deps: Deps = {},
): Promise<State> {
  const state = await loadState(store);
  const wasFailing = state.consecutive_failures > 0;
  const save = () => store.put(STATE_KEY, state);
  const fetchFn: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  let error: string | null = null;

  try {
    // Settings are checked first: a half-configured bridge must fail loudly, never guess.
    const mode = modeOf(cfg);
    if (!cfg.CHARGER_ID) throw new Error("CHARGER_ID is not set");
    if (mode === "live" && !cfg.MERONRG_API_URL) throw new Error("MERONRG_API_URL is not set");
    const floor = cfg.REPORT_FROM ? Date.parse(cfg.REPORT_FROM) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(floor)) throw new Error("REPORT_FROM is not a valid date");
    const skip = skipSet(cfg);

    const source: SessionSource =
      deps.source ??
      (mode === "live"
        ? (from, to) => teslaSessions(cfg, store, from, to)
        : async (from, to) => demoSessions(from, to));
    const send = deps.send ?? (mode === "live" ? (req: Request) => fetch(req) : (req: Request) => mockReceiver(req, store));

    const deliver = async (reading: Reading) => {
      const request = buildDeliveryRequest(reading, cfg); // a settings problem is reported as it is
      let response: Response;
      try {
        response = await send(request);
      } catch {
        throw new Error(`operator did not answer for ${reading.reading_id} (timeout or network error)`);
      }
      if (!accepted(response)) {
        // Stop here: later sessions wait. The same reading goes out again next hour.
        throw new Error(`operator answered HTTP ${response.status} for ${reading.reading_id}`);
      }
      const delivery: Delivery = { reading, sent_at: iso(now), http_status: response.status };
      state.delivered_count += 1;
      state.meter_total_wh = reading.meter_total_wh;
      state.recent.push({ s: reading.session.started_at, e: reading.session.ended_at });
      state.deliveries = [delivery, ...state.deliveries].slice(0, KEEP_DELIVERIES);
      state.pending = null;
      await save(); // after every accepted reading, so a crash never loses the total
    };

    // The start of reporting is fixed at the first attempt. However long the first
    // successful run takes to arrive, nothing after this moment is skipped.
    state.origin ??= iso(Math.max(now - FIRST_RUN_LOOKBACK_MS, floor));

    // A reading that was sent but never confirmed goes out again unchanged, before anything
    // else, so one id never carries two different totals.
    if (state.pending) {
      if (skip.has(state.pending.session.started_at)) state.pending = null;
      else await deliver(state.pending);
    }

    const to = now - SETTLE_MS;
    const from = Math.max(state.watermark ? Date.parse(state.watermark) - OVERLAP_MS : Date.parse(state.origin), floor);

    if (from < to) {
      const seen = new Set(state.recent.map((r) => r.s));
      const inWindow = (await source(from, to))
        .filter((s) => !seen.has(s.started_at) && !skip.has(s.started_at))
        // Judged by when it ended, so a long session that began before the window still counts.
        .filter((s) => !(Date.parse(s.ended_at) < from) && !(Date.parse(s.ended_at) > to))
        .filter((s) => !(Date.parse(s.started_at) < floor));
      inWindow.forEach(check);

      const due = inWindow
        .filter((s) => s.energy_wh > 0) // plugged in but nothing delivered: nothing to bill
        .sort((a, b) => a.started_at.localeCompare(b.started_at));
      const batch = due.slice(0, MAX_PER_RUN);

      for (const session of batch) {
        const reading: Reading = {
          reading_id: readingId(cfg.CHARGER_ID, session.started_at),
          charger_id: cfg.CHARGER_ID,
          session,
          meter_total_wh: state.meter_total_wh + session.energy_wh,
          source: mode === "live" ? "tesla-fleet-api" : "demo",
        };
        state.pending = reading;
        await save();
        await deliver(reading);
      }

      if (batch.length === due.length) {
        // Everything that ended before `to` is delivered. Forget sessions too old to be listed again.
        state.watermark = iso(to);
        const keepFrom = to - OVERLAP_MS - DAY;
        state.recent = state.recent.filter((r) => Date.parse(r.e) >= keepFrom);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  state.last_attempt_at = iso(now);
  state.last_error = error;
  if (error) {
    state.consecutive_failures += 1;
  } else {
    state.consecutive_failures = 0;
    state.last_success_at = state.last_attempt_at;
  }
  await save();

  if (error && (state.consecutive_failures === 1 || state.consecutive_failures % ALERT_REPEAT_EVERY === 0)) {
    await notify(cfg, fetchFn, "failing", state);
  } else if (!error && wasFailing) {
    await notify(cfg, fetchFn, "recovered", state);
  }
  return state;
}
