# Real-behavior proof — PR #207250 / issue #206800

**Bug.** Opening or reopening a local Claude catalog entry in the Control UI
forwarded the catalog route key (`agent:<agent>:catalog:<catalog>:<host>:<thread>`)
into `talk.catalog`. A catalog entry is an external identity the Talk resolver can
never resolve, so the Gateway logged `INVALID_REQUEST` / `No session found`.

**Fix.** `ComposerMicrophoneOwner.syncCatalog` treats a catalog session key as
disconnected for Talk/dictation discovery and leaves both capabilities
unavailable, so no request is sent. Adoption navigates to the returned chat key,
which restores ordinary session-scoped discovery.

## What this capture is

`catalog-talk-discovery-real-gateway.mjs` runs the **actual dist build** end to
end — no product source is imported, only Playwright and node builtins:

- a real isolated **Gateway process** (`dist/index.js gateway`),
- the real bundled **Anthropic plugin**, which registers the native Claude
  session catalog and discovers a synthetic local Claude Code transcript written
  under `CLAUDE_CONFIG_DIR/projects` (exactly the issue's "local Claude session"
  scenario),
- the real **built Control UI** (`dist/control-ui`) in real **Chromium**.

Every `talk.catalog` / `talk.config` request frame the Control UI sends over its
real Gateway WebSocket is captured at the wire (`page.routeWebSocket`), so the
evidence is the runtime RPC capture the review asked for — not an in-page test
hook. Tokens, state-root and home paths are redacted.

## Red / green

| Run  | Build                                  | catalog-keyed `talk.catalog` (open / reopen / focus) | Adoption |
|------|----------------------------------------|------------------------------------------------------|----------|
| BASE | `5c44c9cc4d9~1` picker (fix reverted)  | **1 / 1 / 0 → bug reproduces**                        | n/a      |
| HEAD | `cf79f328ff3` (fix)                    | **0 / 0 / 0**                                         | discovery resumes with the exact adopted key |

- **BASE (`base/proof.json`):** opening the catalog route sends
  `talk.catalog { sessionKey: "agent:main:catalog:claude:gateway%3Alocal:11111111-…" }`,
  and reopening sends it again — the catalog key reaches Talk discovery twice.
- **HEAD (`head/proof.json`):** zero `:catalog:` talk requests across open,
  reopen, and a focus refresh. A real `sessions.catalog.continue` adoption
  returns the chat key
  `agent:main:plugin:anthropic:catalog-adopt:claude:666ff6cc…`; navigating to
  that key's route (`/chat/main/plugin/anthropic/catalog-adopt/claude/666ff6cc…`)
  resumes discovery with a `talk.catalog` whose `sessionKey` **exactly equals**
  the key adoption returned, and the adopted session's `chat.history` retains the
  imported Claude transcript (`head/adopted-history.json`).

The only session keys HEAD ever sends to Talk are ordinary, non-catalog keys
(`agent:main:main` and the exact adopted chat key); the catalog route key is
never sent.

## Files

- `catalog-talk-discovery-real-gateway.mjs` — the capture script.
- `head/proof.json`, `base/proof.json` — structured result + captured frames.
- `head/catalog-route.png`, `head/adopted-route.png`, `base/catalog-route.png` —
  Control UI at the asserted states.
- `head/catalog-list.json`, `base/catalog-list.json` — the real Anthropic catalog
  listing the synthetic Claude session (proves the catalog provider is live).
- `head/adopted-history.json` — the adopted session's `chat.history`, retaining
  the imported Claude transcript.
- `head/gateway.private.log` — redacted Gateway log.

## Reproduce

```bash
# HEAD (fix): dist already built from cf79f328ff3
node catalog-talk-discovery-real-gateway.mjs --repo <openclaw> --out ./head

# BASE: revert the one-file fix, rebuild the UI, rerun
git show 5c44c9cc4d9~1:ui/src/pages/chat/composer-microphone-picker.ts \
  > ui/src/pages/chat/composer-microphone-picker.ts
pnpm ui:build
node catalog-talk-discovery-real-gateway.mjs --repo <openclaw> --out ./base
git checkout -- ui/src/pages/chat/composer-microphone-picker.ts
```
