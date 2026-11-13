# Shipped CLI proof: `sessions delete k1 k2 k3 --yes` Ctrl+C read cancellation

PR: fix(sessions): stop archive/delete batch after Ctrl+C

## Question

Does Ctrl+C during a batch `sessions delete k1 k2 k3 --yes` cancel the in-flight
mutation read and stop the CLI cleanly, instead of leaving the read pending until
the launcher force-kills the process?

## Method

Synthetic loopback WebSocket gateway peer speaking the **real OpenClaw wire
protocol** (connect.challenge → connect → hello-ok `{type:"res", id, ok:true,
payload:{type:"hello-ok", protocol:4}}`). The peer answers `sessions.describe`
(so all three keys enter the delete loop) and **holds** the first
`sessions.delete` request (never replies) so the mutation read stays pending.
The source CLI runs in a real PTY (`node --import scripts/tsx.mjs src/entry.ts
sessions delete agent:main:s1 agent:main:s2 agent:main:s3 --yes --json`), SIGINT
is delivered once the peer observes the held delete, and the process exit is
recorded.

- BASE: `5bdadab2c739` (origin/main, unpatched)
- HEAD: `6c1236466b8e` (this PR)
- Node 24.22.1, isolated HOME/state/config, `OPENCLAW_GATEWAY_URL` points at the
  loopback peer.

## Results

|                      | BASE (unpatched)                         | HEAD (patched)                   |
| -------------------- | ---------------------------------------- | -------------------------------- |
| exit code            | **-9 (SIGKILL)**                         | **130 (SIGINT)**                 |
| interrupt → exit     | **2093.8 ms**                            | **317.3 ms**                     |
| delete requests seen | 1                                        | 1                                |
| outcome              | read never cancels; launcher force-kills | read cancels; CLI exits promptly |

The held delete read is where the fix shows: BASE's `callGatewayFromCliWithTransport`
read carries no `signal`, so SIGINT cannot cancel it and the process is killed by
the launcher after the SIGINT grace window. HEAD forwards the command's
AsyncWorkScope signal through the RPC, so the read cancels and the CLI exits 130
immediately.

## Raw receipts

- [head-receipt.json](head-receipt.json)
- [base-receipt.json](base-receipt.json)
- [drive-peer.mjs](drive-peer.mjs) / [drive.py](drive.py)
