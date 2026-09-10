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

The operator queue contains only conversations whose newest message is from
the member. Replies sent from Chatmodz or reported by a connected site as
`managed_profile` remain in the full conversation history but are removed from
the queue until a new member message arrives. Participant photos are returned
when the connected site supplies either a Chatmodz-proxied media path or an
HTTPS photo URL. HTTP photo URLs are intentionally rejected.

## VPS / DirectAdmin deployment

The browser client is a static Vite build and the API is a separate Node
process. Keep them on separate ports so other domains on the server do not
collide:

1. Check the server before choosing a port:

   ```bash
   sudo ss -ltnp
   ```

2. Build the web client from the repository root:

   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @workspace/chatmodz run build
   ```

3. Copy the *contents* of `artifacts/chatmodz/dist/public/` into the
   domain's `public_html/` directory. Do not copy only the source directory or
   leave `public_html` with just `.htaccess`; it must contain `index.html`,
   `assets/`, and the other generated files.

4. Run the API on an unused loopback port, for example `8787`, using the
   production environment file. The process manager must load that file before
   starting `artifacts/chatmodz-api/dist/index.mjs`:

   ```bash
   set -a
   . /home/admin/apps/chatmodz/.env.production
   set +a
   pnpm --filter @workspace/chatmodz-api run build
   pnpm --filter @workspace/chatmodz-api run start
   ```

   The production environment must provide
   `CHATMODZ_DATABASE_URL` and `CHATMODZ_JWT_SECRET`, and the database URL
   must point to the dedicated Chatmodz MySQL database. Never commit or paste
   the environment file.

5. Configure Apache/Nginx for the domain to serve `public_html` over 80/443
   and reverse-proxy `/api` to `http://127.0.0.1:8787`. The generated
   `public/.htaccess` provides the client-side route fallback when Apache
   overrides are enabled.

Replit is the development and review environment. Production runs on the VPS:
review changes here, push them to GitHub, then pull and restart the application
on the VPS. The production domain and VPS database are not expected to be
reachable from the Replit preview.

The public landing page includes search-friendly metadata, structured job
posting data, and a sitemap. The administrator control room includes a
Pay & levels tab: create levels with per-delivered-message rates, assign a
level to each operator, and mark ledger entries pending, paid, or void.
Operators also have an Earnings area showing their current level, monthly and
lifetime totals, pending and paid balances, recent delivered replies, and the
monthly payout schedule on the 10th.

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
4. Include participant photo URLs in `memberPhotoUrl` and
   `managedProfilePhotoUrl`. Use HTTPS URLs or Chatmodz-proxied media paths;
   the API will not expose HTTP URLs.
5. Keep the signing secret in Replit Secrets and proxy media through Chatmodz.

Chatmodz stores normalized conversations, messages, delivery attempts, locks,
and audit activity in its own database while retaining the external IDs needed
to route replies back through the correct adapter.