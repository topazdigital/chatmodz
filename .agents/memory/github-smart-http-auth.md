---
name: GitHub smart-HTTP authentication
description: Workspace-specific guidance for pushing to GitHub with a stored personal access token.
---

GitHub smart HTTP accepted the stored personal access token with a Basic
authorization header using the `x-access-token` username; a Bearer header was
rejected by the same remote.

**Why:** GitHub's REST API and Git smart-HTTP endpoints can accept different
authorization forms even when they use the same token.

**How to apply:** Keep the token in Replit Secrets and use the standard
`x-access-token` Basic form for `git push`. Never print or place the token in a
remote URL, commit, or workspace file.