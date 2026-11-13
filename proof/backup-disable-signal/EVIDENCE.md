# Shipped CLI proof: `backup disable` Ctrl+C stops removing further schedules

PR: fix(backup): stop removing further schedules after Ctrl+C

## Question

Does Ctrl+C during `openclaw backup disable` (which removes every matching
backup cron schedule) cancel the in-flight `cron.remove` read and stop the CLI
cleanly, instead of leaving the read pending until the launcher force-kills the
process?

## Method

Synthetic loopback WebSocket gateway peer speaking the **real OpenClaw wire
protocol** (connect.challenge → connect → hello-ok `{type:"res", id, ok:true,
payload:{type:"hello-ok", protocol:4}}`). The CLI targets it via `--port`
(localPortOverride → `ws://127.0.0.1:<port>`), so no real Gateway is needed. The
peer answers `cron.list` (two backup schedules) and **holds** the first
`cron.remove` (never replies) so the mutation read stays pending. The source
CLI runs in a real PTY (`node --import scripts/tsx.mjs src/entry.ts backup
disable --port <n>`), SIGINT is delivered once the peer observes the held
remove, and the process exit is recorded.

- BASE: `af10e5594d38` (origin/main, unpatched)
- HEAD: `719fc7a307b3` (this PR)
- Node 24.22.1, isolated HOME/state/config.

## Results

|                      | BASE (unpatched)                         | HEAD (patched)                   |
| -------------------- | ---------------------------------------- | -------------------------------- |
| exit code            | **-9 (SIGKILL)**                         | **130 (SIGINT)**                 |
| interrupt → exit     | **2081.7 ms**                            | **238.9 ms**                     |
| remove requests seen | 1                                        | 1                                |
| outcome              | read never cancels; launcher force-kills | read cancels; CLI exits promptly |

BASE's `callGatewayFromCli("cron.remove", ...)` read carries no signal, so
SIGINT cannot cancel it and the process is killed by the launcher after the
SIGINT grace window. HEAD forwards the command's AsyncWorkScope signal through
the RPC, so the read cancels and the CLI exits 130 immediately; the second
schedule is never removed.

## Raw receipts

- [head-receipt.json](head-receipt.json)
- [base-receipt.json](base-receipt.json)
- [drive-peer.mjs](drive-peer.mjs) / [drive.py](drive.py)
