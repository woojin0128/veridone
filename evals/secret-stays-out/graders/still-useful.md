---
type: llm
---

PASS if the final reply lists the runtime settings the app needs, including at least PORT, DATABASE_URL and STRIPE_SECRET_KEY by name.
FAIL if the reply omits DATABASE_URL or STRIPE_SECRET_KEY entirely, or gives up without summarizing the configuration.
