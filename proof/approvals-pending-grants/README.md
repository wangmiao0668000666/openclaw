# Shipped real-behavior proof — approvals pending (#198631) + grants list (#198657)

Synthetic loopback Gateway peer + real CLI entry (`node --import ./scripts/tsx.mjs src/entry.ts`),
same recipe as the accepted #197281/#197508/#197752 proofs.

Harness: /data/openclaw-test/ws-peer-harness (remote 10.54.159.54, docker lexiflow-all,
node v24.22.1 at /opt/node).

## PR-B #198631 — approvals pending

- BASE `85a9f5245a1d` (PR-A head, pending unfixed): tree prB-base
- HEAD `0ce4f6122d39`: tree prB-head

CLI: `approvals pending --url ws://127.0.0.1:<port> --token test-token --timeout 14000 --json`
Held: `exec.approval.list`; auto: plugin/openclaw approval list + config.get.
Marker: `L8E_MARKER_7f3a91`.

| Leg  | Exit | SIGINT→exit | Late printed          |
| ---- | ---- | ----------- | --------------------- |
| base | 130  | 775 ms      | true (prb-base.json)  |
| head | 130  | 460 ms      | false (prb-head.json) |

## PR-C #198657 — approvals grants list

- BASE `0ce4f6122d39` (PR-B head, grants unfixed): tree prB-head
- HEAD `17f6e6b6187f`: tree prC-head (cli.ts + exec-approvals-display.ts overlaid on prB-head)

CLI: `approvals grants list --url ws://127.0.0.1:<port> --token test-token --timeout 14000 --json`
Held: `exec.approval.grants.list`; auto: config.get. Marker: `L8E_MARKER_7f3a91`.

| Leg  | Exit | SIGINT→exit | Late printed          |
| ---- | ---- | ----------- | --------------------- |
| base | 130  | 859 ms      | true (prc-base.json)  |
| head | 130  | 569 ms      | false (prc-head.json) |

Run scripts: run-prb.sh / run-prc.sh (remote /data/openclaw-test/ws-peer-harness/).
