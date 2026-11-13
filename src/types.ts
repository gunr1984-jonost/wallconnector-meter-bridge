/** Plain settings (wrangler vars and secrets). No bindings, so the core runs anywhere. */
export interface Config {
  /** "demo" = simulated charger + built-in stand-in receiver. "live" = Tesla + the operator's API. */
  MODE: string;
  /** The identifier the operator knows this charger (or customer) by. */
  CHARGER_ID: string;
  TIME_ZONE: string;
  /** Optional ISO date-time: sessions that started before it are never reported. */
  REPORT_FROM?: string;
  /** Optional, comma-separated session start times the owner has decided to leave out. */
  SKIP_SESSIONS?: string;

  // Operator side (live mode)
  MERONRG_API_URL?: string;
  MERONRG_API_KEY?: string; // secret

  // Tesla side (live mode)
  TESLA_API_BASE?: string;
  TESLA_CLIENT_ID?: string;
  TESLA_ENERGY_SITE_ID?: string;
  TESLA_REFRESH_TOKEN?: string; // secret, used once to seed the stored token

  /** Bearer token for /api/status (live) and POST /run. */
  STATUS_TOKEN?: string; // secret
  /** Optional https address that is told when deliveries start failing and when they recover. */
  ALERT_WEBHOOK_URL?: string; // secret
}

/** The bridge's own storage: strongly consistent, one writer (a Durable Object). */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** One completed charging session, as measured by the charger. */
export interface Session {
  started_at: string; // ISO 8601, UTC
  ended_at: string; // ISO 8601, UTC
  energy_wh: number;
}

/** What the operator receives: one completed session plus the running meter total. */
export interface Reading {
  /** Derived from the charger and the session start, so it is the same on every retry, forever. */
  reading_id: string;
  charger_id: string;
  session: Session;
  /** Sum of every session delivered so far, this one included. */
  meter_total_wh: number;
  source: "tesla-fleet-api" | "demo";
}

export interface Delivery {
  reading: Reading;
  sent_at: string;
  http_status: number;
}

export interface State {
  delivered_count: number;
  meter_total_wh: number;
  /** Where reporting starts. Fixed at the first attempt and never moved. */
  origin: string | null;
  /** The end of the last window that was delivered in full. The next run starts a week before it. */
  watermark: string | null;
  /** Start and end of sessions delivered inside the look-back window, to never send one twice. */
  recent: { s: string; e: string }[];
  /** A reading that has been sent but not yet confirmed. It is resent unchanged. */
  pending: Reading | null;
  deliveries: Delivery[]; // newest first, capped
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

/** Where sessions come from. Demo and Tesla both implement this. */
export type SessionSource = (fromMs: number, toMs: number) => Promise<Session[]>;
