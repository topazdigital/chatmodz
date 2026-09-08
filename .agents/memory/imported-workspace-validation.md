---
name: Imported workspace validation
description: Durable setup lesson for imported Replit workspaces with generated manifests.
---

Imported repositories can contain generated workspace manifests that reference
shared config files or workspace packages omitted from the import. Validate the
workspace install and the declared type/build scripts before changing product
behavior.

**Why:** A missing shared TypeScript config and stale workspace dependency
prevented the first install and obscured whether the requested UI changes were
actually runnable.

**How to apply:** Run the workspace install early, resolve only missing
references that are demonstrably unused or required for the existing scripts,
then restart the managed workflows and verify the visible app.