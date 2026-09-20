#!/usr/bin/env bash
# Stop anything scripts/dev.sh (or an orphaned `npm run dev`) left behind.
#   scripts/stop.sh               # service + capture app
#   scripts/stop.sh --validator   # also the local solana-test-validator
# Kills the whole tree above the listener (npm → sh → tsx watch → node): killing
# only the listening process lets `tsx watch` / vite respawn it.
kill_tree() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$p"; done; kill "$1" 2>/dev/null || true; }
top_of() { # climb from a listener to its highest dev-tooling ancestor (never a login shell or an IDE)
  local pid=$1 parent cmd
  while :; do
    parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    { [ -z "$parent" ] || [ "$parent" -le 1 ]; } && break
    cmd=$(ps -o command= -p "$parent" 2>/dev/null)
    case "$cmd" in
      *"tsx watch"*|*"npm run dev"*|*"npm exec"*|*node_modules/.bin/*|*scripts/dev.sh*|*"sh -c "*tsx*|*"sh -c "*vite*) pid=$parent ;;
      *) break ;;
    esac
  done
  echo "$pid"
}
for port in 8787 5173; do
  for pid in $(lsof -ti tcp:$port 2>/dev/null); do
    top=$(top_of "$pid")
    echo "stopping :$port (pid $pid, tree from $top)"
    kill_tree "$top"
  done
done
if [ "${1:-}" = "--validator" ]; then pkill -f solana-test-validator && echo "stopped solana-test-validator" || true; fi
sleep 1
for port in 8787 5173; do lsof -ti tcp:$port >/dev/null 2>&1 && echo "  :$port still busy" || true; done
echo "done"
