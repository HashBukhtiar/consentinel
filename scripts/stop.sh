#!/usr/bin/env bash
# Stop anything scripts/dev.sh (or an orphaned `npm run dev`) left behind.
#   scripts/stop.sh               # service + capture app
#   scripts/stop.sh --validator   # also the local solana-test-validator
for port in 8787 5173; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  [ -n "$pids" ] && { echo "stopping :$port ($pids)"; kill $pids 2>/dev/null || true; }
done
if [ "${1:-}" = "--validator" ]; then pkill -f solana-test-validator && echo "stopped solana-test-validator" || true; fi
echo "done"
