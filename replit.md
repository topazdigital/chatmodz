# Chatmodz project notes

## What this project is

Chatmodz is a private workplace for approved chat operators. Operators sign in
to one queue, open an assigned conversation, and send replies through the
connected site that owns that conversation. The public landing page is
operator-focused; the live queue and administrator controls are protected by
login.

## Running on Replit

The project uses two workflows:

- `artifacts/chatmodz: web` — the Vite web client on port `25549`
- `artifacts/chatmodz-api: Chatmodz API` — the Express API on port `8080`

The web client proxies `/api` requests to the API.

The public landing page includes search-friendly metadata, structured job
posting data, and a sitemap. The administrator control room includes a
Pay & levels tab: create levels with per-delivered-message rates, assign a
level to each operator, and mark ledger entries pending, paid, or void.

## Database requirement

The API uses a dedicated MySQL 8 database through `CHATMODZ_DATABASE_URL`.
It must not point at a dating site's database. Apply
`artifacts/chatmodz/database/schema.mysql.sql` to that database before using
login, the queue, applications, or message delivery.

The public page can be previewed without a database. Authenticated testing
cannot work until the MySQL secret is configured.

Compensation tables and starter levels are included in
`artifacts/chatmodz/database/schema.mysql.sql`. Earnings are an internal
ledger; integrating a payout provider is intentionally separate.

## Admin test account

Set these environment values in Replit before starting the API:

- `CHATMODZ_ADMIN_EMAIL`
- `CHATMODZ_ADMIN_NAME` (optional)
- `CHATMODZ_ADMIN_PASSWORD` (secret)

When both the email and password are present, the API creates or updates that
operator as an active administrator at startup. Passwords are stored as
bcrypt hashes, not in the client or source code.

## Connecting a dating site

A site adapter is required for each external site. A URL alone is not enough.
The adapter must:

1. Send signed member-message events to
   `/api/chatmodz/integrations/{siteKey}/messages`.
2. Translate the site's conversation and message IDs into the common payload
   documented in `artifacts/chatmodz/docs/integration-contract.md`.
3. Receive outgoing replies from the configured site delivery endpoint and
   write them back to the site's own message system.
4. Keep the signing secret in Replit Secrets and proxy media through Chatmodz.

Chatmodz stores normalized conversations, messages, delivery attempts, locks,
and audit activity in its own database while retaining the external IDs needed
to route replies back through the correct adapter.