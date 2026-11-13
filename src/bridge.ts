// The whole job: find charging sessions the operator has not seen yet, post each one,
// and remember how far we got. Runs once an hour.

import { demoSessions } from "./demo";
import { buildDeliveryRequest } from "./meronrg";
import { mockReceiver } from "./mock";
import { teslaSessions } from "./tesla";
import type { Delivery, Env, Reading, SessionSource, State } from "./types";

const STATE_KEY = "state";
const DAY = 86_400_000;
/** A session is only reported once it has been over for this long. */
const SETTLE_MS = 10 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 7 * DAY;
const MAX_PER_RUN = 20;
const KEEP_DELIVERIES = 20;

export const emptyState = (): State => ({
  seq: 0,
  meter_total_wh: 0,
  cursor: null,
  deliveries: [],
  updated_at: null,
  last_error: null,
});

export async function loadState(env: Env): Promise<State> {
  return (await env.STATE.get<State>(STATE_KEY, "json")) ?? emptyState();
}

export interface Deps {
  source?: SessionSource;
  send?: (request: Request) => Promise<Response>;
}

export function isLive(env: Env): boolean {
  return env.MODE === "live";
}

function defaults(env: Env): Required<Deps> {
  return {
    source: isLive(env)
      ? (from, to) => teslaSessions(env, from, to)
      : async (from, to) => demoSessions(from, to),
    send: env.MERONRG_API_URL ? (req) => fetch(req) : (req) => mockReceiver(req, env, true),
  };
}

export async function runCycle(env: Env, now: number = Date.now(), deps: Deps = {}): Promise<State> {
  const { source, send } = { ...defaults(env), ...deps };
  const state = await loadState(env);
  const before = JSON.stringify(state);
  state.last_error = null;

  try {
    const from = state.cursor ? Date.parse(state.cursor) : now - FIRST_RUN_LOOKBACK_MS;
    const sessions = (await source(from, now - SETTLE_MS))
      .filter((s) => Date.parse(s.started_at) > from && Date.parse(s.ended_at) <= now - SETTLE_MS)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .slice(0, MAX_PER_RUN);

    for (const session of sessions) {
      const reading: Reading = {
        reading_id: `${env.CHARGER_ID}-${String(state.seq + 1).padStart(6, "0")}`,
        charger_id: env.CHARGER_ID,
        session,
        meter_total_wh: state.meter_total_wh + session.energy_wh,
        source: isLive(env) ? "tesla-fleet-api" : "demo",
      };
      const response = await send(buildDeliveryRequest(reading, env));
      const delivery: Delivery = {
        reading,
        sent_at: new Date(now).toISOString(),
        http_status: response.status,
      };
      if (!response.ok) {
        // Stop here. The same reading, with the same id, goes out again next hour.
        state.last_error = `operator answered HTTP ${response.status} for ${reading.reading_id}`;
        break;
      }
      state.seq += 1;
      state.meter_total_wh = reading.meter_total_wh;
      state.cursor = session.started_at;
      state.deliveries = [delivery, ...state.deliveries].slice(0, KEEP_DELIVERIES);
    }
  } catch (err) {
    state.last_error = err instanceof Error ? err.message : String(err);
  }

  // Write only when something changed: an idle hour costs no storage write.
  if (JSON.stringify(state) !== before) {
    state.updated_at = new Date(now).toISOString();
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
  }
  return state;
}
