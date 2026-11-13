// A stand-in for the operator's API, used until the real one exists.
// It behaves the way docs/openapi.yaml proposes: bearer key, validation, repeats ignored.

import { DEMO_API_KEY } from "./meronrg";
import type { Env } from "./types";

const SEEN_KEY = "mock_seen";
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function problem(body: unknown): string | null {
  const r = body as Record<string, unknown> | null;
  const s = r?.session as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return "body must be a JSON object";
  if (typeof r.reading_id !== "string" || !r.reading_id) return "reading_id is required";
  if (typeof r.charger_id !== "string" || !r.charger_id) return "charger_id is required";
  if (!s || typeof s !== "object") return "session is required";
  if (Number.isNaN(Date.parse(String(s.started_at)))) return "session.started_at must be an ISO 8601 time";
  if (Number.isNaN(Date.parse(String(s.ended_at)))) return "session.ended_at must be an ISO 8601 time";
  if (typeof s.energy_wh !== "number" || s.energy_wh < 0) return "session.energy_wh must be a number >= 0";
  if (typeof r.meter_total_wh !== "number" || r.meter_total_wh < 0) return "meter_total_wh must be a number >= 0";
  return null;
}

/**
 * `remember` is true only for the bridge's own deliveries. Requests arriving over the
 * public URL are validated and answered but never stored, so the open demo cannot be
 * used to fill storage.
 */
export async function mockReceiver(request: Request, env: Env, remember: boolean): Promise<Response> {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (request.headers.get("authorization") !== `Bearer ${DEMO_API_KEY}`) {
    return json({ error: "missing or wrong API key" }, 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body is not valid JSON" }, 400);
  }
  const error = problem(body);
  if (error) return json({ error }, 422);

  const id = (body as { reading_id: string }).reading_id;
  if (!remember) return json({ status: "accepted", reading_id: id, note: "dry run: not stored" }, 201);

  const seen = (await env.STATE.get<string[]>(SEEN_KEY, "json")) ?? [];
  if (seen.includes(id)) return json({ status: "duplicate", reading_id: id }, 200);
  await env.STATE.put(SEEN_KEY, JSON.stringify([id, ...seen].slice(0, 100)));
  return json({ status: "accepted", reading_id: id }, 201);
}
