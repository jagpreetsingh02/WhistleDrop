# WhistleDrop — Speak Without Being Seen

[![CI](https://github.com/jagpreetsingh02/WistleDrop/actions/workflows/ci.yml/badge.svg)](https://github.com/jagpreetsingh02/WistleDrop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-339933?logo=node.js&logoColor=white)](package.json)

WhistleDrop is a backend API for anonymous whistleblowing. Anyone can file a
report without an account, an email address or a session, and receives a
one-time **case code** — the only key to their case. With it they can follow
the investigation and answer a moderator's questions, while the system stays
unable to identify them: no IP addresses, user-agents or accounts are stored,
the case code exists only as a hash, timestamps are blurred to 15-minute
windows, and closed cases delete themselves. Moderators work the queue behind
JWT authentication, and every report they open is written to a tamper-evident
audit log, so the people watching are watched too.

**Stack:** Node.js · Express 5 · MongoDB (Mongoose 8) · Zod 4 · JWT · Swagger / OpenAPI 3 · Jest + Supertest · Docker

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Getting started](#getting-started) — local and Docker
4. [Configuration](#configuration)
5. [API endpoints](#api-endpoints)
6. [Examples](#examples) — real requests and responses
7. [Status workflow](#status-workflow)
8. [Anonymity and privacy design](#anonymity-and-privacy-design)
9. [Security controls](#security-controls)
10. [Threat model](#threat-model)
11. [Testing and quality](#testing-and-quality)
12. [Design decisions](#design-decisions)
13. [Screenshots](#screenshots)
14. [Known limitations](#known-limitations)

---

## Features

**For reporters (anonymous)**

- Submit a report (category, description, optional evidence link) with no
  account — receive a cryptographically random case code, shown once.
- Track the case: status, public moderator updates and the message thread.
- Answer moderators' questions in an anonymous two-way thread, using only the
  case code.
- Get warned when their own text looks identifying (email, phone, ID, `@handle`,
  "my name is…") — without the API ever echoing the text back.

**For moderators (JWT)**

- List, full-text search and filter reports by status, category, date range,
  evidence and "waiting for reporter"; sort by newest, oldest or recently
  updated.
- Move reports through an enforced workflow — illegal transitions return `422`
  with the moves that *are* allowed, and concurrent edits can never silently
  overwrite each other.
- Post public updates for the reporter, or internal notes they never see.
- Ask the reporter a question and see the case flagged until they answer.

**For admins**

- Create, list, deactivate and reactivate staff accounts (deactivation takes
  effect on the very next request).
- Read the staff audit log and verify its SHA-256 hash chain to detect edited,
  deleted or re-ordered entries.

**Privacy and operations**

- Only the SHA-256 of the case code is stored; reporter timestamps (including
  the one hidden inside the MongoDB `_id`) are coarsened; closed reports are
  deleted after a retention period by a TTL index.
- `Cache-Control: no-store` on every reporter and staff route, Helmet, five rate
  limiters, strict Zod validation that rejects unknown fields.
- Swagger UI, a Postman collection, a dev-only seed script, Docker image and
  compose stack, and CI on Node 20 and 22.

---

## Architecture

```
                         ┌─────────────────────────────────────────────────────────┐
  Reporter ──(no auth)──▶│  helmet · cors · express.json(100 KB) · trust proxy     │
  Moderator ─(JWT)──────▶│  global rate limiter (/api/v1)                          │
  Admin ────(JWT+role)──▶│                                                         │
                         │  routes/       noStore → route limiter → validate(Zod)  │
                         │                → requireModerator → requireRole         │
                         │      │                                                  │
                         │  controllers/  read req.validated, shape the envelope   │
                         │      │         (no business logic)                      │
                         │  services/     the rules: case codes, workflow, atomic  │
                         │      │         writes, presenters, PII scan, audit log  │
                         │  models/       Mongoose schemas in strict mode — the    │
                         │                last word on what may be stored          │
                         └──────┬──────────────────────────────────────────────────┘
                                ▼
                   MongoDB: reports · moderators · auditlogs
                   (TTL index deletes closed reports; text index powers search)

  Any error, from any layer ──▶ middleware/errorHandler ──▶ { success: false, error: { … } }
```

Each layer has one job, so controllers stay thin and the domain rules can be
tested without HTTP. Responses are built by **explicit presenters**
(`toReporterView`, `toModeratorView`, …) field by field, never by serialising a
document — which is what guarantees internal fields cannot leak by accident.

```
src/
├── app.js                   builds the Express app (exported for tests)
├── server.js                connects to MongoDB, syncs indexes, listens, shuts down gracefully
├── config/
│   ├── env.js               loads and validates every environment variable (fail fast)
│   ├── db.js                connect / disconnect / syncIndexes
│   └── swagger.js           hand-written OpenAPI 3 document
├── models/                  Report (+ embedded updates and messages), Moderator, AuditLog
├── controllers/             report (public), auth, moderation, admin
├── routes/                  one router per audience; guards applied router-wide
├── middleware/              auth + requireRole, validate, rateLimiter, noStore, notFound, errorHandler
├── services/                report, auth, admin, audit
├── validators/              Zod schemas per resource
└── utils/                   caseCode, statusWorkflow, timeBuckets, piiScanner, constants, AppError, logger
scripts/                     createModerator.js (provisioning CLI), seed.js (dev-only demo data)
tests/                       19 suites — unit and integration against a real in-memory MongoDB
docs/                        Postman collection, screenshot checklist
```

**Response envelope.** Every response — success or failure — has one shape:

```jsonc
{ "success": true,  "message": "…", "data": { … }, "meta": { … } }
{ "success": false, "error": { "message": "…", "details": … } }
```

---

## Getting started

### Local

**Prerequisites:** Node.js ≥ 20.19 and MongoDB (local or Atlas).

```bash
git clone https://github.com/jagpreetsingh02/WistleDrop.git
cd WistleDrop
npm install
cp .env.example .env
```

Set `MONGODB_URI` and `JWT_SECRET` in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # a strong JWT_SECRET
```

Startup validates every variable with Zod and **exits with a clear message** if
something is missing or too weak, so a bad config fails at boot, not in
production traffic.

Create the first admin. There is no public sign-up endpoint; after this,
admins manage accounts through `/api/v1/admin`:

```bash
npm run create:moderator -- --username root --password "Adm1n-Long-Passphrase" --name "Integrity Office" --role admin
```

Run it:

```bash
npm run dev      # node --watch, restarts on file changes
npm start        # production mode
```

Open **<http://localhost:4000/api-docs>**: submit a report, copy the `caseCode`,
track it, log in, click **Authorize**, paste the token and work the queue.

**Demo data (development only).** `npm run seed` creates `demo-admin` and
`demo-moderator` accounts and five sample reports in different states, all
through the real services, and prints their case codes. It **refuses to run
when `NODE_ENV=production`**, before connecting to any database.

### Docker

```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
docker compose up -d --build --wait            # API + MongoDB, waits for both health checks
docker compose exec api node scripts/createModerator.js \
  --username root --password "Adm1n-Long-Passphrase" --role admin
open http://localhost:4000/api-docs
docker compose down                             # add -v to delete the data volume
```

- **Multi-stage image** on `node:22-alpine`. Production dependencies are
  installed in their own stage with `--ignore-scripts`, so the runtime image has
  no dev tooling, npm cache or install-time scripts.
- Runs as the unprivileged **`node`** user, with a `HEALTHCHECK` on `/health`
  that uses Node's built-in `fetch` (no curl in the image).
- MongoDB stores data in the named volume `mongo-data` and **publishes no port**:
  only the API container can reach it.
- `.dockerignore` keeps `.env`, tests and git history out of the build context.

### Deploying behind a load balancer

Set **`TRUST_PROXY=1`** (or the number of proxy hops). Without it, Express sees
every request as coming from the load balancer's IP, so **all reporters share
one rate-limit bucket** and a single abuser can lock everyone out. Avoid
`TRUST_PROXY=true`: it trusts any `X-Forwarded-For` value, letting a client pick
its own bucket. A forgotten setting shows up in the logs as
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.

---

## Configuration

All variables are validated in [`src/config/env.js`](src/config/env.js);
[`.env.example`](.env.example) is the committed template, and `.env` is
gitignored.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` · `test` · `production` |
| `PORT` | `4000` | HTTP port |
| `MONGODB_URI` | — | **Required.** MongoDB connection string |
| `JWT_SECRET` | — | **Required.** At least 32 characters |
| `JWT_EXPIRES_IN` | `2h` | Staff session length |
| `BCRYPT_ROUNDS` | `12` | bcrypt work factor for staff passwords (4–15; the test suite uses 4) |
| `TRUST_PROXY` | `0` | Reverse-proxy hops in front of the API — **`1` behind a load balancer** |
| `TIMESTAMP_BUCKET_MINUTES` | `15` | Reporter-originated timestamps are rounded down to this window (`0` = exact) |
| `RETENTION_DAYS_AFTER_CLOSE` | `365` | Closed reports are deleted this many days after closing (`0` = keep forever) |
| `CORS_ORIGIN` | `*` | Comma-separated allowlist, or `*` |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | Window shared by all limiters |
| `RATE_LIMIT_MAX` | `100` | Requests per window, whole API |
| `REPORT_RATE_LIMIT_MAX` | `5` | Report submissions per window |
| `AUTH_RATE_LIMIT_MAX` | `10` | Login attempts per window |
| `TRACK_RATE_LIMIT_MAX` | `20` | Case-code lookups per window |
| `REPORTER_MESSAGE_RATE_LIMIT_MAX` | `10` | Reporter replies per window |

The scripts also read `MODERATOR_USERNAME` / `MODERATOR_PASSWORD` /
`MODERATOR_NAME` / `MODERATOR_ROLE` (CLI flags take precedence) and
`SEED_ADMIN_PASSWORD` / `SEED_MODERATOR_PASSWORD`.

---

## API endpoints

Base URL `/api/v1`. Interactive documentation at `/api-docs`; the raw OpenAPI
document at `/api-docs.json`.

### Public — no authentication

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/reports` | Submit an anonymous report; returns the case code (once) and PII warnings |
| `GET` | `/reports/:caseCode` | Track a case: status, public updates, message thread |
| `POST` | `/reports/:caseCode/messages` | Reply to moderators anonymously; returns PII warnings |
| `POST` | `/auth/login` | Exchange staff credentials for a JWT |
| `GET` | `/meta` | Categories, statuses and the status workflow |
| `GET` | `/health` | Liveness probe (also at the root `/health`) |

### Moderator — `Authorization: Bearer <token>` (role `moderator` or `admin`)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/auth/me` | Who the token belongs to |
| `GET` | `/moderator/reports` | List, search and filter — `?status=&category=&q=&from=&to=&hasEvidence=&awaitingReporter=&sort=&page=&limit=` |
| `GET` | `/moderator/reports/:id` | Full report with updates and messages (audit-logged) |
| `PATCH` | `/moderator/reports/:id/status` | Move the report along the workflow |
| `POST` | `/moderator/reports/:id/updates` | Add a public update or an internal note |
| `POST` | `/moderator/reports/:id/messages` | Ask the reporter a question |
| `GET` | `/moderator/stats` | Report counts per status |

### Admin — `Authorization: Bearer <token>` (role `admin`)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/admin/moderators` | Create a moderator or admin account |
| `GET` | `/admin/moderators` | List staff accounts |
| `PATCH` | `/admin/moderators/:id/deactivate` | Deactivate an account (effective on its next request) |
| `PATCH` | `/admin/moderators/:id/activate` | Reactivate an account |
| `GET` | `/admin/audit-log` | Staff audit log, newest first |
| `GET` | `/admin/audit-log/verify` | Recompute the hash chain and report the first break |

### Status codes

| Code | Meaning in this API |
| --- | --- |
| `200` / `201` | Success / resource created |
| `400` | Malformed input: validation, unknown fields, bad JSON, malformed id or case code |
| `401` | Not authenticated: missing, invalid, expired or forged token; bad credentials; role changed since login |
| `403` | Authenticated but not allowed: moderator on an admin route; admin deactivating themselves |
| `404` | Unknown case code, report, account or route |
| `409` | State conflict: already in that status, case closed, another moderator changed it concurrently, thread full, account already (in)active, username taken |
| `413` | Body over 100 KB |
| `422` | Well-formed request that the status workflow forbids |
| `429` | Rate limited |
| `500` / `503` | Unexpected failure (generic message, details only in server logs) / audit log contended |

---

## Examples

> Every payload below is real output from a running instance (tokens and ids
> abbreviated where marked).

### Submit a report

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
    "caseCode": "WD-HGGHE-6M4D5-5Y7KY",
    "category": "SECURITY",
    "status": "SUBMITTED",
    "submittedAt": "2026-10-03T13:15:00.000Z",
    "warnings": []
  }
}
```

`submittedAt` is the start of the 15-minute window, never the real time. The
response carries `Cache-Control: no-store`.

### PII warning

When the text looks identifying, the report is still accepted, but the reporter
is told — by category, never by quoting the match:

```json
// description: "My name is Sam. The lab admin password is on a sticky note; email me at sam.k@example.com."
"warnings": [
  {
    "code": "POSSIBLE_EMAIL",
    "message": "The text appears to contain an email address. Moderators will see this text. If it could identify you, avoid repeating such details in follow-up messages."
  },
  {
    "code": "POSSIBLE_SELF_IDENTIFICATION",
    "message": "The text appears to name or describe how to contact the author. Moderators will see this text. If it could identify you, avoid repeating such details in follow-up messages."
  }
]
```

### Validation — every problem at once, unknown fields rejected

```json
// { "category": "Gossip", "description": "too short", "email": "me@example.com" }  →  400
{
  "success": false,
  "error": {
    "message": "Validation failed",
    "details": [
      { "field": "body.category", "message": "category must be one of: SECURITY, HARASSMENT, CORRUPTION, TECHNICAL, OTHER" },
      { "field": "body.description", "message": "description must be at least 20 characters" },
      { "field": "body", "message": "Unrecognized key: \"email\"" }
    ]
  }
}
```

### Track a case

Codes are matched case-insensitively with separators ignored, so
`wd hgghe 6m4d5 5y7ky` works too. An unknown code returns `404`:
`"No case found for that code. Check the code and try again."`

```json
// GET /api/v1/reports/WD-HGGHE-6M4D5-5Y7KY  — after a moderator asked a question
{
  "success": true,
  "data": {
    "category": "SECURITY",
    "status": "UNDER_REVIEW",
    "submittedAt": "2026-10-03T13:15:00.000Z",
    "lastUpdatedAt": "2026-10-03T13:23:20.014Z",
    "isClosed": false,
    "awaitingYourReply": true,
    "updates": [
      {
        "message": "We have opened an investigation and contacted the infrastructure team.",
        "status": "UNDER_REVIEW",
        "createdAt": "2026-10-03T13:23:20.004Z"
      }
    ],
    "messages": [
      { "from": "MODERATOR", "body": "Which repository are the credentials in?", "createdAt": "2026-10-03T13:23:20.014Z" }
    ]
  }
}
```

Absent by design: the report id, the description, the evidence link, which
moderator acted, and the internal note that was added in between (see below).

### Moderator login

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
    "moderator": { "id": "6ac101c73e7eeae0f95616fe", "username": "alice", "displayName": "Ethics Desk", "role": "moderator" }
  }
}
```

### Search and filter

```bash
curl "http://localhost:4000/api/v1/moderator/reports?q=credentials&category=security&hasEvidence=true&from=2026-01-01&to=2026-12-31&sort=recentlyUpdated" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "success": true,
  "data": [
    {
      "id": "6ac0ffd47702669405534346",
      "category": "SECURITY",
      "status": "SUBMITTED",
      "descriptionPreview": "Production database credentials are committed to a public repository and have not been rotated since March.",
      "hasEvidence": true,
      "updateCount": 0,
      "messageCount": 0,
      "awaitingReporter": false,
      "submittedAt": "2026-10-03T13:15:00.000Z",
      "lastUpdatedAt": "2026-10-03T13:15:00.000Z"
    }
  ],
  "meta": {
    "page": 1, "limit": 20, "total": 1, "totalPages": 1,
    "sort": "recentlyUpdated",
    "filters": {
      "status": null, "category": "SECURITY", "q": "credentials",
      "from": "2026-01-01T00:00:00.000Z", "toExclusive": "2027-01-01T00:00:00.000Z",
      "hasEvidence": true, "awaitingReporter": null
    }
  }
}
```

| Parameter | Meaning |
| --- | --- |
| `q` | Full-text search over descriptions (MongoDB text index: stemmed, case-insensitive, words OR-ed; `"phrase"` and `-exclude` work) |
| `from` / `to` | Submission date range. `from` is inclusive; a plain-date `to` includes that whole day. `meta.filters` shows the normalised bounds |
| `hasEvidence` · `awaitingReporter` | `true` / `false` |
| `sort` | `newest` (default) · `oldest` · `recentlyUpdated` |
| `limit` | 1–100 (default 20) |

A reversed range is a `400`:
`{ "field": "query.to", "message": "to must not be earlier than from" }`.

### Status change rejected by the workflow

```json
// PATCH /api/v1/moderator/reports/:id/status  { "status": "RESOLVED" }  on a SUBMITTED report  →  422
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

### Status change accepted, internal note, question to the reporter

```bash
curl -X PATCH .../moderator/reports/$ID/status   -d '{ "status": "UNDER_REVIEW", "message": "We have opened an investigation and contacted the infrastructure team." }'
curl -X POST  .../moderator/reports/$ID/updates  -d '{ "message": "Repo owner identified as the platform team; rotation planned tonight.", "visibility": "INTERNAL" }'
curl -X POST  .../moderator/reports/$ID/messages -d '{ "body": "Which repository are the credentials in?" }'
```

The moderator's view after those three calls (abridged to the parts that
changed):

```json
{
  "success": true,
  "message": "Message sent to the reporter",
  "data": {
    "id": "6ac0ffd47702669405534346",
    "status": "UNDER_REVIEW",
    "allowedTransitions": ["RESOLVED", "DISMISSED"],
    "closedAt": null,
    "awaitingReporter": true,
    "messages": [
      {
        "from": "MODERATOR",
        "body": "Which repository are the credentials in?",
        "createdAt": "2026-10-03T13:23:20.014Z",
        "moderator": { "id": "6ac101c73e7eeae0f95616fe", "displayName": "Ethics Desk" }
      }
    ],
    "updates": [
      { "id": "6ac101c8b3c0757c7a0071c3", "message": "We have opened an investigation and contacted the infrastructure team.", "status": "UNDER_REVIEW", "visibility": "PUBLIC", "createdAt": "2026-10-03T13:23:20.004Z", "moderator": { "id": "6ac101c73e7eeae0f95616fe", "displayName": "Ethics Desk" } },
      { "id": "6ac101c8b3c0757c7a0071cb", "message": "Repo owner identified as the platform team; rotation planned tonight.", "status": null, "visibility": "INTERNAL", "createdAt": "2026-10-03T13:23:20.010Z", "moderator": { "id": "6ac101c73e7eeae0f95616fe", "displayName": "Ethics Desk" } }
    ]
  }
}
```

Compare with the reporter's view of the same moment in
[Track a case](#track-a-case): the internal note is missing, there is no
moderator identity, and the reporter's `lastUpdatedAt` points at the last
*public* event (13:23:20.014), not at the internal note.

### The reporter answers

```bash
curl -X POST http://localhost:4000/api/v1/reports/WD-HGGHE-6M4D5-5Y7KY/messages \
  -H "Content-Type: application/json" \
  -d '{ "body": "It is the infra-scripts repo, in the deploy folder. Ping me on @sam_k if needed." }'
```

```json
{
  "success": true,
  "message": "Message sent",
  "data": {
    "status": "UNDER_REVIEW",
    "awaitingYourReply": false,
    "messages": [
      { "from": "MODERATOR", "body": "Which repository are the credentials in?", "createdAt": "2026-10-03T13:23:20.014Z" },
      { "from": "REPORTER", "body": "It is the infra-scripts repo, in the deploy folder. Ping me on @sam_k if needed.", "createdAt": "2026-10-03T13:15:00.000Z" }
    ],
    "warnings": [
      {
        "code": "POSSIBLE_SOCIAL_HANDLE",
        "message": "The text appears to contain a social media or chat handle (@name). Moderators will see this text. If it could identify you, avoid repeating such details in follow-up messages."
      }
    ]
  }
}
```

The reply's `createdAt` is the **start of its 15-minute window** (13:15), so it
can display as earlier than the question it answers. That is coarsening
working as intended; **the array order is the true order** of the
conversation.

Once the case is closed, further replies are refused:

```json
// 409
{ "success": false, "error": { "message": "This case is closed (RESOLVED) and no longer accepts messages" } }
```

### Concurrent moderators

If two moderators act on the same report at once (`UNDER_REVIEW → RESOLVED` and
`UNDER_REVIEW → DISMISSED`), exactly one wins. The other receives:

```json
// 409
{
  "success": false,
  "error": {
    "message": "Report status changed from UNDER_REVIEW to RESOLVED while this request was in flight. Reload and try again.",
    "details": { "expectedStatus": "UNDER_REVIEW", "currentStatus": "RESOLVED" }
  }
}
```

### Admin: accounts

```json
// POST /api/v1/admin/moderators  { "username": "Neha.R", "password": "An0ther-Long-Passphrase", "displayName": "Compliance Desk" }  →  201
{
  "success": true,
  "message": "Account \"neha.r\" created",
  "data": { "id": "6ac101c8b3c0757c7a0071ff", "username": "neha.r", "displayName": "Compliance Desk", "role": "moderator", "isActive": true, "createdAt": "2026-10-03T13:23:20.425Z" }
}
```

```json
// PATCH /api/v1/admin/moderators/<own id>/deactivate  →  403
{ "success": false, "error": { "message": "Admins cannot deactivate their own account" } }

// any /admin route called by a moderator  →  403
{ "success": false, "error": { "message": "This action requires the admin role" } }
```

### Admin: audit log and tamper detection

```json
// GET /api/v1/admin/audit-log?limit=4  (first two entries shown)
{
  "success": true,
  "data": [
    {
      "seq": 8,
      "action": "ADMIN_DEACTIVATE_ACCOUNT",
      "moderator": { "id": "6ac101c648eff16b466dfae4", "username": "root", "displayName": "Integrity Office" },
      "reportId": null,
      "targetModeratorId": "6ac101c8b3c0757c7a0071ff",
      "createdAt": "2026-10-03T13:23:20.428Z",
      "prevHash": "39a2dabcf40b41d47efd5fe65d76d1c603709ec0af0731a9453d23e95441d5c2",
      "hash": "1c0bac875c9f23d42872fcb34bf3b764e81c6eb2bd77f1756e9fb6794ac1e9f3"
    },
    {
      "seq": 7,
      "action": "ADMIN_CREATE_ACCOUNT",
      "moderator": { "id": "6ac101c648eff16b466dfae4", "username": "root", "displayName": "Integrity Office" },
      "reportId": null,
      "targetModeratorId": "6ac101c8b3c0757c7a0071ff",
      "createdAt": "2026-10-03T13:23:20.425Z",
      "prevHash": "036b4d2bd1f596fdafbd08637f46d0b756f2c8d5ce31c9b4e64a846831126aba",
      "hash": "39a2dabcf40b41d47efd5fe65d76d1c603709ec0af0731a9453d23e95441d5c2"
    }
  ],
  "meta": { "page": 1, "limit": 4, "total": 8, "totalPages": 2 }
}
```

Each entry's `prevHash` is the previous entry's `hash`. Verification, before and
after someone edits entry #3 directly in the database:

```json
// GET /api/v1/admin/audit-log/verify
{ "success": true, "message": "Audit log is intact",
  "data": { "intact": true, "checkedEntries": 8, "headSeq": 8, "headHash": "1c0bac875c9f23d42872fcb34bf3b764e81c6eb2bd77f1756e9fb6794ac1e9f3" } }

// after: db.auditlogs.updateOne({ seq: 3 }, { $set: { action: "LOGIN" } })
{ "success": true, "message": "Audit log has been tampered with at entry #3",
  "data": { "intact": false, "checkedEntries": 2, "brokenAtSeq": 3, "reason": "CONTENT_HASH_MISMATCH" } }
```

### Workflow discovery

```json
// GET /api/v1/meta
{
  "success": true,
  "data": {
    "categories": ["SECURITY", "HARASSMENT", "CORRUPTION", "TECHNICAL", "OTHER"],
    "statuses": ["SUBMITTED", "UNDER_REVIEW", "RESOLVED", "DISMISSED"],
    "workflow": { "SUBMITTED": ["UNDER_REVIEW", "DISMISSED"], "UNDER_REVIEW": ["RESOLVED", "DISMISSED"], "RESOLVED": [], "DISMISSED": [] }
  }
}
```

---

## Status workflow

```
   ┌───────────┐        ┌──────────────┐        ┌──────────┐
   │ SUBMITTED │───────▶│ UNDER_REVIEW │───────▶│ RESOLVED │  final
   └─────┬─────┘        └──────┬───────┘        └──────────┘
         │                     │                ┌───────────┐
         └─────────────────────┴───────────────▶│ DISMISSED │  final
                                                └───────────┘
```

| From | May move to |
| --- | --- |
| `SUBMITTED` | `UNDER_REVIEW`, `DISMISSED` |
| `UNDER_REVIEW` | `RESOLVED`, `DISMISSED` |
| `RESOLVED` · `DISMISSED` | — (final) |

- Every report starts at `SUBMITTED`; clients cannot choose the initial status.
- Skipping review, moving backwards and reopening a closed case are `422`, and
  the response lists the transitions that are allowed.
- Requesting the current status is `409`, not a silent no-op.
- **Transitions are atomic.** The write is one `findOneAndUpdate` filtered on
  the status that was validated, so concurrent moderators cannot both win (see
  [the example](#concurrent-moderators)). A rejected transition changes nothing.
- Closing a case sets `closedAt` (starting the retention clock) and clears
  `awaitingReporter` **in that same write**. Closed cases accept no new updates
  or messages.
- Every accepted transition appends a `PUBLIC` update recording the new status,
  the message and the moderator.

The rules live in one table, [`src/utils/statusWorkflow.js`](src/utils/statusWorkflow.js).

---

## Anonymity and privacy design

The goal: **the system should be unable to identify a reporter, even if the
database is stolen.** Each mechanism below is enforced in code and covered by
tests.

### What a report stores — and what it never does

A stored report has exactly these fields (a test asserts the key set after a
request carrying `X-Forwarded-For`, a fingerprintable `User-Agent` and a
`Referer`):

```
_id · caseCodeHash · category · description · evidenceUrl · status
updates[] · messages[] · awaitingReporter · closedAt · createdAt · updatedAt · __v
```

| Never stored | Why |
| --- | --- |
| IP address | The most identifying field in a normal request |
| User-agent, `Referer` | Fingerprinting; the referrer reveals *where* the report was filed from |
| Email, name, username | Reporters have no account at all |
| Session or cookie | Nothing links two actions by the same person |
| Uploaded files | Documents carry metadata (author, device, GPS); only an external link is accepted |
| HTTP access logs | No `morgan`-style request logging — that is where identifying data quietly piles up |

This is enforced three times over: **Zod `strictObject`** rejects unknown fields
with `400`, **Mongoose strict mode** would drop them anyway, and **explicit
presenters** build every response field by field.

### The case code

```
WD-HGGHE-6M4D5-5Y7KY      15 characters from a 30-character alphabet ≈ 73 bits of entropy
```

- Generated with `crypto.randomInt()` (a CSPRNG), never `Math.random()`.
- The alphabet drops `0 O 1 I L U`, the characters people misread.
- **Only its SHA-256 is stored.** A stolen database cannot be turned back into
  working codes. SHA-256 rather than bcrypt is correct here: the input is
  high-entropy random data, so there is nothing to brute-force, and lookups stay
  one indexed query.
- Shown exactly once. If a reporter loses it, nobody — not even an administrator
  with database access — can recover it. The submission response says so plainly.

### Timestamp coarsening

An exact submission time is an identifier in disguise: *"the report arrived at
14:32:07"* can be matched against badge swipes or who left a meeting early. So
every reporter-originated time is **rounded down to a 15-minute window before it
is written** (`TIMESTAMP_BUCKET_MINUTES`):

- `createdAt` and the initial `updatedAt` of a report;
- the report's **`_id`** — a MongoDB ObjectId embeds its creation time to the
  second, so report ids are generated from the window start plus 8 random bytes;
- each reporter message's `createdAt`. Messages have **no per-message ObjectId**
  (it would embed the exact time), and a reply moves the report's `updatedAt`
  forward only to the window start (`$max`, with Mongoose timestamps disabled for
  that write).

Moderator actions keep exact times — they describe staff activity, not the
reporter's.

### PII warnings on free text

Reporters often undo their own anonymity. Descriptions and replies go through
[`piiScanner.js`](src/utils/piiScanner.js), which detects emails, phone and long
personal numbers, `@handles`, employee/student/badge IDs and phrases like *"my
name is"*.

- **It never blocks.** Rejecting a real report over a false positive would be
  far worse than an unnecessary warning, so it leans towards over-warning.
- **It returns codes, never the matched text.** Nothing it finds is logged,
  stored or echoed back.
- It is a pure function, with unit tests for what it must catch *and* for
  ordinary report text it must not flag (dates, versions, IPs, CVE ids, amounts).

### Retention

When a report becomes `RESOLVED` or `DISMISSED`, `closedAt` is set in the same
atomic write, and a MongoDB **TTL index** deletes the report
`RETENTION_DAYS_AFTER_CLOSE` days later (default 365; `0` disables it). Open
reports have `closedAt: null` and are never touched. Indexes are synchronised at
startup, so a changed retention period takes effect on the next restart. A test
runs MongoDB's TTL monitor every second and checks that a report closed 400 days
ago is really deleted while an open one survives.

### Caching

`Cache-Control: no-store` and `Pragma: no-cache` are sent on every response from
the reporter, auth, moderator and admin routers — including their own
`400`/`404`/`409`/`429` errors. A cached tracking page on a
shared computer — or in a corporate proxy — would reveal that someone looked up
a whistleblowing case, and the submission response carries the case code itself.

### What each audience can see

| | Reporter (case code) | Moderator | Admin |
| --- | :-: | :-: | :-: |
| Status, category, submission window | ✅ | ✅ | ✅ |
| `PUBLIC` moderator updates | ✅ | ✅ | ✅ |
| `INTERNAL` moderator notes | ❌ | ✅ | ✅ |
| Message thread | ✅ side only (`REPORTER` / `MODERATOR`) | ✅ with moderator name | ✅ with moderator name |
| Which moderator acted | ❌ | ✅ | ✅ |
| Description and evidence link | ❌ | ✅ | ✅ |
| Internal report id, `closedAt` | ❌ | ✅ | ✅ |
| Other reports | ❌ | ✅ | ✅ |
| Staff accounts, audit log | ❌ | ❌ | ✅ |
| Case code, case-code hash, any reporter identity | ❌ | ❌ | ❌ |

The reporter's view leaves out their own description on purpose: the tracking
page answers *"what is happening with my case?"*, so a shoulder-surfed code
reveals a status, not the allegation. The reporter's `lastUpdatedAt` is
computed from public events only — the stored `updatedAt` also moves when an
internal note is added, which would reveal private discussion.

### Rate limiting — the one honest exception

Rate limiters key on IP address. That IP is held **in memory for the window
only** — never written to the database, a log line or a report. Without it the
tracking endpoint could be brute-forced and the submission endpoint flooded.

---

## Security controls

| Control | Implementation |
| --- | --- |
| Security headers | `helmet()` globally; a relaxed CSP scoped to `/api-docs` only, so Swagger UI works without weakening the API |
| Authentication | HS256 JWT with `issuer` and `audience` verified on every request |
| Account re-check | The account is re-loaded per request: a deactivated account loses access immediately, and a token whose `role` claim no longer matches the account is rejected (`401`) |
| Authorisation | `requireRole('admin')` on the whole admin router — checks the database role, not the token claim |
| Passwords | bcrypt (cost 12 by default), hash `select: false` and stripped from JSON; 12-character minimum for new accounts |
| User enumeration | Unknown user, wrong password and inactive account all return the same `401`, and a dummy bcrypt comparison equalises timing |
| No self-registration | First admin via CLI; further accounts only by an admin |
| Validation | Zod on body, query and params; `strictObject` everywhere, so unknown keys are a `400` |
| Injection / ReDoS | Typed input into Mongoose; no string-built queries or `$where`; search uses a `$text` index, never a `RegExp` built from input |
| Stored XSS via links | `evidenceUrl` must be `http(s)` — `javascript:` and `data:` are rejected |
| Race conditions | Status changes, notes, messages and account (de)activation are single atomic updates filtered on the expected state |
| Payload size | JSON bodies capped at 100 KB (`413`) |
| Rate limiting | Global, submission, login, case lookup and reporter-reply limiters; `TRUST_PROXY` for correct client IPs behind a proxy |
| Caching | `no-store` on every response from the reporter, auth, moderator and admin routers, including their errors |
| Error leakage | Unexpected errors are logged server-side; clients get a generic `500` (the message is added as `debug` outside production only) |
| Accountability | Hash-chained audit log of logins, report views, status changes, notes, messages and admin actions |
| Secrets | `.env` is gitignored and excluded from the Docker build context; startup refuses a weak `JWT_SECRET` |
| Container | Non-root user, production dependencies only, install scripts disabled, database not exposed |

---

## Threat model

| Threat | What happens |
| --- | --- |
| Database dump is leaked | Report contents are readable, but no reporter identity exists in them, case codes cannot be recovered from their hashes, and timestamps only place a report within a 15-minute window |
| **Timing correlation** — matching when a report or reply arrived to someone's movements | Only the window start is stored, in `createdAt`, inside the ObjectId and on every reporter message |
| **PII in free text** — the reporter names or contacts themselves | Flagged back to them as a warning (codes only) on submission and on every reply; the API never repeats the text |
| Someone finds a reporter's case code | They see status, public updates and the thread — not the description or evidence — and could post a reply as the reporter. The code is the credential, so it must be kept private |
| Case-code guessing | ~73 bits of entropy plus a lookup rate limit |
| Client posts `email` / `reporterName` alongside a report | Rejected with `400`; nothing stored |
| Cached responses on a shared machine or proxy | `Cache-Control: no-store` on every reporter, auth, moderator and admin route |
| **A moderator abuses access** (snooping, or quietly altering a case) | Every report they open is logged *before* it is shown, along with every status change, note and message, all tied to their account |
| **Someone edits the audit trail to hide it** | The hash chain exposes edited, re-hashed, deleted and re-ordered entries; anchoring `headHash` externally also exposes the newest entries being removed |
| A moderator account is compromised | Contents are exposed, never reporter identity; an admin deactivation cuts it off on its next request, and its activity is in the audit log |
| Two moderators act on one case at once | Exactly one write wins; the other gets `409` |
| Network-level observation (ISP, corporate proxy, the server's own network logs) | **Out of scope.** The application stores no IP, but the network still sees the connection. Reporters needing that protection should use Tor or a network they do not control |

---

## Testing and quality

```bash
npm test                  # 285 tests across 19 suites
npm run test:coverage     # with coverage
npm run lint              # ESLint, zero warnings allowed
npm run format:check      # Prettier
```

Integration tests run against a **real MongoDB** started in memory
(`mongodb-memory-server`), so indexes, unique constraints, text search,
aggregation and TTL deletion behave as in production — without a database
install or a shared test database.

**Coverage:** 94.5% statements · 84.2% branches · 93.1% functions · 94.9% lines.

| Suite | What it proves |
| --- | --- |
| `reports` | Submission, validation, PII warnings, tracking, case-code normalisation, privacy of the stored document, timestamp coarsening, `no-store` caching |
| `moderation` | Listing, filters, pagination, detail, every workflow transition, internal-note visibility, the end-to-end reporter journey |
| `search` | Text search, stemming, regex metacharacters as plain text, date ranges, evidence filter, sorting, combined filters |
| `messages` | The full two-way conversation, identity never leaking, coarse reporter times, closed-case and thread-size rejection, validation |
| `concurrency` | Two conflicting transitions in parallel (forced by a read barrier): exactly one `200` and one `409`; stale reads; notes racing a close |
| `retention` / `retentionDisabled` | `closedAt` set atomically, TTL index definition, real deletion by MongoDB, disabled retention |
| `admin` | `401` / `403` on every admin route, account creation and validation, (de)activation, self-deactivation, role re-validation |
| `audit` | What is recorded and what is not, no reporter data or IPs in entries, fail-closed views, tamper detection (edit, re-hash, delete, re-order), concurrent appends |
| `auth` | Login, enumeration resistance, tampered / forged / expired / wrong-audience tokens, deactivated and deleted accounts |
| `rateLimit` / `trustProxy` | `429`s on every limited route, shared-bucket failure without `TRUST_PROXY`, per-client buckets with it |
| `openapi` | The spec documents exactly the served routes, every `$ref` resolves, protected operations declare auth and `401`, success responses have schemas |
| `errorHandler` | Every error-to-status mapping, generic `500`s, `413` |
| `seed` | Demo data shape, valid audit chain, idempotent accounts, production refusal |
| Unit suites | `caseCode`, `statusWorkflow`, `timeBuckets`, `piiScanner` (including false positives) |

Beyond the Jest suite:

- The OpenAPI document passes `redocly lint` with no errors or warnings.
- The [Postman collection](docs/WhistleDrop.postman_collection.json) runs the
  full reporter, moderator and admin journeys — 27 requests, 48 assertions —
  headless with `newman`.
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, format
  check and tests on **Node 20 and 22**, then builds the Docker image and boots
  the compose stack, waiting for both health checks.

---

## Design decisions

Each decision trades something away; the trade-off is stated alongside it.

1. **The case code is the only reporter credential.** No account means no
   recovery. Losing the code means losing access — the honest price of real
   anonymity, stated in the submission response rather than hidden.
2. **Case codes are hashed, not encrypted.** Encryption implies a key that could
   decrypt, which is one more secret to leak. With a hash there is nothing to
   steal. *Trade-off:* nobody can look a case up on a reporter's behalf.
3. **Reporters do not see their own description when tracking.** Minimum
   disclosure: a compromised code reveals a status, not the allegation.
   *Trade-off:* reporters cannot re-read what they wrote.
4. **No public registration.** An open sign-up route on a service holding
   sensitive reports is an open door. The first admin is provisioned from the
   CLI; admins create the rest.
5. **Updates and messages are embedded in the report.** They are always read
   with their report, so embedding gives atomic writes and one query instead of
   a join. *Trade-off:* the document must stay bounded, so threads are capped at
   200 messages.
6. **Every state change is one conditional atomic write** (`findOneAndUpdate`
   filtered on the expected state), not read-validate-save. It closes the race
   where two moderators both pass a check; when nothing matches, a re-read turns
   the outcome into a precise `404` or `409`.
7. **`400` / `409` / `422` mean different things.** `400`: you sent something
   malformed. `409`: the resource's current state conflicts. `422`: well-formed,
   but the workflow forbids it — and the body says what *is* allowed.
8. **Timestamps are coarsened at write time, including inside the ObjectId.**
   Storing the precise time and hiding it on output would leave it in every
   backup. *Trade-off:* the order of reports within a window is unknowable,
   lists use `_id` as a stable tie-breaker, and a reporter message can show an
   earlier time than the question it answers (thread order is authoritative).
9. **PII detection warns and never blocks, and reports categories, not
   matches.** Blocking on a heuristic would lose real reports; echoing matches
   would make the scanner itself a leak. *Trade-off:* it over-warns, and the
   warning arrives after the description is already stored.
10. **Retention is a database TTL index, not a cron job.** There is nothing extra
    to run or forget. Indexes are synced at startup because Mongoose's
    `autoIndex` only ever creates indexes: a changed TTL would conflict with the
    old one, and `0` would never remove it.
11. **Internal notes do not move the reporter's `lastUpdatedAt`.** That value is
    derived from public events, since the stored `updatedAt` would reveal that
    moderators discussed the case privately.
12. **Two roles, checked against the database on every request.** A token can
    never carry privileges its account no longer has: demotion applies
    immediately, and promotion needs a fresh login. Admins cannot deactivate
    themselves (`403`), which also guarantees at least one active admin always
    remains.
13. **The audit log is a hash chain with a gap-free `seq`.** It is
    tamper-evident without extra infrastructure. A unique index on `seq` keeps
    concurrent appends from forking the chain, and views are logged *before*
    the report is returned (fail closed). *Trade-off:* a chain stored in the
    same database cannot detect its newest entries being deleted, so
    `/verify` returns `headHash` for external anchoring.
14. **The audit log stores ids and actions only.** It watches staff and must not
    become a second copy of the reports, or a new home for IPs.
15. **No HTTP request logging, and `no-store` on sensitive responses.** Access
    logs and caches are the two places identifying data accumulates silently.
16. **Evidence is a URL, never an upload.** File metadata can deanonymise the
    sender; a link leaves that risk under the reporter's control and keeps the
    service free of file storage.
17. **`TRUST_PROXY=0` maps to `false`, not to the number 0.** express-rate-limit
    only warns about a stray `X-Forwarded-For` when the setting is exactly
    `false` — and that warning is how a forgotten setting surfaces.
18. **Search uses a MongoDB text index, not regular expressions.** It gives
    stemming, and since user input never becomes a `RegExp`, there is nothing to
    escape and no ReDoS surface. *Trade-off:* word-based, English stemming, no
    substring matching.
19. **The OpenAPI document is hand-written in one file, and tests hold it to the
    code.** It reads top to bottom and diffs cleanly. The `openapi` suite fails
    if a route is undocumented, a documented route does not exist, or a `$ref`
    dangles.
20. **Tests use a real in-memory MongoDB, bound explicitly to 127.0.0.1.**
    supertest's default `listen(0)` binds `[::]` but connects to `127.0.0.1`,
    which on macOS occasionally reached another local process. Binding the
    loopback address explicitly fixed an intermittent hang.
21. **The bcrypt cost is configurable.** Production uses 12; tests use bcrypt's
    minimum of 4, which took the suite from ~80 s to ~11 s. The timing-equalising
    dummy hash always uses the same cost as real hashes.

---

## Screenshots

Images live in [`docs/screenshots/`](docs/screenshots/); its README lists the
seven shots to capture (`npm run seed`, then Swagger UI):

| Screenshot | Shows |
| --- | --- |
| `01-swagger-overview.png` | Swagger UI with all tags |
| `02-submit-report.png` | Submission response with `caseCode` and `warnings` |
| `03-track-case.png` | Tracking response with updates and messages |
| `04-moderator-login.png` | Login and the **Authorize** dialog |
| `05-filtered-list.png` | Search with `q`, `category` and `hasEvidence` |
| `06-status-change-422.png` | `SUBMITTED → RESOLVED` rejected with `allowedTransitions` |
| `07-audit-log-verify.png` | `audit-log/verify` returning `intact: true` |

---

## Known limitations

- **Network anonymity is out of scope.** The application never stores an IP, but
  networks see connections. Reporters at risk should use Tor.
- **The PII scanner is a heuristic.** It is pattern-based and English-centric: it
  misses a plain name in a sentence, can be evaded, and over-warns on things like
  10-digit invoice numbers. Its warning arrives *after* submission — there is no
  pre-submit check endpoint, so an identifying description is already stored.
- **Report lists are not audit-logged.** Opening a report is recorded, but the
  list view's 140-character previews are not.
- **Audit entries and the actions they record are separate writes.** Without a
  replica set there are no multi-document transactions, so a crash between the
  two could leave an action unrecorded. A replica-set deployment could wrap both
  in one transaction. The chain also cannot detect truncation of its newest
  entries unless `headHash` is anchored outside the database.
- **Rate limits are per instance and in memory.** A multi-instance deployment
  needs a shared store such as Redis.
- **JWTs are stateless.** There is no logout or token blocklist; revocation means
  deactivating the account (effective immediately) or waiting for expiry (2 h).
- **No reporter notifications.** Reporters must poll their case code to see a
  question. Any push channel — email, SMS, web push — would be an identifier.
- **Retention is approximate and database-only.** MongoDB's TTL monitor runs
  about once a minute, and backups or replicas taken outside the live database
  follow their own retention.
- **The compose stack runs MongoDB without authentication**, relying on its
  private network and unpublished port. Production should enable MongoDB auth
  and TLS (or use a managed service).
- **A lost case code is unrecoverable** — by design, as above.
- **Coverage gaps:** `src/config/db.js` runs whenever the server, CLI or seed
  script starts (the Postman run and the CI Docker job both boot the server), but
  not inside the Jest suite, which manages its own in-memory connection.

---

## License

[MIT](LICENSE)
