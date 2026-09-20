#!/usr/bin/env bash
# Run the whole thing: notify/audit service + capture app, in one terminal.
#   scripts/dev.sh             # devnet (the demo)
#   scripts/dev.sh localnet    # against a local validator (start it first — see README)
# Ctrl+C stops both. Logs are prefixed [svc] / [app]. The badge itself runs
# its own Lua app (firmware/); a radio bridge, if you have one, is
# `npm run bridge` in service/ (or `npm run bridge -- --stdin` to fake it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-devnet}"
cd "$ROOT"

for d in service capture-app; do [ -d "$d/node_modules" ] || (cd "$d" && npm install); done
[ -f service/.env ] || cp service/.env.example service/.env
[ -f capture-app/public/wasm/vision_wasm_internal.wasm ] || (cd capture-app && npm run setup)

if [ "$MODE" = "localnet" ]; then
  export SOLANA_CLUSTER=localnet SOLANA_RPC_URL=http://127.0.0.1:8899
  export VITE_SOLANA_CLUSTER=localnet VITE_SOLANA_RPC_URL=http://127.0.0.1:8899
fi

pids=()
cleanup() { echo; echo "stopping…"; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup INT TERM EXIT

( cd service && npm run dev 2>&1 | awk '{print "[svc] " $0; fflush()}' ) & pids+=($!)
( cd capture-app && npm run dev -- --host 2>&1 | awk '{print "[app] " $0; fflush()}' ) & pids+=($!)

sleep 3
echo
echo "  capture app   http://localhost:5173        (Use camera / Synthetic badge)"
echo "  service       http://localhost:8787/health"
echo "  smoke test    cd service && npm run smoke  (in another terminal)"
echo "  stop          Ctrl+C"
echo
wait
