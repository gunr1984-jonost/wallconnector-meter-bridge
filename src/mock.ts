// A stand-in for the operator's API, used until the real one exists.
// It behaves the way docs/openapi.yaml describes: bearer key, validation, repeats ignored.

import { DEMO_API_KEY } from "./meronrg";
import type { Store } from "./types";

const SEEN_KEY = "mock_seen";
const MAX_BODY_BYTES = 4096;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

/** Reads at most `limit` bytes; null when the body is larger. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function problem(body: unknown): string | null {
  const r = body as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return "body must be a JSON object";
  const s = r.session as Record<string, unknown> | undefined;
  if (typeof r.reading_id !== "string" || !r.reading_id || r.reading_id.length > 100) return "reading_id is required";
  if (typeof r.charger_id !== "string" || !r.charger_id || r.charger_id.length > 64) return "charger_id is required";
  if (!s || typeof s !== "object") return "session is required";
  const start = Date.parse(String(s.started_at));
  const end = Date.parse(String(s.ended_at));
  if (Number.isNaN(start)) return "session.started_at must be an ISO 8601 time";
  if (Number.isNaN(end)) return "session.ended_at must be an ISO 8601 time";
  if (end < start) return "session.ended_at is before session.started_at";
  if (typeof s.energy_wh !== "number" || !Number.isFinite(s.energy_wh) || s.energy_wh < 0) {
    return "session.energy_wh must be a number >= 0";
  }
  if (typeof r.meter_total_wh !== "number" || !Number.isFinite(r.meter_total_wh) || r.meter_total_wh < 0) {
    return "meter_total_wh must be a number >= 0";
  }
  return null;
}

/**
 * `store` is given only for the bridge's own deliveries. Requests arriving over the public
 * URL pass null: they are validated and answered but never stored, so the open demo cannot
 * be used to fill storage.
 */
export async function mockReceiver(request: Request, store: Store | null): Promise<Response> {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (request.headers.get("authorization") !== `Bearer ${DEMO_API_KEY}`) {
    return json({ error: "missing or wrong API key" }, 401);
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return json({ error: `body larger than ${MAX_BODY_BYTES} bytes` }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "body is not valid JSON" }, 400);
  }
  const error = problem(body);
  if (error) return json({ error }, 422);

  const id = (body as { reading_id: string }).reading_id;
  if (!store) return json({ status: "accepted", reading_id: id, note: "dry run: not stored" }, 201);

  const seen = (await store.get<string[]>(SEEN_KEY)) ?? [];
  if (seen.includes(id)) return json({ status: "duplicate", reading_id: id }, 200);
  await store.put(SEEN_KEY, [id, ...seen].slice(0, 200));
  return json({ status: "accepted", reading_id: id }, 201);
}
