#!/bin/bash
# Run PR-C (grants list) shipped proof on remote. --out persisted to /data/openclaw-test/ws-peer-results/
# Usage: run-prc.sh <base|head> <port>
set -e
LEG="$1"; PORT="$2"
H=/data/openclaw-test/ws-peer-harness
if [ "$LEG" = "base" ]; then TREE=/data/openclaw-test/prB-head; else TREE=/data/openclaw-test/prC-head; fi
docker run --rm --init --user 0:0 \
  -v "$H":/harness:ro \
  -v "$TREE":/ws:ro \
  -v /data/openclaw-test/ws-peer-results:/out:rw \
  -v /data/openclaw-test/v24.22.1:/opt/node \
  -w /harness lexiflow-all:latest \
  bash -c "export PATH=/opt/node/bin:\$PATH; export HOME=/tmp/wspeer-home; mkdir -p /tmp/wspeer-home; exec node /harness/drive.mjs \
    --tree /ws \
    --port $PORT \
    --method exec.approval.grants.list \
    --late-file /harness/payloads/exec.approval.grants.list.json \
    --marker L8E_MARKER_7f3a91 \
    --auto config.get=/harness/payloads/config.get.json \
    --out /out/prc-$LEG.json \
    -- approvals grants list --url ws://127.0.0.1:$PORT --token test-token --timeout 14000 --json"
