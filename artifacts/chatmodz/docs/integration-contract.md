# Chatmodz integration contract

Chatmodz is the central message router. Connected dating websites do not share
their databases with Chatmodz and operators never receive credentials for those
websites.

## Incoming message

Each site adapter sends a signed request to:

```http
POST /api/chatmodz/integrations/{siteKey}/messages
X-Chatmodz-Timestamp: 2026-09-06T12:00:00Z
X-Chatmodz-Signature: sha256=<HMAC-SHA256(timestamp + "." + raw JSON body)>
Content-Type: application/json
```

```json
{
  "eventId": "evt-123",
  "conversationId": "conversation-456",
  "messageId": "message-789",
  "memberAlias": "Member 7831",
  "managedProfileAlias": "Maria",
  "memberPhotoUrl": "/api/chatmodz/media/member-123",
  "managedProfilePhotoUrl": "/api/chatmodz/media/profile-456",
  "sender": "member",
  "body": "Hi, how are you?",
  "sentAt": "2026-09-06T12:00:00Z"
}
```

The adapter signs the exact raw JSON body with the site secret held in the
Chatmodz API environment. Chatmodz verifies the timestamp window, deduplicates
on `eventId`, maps the payload to the `conversations` and `messages` tables,
then returns `202 Accepted`. Photo and media values must already be proxied
through Chatmodz; operator responses reject raw external URLs.

## Outgoing reply

When an operator sends a reply, Chatmodz resolves the stored `site_id` and
`external_conversation_id` on the server, then calls the site's configured
`endpoint_base_url`:

```json
{
  "conversationId": "conversation-456",
  "messageId": "chatmodz-message-890",
  "body": "I am doing well, thank you for asking.",
  "sentAt": "2026-09-06T12:01:00Z"
}
```

The browser talks only to Chatmodz. Delivery attempts are recorded in
`integration_deliveries`, and the operator sees only `queued`, `delivered`, or
`failed`.

## Security boundaries

- Use a dedicated MySQL database for Chatmodz.
- Store a hash of each site signing secret, never the raw secret.
- Store a hash of each one-time operator activation code.
- Apply role checks in the API before returning data; hiding fields in the UI
  is not sufficient.
- Use separate staff sessions/cookies from every dating-site app.
- Return administrator-only site attribution from admin endpoints only.
- Proxy media through Chatmodz before showing it to operators.
- Never send `siteKey`, `internal_name`, endpoint URLs, or external IDs to an
  operator-facing endpoint.