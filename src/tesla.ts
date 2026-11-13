// The charger side: reads completed charging sessions from Tesla's Fleet API.
//
// A Wall Connector registered in the Tesla app reports to Tesla's cloud by itself, so
// nothing has to be installed in the garage or on the building's network.
//
// STATUS: written from Tesla's published endpoint list, NOT yet run against a real charger
// (the charger is not installed). The response field names below are the ones to confirm
// on the first live run; parsing is strict so a surprise shows up as a clear error.
//
//   GET /api/1/energy_sites/{id}/telemetry_history?kind=charge  -> "charging history of a wall connector", Wh
//   https://developer.tesla.com/docs/fleet-api/endpoints/energy

import type { Config, Session, Store } from "./types";

const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const DEFAULT_API_BASE = "https://fleet-api.prd.eu.vn.cloud.tesla.com"; // Europe, Middle East, Africa
const TOKEN_KEY = "tesla_token";
const TIMEOUT_MS = 20_000;

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms
  /** Which configured TESLA_REFRESH_TOKEN this chain of tokens started from. */
  seed_fp: string | null;
}

async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Fetch = typeof fetch;

/** The access token may only ever be sent to Tesla, over https. */
function apiBase(cfg: Config): URL {
  const base = new URL(cfg.TESLA_API_BASE ?? DEFAULT_API_BASE);
  const tesla = base.hostname.endsWith(".tesla.com") || base.hostname.endsWith(".tesla.cn");
  if (base.protocol !== "https:" || !tesla) throw new Error("TESLA_API_BASE must be an https Tesla address");
  return base;
}

async function accessToken(cfg: Config, store: Store, fetchFn: Fetch, now: number): Promise<string> {
  const stored = await store.get<StoredToken>(TOKEN_KEY);
  // A newly configured TESLA_REFRESH_TOKEN (after authorising again) replaces what is stored.
  const seedFp = cfg.TESLA_REFRESH_TOKEN ? await fingerprint(cfg.TESLA_REFRESH_TOKEN) : null;
  const reseeded = seedFp !== null && stored?.seed_fp !== seedFp;
  if (stored && !reseeded && stored.expires_at - 60_000 > now) return stored.access_token;

  // Tesla rotates the refresh token on every use, so the newest one is kept in storage.
  // The bridge runs one cycle at a time, so a refresh token is never used twice.
  const refresh = reseeded ? cfg.TESLA_REFRESH_TOKEN : stored?.refresh_token;
  if (!refresh || !cfg.TESLA_CLIENT_ID) {
    throw new Error("Tesla is not authorised yet: set TESLA_CLIENT_ID and TESLA_REFRESH_TOKEN");
  }
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.TESLA_CLIENT_ID,
      refresh_token: refresh,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Tesla token refresh failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error("Tesla token refresh: unexpected response");
  }
  const token: StoredToken = {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : refresh,
    expires_at: now + body.expires_in * 1000,
    seed_fp: reseeded ? seedFp : (stored?.seed_fp ?? null),
  };
  await store.put(TOKEN_KEY, token);
  return token.access_token;
}

function seconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t / 1000;
  }
  if (v && typeof v === "object" && "seconds" in v) {
    const s = Number((v as { seconds: unknown }).seconds);
    return Number.isFinite(s) ? s : null;
  }
  return null;
}

/** Turns Tesla's charge-history rows into sessions. Exported for tests. */
export function parseChargeHistory(body: unknown): Session[] {
  const rows = (body as { response?: { charge_history?: unknown } })?.response?.charge_history;
  if (!Array.isArray(rows)) throw new Error("Tesla charge history: unexpected response shape");
  const sessions: Session[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const start = seconds(row?.charge_start_time);
    const duration = seconds(row?.charge_duration);
    const wh = Number(row?.energy_added_wh);
    if (start === null || duration === null || duration < 0 || !Number.isFinite(wh)) {
      // Field names only: the values are private.
      throw new Error(`Tesla charge history: unexpected row with fields [${Object.keys(row ?? {}).join(", ")}]`);
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
  cfg: Config,
  store: Store,
  fromMs: number,
  toMs: number,
  fetchFn: Fetch = fetch,
  now: number = Date.now(),
): Promise<Session[]> {
  const site = cfg.TESLA_ENERGY_SITE_ID;
  if (!site || !/^\d+$/.test(site)) throw new Error("TESLA_ENERGY_SITE_ID must be a number");
  const base = apiBase(cfg);
  const token = await accessToken(cfg, store, fetchFn, now);

  const url = new URL(`/api/1/energy_sites/${site}/telemetry_history`, base);
  url.searchParams.set("kind", "charge");
  url.searchParams.set("start_date", new Date(fromMs).toISOString());
  url.searchParams.set("end_date", new Date(toMs).toISOString());
  url.searchParams.set("time_zone", cfg.TIME_ZONE);

  const res = await fetchFn(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Tesla charge history failed: HTTP ${res.status}`);
  return parseChargeHistory(await res.json());
}
