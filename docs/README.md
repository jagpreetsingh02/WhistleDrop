# Docs

| Path | What it is |
| --- | --- |
| [`WhistleDrop.postman_collection.json`](WhistleDrop.postman_collection.json) | Postman collection covering the full reporter, moderator and admin journeys (27 requests, 48 assertions) |
| [`API.md`](API.md) | Example requests and responses for every feature |
| [`demo.mp4`](demo.mp4) | 60-second demo |
| [`screenshots/`](screenshots/) | Swagger UI screenshots and the demo poster used in the README |

The live, always-current API reference is Swagger UI at `/api-docs` (raw
OpenAPI JSON at `/api-docs.json`).

## Using the Postman collection

1. Start the API and load demo accounts: `npm run seed && npm run dev`.
2. In Postman: **Import** → select the collection file.
3. Run it with the **Collection Runner**, folders in order. Requests pass data
   to each other through collection variables — the case code from submission,
   the report id found by search, the login tokens.

The default credentials are the `npm run seed` demo accounts. To use your own,
edit the `adminUsername` / `adminPassword` / `moderatorUsername` /
`moderatorPassword` collection variables.

From the command line:

```bash
npx newman run docs/WhistleDrop.postman_collection.json \
  --env-var baseUrl=http://localhost:4000/api/v1
```

Each run tags its report with a unique nonce and finds it through full-text
search, so the collection works against a database that already has data.
