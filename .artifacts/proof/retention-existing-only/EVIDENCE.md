# Real shipped-workflow proof — tool-usage retention keeps a removed store missing

Issue: openclaw/openclaw#205927 · PR: openclaw/openclaw#205999

This evidence comes from a **real `openclaw gateway` process** and a **real
`openclaw doctor --non-interactive` CLI run** (built `dist` CLI, not a Vitest
harness), against an isolated `OPENCLAW_STATE_DIR`.

## Setup (both runs)

- Isolated state dir (`chmod 700`), minimal `openclaw.json` = `{ gateway: { mode: "local" } }`.
- Register agent `stale` in the shared `agent_databases` registry **without creating its
  database file** (a retired agent removed by hand).
- Seed live agent `main` with a fresh tool-usage row + a directly-inserted expired row
  (`updated_at = now - 91d`, older than the 90d retention window).
- `OPENCLAW_TEST_MINIMAL_GATEWAY=0` so the shipped side runtimes / maintenance timers run.

## Phase 1 — real Gateway maintenance cycle

Start `openclaw gateway` and wait 160s so the shipped **startup+130s tool-usage retention
timer** fires (the running Gateway's own scheduler, not a manual call).

| Check | BASE (`6356ddabdd3`, before fix) | HEAD (`2b214f1ad93`, with fix) |
|---|---|---|
| expired usage row pruned | ✅ true | ✅ true |
| fresh usage row preserved | ✅ true | ✅ true |
| **removed store recreated** | ❌ **true (bug)** | ✅ **false (stays absent)** |
| registry row survives | true | true |

BASE recreates the hand-removed `stale` database during the retention sweep — the exact
defect in #205927. HEAD prunes the live store but leaves the removed store absent.

## Phase 2 — real Doctor CLI

Run `openclaw doctor --non-interactive` against the same state dir.

| Check | BASE | HEAD |
|---|---|---|
| removed store recreated | ❌ true | ✅ false |
| registry row survives | true | true |
| Doctor output | (no skip note; store already recreated) | `Skipped missing registered agent database <state>/agents/stale/agent/openclaw-agent.sqlite` |

## Files

- `retention-proof.mjs` — the driver (seeds state, starts the real Gateway, waits for the
  retention timer, runs the real Doctor CLI, asserts).
- `head-gateway-doctor.txt` — full redacted terminal output, HEAD (PASS).
- `base-gateway-doctor.txt` — full redacted terminal output, BASE (FAIL = bug reproduced).

## Redaction

State-dir paths and the auth token are redacted (`<state>/`, `token<redacted>`,
`<dist>`). No IPs, API keys, phone numbers, or non-public endpoints appear.
