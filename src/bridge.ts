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
const OVERLAP_MS = 2 * DAY;
const MAX_PER_RUN = 20;
const KEEP_DELIVERIES = 20;
/** A Wall Connector cannot deliver more than 22 kW. Anything above this is bad data, not a bill. */
const MAX_PLAUSIBLE_W = 25_000;
/** /health turns unhealthy when no run has succeeded for this long. */
export const HEALTHY_WITHIN_MS = 3 * HOUR;
const ALERT_REPEAT_EVERY = 24; // failed runs, about once a day

export const emptyState = (): State => ({
  delivered_count: 0,
  meter_total_wh: 0,
  watermark: null,
  recent: [],
  deliveries: [],
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  consecutive_failures: 0,
});

export async function loadState(store: Store): Promise<State> {
  return { ...emptyState(), ...((await store.get<State>(STATE_KEY)) ?? {}) };
}

export function isLive(cfg: Config): boolean {
  return cfg.MODE === "live";
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

function defaults(cfg: Config, store: Store): Required<Deps> {
  return {
    source: isLive(cfg)
      ? (from, to) => teslaSessions(cfg, store, from, to)
      : async (from, to) => demoSessions(from, to),
    send: cfg.MERONRG_API_URL ? (req) => fetch(req) : (req) => mockReceiver(req, store),
    fetch: (input, init) => fetch(input, init),
  };
}

/** Refuses data that should never reach a bill. Throws; the run stops and raises an alert. */
function check(session: Session): void {
  const start = Date.parse(session.started_at);
  const end = Date.parse(session.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new Error("charger data: a session has an invalid start or end time");
  }
  if (!Number.isFinite(session.energy_wh) || session.energy_wh < 0) {
    throw new Error("charger data: a session has an invalid energy value");
  }
  const hours = (end - start) / HOUR;
  if (session.energy_wh > hours * MAX_PLAUSIBLE_W + 1_000) {
    throw new Error("charger data: a session reports more energy than the charger can deliver");
  }
}

async function alert(cfg: Config, fetchFn: typeof fetch, status: "failing" | "recovered", state: State) {
  if (!cfg.ALERT_WEBHOOK_URL) return;
  try {
    const url = new URL(cfg.ALERT_WEBHOOK_URL);
    if (url.protocol !== "https:") return;
    await fetchFn(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "wallconnector-meter-bridge",
        charger_id: cfg.CHARGER_ID,
        status,
        error: state.last_error,
        consecutive_failures: state.consecutive_failures,
        last_success_at: state.last_success_at,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // An alert that cannot be sent must not break the run. /health still shows the problem.
  }
}

export async function runCycle(
  cfg: Config,
  store: Store,
  now: number = Date.now(),
  deps: Deps = {},
): Promise<State> {
  const { source, send, fetch: fetchFn } = { ...defaults(cfg, store), ...deps };
  const state = await loadState(store);
  const wasFailing = state.consecutive_failures > 0;
  const save = () => store.put(STATE_KEY, state);
  let error: string | null = null;

  try {
    if (!cfg.CHARGER_ID) throw new Error("CHARGER_ID is not set");
    const floor = cfg.REPORT_FROM ? Date.parse(cfg.REPORT_FROM) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(floor)) throw new Error("REPORT_FROM is not a valid date");

    const to = now - SETTLE_MS;
    const from = Math.max(
      state.watermark ? Date.parse(state.watermark) - OVERLAP_MS : now - FIRST_RUN_LOOKBACK_MS,
      floor,
    );
    const seen = new Set(state.recent);
    const all = await source(from, to);
    all.forEach(check);

    const due = all
      .filter((s) => Date.parse(s.started_at) >= from && Date.parse(s.ended_at) <= to)
      .filter((s) => s.energy_wh > 0) // plugged in but nothing delivered: nothing to bill
      .filter((s) => !seen.has(s.started_at))
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
    const batch = due.slice(0, MAX_PER_RUN);

    for (const session of batch) {
      const reading: Reading = {
        reading_id: readingId(cfg.CHARGER_ID, session.started_at),
        charger_id: cfg.CHARGER_ID,
        session,
        meter_total_wh: state.meter_total_wh + session.energy_wh,
        source: isLive(cfg) ? "tesla-fleet-api" : "demo",
      };
      const response = await send(buildDeliveryRequest(reading, cfg));
      if (!accepted(response)) {
        // Stop here: later sessions wait. The same reading, same id, goes out again next hour.
        throw new Error(`operator answered HTTP ${response.status} for ${reading.reading_id}`);
      }
      const delivery: Delivery = { reading, sent_at: new Date(now).toISOString(), http_status: response.status };
      state.delivered_count += 1;
      state.meter_total_wh = reading.meter_total_wh;
      state.recent.push(session.started_at);
      state.deliveries = [delivery, ...state.deliveries].slice(0, KEEP_DELIVERIES);
      await save(); // after every accepted reading, so a crash never loses the total
    }

    if (batch.length === due.length) {
      // Everything up to `to` is delivered. Forget ids too old to ever be listed again.
      state.watermark = new Date(to).toISOString();
      const keepFrom = to - OVERLAP_MS - DAY;
      state.recent = state.recent.filter((id) => Date.parse(id) >= keepFrom);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  state.last_attempt_at = new Date(now).toISOString();
  state.last_error = error;
  if (error) {
    state.consecutive_failures += 1;
  } else {
    state.consecutive_failures = 0;
    state.last_success_at = state.last_attempt_at;
  }
  await save();

  if (error && (state.consecutive_failures === 1 || state.consecutive_failures % ALERT_REPEAT_EVERY === 0)) {
    await alert(cfg, fetchFn, "failing", state);
  } else if (!error && wasFailing) {
    await alert(cfg, fetchFn, "recovered", state);
  }
  return state;
}
