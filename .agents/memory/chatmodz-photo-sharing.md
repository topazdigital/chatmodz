---
name: Chatmodz photo sharing
description: Privacy boundary for profile photos synchronized from the linked dating site.
---

Only sync approved and unflagged gallery images from Latest-Rich into Chatmodz. Keep source-image delivery behind Chatmodz authentication and the connected-site hostname allowlist.

**Why:** operators need visual context, while approval and flag status are the source site's moderation gate.

**How to apply:** filter photos in the Latest-Rich adapter when building profile payloads, resolve them against the connected site's base URL in Chatmodz, and preserve the authenticated image proxy.