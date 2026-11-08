#!/usr/bin/env bash
# Starts the built image against the disposable, migrated CI database and checks health,
# the gateway secret, and one authenticated file operation (a Pending upload request).
# R2 is never contacted: presigning is local and the request only writes the database.
# Expects IMAGE and DATABASE_URL (reachable from the host) to be set.
set -euo pipefail
: "${IMAGE:?}" "${DATABASE_URL:?}"
PORT="${SMOKE_PORT:-18091}"
GATEWAY_SECRET=smoke-gateway-secret
docker rm -f file-storage-smoke >/dev/null 2>&1 || true
docker run -d --name file-storage-smoke --network host -e PORT="$PORT" \
  -e DATABASE_URL="$DATABASE_URL" -e GATEWAY_SECRET="$GATEWAY_SECRET" -e CRON_SECRET=smoke-cron-secret \
  -e R2_ACCOUNT_ID=smoke -e R2_ACCESS_KEY_ID=smoke -e R2_SECRET_ACCESS_KEY=smoke \
  -e R2_PUBLIC_BUCKET=smoke-public -e R2_PRIVATE_BUCKET=smoke-private \
  -e R2_PUBLIC_BASE_URL=https://cdn.smoke.invalid "$IMAGE" >/dev/null
trap 'docker logs file-storage-smoke || true; docker rm -f file-storage-smoke >/dev/null' EXIT
BASE="http://127.0.0.1:$PORT"
for attempt in $(seq 1 30); do
  curl --fail --silent "$BASE/health" && break
  [ "$attempt" = 30 ] && { echo "health never became ready" >&2; exit 1; }
  sleep 1
done
echo
status() { curl --silent --output /dev/null --write-out '%{http_code}' "$@"; }
body='{"filename":"smoke.txt","contentType":"text/plain","size":5,"visibility":"private","retentionType":"temporary"}'
[ "$(status -X POST "$BASE/files" -H 'content-type: application/json' -H 'x-system-code: PORTAL' -d "$body")" = 401 ] \
  || { echo "request without the gateway secret was not rejected" >&2; exit 1; }
response=$(curl --fail --silent -X POST "$BASE/files" -H "authorization: Bearer $GATEWAY_SECRET" \
  -H 'x-system-code: PORTAL' -H 'content-type: application/json' -d "$body")
echo "$response" | node -e "const f=JSON.parse(require('fs').readFileSync(0,'utf8'));if(!f.id||!f.uploadUrl)process.exit(1)" \
  || { echo "upload request returned no File: $response" >&2; exit 1; }
echo "ok: authenticated upload request accepted"
