#!/bin/sh
# Prints a fresh LiveKit API key pair, ready to paste into .env (and into the bot's .env).
# Reads nothing, writes nothing: the pair only exists on your screen until you paste it.
#
# Alphanumeric only because render-config.sh passes it through sed; 48 characters of the secret is
# ~285 bits, far above the 32-character floor the server checks.
set -eu
rand() { openssl rand -base64 192 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
echo "LIVEKIT_API_KEY=API$(rand 12)"
echo "LIVEKIT_API_SECRET=$(rand 48)"
