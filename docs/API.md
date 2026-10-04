# WhistleDrop API — example requests and responses

Every payload below is real output from a running instance (tokens and ids
abbreviated where marked). For the full, always-current contract open Swagger UI
at `/api-docs`, or read the raw OpenAPI document at `/api-docs.json`.

Submitting and tracking a report are shown in the [README](../README.md#example-requests-and-responses).
All other examples use base URL `http://localhost:4000/api/v1`; moderator and admin
routes need `Authorization: Bearer $TOKEN` from `POST /auth/login`.

## PII warning

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

## Validation — every problem at once, unknown fields rejected

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

## Moderator login

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
    "token": "<JWT, abbreviated>",
    "expiresIn": "2h",
    "moderator": { "id": "6ac101c73e7eeae0f95616fe", "username": "alice", "displayName": "Ethics Desk", "role": "moderator" }
  }
}
```

## Search and filter

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

## Status change rejected by the workflow

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

## Status change accepted, internal note, question to the reporter

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
the README's [tracking example](../README.md#track-a-case): the internal note is missing, there is no
moderator identity, and the reporter's `lastUpdatedAt` points at the last
*public* event (13:23:20.014), not at the internal note.

## The reporter answers

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

## Concurrent moderators

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

## Admin: accounts

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

## Admin: audit log and tamper detection

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

## Workflow discovery

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
