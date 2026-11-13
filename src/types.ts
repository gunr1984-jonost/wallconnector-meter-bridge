export interface Env {
  STATE: KVNamespace;

  /** "demo" = simulated charger + built-in stand-in receiver. "live" = Tesla + the operator's API. */
  MODE: string;
  /** The identifier the operator knows this charger (or customer) by. */
  CHARGER_ID: string;
  TIME_ZONE: string;

  // Operator side (live mode)
  MERONRG_API_URL?: string;
  MERONRG_API_KEY?: string; // secret

  // Tesla side (live mode)
  TESLA_API_BASE?: string;
  TESLA_CLIENT_ID?: string;
  TESLA_ENERGY_SITE_ID?: string;
  TESLA_REFRESH_TOKEN?: string; // secret, used once to seed the stored token

  /** Live mode only: bearer token that unlocks /api/status. */
  STATUS_TOKEN?: string; // secret
}

/** One completed charging session, as measured by the charger. */
export interface Session {
  started_at: string; // ISO 8601, UTC
  ended_at: string; // ISO 8601, UTC
  energy_wh: number;
}

/** What the operator receives: one completed session plus the running meter total. */
export interface Reading {
  reading_id: string; // unique and stable: a retry repeats the same id
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
  seq: number;
  meter_total_wh: number;
  /** started_at of the last session the operator accepted. */
  cursor: string | null;
  deliveries: Delivery[]; // newest first, capped
  updated_at: string | null;
  last_error: string | null;
}

/** Where sessions come from. Demo and Tesla both implement this. */
export type SessionSource = (fromMs: number, toMs: number) => Promise<Session[]>;
