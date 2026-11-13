// The demo page: shows the chain and the exact message the operator would receive.
// Served in demo mode only.

import { DEMO_API_KEY, MOCK_PATH } from "./meronrg";
import type { Env, State } from "./types";

const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const kwh = (wh: number) => (wh / 1000).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function when(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function duration(startIso: string, endIso: string): string {
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export function statusPage(state: State, env: Env, origin: string): string {
  const latest = state.deliveries[0];
  const sample = latest?.reading ?? {
    reading_id: `${env.CHARGER_ID}-000001`,
    charger_id: env.CHARGER_ID,
    session: { started_at: "2026-11-12T17:42:00.000Z", ended_at: "2026-11-12T20:10:00.000Z", energy_wh: 21840 },
    meter_total_wh: 21840,
    source: "demo",
  };
  const body = JSON.stringify(sample, null, 2);

  const rows = state.deliveries
    .map(
      (d) => `<tr>
        <td>${esc(when(d.reading.session.started_at, env.TIME_ZONE))}</td>
        <td>${esc(duration(d.reading.session.started_at, d.reading.session.ended_at))}</td>
        <td class="n">${esc(kwh(d.reading.session.energy_wh))}</td>
        <td class="n">${esc(kwh(d.reading.meter_total_wh))}</td>
        <td><span class="ok">${esc(d.http_status)}</span> <code>${esc(d.reading.reading_id)}</code></td>
      </tr>`,
    )
    .join("");

  const curl = `curl -X POST ${origin}${MOCK_PATH} \\
  -H "Authorization: Bearer ${DEMO_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(sample)}'`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Wall Connector meter bridge</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1c1d1f; --mute:#62666d; --line:#e2e3e0; --accent:#0b6e4f; --code:#f1f2ef; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151617; --card:#1e2022; --ink:#ecedee; --mute:#9aa0a6; --line:#303336; --accent:#5fd0a5; --code:#26292b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 1.7rem; line-height: 1.2; margin: 10px 0 8px; text-wrap: balance; }
  h2 { font-size: 1.05rem; margin: 40px 0 10px; }
  p { margin: 0 0 12px; max-width: 66ch; }
  .lede { color: var(--mute); font-size: 1.05rem; }
  .badge { display:inline-block; font-size:.75rem; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); border:1px solid var(--accent); border-radius:999px; padding:2px 10px; }
  .flow { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin: 20px 0 6px; padding:0; list-style:none; counter-reset: step; }
  .flow li { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; counter-increment: step; }
  .flow li::before { content: counter(step); display:block; color:var(--accent); font-weight:600; font-size:.85rem; }
  .flow b { display:block; }
  .flow span { color:var(--mute); font-size:.88rem; }
  @media (max-width: 640px) { .flow { grid-template-columns: 1fr 1fr; } }
  pre { background:var(--code); border:1px solid var(--line); border-radius:10px; padding:14px 16px; overflow-x:auto; font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; margin:0 0 12px; }
  code { font:13.5px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .scroll { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  table { border-collapse:collapse; width:100%; font-size:.93rem; }
  th, td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
  tr:last-child td { border-bottom:0; }
  th { color:var(--mute); font-weight:500; font-size:.82rem; }
  .n { text-align:right; font-variant-numeric: tabular-nums; }
  .ok { color:var(--accent); font-weight:600; }
  footer { margin-top:48px; color:var(--mute); font-size:.85rem; }
</style>
</head>
<body>
<main>
  <span class="badge">Demo &middot; simulated charger</span>
  <h1>A private charger that reports every session to MeronRG</h1>
  <p class="lede">After each charging session, one small message goes to the operator's API: when it started, when it ended, how many kWh, and the running meter total. Nothing is installed on the building's network.</p>

  <ol class="flow">
    <li><b>Charger</b><span>Tesla Wall Connector Gen 3 measures the session</span></li>
    <li><b>Tesla cloud</b><span>The charger reports there by itself</span></li>
    <li><b>Bridge</b><span>Checks once an hour for finished sessions</span></li>
    <li><b>MeronRG API</b><span>Receives one HTTPS POST per session</span></li>
  </ol>

  <h2>The message MeronRG receives</h2>
  <pre>POST /v1/readings
Authorization: Bearer &lt;key issued by MeronRG&gt;
Idempotency-Key: ${esc(sample.reading_id)}
Content-Type: application/json

${esc(body)}</pre>
  <p>Answer with any <code>2xx</code> and the session is done. Anything else, and the same message with the same <code>reading_id</code> is sent again the next hour until it is accepted, so nothing is lost and nothing is counted twice.</p>

  <h2>Recent sessions delivered</h2>
  ${
    rows
      ? `<div class="scroll"><table>
    <thead><tr><th>Started</th><th>Duration</th><th class="n">Session kWh</th><th class="n">Meter total kWh</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
      : `<p>No sessions yet. The first hourly run fills this in.</p>`
  }

  <h2>Try the receiving side</h2>
  <p>This demo includes a stand-in for the MeronRG endpoint. It checks the key and the fields and answers the way the proposal describes.</p>
  <pre>${esc(curl)}</pre>

  <footer>Simulated data for a technical proposal. This page is not operated by or affiliated with MeronRG or Tesla.${
    state.last_error ? ` Last error: ${esc(state.last_error)}.` : ""
  }</footer>
</main>
</body>
</html>`;
}
