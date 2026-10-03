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
| `TRUST_PROXY` | `0` | Reverse-proxy hops in front of the API — **set to `1` behind a load balancer** |
| `CORS_ORIGIN` | `*` | Comma-separated allowlist, or `*` |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | Window for all limiters |
| `RATE_LIMIT_MAX` | `100` | Requests per window, whole API |
| `REPORT_RATE_LIMIT_MAX` | `5` | Report submissions per window |
| `AUTH_RATE_LIMIT_MAX` | `10` | Login attempts per window |
| `TRACK_RATE_LIMIT_MAX` | `20` | Case-code lookups per window |

`.env` is gitignored; `.env.example` is the committed template. Startup
validates every variable with Zod and **exits with a clear message** if
something is missing or too weak — a bad config fails at boot, not at 3am.

### 3. Create a moderator

There is no public sign-up endpoint (see
[design decisions](#assumptions-and-design-decisions)). Accounts are
provisioned from the CLI:

```bash
npm run create:moderator -- --username alice --password "Str0ngPassphrase!" --name "Ethics Desk"
```

> **Deploying behind a load balancer?** Set `TRUST_PROXY=1` (or the number of
> proxy hops). Without it, Express sees every request as coming from the load
> balancer's IP, so **all reporters share one rate-limit bucket** and a single
> abuser can lock everyone out of submitting or tracking. Avoid `TRUST_PROXY=true`:
> it trusts any `X-Forwarded-For` value, letting a client pick its own bucket and
> bypass limits. A forgotten setting shows up in the logs as
> `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.

### 4. Run

```bash
npm run dev     # nodemon, auto-restart
npm start       # production mode
npm test        # full test suite (spins up its own in-memory MongoDB)
```

Then open **<http://localhost:4000/api-docs>** and try the API from the browser:
submit a report, copy the `caseCode`, track it, log in, click **Authorize**,
paste the token, and work the queue.

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
| `GET` | `/reports/:caseCode` | Track a case: status + moderator updates |
| `GET` | `/meta` | Categories, statuses and the status workflow |
| `GET` | `/health` | Liveness probe (also at the root `/health`) |

### Moderator — `Authorization: Bearer <token>`

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login` | Exchange credentials for a JWT |
| `GET` | `/auth/me` | Who the current token belongs to |
| `GET` | `/moderator/reports` | List reports — `?status=&category=&page=&limit=&sort=` |
| `GET` | `/moderator/reports/:id` | Full report with description and update history |
| `PATCH` | `/moderator/reports/:id/status` | Move the report to a new status |
| `POST` | `/moderator/reports/:id/updates` | Add a note without changing status |
| `GET` | `/moderator/stats` | Report counts per status |

### Status codes used

| Code | When |
| --- | --- |
| `200 OK` | Successful read or status change |
| `201 Created` | Report submitted, or update added |
| `400 Bad Request` | Validation failed, malformed JSON, malformed id or case code |
| `401 Unauthorized` | Missing, malformed, expired, forged token; bad credentials |
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

### What each audience can see

| | Reporter (case code) | Moderator (JWT) |
| --- | --- | --- |
| Status, timestamps | ✅ | ✅ |
| Category | ✅ | ✅ |
| Moderator update messages | ✅ | ✅ |
| Description / evidence URL | ❌ | ✅ |
| Internal report id | ❌ | ✅ |
| Which moderator wrote an update | ❌ | ✅ |
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
| Someone finds a reporter's case code | Sees status and updates only — not the report body |
| Attacker guesses case codes | ~73 bits of entropy plus a lookup rate limit |
| Malicious client posts `email` alongside a report | Rejected with `400`; nothing is stored |
| Moderator account is compromised | Attacker sees report contents — but still no reporter identity. Accounts can be deactivated and lose access on the very next request |
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
| No self-registration | Moderator accounts are created by an operator via CLI |
| Input validation | Zod on body, query and params; unknown keys rejected |
| Injection | Validated-and-typed input into Mongoose; no string-built queries, no `$where` |
| XSS via stored links | `evidenceUrl` is restricted to `http(s)`, blocking `javascript:` and `data:` payloads |
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

**10. Moderators are a single flat role.**
An admin/moderator split was not required. The JWT already carries a `role`
claim, so adding one later is an authorization middleware, not a redesign.

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
- **No data retention policy yet.** Reports live forever. A real deployment
  should age out resolved cases (for example, delete 12 months after closure) —
  the less data kept, the less there is to leak.
- **No moderator audit log beyond status updates.** Reads are not recorded; a
  regulated deployment would want a separate audit trail of who opened which
  report.
- **No notifications.** Reporters must poll their case code. That is the
  anonymity-preserving choice — any push channel is an identifier.

---

## License

MIT
