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

1. The Tesla developer app needs the `energy_device_data` and `offline_access` scopes.
2. Authorise once in a browser (authorization-code flow) and keep the **refresh token**.
3. The Worker stores each rotated refresh token itself after that; the secret is only the seed.

## 3. MeronRG

Put the real address in `MERONRG_API_URL`, and change [`src/meronrg.ts`](../src/meronrg.ts)
to match their field names and authentication. Update the tests to the new shape.

## 4. Deploy the live Worker

Add to `wrangler.jsonc` (create the storage first: `npx wrangler kv namespace create wc-meter-bridge-live`):

```jsonc
"env": {
  "live": {
    "name": "wc-meter-bridge-live",
    "triggers": { "crons": ["7 * * * *"] },
    "vars": {
      "MODE": "live",
      "CHARGER_ID": "<identifier from MeronRG>",
      "TIME_ZONE": "Asia/Jerusalem",
      "MERONRG_API_URL": "https://<from MeronRG>",
      "TESLA_CLIENT_ID": "<developer app client id>",
      "TESLA_ENERGY_SITE_ID": "<from step 1>"
    },
    "kv_namespaces": [{ "binding": "STATE", "id": "<new namespace id>" }]
  }
}
```

```bash
npx wrangler deploy --env live
npx wrangler secret put MERONRG_API_KEY --env live
npx wrangler secret put TESLA_REFRESH_TOKEN --env live
npx wrangler secret put STATUS_TOKEN --env live     # any long random string
```

In live mode the Worker shows no charging data publicly (charging times reveal when someone
is home). `GET /api/status` and `POST /run` need `Authorization: Bearer <STATUS_TOKEN>`.

## 5. First-run checks

These are the assumptions that could not be tested without a charger:

- [ ] `charge_history` rows carry `charge_start_time`, `charge_duration` and `energy_added_wh`
      as [`src/tesla.ts`](../src/tesla.ts) expects. If not, the run fails with the row printed in
      `last_error`: adjust `parseChargeHistory`.
- [ ] A session still in progress is not listed, or is listed with its final figures only.
      If Tesla lists a growing partial session, hold sessions back until the charger is idle
      (`charger_live_status`).
- [ ] One session's kWh matches the Tesla app.
- [ ] `meter_total_wh` tracks the charger's own lifetime counter (`energy_wh` at
      `http://<charger address>/api/1/lifetime`, readable from the same network).
- [ ] Tesla API usage stays inside the account's monthly allowance (one call an hour, about 720 a month).

The first live run reports sessions from the previous 7 days. To start the meter from a
later point, do the first deployment after the date you want.
