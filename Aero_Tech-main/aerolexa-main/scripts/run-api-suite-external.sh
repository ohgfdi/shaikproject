#!/usr/bin/env bash
# API integration suite in EXTERNAL-SERVER mode.
#
# The default harness spawns a detached Next server from inside jest's process
# group; this sandbox reaps it (SIGTERM) mid-run, so every API test then fails
# with ECONNREFUSED. __tests__/api/global-setup.cjs documents this exact case and
# provides API_TEST_EXTERNAL_SERVER=1, which skips both the spawn and the
# teardown. We therefore migrate the scratch DB and run the server ourselves,
# using the same env contract as the harness.
set -u

cd "$(dirname "$0")/.." || exit 1

export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable"
export DATA_DIR="data/api-test"
export AUTH_SECRET="api-test-secret-0123456789abcdefghijklmnopqrstuv"
export MAIL_TRANSPORT="console"
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3210"
export TRAINING_ENABLED="true"
export AUTH_COOKIE_SECURE="false"
export TRUST_PROXY_HOPS="1"
export NEXT_TELEMETRY_DISABLED="1"
# Production server + console mail: the documented escape hatch for a
# production-like-but-not-public environment (this disposable scratch box).
export ALLOW_INSECURE_PROD_TRANSPORTS="true"

scratch="data/api-test"
rm -rf "$scratch"
mkdir -p "$scratch"

echo "== migrate scratch DB =="
npx prisma migrate deploy > /tmp/api-migrate.log 2>&1
echo "MIGRATE_EXIT=$?"

echo "== start production server on :3210 =="
nohup npx next start -p 3210 > /tmp/next-api.log 2>&1 &
server_pid=$!
echo "server pid $server_pid"

ready=0
for _ in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3210/login" || true)
  if [ "$code" = "200" ]; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "server exited early"; break; fi
  sleep 2
done
echo "READY=$ready"

if [ "$ready" != "1" ]; then
  echo "server never became ready; log tail:"
  tail -30 /tmp/next-api.log
  exit 1
fi

echo "== run API suite =="
API_TEST_EXTERNAL_SERVER=1 npx jest --runInBand --testPathPattern='__tests__/api' > /tmp/jest-api2.log 2>&1
echo "API_EXIT=$?"

kill "$server_pid" 2>/dev/null
echo "done"
