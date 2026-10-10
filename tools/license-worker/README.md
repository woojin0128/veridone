# Automatic license delivery (optional)

> **You don't need this when you sell through Polar with `tools/store-setup.mjs`:** Polar issues, emails and revokes `VERIDONE-…` license keys itself. This worker is for selling offline `VD1` keys through a store without built-in license keys, or for air-gapped customers.

A small webhook worker that turns a paid order into a Veridone license key and emails it to the buyer. It runs on the Cloudflare Workers free tier and issues keys the moment a payment clears. It supports **Polar** (`order.paid`) and **Lemon Squeezy** (`order_created`).

```
buyer pays ──▶ Polar / Lemon Squeezy ──webhook──▶ worker ──signs VD1 key──▶ Resend ──email──▶ buyer
```

Yearly subscriptions on Polar send `order.paid` again on every renewal, and the worker emails a fresh key valid for the new period, so paying customers never lapse.

## Setup (about 15 minutes)

1. **Create the signing key** once on your machine: `node tools/license-admin.mjs init`. Commit the public key it embeds and publish a release.
2. **Create the products** in your store, for example "Veridone Pro (yearly)", "Veridone Pro (lifetime)" and "Veridone Team (yearly)" with seat-based pricing. Note each product ID (Polar) or variant ID (Lemon Squeezy).
3. **Get an email API key** from [resend.com](https://resend.com) and verify your sending domain.
4. **Deploy the worker:**
   ```bash
   cd tools/license-worker
   # edit wrangler.toml: MAIL_FROM, SUPPORT_EMAIL, PLANS (your product IDs)
   npx wrangler deploy
   npx wrangler secret put VERIDONE_SIGNING_KEY_PEM < ~/.veridone-vendor/license-signing-key.pem
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put POLAR_WEBHOOK_SECRET           # Polar: the whsec_… secret shown when you add the webhook
   # or: npx wrangler secret put LEMON_SQUEEZY_SIGNING_SECRET
   ```
5. **Add the webhook** in the store:
   - Polar: Settings → Webhooks → add the worker URL, format **Raw**, event `order.paid`.
   - Lemon Squeezy: Settings → Webhooks → the worker URL, your signing secret, event `order_created`.
6. **Test** with a test-mode/sandbox order. The email contains a `VD1.…` key, and `node tools/license-admin.mjs verify <key>` should report it valid.

## Notes

- Keys are verified offline, so refunds don't revoke them automatically. Yearly keys limit the exposure; handle abuse manually.
- The signing key is the only secret that matters. Keep it in Cloudflare secrets and your password manager, nowhere else.
- To use another email provider, replace `sendEmail` in `worker.mjs`. To support another store, add a verifier and an order mapper next to the existing two.
