# Shipped CLI proof: `backup disable` keeps admitted removal receipts and reports interruption after Ctrl+C

PR: fix(backup): stop removing further schedules after Ctrl+C (+ review follow-ups keeping admitted removal replies and reporting interruption)

## Question

During `openclaw backup disable` (removes every matching backup cron schedule),
does Ctrl+C (a) keep the receipt of an **already-admitted** `cron.remove` (the
Gateway accepted it but the reply is still in flight), (b) stop starting the
next removal, and (c) report the not-reached schedule as interrupted — instead
of dropping the admitted removal's receipt and printing a false
`Scheduled backups disabled.` while a schedule remains enabled?

## Method

Synthetic loopback WebSocket gateway peer speaking the **real OpenClaw wire
protocol** (connect.challenge → connect → hello-ok `{type:"res", id, ok:true,
payload:{type:"hello-ok", protocol:4}}`). The CLI targets it via `--port`
(localPortOverride → `ws://127.0.0.1:<port>`), so no real Gateway is needed.
The peer answers `cron.list` (git-job + offsite-job) and **holds** the first
`cron.remove` (never replies), then **releases** it 0.8 s after SIGINT so the
admitted removal's reply can settle. The source CLI runs in a real PTY (`node
--import scripts/tsx.mjs src/entry.ts backup disable --port <n>`), SIGINT is
delivered once the peer observes the held remove, and the process output is
captured.

- BASE: `c0def7c89648` (finding-1 fix only: mutation RPC keeps its reply; the
  interrupted acknowledgement is NOT reported)
- HEAD: `8a20a85bc47c` (this PR: also reports the interruption)
- Node 24.22.1, isolated HOME/state/config.

## Results

HEAD JSON tail after Ctrl+C (raw captured output):

```
^CScheduled backups disabled before completion: 1 schedule(s) not reached (interrupted).
```

|                                        | BASE (c0def7c89648)                                                  | HEAD (8a20a85bc47c)                                                           |
| -------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| admitted removal released after SIGINT | **1** (receipt kept)                                                 | **1** (receipt kept)                                                          |
| removal requests seen                  | 1                                                                    | 1                                                                             |
| removals at close                      | 1                                                                    | 1                                                                             |
| second removal (offsite-job) started   | **no**                                                               | **no**                                                                        |
| ack after Ctrl+C                       | **`Scheduled backups disabled.`** (false; offsite-job still enabled) | **`...disabled before completion: 1 schedule(s) not reached (interrupted).`** |

Both heads keep the admitted git-job removal's reply and never start the
offsite-job removal (finding 1). BASE still prints the all-disabled
acknowledgement even though offsite-job remains scheduled; HEAD reports the
interruption. This is the behavior ClawSweeper's P2 finding requested: report
an interrupted or partial outcome and reserve the all-disabled acknowledgement
for a completed loop.

## Raw receipts

- [head-receipt.json](head-receipt.json) / [base-receipt.json](base-receipt.json)
- [head-stdout.raw](head-stdout.raw) / [base-stdout.raw](base-stdout.raw)
- [drive-peer.mjs](drive-peer.mjs) / [drive.py](drive.py)
