# Chatmodz

Chatmodz is a secure multi-site chat operator platform. Approved operators
work from one anonymized queue, while administrators manage applications,
activation, connected dating sites, delivery health, and reporting.

The application lives in `artifacts/chatmodz/` and its dedicated API lives in
`artifacts/chatmodz-api/`. Both use a dedicated MySQL 8 database. Start the web
client with:

```bash
pnpm install
pnpm dev
```

Start the API separately with `pnpm --filter @workspace/chatmodz-api run dev`.
See `artifacts/chatmodz/README.md` for the product boundary,
`artifacts/chatmodz/database/schema.mysql.sql` for the database, and
`artifacts/chatmodz/docs/integration-contract.md` for site adapters.
