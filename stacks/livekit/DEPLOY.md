# Deploying LiveKit on the VPS

The exact sequence for the Contabo VPS (Cloud VPS, US Central, Ubuntu 24.04,
`209.145.50.128`), after it has been through
[`hardening-a-fresh-vps.md`](../../docs/runbooks/hardening-a-fresh-vps.md): a
`deploy` user with sudo, key-only SSH, `ufw` closed except SSH, Docker with the
compose plugin. About 20 minutes, most of it DNS.

Everything marked **[workstation]** runs on your machine, **[vps]** on the VPS as
`deploy`. Hostnames below use `brittico.xyz`; if the domain differs, change it in
step 1 and in `.env`.

> Why this layout and what each piece is for: the runbook,
> [`livekit-on-the-vps.md`](../../docs/runbooks/livekit-on-the-vps.md). Nothing
> here needs a Cloudflare API token: certificates come from Let's Encrypt over
> port 80 (HTTP-01), which is enough because the DNS records point straight at
> the VPS.

## 0. Before you start

**[vps]**

```sh
sudo -n true && echo sudo ok
docker compose version
sudo ufw status | head -5        # Status: active, only 22/tcp allowed
```

## 1. DNS, in the Cloudflare dashboard

Zone `brittico.xyz` → DNS → Records. Two **A** records, proxy status **DNS only
(grey cloud)**. `livekit` already exists (DNS only → `209.145.50.128`); **`turn` still has to
be added** — Caddy needs it to issue the TURN/TLS certificate, and without it the
`caddy` container logs a failed challenge for that name (the SFU itself still works):

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `livekit` | `209.145.50.128` | **DNS only** |
| A | `turn` | `209.145.50.128` | **DNS only** |

An orange cloud here breaks the media silently (the proxy only passes HTTP(S)
and WebSocket; the UDP never reaches the server) and also breaks the certificate
challenge. **[workstation]** check, expecting the VPS address and not a
Cloudflare one (104.x / 172.67.x):

```sh
dig +short livekit.brittico.xyz @1.1.1.1
dig +short turn.brittico.xyz @1.1.1.1
```

## 2. Firewall

**[vps]** The containers use host networking, so these `ufw` rules are the real
boundary (a published Docker port would have bypassed `ufw`).

```sh
sudo ufw allow 80/tcp       comment 'livekit: acme http-01'
sudo ufw allow 443/tcp      comment 'livekit: https, wss, turn/tls'
sudo ufw allow 7881/tcp     comment 'livekit: ice/tcp'
sudo ufw allow 7882:7889/udp comment 'livekit: ice/udp'
sudo ufw allow 3478/udp     comment 'livekit: turn/udp, stun'
sudo ufw status numbered
```

Do **not** open 7880 (the API) or 5349 (plain TURN behind Caddy).

## 3. Put the stack on the VPS

**[vps]**

```sh
sudo install -d -o deploy -g deploy /opt/livekit
```

**[workstation]** (from the `homelab` checkout; use whatever `-i` your key for this
VPS needs). The rendered files and `.env` are excluded so a re-sync never
overwrites what the VPS holds:

```sh
rsync -av --exclude '.env' --exclude 'livekit.yaml' --exclude 'caddy.yaml' --exclude 'caddy_data' \
  stacks/livekit/ deploy@209.145.50.128:/opt/livekit/
```

## 4. The `.env` and the keys

**[vps]**

```sh
cd /opt/livekit
cp .env.example .env && chmod 600 .env
# fresh key pair, appended straight to .env — it never appears on screen
sed -i '/^LIVEKIT_API_KEY=$/d;/^LIVEKIT_API_SECRET=$/d' .env
./gen-keys.sh >> .env
grep -c '^LIVEKIT_API_' .env     # 2
```

The defaults already fit the target: `LIVEKIT_DOMAIN=livekit.brittico.xyz`,
`TURN_DOMAIN=turn.brittico.xyz`, `COMPOSE_PROFILES=tls`, the webhook URL
`https://api.brittico.xyz/api/diskenzy/v2/rtc/webhook`, `LIVEKIT_NODE_IP` empty
(found by STUN). Check them with `grep -v '^#' .env | grep -v API_SECRET`.

The key pair is the **only** secret that exists in two places: here, and in the
bot's environment (step 8). Nothing else crosses machines.

## 5. Render and start

**[vps]**

```sh
cd /opt/livekit
./render-config.sh               # writes livekit.yaml and caddy.yaml (mode 600)
docker compose pull
docker compose up -d
```

## 6. Check it is healthy

**[vps]**

```sh
docker compose ps                                  # livekit: Up (healthy); caddy: Up
docker compose logs caddy | grep -i -E 'obtained|error' | cut -c1-200
#   expect "certificate obtained successfully" once for each hostname, within ~30 s
docker compose logs --tail 20 livekit | cut -c1-200
#   expect "starting LiveKit server" with rtc.portUDP {Start:7882 End:7889} and "Starting TURN server"
sudo ss -ltnup | grep -E ':(80|443|7880|7881|5349|3478|788[2-9])\b'
#   7880 on 127.0.0.1 only; the rest on 0.0.0.0 (5349 is blocked by ufw)
```

**[workstation]**

```sh
curl -s https://livekit.brittico.xyz/            # -> OK
echo | openssl s_client -connect turn.brittico.xyz:443 -servername turn.brittico.xyz 2>/dev/null \
  | openssl x509 -noout -issuer -enddate          # issuer: Let's Encrypt
```

An end-to-end media test, from your machine through the real network path. The
keys go into the shell's environment only, never a file:

```sh
cd site/scripts/lab-livekit && npm ci
eval "$(ssh deploy@209.145.50.128 "grep -E '^LIVEKIT_API_(KEY|SECRET)=' /opt/livekit/.env" | sed 's/^/export /')"
node token.mjs --admin 1 > /tmp/lk-admin.jwt                         # admin API works?
curl -s -H "Authorization: Bearer $(cat /tmp/lk-admin.jwt)" -H 'Content-Type: application/json' \
  -d '{}' https://livekit.brittico.xyz/twirp/livekit.RoomService/ListRooms ; rm /tmp/lk-admin.jwt   # -> {}
# two browser tabs in one room: p1 shares a (fake) screen, p2 watches
node token.mjs --room teste --identity p1 --url wss://livekit.brittico.xyz --role screen 2>&1 | tail -2
node token.mjs --room teste --identity p2 --url wss://livekit.brittico.xyz --role watch  2>&1 | tail -2
npm run lab:serve                                                    # in another terminal, serves on :3000
```

Open the two printed links; p2's tab should show p1's screen with 20–60 fps in the
status bar. For media-path numbers (RTT, protocol, relay or not) the page's
console prints `LAB {...}` lines with `pair.rttMs` and `pair.proto`.

## 7. The webhook

LiveKit posts to `LIVEKIT_WEBHOOK_URL` from the first participant on. Until the
bot ships `POST /api/diskenzy/v2/rtc/webhook` the posts fail and are dropped
(harmless; `docker compose logs livekit | grep -i webhook`). The bot verifies the
`Authorization` header with the same key pair (`WebhookReceiver` in
`livekit-server-sdk`; body type `application/webhook+json`, read it raw).

## 8. What the bot needs

In the bot's `.env` on the NAS, same pair as step 4:

```
LIVEKIT_URL=wss://livekit.brittico.xyz
LIVEKIT_API_KEY=<from the VPS .env>
LIVEKIT_API_SECRET=<from the VPS .env>
```

The bot calls the admin API at `https://livekit.brittico.xyz/twirp/...` (outbound
HTTPS from the house — nothing is opened at home) and LiveKit calls the webhook
at `https://api.brittico.xyz/...` (already public through the tunnel).

## Day 2

```sh
# change anything in .env, or update the templates, then:
./render-config.sh && docker compose up -d --force-recreate
# new LiveKit version: edit LIVEKIT_VERSION in .env, then
docker compose pull && docker compose up -d
# roll back: put the previous tag back in .env and repeat the line above
# logs
docker compose logs -f --tail 100 livekit
```

Certificates renew by themselves (Caddy, ~30 days before expiry, over port 80);
keep `caddy_data/` — it holds the ACME account and the certificates. Rotating the
keys: `sed -i '/^LIVEKIT_API_/d' .env && ./gen-keys.sh >> .env`, re-render, recreate,
and update the bot's `.env`; open calls drop and reconnect with fresh tokens.

Run `docker compose` as the `deploy` user that created the files (`docker` group),
not with a stray `sudo`: a root-owned `caddy.yaml` or `livekit.yaml` makes the next
`render-config.sh` fail with "Permission denied".
