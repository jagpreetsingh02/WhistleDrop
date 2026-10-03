# Screenshots

Placeholder for README images. Capture these from Swagger UI
(`npm run seed`, then `npm run dev` and open http://localhost:4000/api-docs) and
save them here with the file names below:

| File | What to capture |
| --- | --- |
| `01-swagger-overview.png` | Swagger UI landing page with all tags expanded |
| `02-submit-report.png` | `POST /reports` response showing the `caseCode` and `warnings` |
| `03-track-case.png` | `GET /reports/{caseCode}` showing status, updates and messages |
| `04-moderator-login.png` | `POST /auth/login` response, then the **Authorize** dialog with the token |
| `05-filtered-list.png` | `GET /moderator/reports` with `q`, `category` and `hasEvidence` filters applied |
| `06-status-change-422.png` | `PATCH /moderator/reports/{id}/status` rejecting `SUBMITTED → RESOLVED` with `allowedTransitions` |
| `07-audit-log-verify.png` | `GET /admin/audit-log/verify` returning `intact: true` |

Crop to the relevant panel and blur any token values before committing.
