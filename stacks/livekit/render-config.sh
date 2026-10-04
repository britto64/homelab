#!/bin/sh
# Renders livekit.yaml and caddy.yaml from the .env, on the host.
#
# Why here and not inside the container: the LiveKit and Caddy images take their config as a file,
# neither interpolates ${VAR} in it, and the secret must not live in the committed tree. The same
# pattern as irl-mediamtx. Only alphanumeric values are accepted (sed does not escape metacharacters),
# which is also what ./gen-keys.sh produces.
#
# Run after changing anything in .env, then restart the containers:
#
#   ./render-config.sh && docker compose up -d --force-recreate
#
# `docker compose up -d` alone does not notice a changed bind-mounted file.
set -eu

cd "$(dirname "$0")"
[ -f .env ] || { echo ".env not found — copy .env.example first" >&2; exit 1; }
# shellcheck disable=SC1091
. ./.env

need() {
  eval "val=\${$1:-}"
  [ -n "$val" ] || { echo "$1 is empty in .env" >&2; exit 1; }
}
need LIVEKIT_DOMAIN
need TURN_DOMAIN
need LIVEKIT_API_KEY
need LIVEKIT_API_SECRET
need LIVEKIT_WEBHOOK_URL
LIVEKIT_HTTP_BIND="${LIVEKIT_HTTP_BIND:-127.0.0.1}"

# the API key pair goes through sed unescaped, so it must be plain
case "$LIVEKIT_API_KEY$LIVEKIT_API_SECRET" in
  *[!A-Za-z0-9]*) echo "LIVEKIT_API_KEY/SECRET must be alphanumeric only (see ./gen-keys.sh)" >&2; exit 1 ;;
esac
[ "${#LIVEKIT_API_SECRET}" -ge 32 ] || { echo "LIVEKIT_API_SECRET must have at least 32 characters" >&2; exit 1; }
[ "$LIVEKIT_DOMAIN" != "$TURN_DOMAIN" ] || { echo "LIVEKIT_DOMAIN and TURN_DOMAIN must differ (Caddy routes :443 by SNI)" >&2; exit 1; }

# hostnames, the URL and the IP go through sed with | as the delimiter: refuse a | or a newline
for v in "$LIVEKIT_DOMAIN" "$TURN_DOMAIN" "$LIVEKIT_WEBHOOK_URL" "${LIVEKIT_NODE_IP:-}" "$LIVEKIT_HTTP_BIND"; do
  case "$v" in *'|'*|*'&'*|*'\'*) echo "unsupported character in: $v" >&2; exit 1 ;; esac
done

if [ -n "${LIVEKIT_NODE_IP:-}" ]; then
  USE_EXTERNAL_IP=false
  NODE_IP_LINE="node_ip: $LIVEKIT_NODE_IP"
else
  USE_EXTERNAL_IP=true
  NODE_IP_LINE="# node_ip: not set — the public IP is discovered by STUN at start"
fi

render() {
  sed -e "s|@@LIVEKIT_DOMAIN@@|$LIVEKIT_DOMAIN|g" \
      -e "s|@@TURN_DOMAIN@@|$TURN_DOMAIN|g" \
      -e "s|@@LIVEKIT_API_KEY@@|$LIVEKIT_API_KEY|g" \
      -e "s|@@LIVEKIT_API_SECRET@@|$LIVEKIT_API_SECRET|g" \
      -e "s|@@LIVEKIT_WEBHOOK_URL@@|$LIVEKIT_WEBHOOK_URL|g" \
      -e "s|@@LIVEKIT_HTTP_BIND@@|$LIVEKIT_HTTP_BIND|g" \
      -e "s|@@USE_EXTERNAL_IP@@|$USE_EXTERNAL_IP|g" \
      -e "s|@@NODE_IP_LINE@@|$NODE_IP_LINE|g" \
      "$1.example" > "$1"
  chmod 600 "$1"
  if grep -Eq '@@[A-Z_]+@@' "$1"; then
    echo "$1 still has an unreplaced @@ marker" >&2
    rm -f "$1"
    exit 1
  fi
}

grep -Eq '@@[A-Z_]+@@' livekit.yaml.example || { echo "livekit.yaml.example has no @@ markers — is this the right file?" >&2; exit 1; }
render livekit.yaml
render caddy.yaml
echo "rendered livekit.yaml and caddy.yaml (secrets from .env)"
