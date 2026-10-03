# WhistleDrop — Speak Without Being Seen

A backend-only REST API for anonymous whistleblowing.

Anyone can file a report without an account, an email address or a session. In
return they get a **case code** — a one-time, cryptographically random string
that is the only way to follow the case. Moderators log in with JWTs, work the
queue, and post updates that the reporter can read using that code.

The design goal is narrow and deliberate: **the system should not be able to
identify a reporter, even if the database is stolen and the server is
compromised.** Every choice below follows from that.

- **Stack:** Node.js · Express 5 · MongoDB (Mongoose 8) · JWT · Zod · Swagger/OpenAPI 3
- **Interactive docs:** `http://localhost:4000/api-docs`
- **Tests:** 84 automated tests (Jest + Supertest + in-memory MongoDB)

---

## Table of contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [API endpoints](#api-endpoints)
4. [Example requests and responses](#example-requests-and-responses)
5. [Status workflow](#status-workflow)
6. [Anonymity and privacy design](#anonymity-and-privacy-design)
7. [Security controls](#security-controls)
8. [Testing](#testing)
9. [Assumptions and design decisions](#assumptions-and-design-decisions)
10. [Known limitations and next steps](#known-limitations-and-next-steps)

---

## Quick start

### Prerequisites

- Node.js 18+ (developed on Node 24)
- MongoDB running locally, or a MongoDB Atlas connection string

### 1. Install

```bash
git clone <your-repo-url> whistledrop
cd whistledrop
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Then edit `.env`. The only values you must set are `MONGODB_URI` and
`JWT_SECRET`:

```bash
# generate a strong secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `4000` | HTTP port |
| `MONGODB_URI` | — | **Required.** MongoDB connection string |
| `JWT_SECRET` | — | **Required.** Min. 32 characters |
| `JWT_EXPIRES_IN` | `2h` | Moderator session length |
| `BCRYPT_ROUNDS` | `12` | bcrypt work factor for staff passwords (4–15; tests use 4) |
| `TRUST_PROXY` | `0` | Reverse-proxy hops in front of the API — **set to `1` behind a load balancer** |
| `TIMESTAMP_BUCKET_MINUTES` | `15` | Reporter-originated timestamps are rounded down to this window (`0` = exact) |
| `RETENTION_DAYS_AFTER_CLOSE` | `365` | Closed reports are deleted this many days after closing (`0` = keep forever) |
| `CORS_ORIGIN` | `*` | Comma-separated allowlist, or `*` |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | Window for all limiters |
| `RATE_LIMIT_MAX` | `100` | Requests per window, whole API |
| `REPORT_RATE_LIMIT_MAX` | `5` | Report submissions per window |
| `AUTH_RATE_LIMIT_MAX` | `10` | Login attempts per window |
| `TRACK_RATE_LIMIT_MAX` | `20` | Case-code lookups per window |
| `REPORTER_MESSAGE_RATE_LIMIT_MAX` | `10` | Reporter replies per window |

`.env` is gitignored; `.env.example` is the committed template. Startup
validates every variable with Zod and **exits with a clear message** if
something is missing or too weak — a bad config fails at boot, not at 3am.

### 3. Create the first admin

There is no public sign-up endpoint (see
[design decisions](#assumptions-and-design-decisions)). The first account is
provisioned from the CLI; after that, admins manage accounts through
`/api/v1/admin`:

```bash
npm run create:moderator -- --username root --password "Adm1n-Long-Passphrase" --name "Integrity Office" --role admin
npm run create:moderator -- --username alice --password "Str0ngPassphrase!" --name "Ethics Desk"   # role defaults to moderator
```

> **Deploying behind a load balancer?** Set `TRUST_PROXY=1` (or the number of
> proxy hops). Without it, Express sees every request as coming from the load
> balancer's IP, so **all reporters share one rate-limit bucket** and a single
> abuser can lock everyone out of submitting or tracking. Avoid `TRUST_PROXY=true`:
> it trusts any `X-Forwarded-For` value, letting a client pick its own bucket and
> bypass limits. A forgotten setting shows up in the logs as
> `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.

### Demo data (development only)

```bash
npm run seed
```

Creates `demo-admin` / `demo-moderator` accounts and five sample reports in
different states (resolved, awaiting the reporter, under review with a reply,
submitted, dismissed), all through the real services, and prints their case
codes. It **refuses to run when `NODE_ENV=production`**, exiting before it
connects to any database.

### 4. Run

```bash
npm run dev     # node --watch, restarts on file changes
npm start       # production mode
npm test        # full test suite (spins up its own in-memory MongoDB)
```

Then open **<http://localhost:4000/api-docs>** and try the API from the browser:
submit a report, copy the `caseCode`, track it, log in, click **Authorize**,
paste the token, and work the queue.

### Run with Docker

```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
docker compose up -d --build --wait          # API + MongoDB, waits for health checks
docker compose exec api node scripts/createModerator.js \
  --username root --password "Adm1n-Long-Passphrase" --role admin
open http://localhost:4000/api-docs
docker compose down                           # add -v to delete the data volume
```

- **Multi-stage image** on `node:22-alpine`: production dependencies are
  installed in a separate stage with `--ignore-scripts`, so the runtime image
  has no dev tooling, npm cache or install-time scripts.
- Runs as the unprivileged **`node`** user, with a `HEALTHCHECK` on `/health`
  using Node's built-in `fetch` (no curl in the image).
- MongoDB data lives in the named volume `mongo-data`. The database publishes
  **no port** — it is reachable only from the API container.
- `.dockerignore` keeps `.env`, tests and git history out of the build context.

---

## Architecture

### Layers

The request path is deliberately boring and one-directional. Each layer has one
job, which keeps controllers small and makes the domain rules testable without
HTTP.

```
HTTP request
    │
    ├─ helmet · cors · express.json(100kb)      security headers, body cap
    ├─ rate limiter                             per-route throttling
    ├─ validate(schema)                         Zod → req.validated
    ├─ requireModerator                         JWT verify + account re-check   (protected routes only)
    │
    ▼
routes/        maps URLs to middleware + controller
    ▼
controllers/   reads req.validated, shapes the HTTP response — no business logic
    ▼
services/      the actual rules: case codes, status workflow, presenters
    ▼
models/        Mongoose schemas — the last line of defence on what may be stored
    ▼
MongoDB

errors from any layer ──▶ middleware/errorHandler.js  ──▶  { success: false, error: { … } }
```

### Directory layout

```
src/
├── app.js                  builds the Express app (exported for tests)
├── server.js               connects to MongoDB, listens, handles shutdown
├── config/
│   ├── env.js              loads + validates environment variables (fail fast)
│   ├── db.js               MongoDB connect/disconnect
│   └── swagger.js          hand-written OpenAPI 3 document
├── models/
│   ├── Report.js           report + embedded status updates
│   └── Moderator.js        moderator account, bcrypt helpers
├── controllers/
│   ├── report.controller.js       public submit + track
│   ├── auth.controller.js         login, me
│   └── moderation.controller.js   protected moderator actions
├── routes/
│   ├── index.js            /meta, /health, mounts the routers
│   ├── report.routes.js    public routes
│   ├── auth.routes.js      login / me
│   └── moderator.routes.js protected routes (one router-level guard)
├── middleware/
│   ├── auth.js             JWT verification
│   ├── validate.js         generic Zod validation middleware
│   ├── rateLimiter.js      the four limiters
│   ├── notFound.js         unmatched routes → 404
│   └── errorHandler.js     centralized error → HTTP mapping
├── services/
│   ├── report.service.js   domain logic + reporter/moderator presenters
│   └── auth.service.js     login, token signing, account creation
├── utils/
│   ├── caseCode.js         generate / normalize / hash case codes
│   ├── statusWorkflow.js   the transition table
│   ├── constants.js        categories, statuses, JWT claims
│   ├── AppError.js         typed, expected errors
│   ├── asyncHandler.js     async error forwarding
│   └── logger.js           deliberately minimal (no request logging)
├── validators/             Zod schemas per resource
scripts/createModerator.js  account provisioning CLI
tests/                      unit + integration suites
```

### Response envelope

Every response — success or failure — uses the same shape, so a client needs
one parser:

```jsonc
// success
{ "success": true, "message": "…", "data": { … }, "meta": { … } }

// failure
{ "success": false, "error": { "message": "…", "details": … } }
```

---

## API endpoints

Base URL: `/api/v1`

### Public — no authentication

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/reports` | Submit an anonymous report, receive a case code |
| `GET` | `/reports/:caseCode` | Track a case: status, public updates and the message thread |
| `POST` | `/reports/:caseCode/messages` | Reply to moderators anonymously (returns PII warnings) |
| `GET` | `/meta` | Categories, statuses and the status workflow |
| `GET` | `/health` | Liveness probe (also at the root `/health`) |

### Moderator — `Authorization: Bearer <token>`

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login` | Exchange credentials for a JWT |
| `GET` | `/auth/me` | Who the current token belongs to |
| `GET` | `/moderator/reports` | List, search and filter — `?status=&category=&q=&from=&to=&hasEvidence=&sort=&page=&limit=` |
| `GET` | `/moderator/reports/:id` | Full report with description and update history |
| `PATCH` | `/moderator/reports/:id/status` | Move the report to a new status |
| `POST` | `/moderator/reports/:id/updates` | Add a public update or internal note without changing status |
| `POST` | `/moderator/reports/:id/messages` | Ask the reporter a question (sets `awaitingReporter`) |
| `GET` | `/moderator/stats` | Report counts per status |

### Admin — `Authorization: Bearer <token>` with the `admin` role

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/admin/moderators` | Create a moderator or admin account |
| `GET` | `/admin/moderators` | List staff accounts — `?page=&limit=` |
| `PATCH` | `/admin/moderators/:id/deactivate` | Deactivate an account (effective on its next request) |
| `PATCH` | `/admin/moderators/:id/activate` | Reactivate an account |

| `GET` | `/admin/audit-log` | Staff audit log, newest first — `?page=&limit=` |
| `GET` | `/admin/audit-log/verify` | Recompute the audit hash chain and report the first break |

Admins can also use every moderator route. Moderators get `403` on admin routes.

### Status codes used

| Code | When |
| --- | --- |
| `200 OK` | Successful read or status change |
| `201 Created` | Report submitted, or update added |
| `400 Bad Request` | Validation failed, malformed JSON, malformed id or case code |
| `401 Unauthorized` | Missing, malformed, expired, forged token; bad credentials; role changed since login |
| `403 Forbidden` | Moderator calling an admin route; admin deactivating themselves |
| `404 Not Found` | Unknown case code, unknown report id, unknown route |
| `409 Conflict` | Status is already the requested one; update on a closed case; another moderator changed the report concurrently |
| `422 Unprocessable Entity` | Well-formed request that breaks the status workflow |
| `429 Too Many Requests` | Rate limit exceeded |
| `500 Internal Server Error` | Unexpected failure (generic message, details logged server-side) |

`400` vs `422` is a deliberate distinction: `400` means *the request was
malformed*, `422` means *the request was fine but the domain forbids it*. A
client can react differently to each.

---

## Example requests and responses

> All payloads below are actual output from a running instance.

### 1. Submit a report (anonymous)

```bash
curl -X POST http://localhost:4000/api/v1/reports \
  -H "Content-Type: application/json" \
  -d '{
    "category": "Security",
    "description": "Production database credentials are committed to a public repository and have not been rotated since March.",
    "evidenceUrl": "https://example.com/evidence/2026-09-21"
  }'
```

```json
{
  "success": true,
  "message": "Report submitted. Save your case code now — it is shown only once and cannot be recovered.",
  "data": {
    "caseCode": "WD-7JCF5-FRY4F-QNEEB",
    "category": "SECURITY",
    "status": "SUBMITTED",
    "submittedAt": "2026-09-21T18:16:06.287Z"
  }
}
```

`category` is case-insensitive on input and normalized to upper case.
`evidenceUrl` is optional and must be `http(s)`.

### 2. Track the case

```bash
curl http://localhost:4000/api/v1/reports/WD-7JCF5-FRY4F-QNEEB
```

Codes are matched case-insensitively with separators ignored, so
`wd 7jcf5 fry4f qneeb` works too.

```json
{
  "success": true,
  "data": {
    "category": "SECURITY",
    "status": "RESOLVED",
    "submittedAt": "2026-09-21T18:16:06.287Z",
    "lastUpdatedAt": "2026-09-21T18:16:06.510Z",
    "isClosed": true,
    "updates": [
      {
        "message": "We have opened an investigation and contacted the infrastructure team.",
        "status": "UNDER_REVIEW",
        "createdAt": "2026-09-21T18:16:06.503Z"
      },
      {
        "message": "Still in progress — we expect an outcome within two weeks.",
        "status": null,
        "createdAt": "2026-09-21T18:16:06.507Z"
      },
      {
        "message": "The exposed credentials were rotated and access logs were reviewed.",
        "status": "RESOLVED",
        "createdAt": "2026-09-21T18:16:06.510Z"
      }
    ]
  }
}
```

Note what is **not** here: no report id, no description, no moderator name — see
[privacy design](#anonymity-and-privacy-design).

### 3. Invalid case code

```json
// GET /api/v1/reports/WD-ZZZZZ-ZZZZZ-ZZZZZ  →  404
{
  "success": false,
  "error": { "message": "No case found for that code. Check the code and try again." }
}
```

A code too short to be real is rejected earlier, with `400` and a field-level
message.

### 4. Validation failure

```json
// POST /api/v1/reports  { "category": "Gossip", "description": "too short" }  →  400
{
  "success": false,
  "error": {
    "message": "Validation failed",
    "details": [
      { "field": "body.category",    "message": "category must be one of: SECURITY, HARASSMENT, CORRUPTION, TECHNICAL, OTHER" },
      { "field": "body.description", "message": "description must be at least 20 characters" }
    ]
  }
}
```

Every failing field is reported at once, not one per round trip.

### 5. Moderator login

```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "username": "alice", "password": "Str0ngPassphrase!" }'
```

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "expiresIn": "2h",
    "moderator": { "id": "6ab17466f6cabe35b17ce5cc", "username": "alice", "displayName": "Ethics Desk" }
  }
}
```

### 6. List and filter reports

```bash
curl "http://localhost:4000/api/v1/moderator/reports?category=SECURITY&page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "success": true,
  "data": [
    {
      "id": "6ab17466f6cabe35b17ce5cf",
      "category": "SECURITY",
      "status": "SUBMITTED",
      "descriptionPreview": "Production database credentials are committed to a public repository and have not been rotated since March.",
      "hasEvidence": true,
      "updateCount": 0,
      "submittedAt": "2026-09-21T18:16:06.287Z",
      "lastUpdatedAt": "2026-09-21T18:16:06.287Z"
    }
  ],
  "meta": {
    "page": 1, "limit": 20, "total": 1, "totalPages": 1,
    "filters": { "status": null, "category": "SECURITY" }
  }
}
```

Search and filters combine freely:

```bash
curl "http://localhost:4000/api/v1/moderator/reports?q=credentials&category=security&hasEvidence=true&from=2026-09-01&to=2026-09-30&sort=recentlyUpdated" \
  -H "Authorization: Bearer $TOKEN"
```

| Parameter | Meaning |
| --- | --- |
| `q` | Full-text search over descriptions (MongoDB text index: stemmed, case-insensitive, words OR-ed; `"phrase"` and `-exclude` work) |
| `from` / `to` | Submission date range. `from` is inclusive; a plain-date `to` includes that whole day |
| `hasEvidence` | `true` / `false` |
| `sort` | `newest` (default), `oldest`, `recentlyUpdated` |
| `limit` | 1–100 (default 20) |

`meta.filters` echoes back what was applied after normalisation, so a client
can see exactly how `to=2026-09-30` was interpreted.

Without a token the same call returns `401`:

```json
{ "success": false, "error": { "message": "Missing or malformed Authorization header" } }
```

### 7. Change status — rejected

```bash
curl -X PATCH http://localhost:4000/api/v1/moderator/reports/6ab17466f6cabe35b17ce5cf/status \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "status": "RESOLVED" }'
```

```json
// 422 — a report cannot jump straight from SUBMITTED to RESOLVED
{
  "success": false,
  "error": {
    "message": "Cannot change status from SUBMITTED to RESOLVED",
    "details": {
      "currentStatus": "SUBMITTED",
      "requestedStatus": "RESOLVED",
      "allowedTransitions": ["UNDER_REVIEW", "DISMISSED"]
    }
  }
}
```

The error tells the client exactly what *is* allowed, so a UI can render the
right buttons without hard-coding the workflow.

### 8. Change status — accepted

```bash
curl -X PATCH http://localhost:4000/api/v1/moderator/reports/6ab17466f6cabe35b17ce5cf/status \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "status": "UNDER_REVIEW", "message": "We have opened an investigation and contacted the infrastructure team." }'
```

```json
{
  "success": true,
  "message": "Report status updated to UNDER_REVIEW",
  "data": {
    "id": "6ab17466f6cabe35b17ce5cf",
    "category": "SECURITY",
    "description": "Production database credentials are committed to a public repository and have not been rotated since March.",
    "evidenceUrl": "https://example.com/evidence/2026-09-21",
    "status": "UNDER_REVIEW",
    "allowedTransitions": ["RESOLVED", "DISMISSED"],
    "submittedAt": "2026-09-21T18:16:06.287Z",
    "lastUpdatedAt": "2026-09-21T18:16:06.503Z",
    "updates": [
      {
        "id": "6ab17466f6cabe35b17ce5de",
        "message": "We have opened an investigation and contacted the infrastructure team.",
        "status": "UNDER_REVIEW",
        "createdAt": "2026-09-21T18:16:06.503Z",
        "moderator": { "id": "6ab17466f6cabe35b17ce5cc", "displayName": "Ethics Desk" }
      }
    ]
  }
}
```

If `message` is omitted the system writes `"Status changed to UNDER_REVIEW"`, so
the reporter always sees *something*.

### 9. Add an update without changing status

```bash
curl -X POST http://localhost:4000/api/v1/moderator/reports/6ab17466f6cabe35b17ce5cf/updates \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "message": "Still in progress — we expect an outcome within two weeks." }'
```

Returns `201` with the full report. The update has `"status": null`, marking it
as a note rather than a transition.

Add `"visibility": "INTERNAL"` for a moderator-only note. Internal notes never
appear on the tracking endpoint, and they do not move the reporter's
`lastUpdatedAt` — otherwise the reporter could tell that moderators had been
discussing their case privately.

### Anonymous follow-up conversation

Moderators often need one more detail. They can ask through the case, and the
reporter answers with nothing but the case code:

```bash
# moderator asks — the case is flagged awaitingReporter=true
curl -X POST http://localhost:4000/api/v1/moderator/reports/$ID/messages \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "body": "Which repository are the credentials in?" }'

# reporter sees it on the tracking page (awaitingYourReply: true) and replies
curl -X POST http://localhost:4000/api/v1/reports/WD-7JCF5-FRY4F-QNEEB/messages \
  -H "Content-Type: application/json" \
  -d '{ "body": "It is the infra-scripts repo, in the deploy folder." }'
```

- The reporter sees `from: "MODERATOR"`, never which moderator. Moderators see
  who on their side wrote each message.
- Reporter messages get the same PII scan as the description (`warnings[]`), a
  coarse timestamp, and no per-message ObjectId (which would embed the exact
  time). Thread order is the array order.
- Writes are atomic `$push` updates whose filter also requires an open case, so
  a reply can never land on a case closed a moment earlier (`409`). Closing a
  case clears `awaitingReporter`.
- `GET /moderator/reports?awaitingReporter=true` is the "waiting on reporter"
  queue. Threads are capped at 200 messages to keep the embedded document
  bounded.

### 10. Queue overview

```json
// GET /api/v1/moderator/stats
{ "success": true, "data": { "total": 12, "byStatus": { "SUBMITTED": 5, "UNDER_REVIEW": 4, "RESOLVED": 3 } } }
```

### 11. Discover the workflow

```json
// GET /api/v1/meta
{
  "success": true,
  "data": {
    "categories": ["SECURITY", "HARASSMENT", "CORRUPTION", "TECHNICAL", "OTHER"],
    "statuses": ["SUBMITTED", "UNDER_REVIEW", "RESOLVED", "DISMISSED"],
    "workflow": {
      "SUBMITTED": ["UNDER_REVIEW", "DISMISSED"],
      "UNDER_REVIEW": ["RESOLVED", "DISMISSED"],
      "RESOLVED": [],
      "DISMISSED": []
    }
  }
}
```

---

## Status workflow

```
                    ┌──────────────────────────────┐
                    │                              ▼
   ┌───────────┐    │    ┌──────────────┐    ┌───────────┐
   │ SUBMITTED │────┴───▶│ UNDER_REVIEW │───▶│ DISMISSED │  (final)
   └───────────┘         └──────────────┘    └───────────┘
                                │
                                ▼
                          ┌──────────┐
                          │ RESOLVED │  (final)
                          └──────────┘
```

| From | May move to |
| --- | --- |
| `SUBMITTED` | `UNDER_REVIEW`, `DISMISSED` |
| `UNDER_REVIEW` | `RESOLVED`, `DISMISSED` |
| `RESOLVED` | — final |
| `DISMISSED` | — final |

**Rules enforced by the API**

- A report starts at `SUBMITTED`. Clients cannot set the initial status.
- `SUBMITTED → RESOLVED` is rejected: nothing is resolved before it is reviewed.
- Backwards moves (`UNDER_REVIEW → SUBMITTED`) are rejected.
- `RESOLVED` and `DISMISSED` are terminal — a closed case cannot be reopened or
  receive new updates. A reporter can trust that the outcome they were shown is
  final.
- Re-applying the current status returns `409`, not a silent no-op.
- Transitions are **atomic**. The write is a single `findOneAndUpdate` filtered
  on the status that was validated, so if two moderators act at once
  (`UNDER_REVIEW → RESOLVED` and `UNDER_REVIEW → DISMISSED`) exactly one wins and
  the other gets `409` with `expectedStatus` / `currentStatus` in the details.
  Notes use the same technique, so one can never land on a case closed a moment
  earlier.
- A rejected transition changes nothing: the status stays put and no update is
  written.
- Every accepted transition appends an update recording the new status, the
  message and which moderator made it.

The rules live in one table in
[`src/utils/statusWorkflow.js`](src/utils/statusWorkflow.js) — adding a status
means editing that table, not hunting through controllers.

---

## Anonymity and privacy design

### What is stored against a report

A report document has exactly these fields, and Mongoose runs in strict mode so
nothing else can be written:

```jsonc
{
  "_id":          "…",        // internal, never shown to the reporter
  "caseCodeHash": "…",        // SHA-256 of the case code — never the code itself
  "category":     "SECURITY",
  "description":  "…",        // the reporter's own words
  "evidenceUrl":  "https://…" // optional, or null
  "status":       "SUBMITTED",
  "updates":      [ … ],      // moderator notes
  "createdAt":    "…",
  "updatedAt":    "…"
}
```

### What is deliberately **not** stored

| Not stored | Why |
| --- | --- |
| IP address | The single most identifying field in a normal web request |
| User-agent, `Referer` | Browser/device fingerprinting, and referrer leaks *where* the report was filed from |
| Email, name, username, employee id | There is no reporter account at all |
| Session or cookie | Nothing to correlate two submissions by the same person |
| Uploaded files | Documents carry metadata (author, device, GPS). Only an external URL is accepted |
| HTTP access logs | No `morgan`-style request logging. Access logs are where identifying data silently accumulates |

This is enforced in three places, not one: the **Zod schema** rejects unknown
fields with `400`, the **Mongoose schema** would drop them anyway, and the
**presenters** in `report.service.js` build responses field by field instead of
serialising documents. A test asserts the exact set of keys on a stored report
after a request carrying `X-Forwarded-For`, a fingerprintable `User-Agent` and a
`Referer`.

### The case code

```
WD-7JCF5-FRY4F-QNEEB
   └──────┬──────┘
   15 characters from a 30-character alphabet ≈ 73 bits of entropy
```

- Generated with `crypto.randomInt()` (a CSPRNG), never `Math.random()`.
- Alphabet excludes `0 O 1 I L U` — the characters people misread when copying a
  code off a screen.
- **Only the SHA-256 hash is stored.** A stolen database dump cannot be turned
  back into working case codes; an attacker would have to guess a ~73-bit value.
- Shown exactly once, in the submission response. If a reporter loses it, nobody
  — including an administrator with database access — can recover it. That is
  the cost of not knowing who they are, and the API says so in plain language in
  the response message.
- SHA-256 rather than bcrypt is correct here: the input is high-entropy random
  data (not a human-chosen password), so there is nothing to brute-force, and
  lookups stay a single indexed query.

### Timestamp coarsening

An exact submission time is an identifier in disguise: *"the report arrived at
14:32:07"* can be lined up against badge swipes, VPN logs or who stepped out of
a meeting. So the submission time is **rounded down to a 15-minute bucket**
(`TIMESTAMP_BUCKET_MINUTES`) *before it is written*. The precise time never
reaches the database.

That covers more than `createdAt`:

- `updatedAt` starts at the same coarse value.
- **The report `_id` too.** A MongoDB ObjectId embeds its creation time to the
  second, so coarsening only `createdAt` would leave the real time readable from
  the id. Report ids are built from the bucket time plus 8 random bytes instead.

**Trade-off:** reports filed in the same window share a `createdAt` and their
relative order inside that window is unknowable — by design. Lists sort by
`createdAt` then `_id`, so pagination stays stable. Moderator actions keep exact
timestamps; they describe staff activity, not the reporter's.

### Retention

The less data kept, the less there is to leak, subpoena or cross-reference.
When a report becomes `RESOLVED` or `DISMISSED`, `closedAt` is set **in the same
atomic write as the status**, and a MongoDB TTL index deletes the report
`RETENTION_DAYS_AFTER_CLOSE` days later (default 365; `0` disables it).

- Open reports have `closedAt: null` and are never touched by the TTL index.
- MongoDB's TTL monitor runs about once a minute, so deletion happens shortly
  after the deadline, not to the second.
- Indexes are synchronised at startup (`syncIndexes()`), so changing the
  retention period takes effect on the next restart. Mongoose's default
  `autoIndex` only creates indexes, so a changed TTL would otherwise conflict
  with the existing one and `0` would never remove it.
- A test runs MongoDB's TTL monitor every second and checks that a report closed
  400 days ago is really deleted while an open one survives.

### PII warnings on free text

Reporters often undo their own anonymity — signing off with an email address,
or mentioning their staff number. On submission the description goes through
[`piiScanner.js`](src/utils/piiScanner.js), which looks for emails, phone
numbers, `@handles`, employee/student/badge IDs and phrases like *"my name is"*.

```json
"warnings": [
  { "code": "POSSIBLE_EMAIL", "message": "The text appears to contain an email address. Moderators will see this text. …" }
]
```

- **It never blocks a submission.** A false positive that rejects a real report
  is far worse than a warning the reporter can ignore, so it deliberately leans
  towards over-warning (a 10-digit invoice number is flagged as a phone number).
- **It returns codes, never the matched text.** Nothing it finds is logged,
  stored or echoed back.
- It is a pure function with its own unit tests, including the false positives
  it must *not* raise (dates, versions, IPs, CVE ids, amounts).

### Audit log: watching the watchers

Moderators can read every report, so their access needs accountability too.
Every `LOGIN`, `VIEW_REPORT`, `UPDATE_STATUS`, `ADD_UPDATE` and admin account
action is appended to an `AuditLog` collection as
`{ seq, moderator, action, report?, targetModerator?, createdAt, prevHash, hash }`.

- **Tamper-evident hash chain.** `hash = SHA-256(prevHash + this entry's
  fields)` and `seq` has no gaps. `GET /admin/audit-log/verify` recomputes the
  chain and pinpoints the first edited, re-hashed, deleted or re-ordered entry.
- **No reporter data, no IPs.** Entries hold ids and an action name — never
  report text, case codes, IP addresses or user-agents. The audit log watches
  staff; it must not become a second copy of the reports.
- **Reads fail closed.** `VIEW_REPORT` is written *before* the report is
  returned: if the view cannot be recorded, the moderator does not see the
  report.
- **Concurrent appends never fork the chain.** A unique index on `seq` lets one
  writer win; the others re-read the new head and retry (`503` if the log stays
  contended).
- **Limits, stated honestly.** The chain proves the log was not *changed*; it
  cannot by itself prove the newest entries were not *removed*. That is why
  `verify` returns `headHash` — store it somewhere outside the database (a
  ticket, a signed email) and compare later. Status changes and their audit
  entry are two writes, not one transaction; a replica-set deployment could wrap
  them in a transaction.

### What each audience can see

| | Reporter (case code) | Moderator (JWT) |
| --- | --- | --- |
| Status, timestamps | ✅ | ✅ |
| Category | ✅ | ✅ |
| Public moderator updates | ✅ | ✅ |
| Follow-up message thread | ✅ (side only: `REPORTER` / `MODERATOR`) | ✅ (with moderator name) |
| Description / evidence URL | ❌ | ✅ |
| Internal report id | ❌ | ✅ |
| Which moderator wrote an update | ❌ | ✅ |
| `INTERNAL` moderator notes | ❌ | ✅ |
| Any other report | ❌ | ✅ (that is their job) |

The reporter's view omits the description on purpose: the tracking endpoint
exists to answer *"what is happening with my case?"*, and if a code is
shoulder-surfed or found in a browser history, the leak is limited to a status
rather than the full allegation. Moderator identity is hidden from the reporter
for the moderator's safety, while still being recorded internally for
accountability.

### The one honest exception: rate limiting

Rate limiting keys buckets by IP address. That IP is held **in memory for the
length of the window only** — never written to the database, a log line or a
report. Without it, the tracking endpoint could be brute-forced and the
submission endpoint flooded. It is a deliberate trade, documented rather than
hidden.

### Threat model — what this design does and does not stop

| Threat | Outcome |
| --- | --- |
| Database dump is leaked | Reports readable, but no reporter identity exists in them and case codes cannot be recovered from hashes |
| Reporter includes their own email/phone/ID in the text | Flagged back to them as a warning (codes only); the report is still accepted |
| Timing correlation (matching submission time to someone's movements) | Only a 15-minute window is stored — in `createdAt` and inside the ObjectId |
| Someone finds a reporter's case code | Sees status and updates only — not the report body |
| Attacker guesses case codes | ~73 bits of entropy plus a lookup rate limit |
| Malicious client posts `email` alongside a report | Rejected with `400`; nothing is stored |
| Moderator account is compromised | Attacker sees report contents — but still no reporter identity. Every report they open is in the audit log, and an admin can deactivate the account, which loses access on its very next request |
| A moderator snoops on reports, or someone edits the audit trail to hide it | Every view is logged before the report is shown; the hash chain exposes edited, deleted or re-ordered entries |
| Network-level observation (ISP, corporate proxy) | **Out of scope.** Reporters should use Tor or a network they do not control — no server-side design can fix this |

---

## Security controls

| Control | Implementation |
| --- | --- |
| Security headers | `helmet()` globally; a relaxed CSP scoped to `/api-docs` only, so Swagger UI works without weakening the API |
| Authentication | JWT (HS256) with `issuer` and `audience` claims verified on every request |
| Account re-check | The moderator is re-loaded from the database per request, so a deactivated account loses access immediately, not at token expiry |
| Password storage | bcrypt, cost factor 12; the hash is `select: false` and stripped from JSON |
| User enumeration | Unknown username, wrong password and deactivated account all return the same `401` message |
| Timing attacks | A dummy bcrypt comparison runs when the username does not exist, so failed logins take the same time |
| No self-registration | The first admin is created via CLI; further accounts only by an admin |
| Roles | `moderator` and `admin`. The role is re-checked against the database on every request: a token whose `role` claim no longer matches the account is rejected with `401`, so a demotion takes effect immediately and a promotion requires a fresh login |
| Input validation | Zod on body, query and params; unknown keys rejected |
| Injection | Validated-and-typed input into Mongoose; no string-built queries, no `$where`. Free-text search goes to a `$text` index, never into a `RegExp`, so there is nothing to escape and no ReDoS surface |
| XSS via stored links | `evidenceUrl` is restricted to `http(s)`, blocking `javascript:` and `data:` payloads |
| Caching | `Cache-Control: no-store` + `Pragma: no-cache` on every reporter, auth and moderator response — including errors — so no browser, proxy or CDN keeps a case code, a case status or a token |
| Payload size | JSON bodies capped at 100 KB |
| Rate limiting | Four separate limiters: global, submission, login, case lookup |
| Error leakage | Unexpected errors are logged server-side and returned as a generic `500` — never a stack trace or driver message |
| Secret management | All secrets in `.env` (gitignored); startup refuses a `JWT_SECRET` under 32 characters |

---

## Testing

```bash
npm test                  # everything
npm test -- reports       # one suite
npm test -- --coverage    # with coverage
```

Integration tests run against a real MongoDB started in memory
(`mongodb-memory-server`), so indexes, unique constraints and aggregations
behave exactly as in production. No database installation and no shared test
database are needed.

**84 tests across 6 suites:**

| Suite | Covers |
| --- | --- |
| `caseCode.test.js` | Code format, alphabet safety, 5,000-code uniqueness, normalization, hash stability |
| `statusWorkflow.test.js` | Every legal and illegal transition, terminal states, unknown status input |
| `reports.test.js` | Submission, validation, tracking, case-code normalization, 404/400 paths, and privacy assertions on the stored document |
| `auth.test.js` | Login, user enumeration, tampered/forged/expired/wrong-audience tokens, deactivated and deleted accounts |
| `moderation.test.js` | Listing, filtering, pagination, detail, all workflow transitions, closed-case rules, and a full end-to-end reporter journey |
| `rateLimit.test.js` | `429` behaviour on submission, tracking and login, plus `RateLimit` headers |

Edge cases covered include: malformed JSON, oversized descriptions,
`javascript:` evidence URLs, extra identifying fields in the payload, malformed
report ids (`400`, not a Mongoose cast error), re-applying the current status
(`409`), and confirming that a rejected transition leaves the report untouched.

---

## Assumptions and design decisions

**1. The case code is the only reporter credential.**
No account means no password reset, no email recovery. Losing the code means
losing access to the case. That is the honest consequence of true anonymity, so
the API states it explicitly in the submission response instead of quietly
implying recovery is possible.

**2. Case codes are hashed, not encrypted.**
Encryption implies a key that can decrypt — another secret that can leak.
Hashing means there is simply nothing to steal. The trade-off: nobody can look
up a case *for* a reporter, by design.

**3. Reporters do not see their own report body when tracking.**
Minimum necessary disclosure. The endpoint answers "what is happening?" — if a
code is compromised, the allegation itself is not exposed.

**4. There is no public moderator registration endpoint.**
An open `/auth/register` on a service holding sensitive reports would be an
open door. Accounts are provisioned deliberately via
`npm run create:moderator`.

**5. Status updates are embedded in the report document.**
Updates are always read with their report, are few, and are bounded at 500
characters. Embedding gives atomic writes and one query instead of a join. A
separate collection would be the right call only if updates grew unbounded.

**6. No HTTP request logging.**
A conventional `morgan` line contains IP, user-agent and path — exactly the
data this project promises not to keep. Only lifecycle and error events are
logged, without request bodies.

**7. Evidence is a URL, not a file upload.**
Uploaded documents carry metadata that can deanonymise the sender (author name,
device, GPS). Accepting a link keeps that risk with the reporter, where they can
control it, and keeps the service stateless.

**8. Categories and statuses are fixed enums.**
They are part of the contract, exposed at `GET /meta` so clients discover them
at runtime rather than hard-coding them.

**9. `422` for workflow violations, `400` for malformed input.**
A client can tell "you sent nonsense" from "that move isn't allowed", and the
`422` body lists the transitions that *are* allowed.

**10. Two roles, checked against the database.**
`admin` can do everything a `moderator` can, plus manage accounts. The JWT's
`role` claim is compared with the stored account on every request, so a token
can never carry privileges the account no longer has. Admins cannot deactivate
themselves — which also guarantees at least one active admin always remains,
because the last one has nobody else who could remove them. Self-deactivation
is a `403` (an action this caller may not take), while re-deactivating an
inactive account is a `409` (the state already is what was asked for).

**11. JWTs are stateless with a 2-hour expiry.**
No token blocklist. Immediate revocation is instead achieved by deactivating the
account, which is checked on every request.

**12. The OpenAPI spec is hand-written in one file.**
Rather than scattering JSDoc across routes, the whole contract is readable
top-to-bottom in `src/config/swagger.js`, reviewable in a diff and exportable
as-is from `/api-docs.json`.

**13. `app.js` and `server.js` are separate.**
Tests drive the app with Supertest without opening a port or touching a real
database.

---

## Known limitations and next steps

- **Network-level anonymity is out of scope.** The server never records an IP,
  but a network observer still sees the connection. Reporters needing protection
  from that should use Tor.
- **Rate limits are in-memory.** Correct for a single instance; a multi-instance
  deployment needs a shared store (Redis) so all instances see the same counts.
- **No notifications.** Reporters must poll their case code to see a
  moderator's question. That is the anonymity-preserving choice — any push
  channel (email, SMS, web push) is an identifier.

---

## License

MIT
