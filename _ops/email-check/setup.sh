#!/usr/bin/env bash
# SUBNEX email check — adds a mailbox check to the road server. Run AFTER routing-server/setup.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/SUBNEXGROUP/subnex-driver/main/_ops/email-check/setup.sh | sudo bash
#
# What it does (about 1 minute, the road server keeps working):
#   * checks that the server may talk to other mail servers (outgoing port 25);
#   * starts a small service (Docker, Node 22, no other software) that asks the customer's
#     mail server whether a mailbox exists — no email is sent;
#   * adds it to Caddy under its own secret path token; the road route stays as it was;
#   * tests itself and prints the line to send to Claude (EMAIL_CHECK_URL=…).
# Safe to run again: the token is kept, the service is replaced with the latest version.
set -euo pipefail

ROOT=/opt/subnex-emailcheck
ROUTING=/opt/subnex-routing
NODE_IMAGE=node:22-alpine
RAW="${RAW:-https://raw.githubusercontent.com/SUBNEXGROUP/subnex-driver/main/_ops/email-check}"

say() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
stop() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || stop "Run as root (sudo)."
[ -s "$ROUTING/host" ] && [ -s "$ROUTING/token" ] || stop "The road server is not installed here ($ROUTING missing)."
docker inspect caddy >/dev/null 2>&1 || stop "Caddy is not running. Run the road server setup first."

say "1/4 Outgoing mail port"
if ! timeout 10 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
  stop "Outgoing port 25 is closed on this server, so mailboxes cannot be checked. Nothing was changed."
fi
echo "port 25 open"

say "2/4 Service"
mkdir -p "$ROOT"
curl -fsSL "$RAW/server.mjs" -o "$ROOT/server.mjs.new" && mv "$ROOT/server.mjs.new" "$ROOT/server.mjs"
[ -s "$ROOT/token" ] || openssl rand -hex 16 > "$ROOT/token"
HOST=$(cat "$ROUTING/host")
RTOKEN=$(cat "$ROUTING/token")
ETOKEN=$(cat "$ROOT/token")
docker network inspect subnex >/dev/null 2>&1 || docker network create subnex >/dev/null
docker pull -q "$NODE_IMAGE" >/dev/null
docker rm -f emailcheck >/dev/null 2>&1 || true
docker run -d --name emailcheck --network subnex --restart unless-stopped \
  -e HELO="$HOST" -v "$ROOT/server.mjs:/app/server.mjs:ro" \
  --log-opt max-size=5m --log-opt max-file=2 \
  "$NODE_IMAGE" node /app/server.mjs >/dev/null

say "3/4 Caddy route"
cp "$ROUTING/Caddyfile" "$ROUTING/Caddyfile.bak"
# Same file in place (Caddy reads it through a bind mount), then a reload without downtime.
cat > "$ROUTING/Caddyfile" <<EOF
$HOST {
	handle_path /$RTOKEN/* {
		reverse_proxy osrm:5000
	}
	handle_path /$ETOKEN/* {
		reverse_proxy emailcheck:8080
	}
	respond 404
}
EOF
if ! docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  cat "$ROUTING/Caddyfile.bak" > "$ROUTING/Caddyfile"
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || docker restart caddy >/dev/null
  stop "Caddy did not accept the new route; the old one is back. Send this screen to Claude."
fi

say "4/4 Self-test"
URL="https://$HOST/$ETOKEN"
sleep 3
GOOD=$(curl -fsS --max-time 30 "$URL/check?email=info@subnex.co.uk" || true)
BAD=$(curl -fsS --max-time 30 "$URL/check?email=subnex-test-$(openssl rand -hex 4)@gmail.com" || true)
ROAD=$(curl -fsS --max-time 15 -o /dev/null -w '%{http_code}' "https://$HOST/$RTOKEN/table/v1/driving/-3.1791,51.4816;-2.9977,51.5842?annotations=duration" || true)
echo "existing mailbox   : ${GOOD:-no answer}"
echo "made-up mailbox    : ${BAD:-no answer}"
echo "road server        : HTTP ${ROAD:-no answer}"
if echo "$GOOD" | grep -q '"valid"' && echo "$BAD" | grep -q '"invalid"'; then
  printf '\n\033[1;32mREADY.\033[0m Send this line to Claude:\n\n  EMAIL_CHECK_URL=%s\n\n' "$URL"
else
  printf '\n\033[1;33mINSTALLED, BUT THE TEST DID NOT GIVE THE EXPECTED ANSWERS.\033[0m\n'
  printf 'Send this whole screen to Claude, including the line:\n\n  EMAIL_CHECK_URL=%s\n\n' "$URL"
fi
