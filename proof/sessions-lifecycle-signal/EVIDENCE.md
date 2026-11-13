# Shipped CLI proof: Ctrl+C keeps admitted session delete receipts, stops later mutations

PR: fix(sessions): stop archive/delete batch after Ctrl+C (+ review follow-up keeping admitted mutation receipts)

## Question

During `openclaw sessions delete k1 k2 k3 --yes`, does Ctrl+C (a) keep the
receipt of an **already-admitted** delete (the Gateway accepted it but the reply
is still in flight), and (b) stop starting later mutations — instead of dropping
the admitted mutation's receipt and force-killing the CLI?

## Method

Synthetic loopback WebSocket gateway peer speaking the **real OpenClaw wire
protocol** (connect.challenge → connect → hello-ok `{type:"res", id, ok:true,
payload:{type:"hello-ok", protocol:4}}`). It answers `sessions.describe` for all
three keys, then **holds** the first `sessions.delete` (never replies), and
**releases** it 0.8 s after SIGINT so the admitted mutation's reply can settle.
The source CLI runs in a real PTY (`node --import scripts/tsx.mjs src/entry.ts
sessions delete agent:main:s1 agent:main:s2 agent:main:s3 --yes --json`), SIGINT
is delivered once the peer observes the held delete, and the process output is
captured.

- BASE (old head with mutation signal, `c18593cb904d`): forwarding the abort
  signal to the mutation RPC rejects the in-flight delete, so its receipt never
  settles (`deletesReleased: 0`), exit 130 after 410 ms.
- HEAD (`8f5546c0f7b0`, this PR): the mutation RPC carries no abort signal, so
  the admitted delete settles as `deleted`; the loop stops before s2/s3.

## Results

HEAD JSON after Ctrl+C (raw captured output):

```json
{
  "ok": false,
  "error": {
    "type": "cli_error",
    "message": "Session delete did not complete for every requested key."
  },
  "operation": "delete",
  "dryRun": false,
  "results": [
    { "key": "agent:main:s1", "ok": true, "status": "deleted" },
    {
      "key": "agent:main:s2",
      "ok": false,
      "status": "interrupted",
      "error": "Operation was interrupted before this session was handled."
    },
    {
      "key": "agent:main:s3",
      "ok": false,
      "status": "interrupted",
      "error": "Operation was interrupted before this session was handled."
    }
  ]
}
```

|                                   | BASE (mutation signal)  | HEAD (this PR)                        |
| --------------------------------- | ----------------------- | ------------------------------------- |
| held delete released after SIGINT | **0** (receipt dropped) | **1** (receipt kept)                  |
| delete requests seen              | 1                       | 1                                     |
| s1 result                         | failed (receipt lost)   | **deleted**                           |
| s2/s3 result                      | not reached             | **interrupted** (not false not_found) |
| batch `ok`                        | —                       | **false**                             |

The admitted s1 delete keeps its receipt; s2/s3 are reported `interrupted`
rather than a false `not_found`; the partial batch is `ok:false`. This is the
behavior ClawSweeper's P2 findings requested.

## Raw receipts

- [head-receipt.json](head-receipt.json) / [base-receipt.json](base-receipt.json)
- [drive-peer.mjs](drive-peer.mjs) / [drive.py](drive.py)
