#!/bin/sh
# Renders mediamtx.yml from the .env secrets, on the host.
#
# Why here and not inside the container: the MediaMTX image is distroless —
# there is no shell to run sed in — and the server itself neither interpolates
# ${VAR} in its YAML nor accepts list-valued parameters through the MTX_* env
# overrides. Only scalars go through env vars; authInternalUsers is a list.
#
# Run after changing anything in .env, then `docker compose up -d`:
#
#   ./render-config.sh
#
# The committed tree holds the @@ markers (mediamtx.yml.example); the rendered
# file holds the secrets and is never committed.
set -eu

cd "$(dirname "$0")"
. ./.env

render() {
  sed -e "s|@@IRL_SRT_USER@@|$IRL_SRT_USER|g" \
      -e "s|@@IRL_SRT_PASSWORD@@|$IRL_SRT_PASSWORD|g" \
      -e "s|@@IRL_API_USER@@|$IRL_API_USER|g" \
      -e "s|@@IRL_API_PASSWORD@@|$IRL_API_PASSWORD|g" \
      mediamtx.yml.example > mediamtx.yml
  chmod 600 mediamtx.yml
}

if grep -q '@@' mediamtx.yml.example; then :; else
  echo "mediamtx.yml.example has no @@ markers — is this the right file?" >&2
  exit 1
fi

render
echo "rendered mediamtx.yml (secrets from .env)"
