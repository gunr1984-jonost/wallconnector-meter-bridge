// The demo page: shows the chain and the exact message the operator would receive.
// Served in demo mode only. Plain black and white, monospace, ASCII diagrams: no scripts,
// no outside resources.

import { DEMO_API_KEY, MOCK_PATH, readingId } from "./meronrg";
import type { Config, State } from "./types";

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

// ---- ASCII diagrams. Each has a wide form and a narrow form for phones. ----

const FLOW_WIDE = [
  " GARAGE            INTERNET                             MERONRG",
  "+-----------+     +-------------+     +----------+     +-------------+",
  "|  Charger  |--1->| Tesla cloud |--2->|  Bridge  |--3->| MeronRG API |",
  "+-----------+     +-------------+     +----------+     +-------------+",
].join("\n");

function stack(steps: { zone?: string; label: string }[], width = 28): string {
  const rule = `+${"-".repeat(width)}+`;
  const mid = " ".repeat(Math.floor(width / 2));
  const out: string[] = [];
  steps.forEach((s, i) => {
    if (s.zone) out.push(` ${s.zone}`);
    out.push(rule, `| ${s.label.padEnd(width - 1)}|`, rule);
    if (i < steps.length - 1) out.push(`${mid}| ${i + 1}`, `${mid}v`);
  });
  return out.join("\n");
}

const FLOW_NARROW = stack([
  { zone: "GARAGE", label: "Charger" },
  { zone: "INTERNET", label: "Tesla cloud" },
  { label: "Bridge" },
  { zone: "MERONRG", label: "MeronRG API" },
]);

const FAN_WIDE = [
  "Resident A  (Tesla, key A) ---+",
  "                              |     +-------------+     +---------+",
  "Resident B  (Tesla, key B) ---+---->| MeronRG API |---->| Billing |",
  "                              |     +-------------+     +---------+",
  "Resident C  (other, key C) ---+       built once",
].join("\n");

const FAN_NARROW = [
  "Resident A (Tesla, key A) --+",
  "Resident B (Tesla, key B) --+",
  "Resident C (other, key C) --+",
  "                            |",
  "                            v",
  "                     +-------------+",
  "                     | MeronRG API |",
  "                     +-------------+",
  "                       built once",
  "                            |",
  "                            v",
  "                     +-------------+",
  "                     |   Billing   |",
  "                     +-------------+",
].join("\n");

const diagram = (wide: string, narrow: string, label: string) =>
  `<pre class="art wide" role="img" aria-label="${esc(label)}">${esc(wide)}</pre>
  <pre class="art narrow" role="img" aria-label="${esc(label)}">${esc(narrow)}</pre>`;

export function statusPage(state: State, env: Config, origin: string): string {
  const latest = state.deliveries[0];
  const sample = latest?.reading ?? {
    reading_id: readingId(env.CHARGER_ID, "2026-11-12T17:42:00.000Z"),
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
        <td>${esc(d.http_status)}</td>
        <td>${esc(d.reading.reading_id)}</td>
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
  :root { --bg:#fff; --ink:#000; }
  @media (prefers-color-scheme: dark) { :root { --bg:#000; --ink:#fff; } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font: 14px/1.6 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace; }
  main { max-width: 80ch; margin: 0 auto; padding: 32px 16px 64px; }
  header { border-bottom: 3px double var(--ink); padding-bottom: 12px; margin-bottom: 20px; }
  .top { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; text-transform:uppercase; letter-spacing:.04em; }
  h1 { font-size: 1.25rem; line-height: 1.35; margin: 14px 0 8px; font-weight: 700; }
  h2 { font-size: 1rem; margin: 40px 0 12px; padding-bottom: 4px; border-bottom: 1px solid var(--ink); text-transform: uppercase; letter-spacing:.04em; }
  h3 { font-size: 1rem; margin: 20px 0 6px; font-weight: 700; }
  p { margin: 0 0 12px; }
  a { color: inherit; }
  code, pre { font: inherit; }
  pre { margin: 0 0 14px; overflow-x: auto; }
  pre.box { border: 1px solid var(--ink); padding: 12px 14px; }
  pre.art { line-height: 1.25; padding: 6px 0; }
  .narrow { display: none; }
  @media (max-width: 680px) { .wide { display: none; } .narrow { display: block; } }
  ol, ul { margin: 0 0 14px; padding-left: 3ch; }
  li { margin-bottom: 4px; }
  .note { border: 1px solid var(--ink); padding: 10px 14px; margin: 0 0 14px; }
  .note b { text-transform: uppercase; letter-spacing:.04em; }
  dl { margin: 0 0 14px; }
  dt { font-weight: 700; margin-top: 10px; }
  dd { margin: 0 0 0 3ch; }
  .scroll { overflow-x: auto; margin: 0 0 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 14px 5px 0; white-space: nowrap; font-weight: 400; }
  thead th { border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); font-weight: 700; }
  tbody tr:last-child td { border-bottom: 1px solid var(--ink); }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 48px; border-top: 3px double var(--ink); padding-top: 12px; }
</style>
</head>
<body>
<main>
  <header>
    <div class="top"><span>Wall Connector meter bridge</span><span>[ demo / simulated charger ]</span></div>
    <h1>A private charger that reports every session to MeronRG</h1>
    <p>After each charging session, one small message goes to the operator's API: when it started, when it ended, how many kWh, and the running meter total.</p>
  </header>

  <h2>1. How it works</h2>
  ${diagram(FLOW_WIDE, FLOW_NARROW, "The charger reports to Tesla's cloud. The bridge reads the finished sessions every hour and posts each one to the MeronRG API.")}
  <ol>
    <li>The charger (Tesla Wall Connector Gen 3) measures each session and reports it to Tesla by itself.</li>
    <li>The bridge reads the finished sessions from Tesla once an hour.</li>
    <li>The bridge sends MeronRG one HTTPS POST per session. MeronRG bills as usual.</li>
  </ol>
  <p>Nothing is installed on the building's network and nothing connects in to it. The charger only needs ordinary internet access, and MeronRG only needs one address that accepts a message like the one below.</p>

  <h2>2. The message MeronRG receives</h2>
  <pre class="box">POST /v1/readings
Authorization: Bearer &lt;key issued by MeronRG&gt;
Idempotency-Key: ${esc(sample.reading_id)}
Content-Type: application/json

${esc(body)}</pre>
  <p>Answer with any <code>2xx</code> and the session is done. Anything else, and the same message with the same <code>reading_id</code> is sent again the next hour until it is accepted, so nothing is lost and nothing is counted twice.</p>
  <div class="note"><b>Note.</b> This message is a starting point, not a requirement. The bridge is ours to change, so it adapts to the API MeronRG already has: its address, authentication, field names, units and timing. MeronRG does not need to build anything new.</div>

  <h2>3. Recent sessions delivered</h2>
  ${
    rows
      ? `<div class="scroll"><table>
    <thead><tr><th>Started</th><th>Duration</th><th class="n">kWh</th><th class="n">Meter kWh</th><th>HTTP</th><th>Reading id</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
      : `<p>No sessions yet. The first hourly run fills this in.</p>`
  }

  <h2>4. Reusing it for other residents</h2>
  <p>MeronRG builds the receiving address once. Every resident who wants to use their own charger then sends the same message to the same address, with their own key. The key and <code>charger_id</code> say whose session it is.</p>
  ${diagram(FAN_WIDE, FAN_NARROW, "Several residents, each with their own key, post the same message to one MeronRG address, which feeds billing.")}

  <h3>Adding a resident</h3>
  <ol>
    <li>MeronRG issues a key and a <code>charger_id</code> for the resident.</li>
    <li>A bridge is pointed at that resident's charger with that key.</li>
    <li>Sessions start arriving. Withdrawing the key stops them.</li>
  </ol>

  <h3>Two ways to run the bridge</h3>
  <dl>
    <dt>(a) Each resident runs their own &nbsp;[built, awaiting a real charger]</dt>
    <dd>What this demo does. The code is public: copy it, add the key from MeronRG, deploy it on a free cloud account. Suits a technically minded resident, who also registers with Tesla as a developer.</dd>
    <dt>(b) MeronRG runs one for everyone &nbsp;[not built yet]</dt>
    <dd>One bridge and one registration with Tesla. Each resident approves access once with their Tesla login, and MeronRG's bridge reads all the chargers. The same code with a list of chargers in place of one.</dd>
  </dl>
  <p>A different charger brand changes only the part that reads the charger. The message MeronRG receives stays the same.</p>

  <h2>5. Try the receiving side</h2>
  <p>This demo includes a stand-in for the MeronRG endpoint. It checks the key and the fields and answers the way the specification describes.</p>
  <pre class="box">${esc(curl)}</pre>

  <footer>Simulated data for a technical proposal. This page is not operated by or affiliated with MeronRG or Tesla.${
    state.last_error ? ` Last error: ${esc(state.last_error)}.` : ""
  }</footer>
</main>
</body>
</html>`;
}
