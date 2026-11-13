// The operator-facing side: everything MeronRG might want changed lives in this file.
//
// Today it sends the proposal in docs/openapi.yaml. When the real API arrives, adjust the
// URL, the auth header and the field names here; nothing else in the project needs to move.

import type { Env, Reading } from "./types";

/** Used when no real endpoint is configured: the request goes to the built-in stand-in. */
export const MOCK_PATH = "/mock/meronrg/v1/readings";
/** Not a secret: the stand-in receiver's key, so the demo shows a normal bearer header. */
export const DEMO_API_KEY = "demo-key";

export function buildDeliveryRequest(reading: Reading, env: Env): Request {
  const url = env.MERONRG_API_URL ?? `https://bridge.invalid${MOCK_PATH}`;
  const key = env.MERONRG_API_URL ? env.MERONRG_API_KEY : DEMO_API_KEY;
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
  });
}
