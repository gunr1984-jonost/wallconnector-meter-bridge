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
  .diagram, .fan { display:flex; align-items:stretch; gap:6px; margin:18px 0 8px; }
  .fan { margin-bottom:22px; }
  .zone { flex:1 1 0; display:flex; align-items:stretch; gap:6px; border:1.5px dashed var(--line); border-radius:12px; padding:26px 8px 8px; position:relative; min-width:0; }
  .zone.wide { flex:2.5 1 0; }
  .zt { position:absolute; top:6px; left:10px; font-size:.7rem; letter-spacing:.06em; text-transform:uppercase; color:var(--mute); white-space:nowrap; }
  .node { flex:1 1 0; min-width:0; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .node.hi { border-color:var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .node b { display:block; font-size:.95rem; }
  .node span { display:block; color:var(--mute); font-size:.82rem; line-height:1.35; }
  .arrow { flex:0 0 74px; position:relative; align-self:center; text-align:center; font-size:.72rem; line-height:1.25; color:var(--mute); padding:0 2px 14px; }
  .arrow::before { content:""; position:absolute; left:2px; right:7px; bottom:5px; border-top:2px solid var(--accent); }
  .arrow::after { content:""; position:absolute; right:1px; bottom:1px; border:5px solid transparent; border-left:7px solid var(--accent); border-right:0; }
  .clients { flex:1.3 1 0; display:flex; flex-direction:column; gap:6px; padding-right:12px; border-right:2px solid var(--accent); border-radius:0 10px 10px 0; min-width:0; }
  .fan .node { display:flex; flex-direction:column; justify-content:center; }
  .fan .clients .node { flex:0 0 auto; }
  .note { color:var(--mute); font-size:.9rem; }
  .ways { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:14px 0 12px; }
  .ways .node span { font-size:.9rem; }
  .ways .tag { display:inline-block; margin-top:6px; font-size:.72rem; letter-spacing:.05em; text-transform:uppercase; color:var(--accent); }
  ol.steps { margin:0 0 12px; padding-left:1.3em; max-width:66ch; }
  ol.steps li { margin-bottom:4px; }
  @media (max-width: 720px) {
    .diagram, .fan, .zone { flex-direction:column; }
    .zone { padding:28px 8px 8px; }
    .arrow { flex:0 0 auto; align-self:stretch; min-height:40px; display:flex; align-items:center; text-align:left; padding:0 0 0 30px; }
    .arrow::before { left:12px; right:auto; top:3px; bottom:8px; border-top:0; border-left:2px solid var(--accent); }
    .arrow::after { left:8px; right:auto; bottom:2px; border:5px solid transparent; border-top:7px solid var(--accent); border-bottom:0; }
    .clients { padding:0 0 12px; border-right:0; border-bottom:2px solid var(--accent); border-radius:0 0 10px 10px; }
    .ways { grid-template-columns:1fr; }
  }
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
  <p class="lede">After each charging session, one small message goes to the operator's API: when it started, when it ended, how many kWh, and the running meter total.</p>

  <h2>How it works</h2>
  <div class="diagram" role="img" aria-label="The charger reports to Tesla's cloud. The bridge reads the finished sessions every hour and posts each one to the MeronRG API.">
    <div class="zone"><span class="zt">Garage</span>
      <div class="node"><b>Charger</b><span>Tesla Wall Connector Gen 3 measures each session</span></div>
    </div>
    <div class="arrow"><span>reports by itself</span></div>
    <div class="zone wide"><span class="zt">Internet</span>
      <div class="node"><b>Tesla cloud</b><span>Keeps the charging history</span></div>
      <div class="arrow"><span>read every hour</span></div>
      <div class="node hi"><b>Bridge</b><span>Finds finished sessions, sends each one once</span></div>
    </div>
    <div class="arrow"><span>HTTPS POST per session</span></div>
    <div class="zone"><span class="zt">MeronRG</span>
      <div class="node"><b>MeronRG API</b><span>Receives the session, bills as usual</span></div>
    </div>
  </div>
  <p class="note">Nothing is installed on the building's network and nothing connects in to it. The charger only needs ordinary internet access, and MeronRG only needs one address that accepts the message below.</p>

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

  <h2>Reusing it for other residents</h2>
  <p>MeronRG builds the receiving address once. Every resident who wants to use their own charger then sends the same message to the same address, with their own key.</p>
  <div class="fan" role="img" aria-label="Several residents, each with their own key, post the same message to one MeronRG address, which feeds billing.">
    <div class="clients">
      <div class="node"><b>Resident A</b><span>Tesla Wall Connector &middot; key A</span></div>
      <div class="node"><b>Resident B</b><span>Tesla Wall Connector &middot; key B</span></div>
      <div class="node"><b>Resident C</b><span>Another charger brand &middot; key C</span></div>
    </div>
    <div class="arrow"><span>same message, same address</span></div>
    <div class="node hi"><b>MeronRG API</b><span>Built once. The key and <code>charger_id</code> say whose session it is.</span></div>
    <div class="arrow"><span>per customer</span></div>
    <div class="node"><b>Billing</b><span>As for any other charge point</span></div>
  </div>

  <p><b>Adding a resident</b></p>
  <ol class="steps">
    <li>MeronRG issues a key and a <code>charger_id</code> for the resident.</li>
    <li>A bridge is pointed at that resident's charger with that key.</li>
    <li>Sessions start arriving. Withdrawing the key stops them.</li>
  </ol>

  <p><b>Two ways to run the bridge</b></p>
  <div class="ways">
    <div class="node"><b>Each resident runs their own</b><span>What this demo does. The code is public: copy it, add the key from MeronRG, deploy it on a free cloud account. Suits a technically minded resident, who also registers with Tesla as a developer.</span><span class="tag">Built &middot; awaiting a real charger</span></div>
    <div class="node"><b>MeronRG runs one for everyone</b><span>One bridge and one registration with Tesla. Each resident approves access once with their Tesla login, and MeronRG's bridge reads all the chargers. The same code with a list of chargers in place of one.</span><span class="tag">Not built yet</span></div>
  </div>
  <p class="note">A different charger brand changes only the part that reads the charger. The message MeronRG receives stays the same.</p>

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
