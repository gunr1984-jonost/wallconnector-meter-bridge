// The operator-facing side: everything MeronRG might want changed lives in this file.
//
// The bridge is ours to change, so it fits MeronRG's API, not the other way round. Today it
// sends the default message in docs/openapi.yaml. When the real API is known, adjust the URL,
// the authentication, the field names and what counts as "accepted" here; nothing else moves.

import type { Config, Reading } from "./types";

/** Used when no real endpoint is configured: the request goes to the built-in stand-in. */
export const MOCK_PATH = "/mock/meronrg/v1/readings";
/** Not a secret: the stand-in receiver's key, so the demo shows a normal bearer header. */
export const DEMO_API_KEY = "demo-key";
const TIMEOUT_MS = 15_000;

/** Stable for a given charger and session start: `WC3-0001-20261112T170000Z`. */
export function readingId(chargerId: string, startedAt: string): string {
  const compact = new Date(startedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${chargerId}-${compact}`;
}

export function buildDeliveryRequest(reading: Reading, cfg: Config): Request {
  const url = new URL(cfg.MERONRG_API_URL ?? `https://bridge.invalid${MOCK_PATH}`);
  // The key must never travel unencrypted.
  if (url.protocol !== "https:") throw new Error("MERONRG_API_URL must start with https://");
  const key = cfg.MERONRG_API_URL ? cfg.MERONRG_API_KEY : DEMO_API_KEY;
  if (!key) throw new Error("MERONRG_API_KEY is not set");

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      // Lets the receiver drop a repeat if we retry after a timeout.
      "idempotency-key": reading.reading_id,
    },
    body: JSON.stringify(reading),
    // Never follow a redirect: it could carry the key to another host.
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Did the operator take the reading? A repeat they already hold must also answer 2xx. */
export function accepted(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}
