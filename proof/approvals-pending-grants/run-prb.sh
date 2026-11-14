#!/bin/bash
# Run PR-B (pending) shipped proof on remote. --out persisted to /data/openclaw-test/ws-peer-results/
# Usage: run-prb.sh <base|head> <port>
set -e
LEG="$1"; PORT="$2"
H=/data/openclaw-test/ws-peer-harness
if [ "$LEG" = "base" ]; then TREE=/data/openclaw-test/prB-base; else TREE=/data/openclaw-test/prB-head; fi
docker run --rm --init --user 0:0 \
  -v "$H":/harness:ro \
  -v "$TREE":/ws:ro \
  -v /data/openclaw-test/ws-peer-results:/out:rw \
  -v /data/openclaw-test/v24.22.1:/opt/node \
  -w /harness lexiflow-all:latest \
  bash -c "export PATH=/opt/node/bin:\$PATH; export HOME=/tmp/wspeer-home; mkdir -p /tmp/wspeer-home; exec node /harness/drive.mjs \
    --tree /ws \
    --port $PORT \
    --method exec.approval.list \
    --late-file /harness/payloads/exec.approval.list.json \
    --marker L8E_MARKER_7f3a91 \
    --auto plugin.approval.list=/harness/payloads/plugin.approval.list.json \
    --auto openclaw.approval.list=/harness/payloads/openclaw.approval.list.json \
    --auto config.get=/harness/payloads/config.get.json \
    --out /out/prb-$LEG.json \
    -- approvals pending --url ws://127.0.0.1:$PORT --token test-token --timeout 14000 --json"
