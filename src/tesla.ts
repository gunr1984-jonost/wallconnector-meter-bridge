// The charger side: reads completed charging sessions from Tesla's Fleet API.
//
// A Wall Connector registered in the Tesla app reports to Tesla's cloud by itself, so
// nothing has to be installed in the garage or on the building's network.
//
// STATUS: written from Tesla's published endpoint list, NOT yet run against a real charger
// (the charger is not installed). The response field names below are the ones to confirm
// on the first live run; parsing is tolerant so a surprise shows up as a clear error.
//
//   GET /api/1/energy_sites/{id}/telemetry_history?kind=charge  -> "charging history of a wall connector", Wh
//   https://developer.tesla.com/docs/fleet-api/endpoints/energy

import type { Env, Session } from "./types";

const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const DEFAULT_API_BASE = "https://fleet-api.prd.eu.vn.cloud.tesla.com"; // Europe, Middle East, Africa
const TOKEN_KEY = "tesla_token";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms
}

type Fetch = typeof fetch;

async function accessToken(env: Env, fetchFn: Fetch, now: number): Promise<string> {
  const stored = await env.STATE.get<StoredToken>(TOKEN_KEY, "json");
  if (stored && stored.expires_at - 60_000 > now) return stored.access_token;

  // Tesla rotates the refresh token on every use, so the newest one is kept in KV.
  const refresh = stored?.refresh_token ?? env.TESLA_REFRESH_TOKEN;
  if (!refresh || !env.TESLA_CLIENT_ID) {
    throw new Error("Tesla is not authorised yet: set TESLA_CLIENT_ID and TESLA_REFRESH_TOKEN");
  }
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.TESLA_CLIENT_ID,
      refresh_token: refresh,
    }),
  });
  if (!res.ok) throw new Error(`Tesla token refresh failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const token: StoredToken = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? refresh,
    expires_at: now + body.expires_in * 1000,
  };
  await env.STATE.put(TOKEN_KEY, JSON.stringify(token));
  return token.access_token;
}

function seconds(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t / 1000;
  }
  if (v && typeof v === "object" && "seconds" in v) return Number((v as { seconds: unknown }).seconds);
  return null;
}

/** Turns Tesla's charge-history rows into sessions. Exported for tests. */
export function parseChargeHistory(body: unknown): Session[] {
  const rows = (body as { response?: { charge_history?: unknown } })?.response?.charge_history;
  if (!Array.isArray(rows)) throw new Error("Tesla charge history: unexpected response shape");
  const sessions: Session[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const start = seconds(row.charge_start_time);
    const duration = seconds(row.charge_duration);
    const wh = Number(row.energy_added_wh);
    if (start === null || duration === null || !Number.isFinite(wh)) {
      throw new Error(`Tesla charge history: unexpected row ${JSON.stringify(row)}`);
    }
    sessions.push({
      started_at: new Date(start * 1000).toISOString(),
      ended_at: new Date((start + duration) * 1000).toISOString(),
      energy_wh: Math.round(wh),
    });
  }
  return sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export async function teslaSessions(
  env: Env,
  fromMs: number,
  toMs: number,
  fetchFn: Fetch = fetch,
  now: number = Date.now(),
): Promise<Session[]> {
  if (!env.TESLA_ENERGY_SITE_ID) throw new Error("TESLA_ENERGY_SITE_ID is not set");
  const token = await accessToken(env, fetchFn, now);
  const url = new URL(
    `/api/1/energy_sites/${env.TESLA_ENERGY_SITE_ID}/telemetry_history`,
    env.TESLA_API_BASE ?? DEFAULT_API_BASE,
  );
  url.searchParams.set("kind", "charge");
  url.searchParams.set("start_date", new Date(fromMs).toISOString());
  url.searchParams.set("end_date", new Date(toMs).toISOString());
  url.searchParams.set("time_zone", env.TIME_ZONE);

  const res = await fetchFn(url.toString(), { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Tesla charge history failed: HTTP ${res.status}`);
  return parseChargeHistory(await res.json());
}
