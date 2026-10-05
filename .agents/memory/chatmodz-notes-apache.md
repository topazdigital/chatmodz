---
name: Chatmodz notes through Apache
description: Production proxy behavior that affects shared conversation note saves.
---

Use POST from the Chatmodz web client to save shared conversation notes. The production Apache proxy returns 406 for PUT before the request reaches the API, while POST reaches the API. Keep the API capable of accepting both methods for compatibility.

**Why:** A live unauthenticated method probe reproduced Apache's 406 for PUT and an API-generated 401 for POST; the API health endpoint reported a connected database.

**How to apply:** When notes fail on the published Chatmodz site, check the HTTP method/proxy response before diagnosing database persistence. Do not switch the web client back to PUT unless the production proxy is known to permit it.