#!/usr/bin/env bash
# Headless smoke test for the server-python Docker stack (podman compose in
# server-python/docker/). Drives the real game boot flow through nginx with
# curl, exercising:
#
#   - director bootstrap (EA URLs rewritten to the server)
#   - anonymous device auth (EA-Connect-shaped sig/token/tokeninfo)
#   - email login with the code read from the server's console logs
#     (EMAIL_BACKEND=console:// — the chosen delivery method)
#   - land-token acquisition and town save/load, where the second load
#     proves the X-Accel-Redirect path: Django hands nginx an internal
#     redirect and nginx streams the town file out of the shared named
#     volume (no Python worker in the data path).
#
# Usage:
#   bash tools/smoke-server.sh [base_url]
#   default base_url: http://127.0.0.1:8090
#
# Re-runnable: uses a fixed advertising id and email, so it always
# reuses the same smoke user.

set -euo pipefail

B="${1:-http://127.0.0.1:8090}"
STACK="$(cd "$(dirname "$0")/../server-python/docker" && pwd)"
EMAIL="smoke@example.com"
ADV="smoke-test-0001"
TMP="$(mktemp -d /tmp/opencode/smoke-server.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
step() { echo "-- $*"; }

b64sig() { python3 -c 'import base64,sys; print(base64.b64encode(sys.argv[1].encode()).decode())' "$1"; }
jget()   { python3 -c 'import json,sys; print(eval("d"+sys.argv[1], {}, {"d": json.load(sys.stdin)}))' "$1"; }

# Run a Python snippet inside the server container (Django context).
# Plain `python -c` with explicit setup: `manage.py shell` prints an
# import banner to stdout that would corrupt parsed output.
cexec() {
  (cd "$STACK" && podman compose exec -T server python -c "
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'springfield.settings')
import django
django.setup()
$1
")
}

# ---------------------------------------------------------------- director
step "director bootstrap"
DIR="$(curl -sf "$B/director/api/android/getDirectionByPackage")" \
  || fail "director bootstrap unreachable at $B"
svc() { python3 -c '
import json, sys
for s in json.loads(sys.argv[1])["serverData"]:
    if s["key"] == sys.argv[2]:
        print(s["value"])
        break' "$DIR" "$1"; }
NEXUS="$(svc nexus.connect)"
USER_SVC="$(svc synergy.user)"
[ -n "$NEXUS" ] && [ -n "$USER_SVC" ] || fail "service URLs missing from director response"
DEV="$(printf '%s' "$NEXUS" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)"
[ -n "$DEV" ] || fail "no device uuid in nexus.connect URL"
echo "   device=$DEV nexus=$NEXUS"

# ------------------------------------------------- device registration bits
step "anon uid / device id"
curl -sf "$USER_SVC/user/api/android/getAnonUid"     -o "$TMP/uid.json"  \
  || fail "getAnonUid failed"
curl -sf "$USER_SVC/user/api/android/getDeviceID"    -o "$TMP/dev.json"  \
  || fail "getDeviceID failed"
[ "$(jget '["resultCode"]' < "$TMP/uid.json")" = "0" ] \
  && [ "$(jget '["resultCode"]' < "$TMP/dev.json")" = "0" ] \
  || fail "device registration resultCode != 0"

# ------------------------------------------------- anonymous EA-Connect auth
step "anonymous auth (sig)"
SIG="$(b64sig "{\"advertisingId\": \"$ADV\", \"platform\": \"android\"}")"
AUTH="$(curl -sf "$NEXUS/connect/auth?sig=$SIG&authenticator_login_type=mobile_anonymous")" \
  || fail "anonymous auth failed"
CODE="$(printf '%s' "$AUTH" | jget '["code"]')"; [ -n "$CODE" ] || fail "no auth code"
TOK="$(curl -sf "$NEXUS/connect/token?code=$CODE")" || fail "connect/token failed"
AT="$(printf '%s' "$TOK" | jget '["access_token"]')"; [ -n "$AT" ] || fail "no access token"
TI="$(curl -sf "$NEXUS/connect/tokeninfo?access_token=$AT")" || fail "tokeninfo failed"
ANON_UID="$(printf '%s' "$TI" | jget '["user_id"]')"
echo "   anonymous user_id=$ANON_UID"

# ------------------------------------------------- email login (code from logs)
step "email login code via console logs"
SRV=$(podman ps --filter "ancestor=springfield-server:local" --format '{{.Names}}' | head -1)
[ -n "$SRV" ] || fail "server container not running"
# The server reuses an unexpired code instead of re-sending one, so
# expire anything previously issued to make this run deterministic.
cexec '
from proxy.models import ProgRegCode
from django.utils import timezone
ProgRegCode.objects.filter(email="'"$EMAIL"'").update(expiry_on=timezone.now())
'
curl -sf -X POST "$B/proxy/identity/progreg/code" \
  -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"codeType\": \"email\"}" -o /dev/null \
  || fail "progreg/code request failed"
sleep 1
E_CODE="$(podman logs --tail 100 "$SRV" 2>/dev/null \
  | grep -oE 'authentication code is [0-9]{6}' | tail -1 | grep -oE '[0-9]{6}' || true)"
[ -n "${E_CODE:-}" ] || fail "login code not found in server logs (SENDER_EMAIL + EMAIL_BACKEND=console:// set?)"
echo "   code from logs: $E_CODE"

SIG="$(b64sig "{\"email\": \"$EMAIL\", \"cred\": \"$E_CODE\", \"platform\": \"android\"}")"
AUTH="$(curl -sf "$NEXUS/connect/auth?sig=$SIG")" || fail "email auth failed (bad code?)"
CODE="$(printf '%s' "$AUTH" | jget '["code"]')"; [ -n "$CODE" ] || fail "no auth code (email)"
TOK="$(curl -sf "$NEXUS/connect/token?code=$CODE")" || fail "connect/token failed (email)"
AT="$(printf '%s' "$TOK" | jget '["access_token"]')"
TI="$(curl -sf "$NEXUS/connect/tokeninfo?access_token=$AT")" || fail "tokeninfo failed (email)"
USER_ID="$(printf '%s' "$TI" | jget '["user_id"]')"
echo "   registered user_id=$USER_ID"

# ------------------------------------------------- mayhem id + land token
step "mayhem id / session key"
curl -sf -X PUT "$B/mh/users?applicationUserId=$USER_ID" -o "$TMP/users.pb" \
  || fail "mh/users PUT failed"
read -r MH SESS < <(cexec '
import sys
from protofiles import AuthData_pb2
m = AuthData_pb2.UsersResponseMessage()
m.ParseFromString(sys.stdin.buffer.read())
print(m.user.userId, m.token.sessionKey)' < "$TMP/users.pb")
[ -n "${MH:-}" ] || fail "could not parse mayhem id"
echo "   mayhem_id=$MH"

step "checkToken + land token"
curl -sf "$B/mh/games/bg_gameserver_plugin/checkToken/$MH/protoWholeLandToken/" \
  -o "$TMP/ct.pb" || fail "checkToken failed"
curl -sf "$B/mh/games/bg_gameserver_plugin/protoWholeLandToken/$MH/" \
  -o "$TMP/lwt.pb" || fail "protoWholeLandToken failed"
LT="$(cexec '
import sys
from protofiles import WholeLandTokenData_pb2
m = WholeLandTokenData_pb2.WholeLandTokenResponse()
m.ParseFromString(sys.stdin.buffer.read())
print(m.token)' < "$TMP/lwt.pb")"
[ -n "$LT" ] || fail "no land token"
echo "   land_token=$LT"

step "userstats (authorize land token; 409 by design)"
# The client's POST /mh/userstats is the step that flips the land token
# to authorized (and binds the session to the device) — it only works
# once protoWholeLandToken set retrieved=True.
SESS4="$(python3 -c 'import uuid; print(uuid.uuid4())')"
HTTP="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mh/userstats?device_id=$DEV" \
  -H "currentClientSessionId: $SESS4")"
[ "$HTTP" = "409" ] || fail "userstats returned $HTTP (expected 409 by design)"

# ------------------------------------------------- town load / save / reload
step "protoland GET (initial town, inline)"
PL="$B/mh/games/bg_gameserver_plugin/protoland/$MH/"
curl -sf "$PL" -H "Land-Update-Token: $LT" -o "$TMP/town1.pb" || fail "initial protoland GET failed"
[ -s "$TMP/town1.pb" ] || fail "initial town is empty"
# The view returns 200 even for its 409 XML errors, so verify the body
# really is a LandMessage proto.
cexec '
import sys
from protofiles import LandData_pb2
m = LandData_pb2.LandMessage()
m.ParseFromString(sys.stdin.buffer.read())
assert m.id, "empty land message"
' < "$TMP/town1.pb" || fail "initial town is not a LandMessage (error XML?)"
echo "   initial town: $(stat -c %s "$TMP/town1.pb") bytes (valid LandMessage)"

step "protoland PUT (save through Python)"
HTTP="$(curl -s -o "$TMP/put.xml" -w '%{http_code}' -X PUT "$PL" \
  -H "Land-Update-Token: $LT" --data-binary @"$TMP/town1.pb")"
[ "$HTTP" = "200" ] || fail "protoland PUT returned $HTTP: $(cat "$TMP/put.xml")"

step "protoland GET (X-Accel-Redirect via nginx volume)"
curl -sf "$PL" -H "Land-Update-Token: $LT" -o "$TMP/town2.pb" || fail "town reload GET failed"
[ -s "$TMP/town2.pb" ] || fail "reloaded town is empty"
cmp -s "$TMP/town1.pb" "$TMP/town2.pb" || fail "reloaded town differs from saved town"
VFILE="$( (cd "$STACK" && podman compose exec -T server sh -c 'ls /app/media/towns/*.pb' 2>/dev/null || true) | head -1)"
[ -n "$VFILE" ] || fail "no town file on the shared media volume"
echo "   reloaded $(stat -c %s "$TMP/town2.pb") bytes via nginx; volume file: $VFILE"

echo "SMOKE OK: full game boot flow + X-Accel-Redirect town roundtrip"
