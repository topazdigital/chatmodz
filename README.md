# Chatmodz

Chatmodz is a secure multi-site chat operator platform. Operators complete
policy, typing, and safety assessments before recruiters or administrators can
approve live-chat access. Approved operators work from one anonymized queue,
while staff manage onboarding, safety reports, connected dating sites, and
delivery health.

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
