# What Tesla requires

Checked against Tesla's developer documentation on 13 November 2026. Each line says what
Tesla's own pages state, and what they leave open.

## Is it possible?

Yes. Tesla documents exactly this use.

| Claim the bridge relies on | Tesla's documentation |
|---|---|
| A Wall Connector's charging history can be read through the API | Energy endpoint `charge_history`: "Returns the charging history of a wall connector." Energy values are in watt-hours. `GET /api/1/energy_sites/{energy_site_id}/telemetry_history?kind=charge&start_date=…&end_date=…&time_zone=…` ([Energy endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/energy)) |
| Read-only access is enough | Scope `energy_device_data`: "Energy live status, site info, backup history, energy history, and charge history." Control is a separate scope (`energy_cmds`) that the bridge never asks for ([Authentication overview](https://developer.tesla.com/docs/fleet-api/authentication/overview)) |
| An individual may connect their own product | Third-party tokens are for "developers building apps or services" and for "hobbyists integrating their own Tesla products" (same page) |
| An operator may do it for many customers | "Partners can interact with their own devices or devices for which they have been granted access by a customer" ([What is Fleet API](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api)). This is option (b) in the README: MeronRG runs one bridge, each resident approves with their Tesla login |
| The bridge can keep its access without the owner logging in again | Scope `offline_access`; refresh with `grant_type=refresh_token`, `client_id`, `refresh_token` at `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` ([Third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)) |

## Requirements

| # | Requirement | Source |
|---|---|---|
| 1 | A Tesla account with a verified e-mail and multi-factor sign-in. Personal or business. | What is Fleet API |
| 2 | A developer application, created at developer.tesla.com (name, description, purpose, scopes). It gives a client id and a client secret. | What is Fleet API |
| 3 | A web domain that hosts the application's public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem`. "A public key must be hosted on the application's domain before making calls to Fleet API." It must stay there. | What is Fleet API, [Partner endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints) |
| 4 | One call to the register endpoint (`POST /api/1/partner_accounts`) in each region used. "Each application from developer.tesla.com must complete this step." | Partner endpoints |
| 5 | The charger's owner signs in once and approves the scopes `openid offline_access energy_device_data`. The application's redirect address must be registered in the developer application. The one-time code is exchanged, with the client secret, for an access token and a refresh token. | Third-party tokens |
| 6 | The right regional address. Europe, Middle East and Africa: `https://fleet-api.prd.eu.vn.cloud.tesla.com`. `GET /api/1/users/region` returns the correct one for an account. | [Regions](https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries), [User endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/user-endpoints) |
| 7 | The Wall Connector is on Wi-Fi and added to the owner's Tesla account in the Tesla app, so that it reports to Tesla. | Not in the developer documentation; see "Left open" |

## Token rules the bridge follows

From [Third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens):

- A refresh token is "single use only". Each refresh returns a new one, which the bridge stores.
- The previous refresh token stays valid "for up to 24 hours", so one lost answer does not
  break the chain: the next hourly run succeeds with the token already stored.
- A refresh token "expires after 3 months". The bridge refreshes several times a day, so it
  never ages out while the bridge runs.
- A refresh fails with `401 login_required` when the token has expired or been replaced, or
  when the owner has reset their password. Then the owner approves again (GO-LIVE step 2).

## Cost and limits

From [Billing and limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits) and the
[developer home page](https://developer.tesla.com/):

- Pay per use. Data requests: 500 for $1. "Each account receives a $10 monthly discount."
- The bridge makes one request an hour, about 720 a month: at most about $1.50 a month if
  billed as data requests, well inside the discount. (Home Assistant's documentation states
  that "Energy product APIs are free to use"; Tesla's own pages do not show a pricing
  category for the energy endpoints.)
- Limit: 60 data requests a minute per device. The bridge makes one an hour.
- Tesla states that an application needs a payment method on file, that the billing limit
  starts at 0, and that usage beyond the limit suspends the application. The $10 discount is
  per developer account and shared by everything on it.

## Left open by Tesla's documentation

These cannot be settled by reading; they are the first-run checks in [`GO-LIVE.md`](GO-LIVE.md).

- Whether a Wall Connector with no Powerwall or solar is listed as an energy site by
  `GET /api/1/products`. The endpoint exists for Wall Connectors, but the page does not
  describe this case.
- The field names in the `charge_history` answer. Tesla's page gives no example.
- How a session still in progress is listed.
- The pricing category of the energy endpoints.
- Tesla's list of countries where a payment method can be added does not include every
  country where the API works. Check the developer dashboard for the account's country.
- Whether approving a narrower set of scopes for an application changes what an existing
  approval of the same application allows. If the developer application is shared with
  another integration, check that integration still works after step 5, or use a separate
  application for the bridge.
