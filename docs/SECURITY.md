# Security and operations

## What the bridge holds, and what it can do

| Item | Where it lives | What it allows |
|---|---|---|
| MeronRG API key | Cloudflare secret (encrypted, cannot be read back) | Posting readings for this one charger |
| Tesla authorisation | The bridge's private storage | **Reading** the charger's history. It is requested with the `energy_device_data` scope only: no control of the charger or of any car |
| Status token | Cloudflare secret | Reading the bridge's status, starting a run |
| Alert address (optional) | Cloudflare secret | Receiving failure notices |

No secret is in this repository. GitHub secret scanning and push protection are on.

## How the design protects the data

- **Outbound only.** The bridge calls Tesla and MeronRG. Nothing connects in to the
  building's network, the charger or MeronRG's systems.
- **Keys stay on HTTPS.** The MeronRG address must be `https://`. Tesla tokens are sent only
  to Tesla's own hosts. No outbound call follows a redirect, so a key cannot be carried to
  another host. Plain `http://` requests to the bridge are refused or redirected.
- **Exact totals.** State lives in one Durable Object: strongly consistent storage and one
  run at a time. A second trigger joins the run in progress. Each accepted reading is saved
  before the next is sent.
- **No double counting, no gaps.** A reading's id is built from the charger id and the
  session start, so it is identical on every retry. A reading that was sent but not
  confirmed is resent unchanged before anything else, so one id never carries two totals.
  Each run looks a week behind its own high-water mark, so a session Tesla lists up to a
  week late is still delivered, once. The start of reporting is fixed at the first attempt,
  so after an outage of any length, including one right at the start, the bridge resumes
  where it stopped.
- **A reset is visible, not silent.** If the bridge's storage were ever wiped, ids stay the
  same (MeronRG ignores the repeats) but the running total starts again from zero. Agree
  the new base with MeronRG if that ever happens. A deliberate reset is a recorded
  configuration change (`STATE_NAME`), never something a request can trigger.
- **Half-configured means stopped.** The mode must be exactly `demo` or `live`. Live without
  an operator address, or a misspelt mode, is an error and is treated as private; real
  sessions can never go to the stand-in, and simulated ones can never go to MeronRG.
- **Bad data is not billed.** A session with an end before its start, a negative amount, or
  more energy than the charger can physically deliver stops the run and raises an alert.
- **Nothing private is public.** In live operation the page shows no data; status needs the
  token. `/health` says only `ok` or `unhealthy`.
- **Small attack surface.** No scripts or outside resources on the page (enforced by a
  content security policy), no runtime dependencies, request bodies capped, tokens compared
  in constant time. Build tools are checked by `npm audit` on every change.

## Trust model

- In the self-hosted setup the resident runs the bridge, so MeronRG receives what the
  resident's bridge reports. The figures come from the charger through Tesla, but MeronRG
  cannot verify them independently.
- Checks MeronRG can make: the charger's own lifetime energy counter, readable on site,
  must match the running `meter_total_wh`; a certified sub-meter on the charger's supply
  settles any doubt.
- If MeronRG runs the bridge itself (see "Reusing it for other residents" in the README),
  the data goes from Tesla to MeronRG without passing through anything the resident
  controls.
- The Wall Connector's meter is not a certified billing meter.

## Operating it

| Check | How |
|---|---|
| Is it working? | `GET /health` answers `200 ok` when a run has succeeded in the last 3 hours, `503` otherwise. Point any uptime monitor at it. |
| What is it doing? | `GET /api/status` with `Authorization: Bearer <STATUS_TOKEN>`: last attempt, last success, last error, recent deliveries. |
| Tell me when it breaks | Set `ALERT_WEBHOOK_URL`. It receives a JSON notice on the first failed run, once a day while it keeps failing, and on recovery. |
| Run it now | `POST /run` with the status token. |
| Prove alerts arrive | `POST /test-alert` with the status token sends a test notice. |

### When something fails

| `last_error` says | Meaning | Action |
|---|---|---|
| `operator answered HTTP 401/403` | Key rejected | Get a new key from MeronRG; `wrangler secret put MERONRG_API_KEY`. Nothing is lost: delivery resumes from the same session. |
| `operator answered HTTP 4xx` (other) | MeronRG refuses this reading | Compare the message with their API; fix `src/meronrg.ts`. Later sessions wait behind it, in order. If the two sides agree that one session is to be left out, list its start time in `SKIP_SESSIONS`. |
| `operator answered HTTP 5xx`, or `operator did not answer` | MeronRG is down or unreachable | Nothing. It retries every hour, with the identical message. |
| `Tesla token refresh failed` (Tesla answers `401 login_required`) | Authorisation expired, was replaced, or the owner reset their Tesla password | Authorise again (GO-LIVE step 2) and set the new `TESLA_REFRESH_TOKEN`. A newly set token replaces the stored one. |
| `Tesla charge history failed: HTTP 429/5xx` | Tesla is busy or down | Nothing. It retries every hour. |
| `charger data: ...` | Tesla returned figures that cannot be right; the message names the session | Look at the session in the Tesla app before anything is billed. Delivery waits. To leave that session out and continue, add its start time to `SKIP_SESSIONS` (comma-separated) and deploy. |
| `MODE must be ...`, `... is not set` | A setting is missing or misspelt | Fix the setting. Nothing was sent. |

### Routine

- Rotate the MeronRG key and the status token yearly, or at once if either may have leaked.
- Keep two-step sign-in on the Cloudflare, GitHub and Tesla accounts: whoever controls those
  controls the bridge.
- Dependency updates arrive as pull requests (Dependabot); tests run on each.

## Known limits

- The Tesla side has not yet run against a real charger (see `docs/GO-LIVE.md`).
- Cloudflare's free plan has a daily request allowance shared by every Worker on the
  account. A flood of requests against any public Worker could pause the bridge until the
  next day; sessions are then delivered late, not lost. The paid plan removes this.
- Readings are reported within about an hour, not instantly.

## Reporting a problem

Use this repository's "Report a vulnerability" button (Security tab), or open an issue for
anything that is not sensitive.
