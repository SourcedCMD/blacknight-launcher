# BlackNight services

The launcher is local-first and works with none of this running. What a server
adds is the handful of things a single machine genuinely cannot do:

| Endpoint | What it unblocks | Client that already speaks it |
| --- | --- | --- |
| `GET /catalog` | Announce a title without shipping a build | `catalogUrl` |
| `POST /auth/*` | One library across machines, password reset, passkeys | `auth.js` |
| `GET /entitlements` | Playtest access enforced somewhere the user cannot edit | `library.setChannel` |
| `POST /crash` | Seeing every crash, not only the reported ones | `crashReportUrl` |
| `WS /rendezvous` | Sharing builds with friends outside your network | `rendezvousUrl` |

Every one of those clients is already built and tested against fixtures. This
is the other half.

## Running it

```bash
cd server
npm start
```

No dependencies, same as the launcher. Node 20 or later.

```
PORT=8080                      # default 8080
DATA_DIR=./data                # where accounts and crashes are written
CATALOG_FILE=../electron/data/catalog.json
ORIGIN=https://sourcedcmd.github.io
```

Then point the launcher at it — Settings, or directly in `settings.json`:

```json
{
  "catalogUrl": "http://localhost:8080/catalog",
  "crashReportUrl": "http://localhost:8080/crash",
  "rendezvousUrl": "ws://localhost:8080/rendezvous"
}
```

## What this is not

**It is not a payment system.** The store shows prices and the membership page
shows a monthly cost; neither can take money, and nothing here changes that.
Taking payments means a processor, a merchant account and obligations that do
not belong in a file like this. `/entitlements` is deliberately shaped so that
a processor's webhook can grant an entitlement later without the launcher
changing at all.

**It is not hardened for the open internet.** Accounts are stored in JSON
files, which is fine for a studio's own machine and wrong for public traffic.
Before this faces the world it needs a real database, rate limiting, and TLS
terminated in front of it.

**It is not a CDN.** Game builds should be served from object storage, not
from here. The delta patching and LAN sharing in the launcher exist to keep
that bill small, but the origin still has to be something you are willing to
pay for.

## Layout

```
server/
  index.js        Routing and the HTTP surface
  lib/
    http.js       Request parsing, JSON replies, CORS
    store.js      The same atomic JSON store the launcher uses
    accounts.js   Registration, sessions, passkeys
    ws.js         A minimal RFC 6455 server, for the rendezvous
  data/           Written at runtime; not in the repository
```

## Pointing the launcher at it

The three settings that reach a service are deliberately empty in a fresh
install, and each feature stays dormant until one is filled in. Nothing here
changes that: you point the launcher at this server yourself.

Start it:

```
npm run services
```

Then in the launcher, under Settings:

| Setting | Value |
| --- | --- |
| Catalog URL | `http://localhost:8080/catalog` |
| Crash report URL | `http://localhost:8080/crash` |
| Rendezvous URL | `ws://localhost:8080/rendezvous` |

Each row explains itself in the UI when empty, and the matching switch stays
disabled — so an unconfigured launcher says so rather than pretending the
feature works.

### Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | `0` picks a free port and prints it |
| `DATA_DIR` | `server/data` | Accounts and crash reports |
| `CATALOG_FILE` | the bundled catalog | What `/catalog` serves |
| `ORIGIN` | the Pages site | The only origin CORS allows |
| `ADMIN_TOKEN` | unset | Without it, granting and the crash summary are closed |
| `RESET_ECHO` | unset | `1` returns reset tokens in the response, for local testing only |

### Tests

```
npm run test:server
```

Starts a real server on an ephemeral port with its own data directory and
talks to it over a socket — including the WebSocket rendezvous, which is
exercised through the browser's own `WebSocket` client rather than a stub.

## Rate limits

| Bucket | Limit | Window |
| --- | --- | --- |
| `login` | 10 | 5 minutes |
| `register` | 5 | 15 minutes |
| `reset` | 5 | 15 minutes |
| `crash` | 60 | 1 minute |
| everything else | 120 | 1 minute |

Plus a per-account lockout after five consecutive failed sign-ins, growing to
fifteen minutes and capping there so nobody can be locked out permanently by
somebody else's attempts.

Counters live in memory. A restart forgets them, which is the right trade for a
single process: an attacker cannot restart the server, and persisting lockout
state invites its own bugs.

Behind a reverse proxy, set `TRUST_PROXY=1` so the forwarded address is used.
Without it the socket address is used, because a client can send
`X-Forwarded-For` itself and trusting it unconditionally would let anyone forge
their way around a limit.

`RATE_LIMITS=off` disables them entirely. That exists so the functional test
suite can register dozens of accounts from one address; the limits themselves
are covered by their own unit tests and by a second server that runs with them
on.

## Passkeys

| Variable | Default | What it does |
| --- | --- | --- |
| `RP_ID` | `localhost` | The domain credentials are scoped to |
| `RP_ORIGIN` | `https://localhost` | The exact origin an assertion must name |

Both must match where the launcher actually runs, or every assertion is
correctly refused as being for a different site.

## Cloud saves

A push carries `basedOn`, the version the machine last synced. If the server has
moved on, the push is refused with a 409 and both versions are named — the
launcher asks rather than picking. Five versions are kept per title, and the
newest is never pruned.
