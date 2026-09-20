#!/usr/bin/env bash
# Consentinel preflight: is this laptop ready to run the whole system?
#   scripts/preflight.sh            # devnet (the demo)
#   scripts/preflight.sh localnet   # local validator
# Read-only. Prints ✓ / ✗ per check plus the command that fixes each ✗.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-devnet}"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ok=0; bad=0
pass() { echo "  ✓ $1"; ok=$((ok+1)); }
fail() { echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      → $2"; bad=$((bad+1)); }

echo "consentinel preflight ($MODE)"
echo "toolchain"
if command -v node >/dev/null; then v=$(node -v); case "$v" in v2[0-9]*|v[3-9][0-9]*) pass "node $v";; *) fail "node $v (need ≥ 20)" "brew install node";; esac; else fail "node missing" "brew install node"; fi
command -v solana >/dev/null && pass "solana-cli $(solana --version 2>/dev/null | awk '{print $2}')" || fail "solana-cli not on PATH (only needed to deploy/seed)" 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"'

echo "packages"
for d in registry service capture-app; do
  [ -d "$ROOT/$d/node_modules" ] && pass "$d/node_modules" || fail "$d dependencies" "cd $d && npm install"
done
[ -f "$ROOT/capture-app/public/wasm/vision_wasm_internal.wasm" ] && [ -f "$ROOT/capture-app/public/models/blaze_face_short_range.tflite" ] \
  && pass "MediaPipe assets (capture-app/public)" || fail "MediaPipe wasm/model" "cd capture-app && npm run setup"

echo "keys + config"
[ -f "$ROOT/registry/keys/program-keypair.json" ] && pass "program keypair" || fail "registry/keys/program-keypair.json (needed only to build/deploy)" "get it from C"
[ -f "$ROOT/registry/keys/camera-cam-1.json" ] && [ -f "$ROOT/registry/keys/relayer.json" ] && pass "camera + relayer keys" || fail "camera/relayer keys" "cd registry && SOLANA_CLUSTER=$MODE npm run seed"
[ -f "$ROOT/capture-app/public/demo/badges.json" ] && pass "demo badge keys for the operator panel" || fail "capture-app/public/demo/badges.json" "cd registry && SOLANA_CLUSTER=$MODE npm run seed"
if [ "$MODE" = "localnet" ]; then
  grep -q '^SOLANA_CLUSTER=localnet' "$ROOT/service/.env" 2>/dev/null && pass "service/.env is localnet" || fail "service/.env" "cd service && cp .env.localnet .env"
  grep -q 'VITE_SOLANA_CLUSTER=localnet' "$ROOT/capture-app/.env.local" 2>/dev/null && pass "capture-app/.env.local is localnet" || fail "capture-app/.env.local" "echo VITE_SOLANA_CLUSTER=localnet > capture-app/.env.local"
else
  [ -f "$ROOT/service/.env" ] && ! grep -q '^SOLANA_CLUSTER=localnet' "$ROOT/service/.env" && pass "service/.env (devnet)" || fail "service/.env" "cd service && cp .env.example .env   # add ELEVENLABS_API_KEY"
  grep -q '^ELEVENLABS_API_KEY=.\+' "$ROOT/service/.env" 2>/dev/null && pass "ElevenLabs key set" || echo "  · ElevenLabs key empty → macOS 'say' fallback (labeled as such in /health)"
  if [ -f "$ROOT/capture-app/.env.local" ] && grep -q 'localnet' "$ROOT/capture-app/.env.local"; then fail "capture-app/.env.local points at localnet" "rm capture-app/.env.local"; else pass "capture-app env (devnet defaults)"; fi
fi

echo "chain ($MODE)"
if [ "$MODE" = "localnet" ]; then
  curl -s -m 3 http://127.0.0.1:8899 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok \
    && pass "local validator on :8899" || fail "local validator" "solana-test-validator -r --quiet --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g"
fi
if [ -d "$ROOT/registry/node_modules" ]; then
  # macOS has no `timeout`; perl's alarm is everywhere
  out=$(cd "$ROOT/registry" && SOLANA_CLUSTER=$MODE perl -e 'alarm shift; exec @ARGV' 45 npx tsx client/scripts/status.mts 2>&1)
  echo "$out" | grep -q '^deployed yes' && pass "program deployed" || fail "program not deployed on $MODE" "cd registry && npm run build && anchor deploy --provider.cluster $MODE"
  echo "$out" | grep -q 'issuer=' && pass "registry initialized ($(echo "$out" | grep -o 'registrations=[0-9]*'))" || fail "registry not seeded" "cd registry && SOLANA_CLUSTER=$MODE npm run seed"
  n=$(echo "$out" | grep -c '  opt_')
  [ "$n" -ge 1 ] && pass "$n consent record(s): $(echo "$out" | grep '  opt_' | awk '{printf "%s=%s ", $1, $2}')" || fail "no consent records" "cd registry && SOLANA_CLUSTER=$MODE npm run seed"
  echo "$out" | grep -q 'count=' && pass "camera log registered ($(echo "$out" | grep -o 'count=[0-9]*' | head -1))" || fail "camera not registered" "cd registry && SOLANA_CLUSTER=$MODE npm run seed"
  echo "$out" | grep '^deployer' | sed 's/^/  · /'
  if [ "$MODE" = "devnet" ]; then
    for k in relayer camera-cam-1; do
      b=$(solana balance -u devnet "$ROOT/registry/keys/$k.json" 2>/dev/null | awk '{print $1}')
      # the camera pays rent for every capture notice it files (~0.0016 SOL each), so it needs more headroom than the relayer
      min=0.02; [ "$k" = "camera-cam-1" ] && min=0.05
      if [ -n "$b" ]; then awk -v b="$b" -v m="$min" 'BEGIN{exit !(b>=m)}' && pass "$k balance $b SOL" || fail "$k balance $b SOL (low; need ≥ $min)" "cd registry && npm run seed   # tops up from the deployer"; fi
    done
  fi
fi

echo "running now"
if curl -s -m 3 http://localhost:8787/health >/dev/null; then pass "service on :8787 ($(curl -s -m 3 http://localhost:8787/health | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const h=JSON.parse(d);console.log(h.flags.SOLANA_CLUSTER+", attest "+(h.attest.enabled?"on":"OFF")+", voice "+h.voice.provider+", bridges "+(h.radio?h.radio.bridges:"?"))})'))"; else echo "  · service not running → scripts/dev.sh"; fi
curl -s -m 3 -o /dev/null http://localhost:5173 && pass "capture app on :5173" || echo "  · capture app not running → scripts/dev.sh"

echo
[ "$bad" -eq 0 ] && echo "ready: $ok checks passed" || echo "$bad problem(s), $ok ok — fix the ✗ lines above"
exit $bad
