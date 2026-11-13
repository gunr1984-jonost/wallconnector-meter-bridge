# Going live

The demo Worker stays as it is. Live is a second Worker with its own storage and secrets.
Two things have to exist first: the installed charger, and MeronRG's API details.

## 1. Charger

1. Install and commission the Wall Connector; join it to Wi-Fi; add it to the Tesla account
   in the Tesla app.
2. Check it shows up for the account: `GET /api/1/products` on the Fleet API should list an
   energy site. Its `energy_site_id` is `TESLA_ENERGY_SITE_ID`.
   **To confirm:** that a Wall Connector with no solar or Powerwall is listed as an energy
   site. Tesla's documentation does not say either way.

## 2. Tesla authorisation

What Tesla requires, with sources, is in [`TESLA.md`](TESLA.md). In short: a developer
application (client id and secret), its public key hosted on a domain, and one register
call per region. Then, once:

1. In the developer application, add a redirect address you control (any page that lets
   you read the `code` from the address bar).
2. Open the approval page in a browser and sign in as the charger's owner:
   `https://auth.tesla.com/oauth2/v3/authorize?response_type=code&client_id=<client id>&redirect_uri=<redirect address>&scope=openid%20offline_access%20energy_device_data&state=<any random text>`
   Ask for **only** these scopes: the bridge must not hold anything that can control a
   charger or a car.
3. Exchange the `code` from the redirect for tokens (it expires within minutes):
   `POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` with
   `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri` and
   `audience=https://fleet-api.prd.eu.vn.cloud.tesla.com`.
4. Keep the **refresh token** from the answer; it is the `TESLA_REFRESH_TOKEN` seed. The
   client secret is used only in step 3 and is never given to the bridge.
5. Confirm the region: `GET /api/1/users/region` with the access token returns the base
   address to use as `TESLA_API_BASE` (Europe, Middle East and Africa is the default).
6. The Worker stores each rotated refresh token itself after that. If the developer
   application is shared with another integration, check that integration still works.

## 3. MeronRG

Put the real address in `MERONRG_API_URL` (https only), and change
[`src/meronrg.ts`](../src/meronrg.ts) to match their API: field names, authentication, and
what counts as accepted. Update the tests to the new shape. If their API answers a repeat
with something other than `2xx` (for example `409`), make `accepted()` treat it as success.

## 4. Deploy the live Worker

Add to `wrangler.jsonc`:

```jsonc
"env": {
  "live": {
    "name": "wc-meter-bridge-live",
    "preview_urls": false,
    "triggers": { "crons": ["7 * * * *"] },
    "vars": {
      "MODE": "live",
      "CHARGER_ID": "<identifier from MeronRG>",
      "TIME_ZONE": "Asia/Jerusalem",
      "REPORT_FROM": "<agreed start, e.g. 2026-12-01T00:00:00+02:00>",
      "MERONRG_API_URL": "https://<from MeronRG>",
      "TESLA_CLIENT_ID": "<developer app client id>",
      "TESLA_ENERGY_SITE_ID": "<from step 1>"
    },
    "durable_objects": { "bindings": [{ "name": "BRIDGE", "class_name": "BridgeState" }] }
  }
}
```

```bash
npx wrangler deploy --env live
npx wrangler secret put MERONRG_API_KEY --env live
npx wrangler secret put TESLA_REFRESH_TOKEN --env live
npx wrangler secret put STATUS_TOKEN --env live        # any long random string
npx wrangler secret put ALERT_WEBHOOK_URL --env live   # optional: where failure notices go
```

Run `wrangler` from the project folder, never from the home folder.

`CHARGER_ID` is part of every reading id. Set it once and never change it: a different
value would make MeronRG see old sessions as new ones.

`MODE` must be exactly `live`. A missing address or a misspelt mode stops the bridge with a
clear error; it never falls back to the demo.

`REPORT_FROM` is the moment billing through the bridge starts. Sessions that began before
it are never reported. Without it, the first run reports the previous 7 days.

In live mode the Worker shows no charging data publicly (charging times reveal when someone
is home). `GET /api/status` and `POST /run` need `Authorization: Bearer <STATUS_TOKEN>`.
Point an uptime monitor at `/health`.

## 5. First-run checks

These are the assumptions that could not be tested without a charger:

- [ ] `charge_history` rows carry `charge_start_time`, `charge_duration` and `energy_added_wh`
      as [`src/tesla.ts`](../src/tesla.ts) expects. If not, the run fails and `last_error`
      lists the field names Tesla sent: adjust `parseChargeHistory`.
- [ ] A session still in progress is not listed, or is listed with its final figures only.
      If Tesla lists a growing partial session, hold sessions back until the charger is idle
      (`charger_live_status`).
- [ ] One session's kWh matches the Tesla app.
- [ ] `meter_total_wh` tracks the charger's own lifetime counter (`energy_wh` at
      `http://<charger address>/api/1/lifetime`, readable from the same network).
- [ ] Tesla API usage stays inside the account's monthly allowance (one call an hour, about
      720 a month, at most about $1.50 if billed as data requests; the $10 monthly discount
      is shared with everything else on the same developer account).
- [ ] `/health` answers `ok`, and a test alert arrives: `POST /test-alert` with the status
      token answers `{"sent":true}` and the notice shows up at the alert address.

## 6. Before relying on it for billing

- Consider Cloudflare's paid Workers plan: the free plan's daily request allowance is shared
  by every Worker on the account (see "Known limits" in [`SECURITY.md`](SECURITY.md)).
- Agree with MeronRG how a disputed figure is settled (the charger's lifetime counter, or a
  certified sub-meter).

Security properties, the runbook and what each error means are in [`SECURITY.md`](SECURITY.md).
