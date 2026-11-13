# Shipped CLI proof: interrupted `openclaw audit` reads cancel promptly

Fixes the read-only `audit.activity.list` / `audit.list` / `audit.run.inspect` calls so
an interrupted CLI read releases promptly instead of hanging until the launcher kills
the process.

## Method

Real `openclaw audit --json` executed from the source tree (`node --import
scripts/tsx.mjs src/entry.ts audit --json`) inside an isolated state/workspace, driven
against a synthetic loopback WebSocket gateway peer speaking the real OpenClaw wire
protocol. The peer completes the real `connect.challenge` / `connect` / `hello-ok`
handshake (protocol 4), then **holds the real `audit.activity.list` request** (never
replies). SIGINT (Ctrl+C) is delivered to the controlling PTY while the read is held
pending. The harness records the exact exit code, the delay from SIGINT to exit, and
the terminal/stderr readback.

- `drive-peer.mjs` — the synthetic WS gateway peer (handshake + held audit read).
- `drive.py` — the PTY driver: starts the peer, runs the CLI, sends Ctrl+C on the held
  read, records `exitCode` / `interruptToExitMs` / stderr, asserts expectations.
- `base-receipt.json` / `head-receipt.json` — machine-readable transcripts.
- `base-stderr.txt` / `head-stderr.txt`, `base-stdout.raw` / `head-stdout.raw` —
  raw readback.

Reproduce with `python3 drive.py <checkout> <out> <node24.22.1> <red|green> src` on the
pinned BASE (`d5d77e181a2e`) and HEAD (`378deb30e85a`) commits.

## Result

| Revision                      | exitCode         | SIGINT→exit | Outcome                                                                                                                                                             |
| ----------------------------- | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BASE `d5d77e181a2e` (unfixed) | **-9 (SIGKILL)** | **2068 ms** | Read is NOT cancelled. The process hangs in the pending `audit.activity.list` read after Ctrl+C and is killed by the harness timeout instead of exiting on its own. |
| HEAD `f02c79ff0a79` (fixed)   | **130 (SIGINT)** | **185 ms**  | Read is cancelled. The CLI exits normally with the SIGINT code ~11× faster; no late audit output is printed.                                                        |

BASE stderr: `Command interrupted by SIGINT. Waiting for cleanup before exiting.` then
the process is SIGKILLed (2068 ms) — it never reaches the interrupted-notice exit path.
HEAD stderr: the same notice, then the normal cleanup path runs and exits 130 (238 ms).

The decisive difference: BASE holds the pending read after interruption and is killed;
HEAD cancels the pending read and exits promptly with the canonical SIGINT code.
