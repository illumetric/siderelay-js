# SideRelay for JavaScript

Send confirmed purchases and leads from your Node.js backend to SideRelay.
Requires Node.js 22+. No runtime dependencies.

```sh
npm install github:illumetric/siderelay-js#v0.1.0
```

```js
import { SideRelay } from '@siderelay/node';
const client = new SideRelay({ token: process.env.SIDERELAY_TOKEN });
const result = await client.purchase({
  event_id: `purchase:${order.id}`,
  occurred_at: order.paidAt.toISOString(),
  consent: order.savedConsent,
  properties: { transaction_id: String(order.id), value: order.total, currency: order.currency }
});
```

Create a backend connection in SideRelay and copy its token. Keep the token on
your server. Never put it in browser code. CommonJS supports
`const { SideRelay } = require('@siderelay/node')`.

## Results

- **Received** (`received`): SideRelay safely collected the event. Check Activity for destination delivery.
- **Try again** (`retry`): put the same event back on your website's background queue.
- **Check configuration** (`configuration`): check the token and event details. Do not retry unchanged requests.

Send only after the order or lead is committed. Call SideRelay from your existing
background queue; never make a successful checkout depend on tracking.
Retries reuse the exact same event. The client makes up to three attempts, with
five-second request timeouts and a twenty-second call budget. A longer Retry-After
returns control to your queue rather than blocking the website.

`track(event)` accepts an event name; `lead(event)` sends `generate_lead`.
`batch(events)` sends up to 100 events and returns individual acknowledgements.
Every event needs `event_id` and `occurred_at`. A single event may be at most 96 KB;
a batch at most 200 KB. Use the same ID for browser/backend copies and retries.

## Permission and customer matching

Save the visitor's actual choice with the order or lead and pass it as `consent`.
Missing choices remain unknown. GPC and advertising opt-outs override advertising
grants. A backend event is not permission to send customer data to advertising.

The website can use `SideRelay.getBackendContext(eventId)` to obtain an event ID,
current choice, and permitted browser identifiers to hand to its backend. Do not
send that helper's values directly to an advertising platform.

Supported identity fields follow the public canonical v1 contract. Raw `email`,
`phone`, and `user_id` are hashed before sending. `hashIdentity(value, type)` also
supports names and location fields. Supply phone numbers with country codes;
no SDK guesses a missing country code.

For development, set `endpoint: 'http://localhost:5178'`. Production endpoints
must use HTTPS. Redirects are rejected. `transport` and `sleep` can be injected
for application integration and tests.

## Development and releases

Run `npm test` and `npm pack --dry-run`. Protocol v1 fixtures live in `fixtures`.
Versions are independent of the SideRelay platform. An explicit GitHub release
workflow publishes a selected version using the repository's npm credentials;
ordinary commits never publish. The npm package name is `@siderelay/node`. npm registry publication requires
organization publisher credentials; until then the tagged GitHub installation above works.
