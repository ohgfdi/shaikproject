#!/usr/bin/env bash
# Run a QA script against a freshly started server, then stop the whole process
# group. Backgrounded servers do not survive between tool calls in this
# environment; keeping start -> check -> stop inside one shell makes the run
# reproducible.
set -euo pipefail
cd "$(dirname "$0")/../../.."
MODE="${QA_MODE:-dev}"
LOG="${QA_SERVER_LOG:-/tmp/qa-server.log}"
if [ "$MODE" = "prod" ]; then
  CMD=(npm run start)
else
  CMD=(npm run dev)
fi
setsid "${CMD[@]}" >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill -TERM -- -"$SERVER_PID" 2>/dev/null || true
  sleep 1
  kill -KILL -- -"$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/login; then break; fi
  sleep 1
done
if ! curl -sf -o /dev/null http://127.0.0.1:3000/login; then
  echo "server failed to start; last log lines:" >&2
  tail -40 "$LOG" >&2
  exit 1
fi
QA_BASE_URL=http://127.0.0.1:3000 node "$@"
