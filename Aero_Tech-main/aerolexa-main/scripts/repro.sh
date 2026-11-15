#!/usr/bin/env bash
# AeroLexa — full verification repro.
# Phase 2 style-matrix + Phase 3 tests + Phase 4 security + Phase 5 perf subset.
# Usage: bash scripts/repro.sh            (run from repo root or scripts/)
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=verification
mkdir -p "$OUT"

echo "== [1/6] Clean production build =="
rm -rf .next
npm run build > "$OUT/build.log" 2>&1
BUILD=$?
echo "{\"build_exit\": $BUILD}" > "$OUT/build.json"
[ $BUILD -ne 0 ] && echo "BUILD FAILED — see $OUT/build.log"

echo "== [2/6] Start server =="
npx next start -p 3199 > "$OUT/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 30); do curl -sf -o /dev/null http://localhost:3199/ && break; sleep 2; done

echo "== [3/6] Phase 2: styling matrix across routes =="
node scripts/verify-styling.mjs > "$OUT/styling.json" 2>"$OUT/styling.err" || true

echo "== [4/6] Phase 4: security spot flags + cookies + audit =="
node scripts/verify-security.mjs > "$OUT/security.json" 2>"$OUT/security.err" || true
npm audit --omit=dev --json > "$OUT/npm-audit.json" 2>/dev/null || true

echo "== [5/6] Phase 5: robustness/perf subset =="
node scripts/verify-perf.mjs > "$OUT/perf.json" 2>"$OUT/perf.err" || true

echo "== [6/6] Phase 3: auth/data/oracle tests =="
npx jest --runInBand --silent \
  --testPathPatterns="(__tests__/unit/(auth-hardening|auth-saml|api-key-auth|publish-authz|forecast-oracle|cohort-oracle|stats-whatif-oracle)|__tests__/api/app.test)" \
  > "$OUT/tests.log" 2>&1 || true

kill $SRV 2>/dev/null
echo "done — artifacts in $OUT/"
