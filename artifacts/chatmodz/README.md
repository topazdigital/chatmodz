# Chatmodz

Chatmodz is a separate multi-site operator platform for approved chat
operators and administrators. Operators work from one queue without seeing
which dating website a conversation came from. Administrators can review
applications, activate operators, manage connected sites, and see reporting
by site and operator.

## Current app

The web artifact is a live-data client for the dedicated Chatmodz API:

- public operator applications
- email/password login plus one-time activation codes
- required 60-second typing test, safety quiz, and simulated practice chats
- automatic score thresholds followed by recruiter or administrator approval
- API-enforced approval gate that keeps live conversation data inaccessible
  until training is approved
- anonymized conversation queue with 10-minute locks and keepalive
- real message loading, 75-character minimum, duplicate-reply checks, delivery
  status, media metadata, and browser push notification controls
- visible reply rules, 25-minute timing alerts and review records, and
  recruiter/admin-only Panic Room reports for the defined severe safety cases
- append-only shared operator handoff notes, each saved with its author and
  timestamp in a conversation-linked history separate from customer messages
- administrator-only application approval, operator status, site health,
  attribution, delivery reporting, and operator compensation levels
- three-level staff hierarchy: administrators manage recruiters, recruiters
  recruit and monitor their assigned operators, and operators work only from
  the anonymized queue
- recruiter ownership and activity monitoring with administrator-wide
  oversight
- per-message earnings snapshots that preserve the operator level and rate used
  when each reply was delivered

There are no seeded conversations, fake operators, local reply persistence, or
browser-side site credentials. When `CHATMODZ_DATABASE_URL` is not configured,
the API returns a clear setup error instead of falling back to a dating-site
database.

## MySQL database

Chatmodz is designed for its own MySQL 8 database. Apply
`database/schema.mysql.sql` to a dedicated database when the live API is
connected. Do not point it at a dating site's database.

The startup initializer creates the assessment, safety-escalation, and
conversation note-history tables, and ensures the optional conversation
notes/profile columns exist. On upgrade, the current single note for each
conversation is imported into its history once. Older overwritten note versions
cannot be recovered. The schema file is the canonical database definition and
should be applied before using the production API.

If applying the recruiter hierarchy to an existing Chatmodz database, update
the `operators.role` enum to include `recruiter` and add the nullable
`operators.recruiter_id` self-reference before deploying the new API.

The database stores normalized conversations and messages plus the original
`site_id` and external IDs needed to route replies back to the correct site.
Operators receive only anonymized conversation payloads; admin reporting can
join site attribution server-side. Compensation is tracked in
`operator_earnings`; it is an internal ledger for payout reconciliation and
does not transfer money by itself.

## Connecting dating sites

Implement one adapter per dating site behind the integration contract in
`docs/integration-contract.md`. The sites can use different databases and
different APIs; each adapter translates its native payload into Chatmodz's
common message format and signs incoming requests. Chatmodz routes outgoing
replies through the adapter using the stored external conversation ID.

## API configuration

The API server expects these production environment variables:

- `CHATMODZ_DATABASE_URL` — a dedicated MySQL 8 connection URL
- `CHATMODZ_JWT_SECRET` — a separate staff-session signing secret
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — optional push
  notification configuration
- one environment secret per connected site, referenced by the site's
  `secret_env_key` (for example `CHATMODZ_RDN_SECRET`)

Apply `database/schema.mysql.sql` to the dedicated database before starting
the API. Create the first administrator through a controlled SQL operation,
then use the admin control room to approve applications and connect sites.