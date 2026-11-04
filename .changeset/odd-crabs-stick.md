---
'posthog-js': patch
---

Omit iframe srcdoc during replay rebuilds so native document loading cannot overwrite recorded content.
