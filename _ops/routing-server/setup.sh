#!/usr/bin/env bash
# SUBNEX road server (OSRM) — one-command setup on a fresh Ubuntu 22.04/24.04 x86_64 VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/SUBNEXGROUP/subnex-driver/main/_ops/routing-server/setup.sh | sudo bash
#
# What it does:
#   * installs Docker, osmium, a firewall and 4 GB swap;
#   * downloads the OpenStreetMap map of Great Britain (Geofabrik) and cuts out our area:
#     Wales + South West England + West Midlands (box -5.9,50.4 → -1.3,53.5);
#   * builds the car road graph with OSRM and serves it over HTTPS (Caddy, Let's Encrypt);
#   * only requests that start with a secret path token are answered — everything else gets 404;
#   * rebuilds the map every Sunday night (no collections on Sundays), the app falls back to
#     openrouteservice for those minutes.
# At the end it prints the address to put into Supabase as ROUTING_OSRM_URL.
# Optional: DOMAIN=routing.subnex.co.uk before the command, once a DNS A record points at this server.
set -euo pipefail

ROOT=/opt/subnex-routing
OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
CADDY_IMAGE=caddy:2
BBOX="${BBOX:--5.9,50.4,-1.3,53.5}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/great-britain-latest.osm.pbf}"

say() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "This script needs an x86_64 server."; exit 1; }

say "1/6 Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io osmium-tool curl openssl ufw ca-certificates
systemctl enable --now docker

say "2/6 Swap and firewall"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "3/6 Settings"
mkdir -p "$ROOT/data" "$ROOT/build"
[ -s "$ROOT/token" ] || openssl rand -hex 16 > "$ROOT/token"
TOKEN=$(cat "$ROOT/token")
IP=$(curl -4 -fsS https://api.ipify.org)
HOST="${DOMAIN:-${IP//./-}.sslip.io}"
echo "$HOST" > "$ROOT/host"

# Rebuild script: new graph is built next to the live one and swapped in at the end.
cat > "$ROOT/build.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $ROOT/build
rm -f region.osrm* region.osm.pbf
curl -fL --retry 3 -o gb.osm.pbf.part "$PBF_URL" && mv gb.osm.pbf.part gb.osm.pbf
osmium extract -b "$BBOX" -s complete_ways --overwrite -o region.osm.pbf gb.osm.pbf
docker run --rm -v $ROOT/build:/data $OSRM_IMAGE osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run --rm -v $ROOT/build:/data $OSRM_IMAGE osrm-partition /data/region.osrm
docker run --rm -v $ROOT/build:/data $OSRM_IMAGE osrm-customize /data/region.osrm
docker stop osrm >/dev/null 2>&1 || true
rm -f $ROOT/data/region.osrm*
mv region.osrm* $ROOT/data/
rm -f gb.osm.pbf
docker start osrm >/dev/null 2>&1 || true
echo "rebuilt \$(date -u +%FT%TZ)"
EOF
chmod +x "$ROOT/build.sh"

# The email check (_ops/email-check) shares this Caddy; keep its route if it is installed.
EMAIL_ROUTE=""
if [ -s /opt/subnex-emailcheck/token ]; then
  EMAIL_ROUTE="	handle_path /$(cat /opt/subnex-emailcheck/token)/* {
		reverse_proxy emailcheck:8080
	}"
fi
cat > "$ROOT/Caddyfile" <<EOF
$HOST {
	handle_path /$TOKEN/* {
		reverse_proxy osrm:5000
	}
$EMAIL_ROUTE
	respond 404
}
EOF

say "4/6 Map and road graph (15–30 minutes)"
docker network inspect subnex >/dev/null 2>&1 || docker network create subnex >/dev/null
"$ROOT/build.sh"

say "5/6 Services"
docker rm -f osrm caddy >/dev/null 2>&1 || true
docker run -d --name osrm --network subnex --restart unless-stopped -v "$ROOT/data:/data" \
  "$OSRM_IMAGE" osrm-routed --algorithm mld --max-table-size 1000 /data/region.osrm >/dev/null
docker run -d --name caddy --network subnex --restart unless-stopped -p 80:80 -p 443:443 \
  -v "$ROOT/Caddyfile:/etc/caddy/Caddyfile:ro" -v subnex_caddy:/data "$CADDY_IMAGE" >/dev/null
echo "40 2 * * 0 root $ROOT/build.sh >> /var/log/subnex-routing.log 2>&1" > /etc/cron.d/subnex-routing

say "6/6 Check (Cardiff ↔ Newport)"
URL="https://$HOST/$TOKEN"
for _ in $(seq 1 30); do
  if curl -fsS "$URL/table/v1/driving/-3.1791,51.4816;-2.9977,51.5842?annotations=duration" | grep -q '"durations"'; then
    printf '\n\033[1;32mREADY.\033[0m Send this line to Claude:\n\n  ROUTING_OSRM_URL=%s\n\n' "$URL"
    exit 0
  fi
  sleep 10
done
echo "The road server is built but HTTPS did not answer yet. Wait 5 minutes and run:"
echo "  curl -s '$URL/table/v1/driving/-3.1791,51.4816;-2.9977,51.5842?annotations=duration'"
echo "Address for Claude: ROUTING_OSRM_URL=$URL"
exit 1
