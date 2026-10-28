# Licensing

Veridone is source-available under the [Elastic License 2.0](../LICENSE). The guardrails are free for everyone, including commercial use. A paid plan unlocks the features teams use to make Veridone their own.

| Feature | Free | Pro | Team |
|---|---|---|---|
| Completion gate, integrity scanner, command & secret guard, condensing, session memory, code intelligence, all commands and agents, CI scan (text/JSON/GitHub/Markdown) | ✅ | ✅ | ✅ |
| Team rules: custom guard and code rules (`guard.customRules`, `integrity.customRules`) | | ✅ | ✅ |
| HTML value dashboard (`/veridone:report` → `report --html`) | | ✅ | ✅ |
| SARIF output for GitHub code scanning | | ✅ | ✅ |
| Organization policy file with locked settings | | | ✅ |

Plans and prices: [the website](https://woojin0128.github.io/veridone/#pricing).

## Try it first

```text
/veridone:license trial
```

Every paid feature, on this computer, for 14 days. No card and no account; the trial is recorded in `~/.claude/veridone-trial.json`.

## Activate a key

Keys bought in the store look like `VERIDONE-PRO-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` (Team: `VERIDONE-TEAM-…`). You'll find yours on the order confirmation page and in the customer portal.

```text
/veridone:license activate VERIDONE-PRO-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
/veridone:license status
```

From a shell: `node scripts/veridone.mjs license activate <key> [--label "work laptop"]`.

- A key works on up to **3 computers**. Each activation shows up in the customer portal under the label you gave it (default: your OS plus a random id), where you can remove old ones. `/veridone:license deactivate` frees this computer's slot.
- The activation is stored in `~/.claude/veridone-license.json` (mode 600).
- **In CI**, set `VERIDONE_LICENSE_KEY` from a secret. CI runs validate the key without taking a computer slot.
- **Team:** whoever buys the plan assigns seats by email in the customer portal; each person claims their seat and gets their own key.

## How keys are checked

| | Store keys (`VERIDONE-…`) | Offline keys (`VD1.…`) |
|---|---|---|
| Sold through | the store (Polar) | direct invoice, on request |
| Checked | online at activation, then in the background every 3 days | locally, against an Ed25519 signature |
| Without a connection | keeps working for 14 days after the last successful check | always works |
| Subscription ended, key revoked (e.g. with a refund), expired | paid features switch off at the next check | at the expiry date in the key |

Store-key checks never run inside a hook: activation is a command you run, and re-checks happen in a detached background process started at session start, so they never slow Claude down. A check sends the key, the store's organization id and the activation id to Polar's public license API; activation also sends the computer label, Veridone version and OS name. A build released before the store opened also downloads the published `store.json` from GitHub when you activate. Nothing about your code, prompts or files is sent.

When a license stops being active, Veridone tells you once at the start of a session. Only the paid features switch off; the free guardrails keep working.

**Behind a proxy:** Node.js ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node.js 22.21+ or 24+).

## Organization policy (Team)

Distribute a policy file to developer machines (MDM, dotfiles, or your devcontainer image) at `~/.claude/veridone-policy.json`, or point `VERIDONE_POLICY_FILE` at it:

```json
{
  "locked": true,
  "mode": "strict",
  "guard": {
    "protectedBranches": ["main", "release/*"],
    "customRules": [
      { "id": "prod", "pattern": "--context[= ]prod", "level": "deny", "message": "No kubectl against prod from an agent." }
    ]
  },
  "verify": { "require": ["test", "typecheck"] }
}
```

The policy is applied last, over user, project, session and environment settings. With `"locked": true`, its `mode` can't be lowered by `/veridone:mode`, `VERIDONE_MODE` or `VERIDONE_DISABLE`. A Team key (or the trial) must be active on the machine for the policy to apply.

## For the seller

- `tools/store-setup.mjs` (or the **Connect store** GitHub workflow) creates the products, license-key benefits and checkout links in Polar and writes [`store.json`](../store.json), which the plugin and the website read.
- **Refunds don't revoke keys by themselves.** In Polar, refund a one-time order with *Revoke benefits* ticked; for a subscription, revoke the subscription (cancel immediately) and then refund. Polar revokes the key, and Veridone's paid features stop at the next check.
- `tools/license-admin.mjs` issues offline `VD1` keys for invoiced or air-gapped customers. Run `init` once to create the signing key (keep it private) and publish a release with the embedded public key.
- `tools/license-worker/` is an optional webhook worker that emails offline keys automatically, for stores without built-in license keys.
