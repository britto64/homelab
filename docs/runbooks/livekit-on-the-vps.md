# Runbook — LiveKit on the VPS

The reasoning behind `stacks/livekit/`. The exact commands, in order, are in
[`stacks/livekit/DEPLOY.md`](../../stacks/livekit/DEPLOY.md); this page is for the
"why" and for the day something does not connect.

Target: the Contabo Cloud VPS in US Central (St. Louis), Ubuntu 24.04, 4 vCPU /
8 GB, 200 Mbit/s port, prepared as in
[`hardening-a-fresh-vps.md`](hardening-a-fresh-vps.md). The domain is
`brittico.xyz` on Cloudflare. LiveKit server `v1.13.7`.

---

## Why a VPS, and why LiveKit at all

Diskenzy's calls used a peer-to-peer mesh: in a room of 8, whoever shared a screen
encoded it seven times and uploaded ~28 Mbps. An SFU takes **one** set of streams
from each person and forwards each viewer the size that fits their tile. The
measurements that justify it are in the site repo, `docs/DISKENZY-MIDIA.md`.

The server must be reachable on raw UDP and TCP ports from the whole internet.
That rules out this house today: the line is behind CGNAT (the path goes through
`100.78.0.1`, in the shared `100.64.0.0/10` range), so a router port forward
reaches nobody, and the Cloudflare tunnel carries HTTP only. The NAS variant is in
the stack README, with the questions to ask the ISP.

## DNS: grey cloud, always

Two A records in the `brittico.xyz` zone, both pointing at `209.145.50.128`:
`livekit` and `turn`. **Proxy status must be "DNS only" (grey cloud).**

The orange cloud puts Cloudflare's reverse proxy in front of the name. That proxy
speaks HTTP(S) and WebSocket — it does not forward UDP, and not the TCP ports
7881/443-as-TURN either. The failure mode is the nasty kind:

- the page loads, the token is accepted, the **signalling WebSocket connects**
  (that is plain HTTPS, which the proxy handles), the participant even shows up in
  the room — and then ICE never completes, because the media addresses are the
  VPS's own IPs, reached on ports the proxy does not carry. Symptom: everyone
  "joins" and nobody sees or hears anybody; after ~15 s the SDK gives up with
  `could not establish pc connection`.
- certificate issuance also fails (the HTTP-01 challenge reaches Cloudflare, not
  Caddy), and TURN/TLS gets Cloudflare's certificate instead of ours.

The check, from any machine: `dig +short livekit.brittico.xyz @1.1.1.1` must print
`209.145.50.128`, not `104.x` / `172.67.x`.

## TLS: Caddy over HTTP-01, no Cloudflare token

Caddy (LiveKit's own `caddyl4` build, with the layer4 plugin) obtains a Let's
Encrypt certificate for each name by the **HTTP-01** challenge: Let's Encrypt
fetches `http://livekit.brittico.xyz/.well-known/acme-challenge/...` on port 80,
which Caddy answers. This works because the records are grey: the request lands on
the VPS. It needs port 80 open and **no secret at all**. Renewal is automatic,
about 30 days before expiry, and also needs port 80. The certificates live in
`caddy_data/` (a bind mount), so `down`/`up` does not re-issue them and burn the
Let's Encrypt rate limit.

Why not the alternatives:

| Option | Verdict |
| --- | --- |
| **HTTP-01 (chosen)** | Needs port 80 open and a grey record. No token. This is also what LiveKit's own generated install does (it lists 80 as "TLS issuance"). |
| DNS-01 with the Cloudflare API | Works with port 80 closed and with an orange record, but needs a token (scope `Zone → DNS → Edit`, limited to this one zone), a custom Caddy image built with the `caddy-dns/cloudflare` **and** the layer4 plugin (`xcaddy`), and one more secret on the VPS. Only worth it if port 80 cannot be opened. |
| Cloudflare Origin CA certificate | **Does not work here.** It is trusted only by Cloudflare's proxy talking to your origin; a browser or the LiveKit SDK connecting straight to the VPS rejects it. And the whole point is that the record is not proxied. |
| `certbot --standalone` | Works, but then Caddy cannot own :443 for the SNI routing; no gain. |

If port 80 ever has to stay closed, switch to DNS-01: build a Caddy with both
plugins, replace the `automate` list in `caddy.yaml.example` by an `automation`
policy with the `dns` challenge, and add the token to `.env`. Not needed today.

## Ports

| Port | Who | Why it is open |
| --- | --- | --- |
| 80/tcp | Let's Encrypt | HTTP-01 challenge, at issue and renewal |
| 443/tcp | Browsers, the bot | `wss://livekit.<domain>` (signalling) and the REST admin API; `turn.<domain>` for TURN over TLS. Caddy tells them apart by SNI |
| 7881/tcp | Browsers | WebRTC over TCP when UDP is blocked |
| 7882–7889/udp | Browsers | WebRTC media. Eight ports (twice the vCPUs) instead of LiveKit's default 50000–60000 range: one firewall line, same performance |
| 3478/udp | Browsers | TURN/UDP and STUN |

Closed on purpose: `7880` (the API; it only listens on loopback) and `5349` (plain
TURN that Caddy forwards to). With `network_mode: host` there are no published
ports to bypass `ufw`, so `ufw status` is the whole story.

The admin API is reachable through `https://livekit.<domain>/twirp/...` because the
bot calls it from the house. It is protected by the API key (every call needs a JWT
signed with the secret, 48 random characters): without the key it answers 401.
Do not expose 7880 or add routes around Caddy, and keep the secret out of the
logs and the chat.

## The bot and LiveKit

Two directions, both ordinary HTTPS, nothing opened at home:

- **bot → LiveKit** (outbound from the house): the bot mints participant tokens
  locally with the key pair (no network call), and calls the admin API —
  `RemoveParticipant`, `MutePublishedTrack`, `UpdateParticipant`, `ListParticipants`
  — at `https://livekit.brittico.xyz/twirp/livekit.RoomService/<Method>`.
  `MoveParticipant` and `ForwardParticipant` are **LiveKit Cloud only** (the docs
  say so); on this self-hosted server the bot moves someone by sending the new
  token and letting the client reconnect to the other room.
- **LiveKit → bot** (inbound through the tunnel): a signed POST to
  `https://api.brittico.xyz/api/diskenzy/v2/rtc/webhook` for `participant_joined`,
  `participant_left`, `track_published`, `room_started`, ... The request carries
  `Authorization: <JWT signed with the API secret>` and the JWT contains the SHA-256
  of the body, so the receiver must read the **raw** body (`Content-Type:
  application/webhook+json`) and verify it with the same pair — `WebhookReceiver`
  in `livekit-server-sdk` does exactly that.

**If the bot is down.** LiveKit queues events (100 per URL) and retries a failed
POST with the HTTP library's exponential back-off (assumed defaults of
`go-retryablehttp`: 4 retries, 1 s to 30 s apart — not verified against the
parameters LiveKit passes it, and not measured), then drops the event and logs
`dropped webhook`. So an outage of
more than half a minute or so loses `participant_joined/left` events, and the voice
roster the bot keeps goes stale. Nothing breaks on the media side — people stay
connected to each other, because the SFU does not depend on the bot once the token
is issued. What the bot must do on start (and periodically): `ListParticipants` for
each voice room and reconcile its roster. That is the recovery path; do not rely on
the retry.

## TURN: the built-in one, not forced

`turn.enabled: true` runs LiveKit's own TURN server: UDP on 3478 and TLS on 443
(through Caddy, hostname `turn.<domain>`). The SDK uses it **only** when direct UDP
or TCP does not work, so almost everyone connects direct, and the few behind a
firewall that only lets 443 out still get through.

Two rules for the client side:

1. **Never set `iceTransportPolicy: "relay"` for LiveKit** (the app's
   `voice-presets.js` strips it). Forcing relay makes everybody's media go through
   TURN even when a direct path works: TURN/TLS is TCP, so one lost packet stalls
   the whole stream behind it (the opposite of what a screen share needs), and
   every packet is processed one more time. With the Cloudflare TURN it would also
   be an extra network hop and a draw on the shared allowance below.
2. The Cloudflare TURN credentials the bot already mints for the old app
   (`ice.ts`) are **not** needed for LiveKit. They remain for the old mesh app, and
   Cloudflare's 1 TB/month free allowance is shared between its TURN and its SFU,
   so there is no reason to spend it on a server that has TURN of its own.

## Sizing

The port is the constraint, not the CPU. The numbers come from `docs/DISKENZY-MIDIA.md` in
the site repo (measured on a workstation with Chromium and fake screens; the model is
`estimateSfuEgressKbps` in `voice-presets.js`):

- **CPU:** the SFU forwarded 25–67 Mbps of video on 0.1–0.3 of one core. 4 vCPUs are
  overkill; 2 would do.
- **Bandwidth out of the VPS** for the event room (8 people: 5 screens + 3 cameras, each
  viewer seeing one stage in full quality and the rest as thumbnails): **~73 Mbps typical,
  ~81 Mbps with every layer at its configured ceiling, ~122 Mbps worst case** (all
  thumbnails on the medium layer). That is **~33 GB per hour** typical (55 GB/h worst). The
  Contabo port is 200 Mbit/s: typical use is 36% of it, the worst case 61%, so the headroom
  is 78–127 Mbps. A three-hour session is ~100 GB; three a week is ~1.3 TB a month.
- **Bandwidth into the VPS:** the sum of what the sharers upload (2–10 Mbps each),
  below the egress.
- What was **not** verified: Contabo's "unlimited traffic" fine print.

## Updating, rolling back, rotating

- **New LiveKit version:** read the release notes (<https://github.com/livekit/livekit/releases>),
  edit `LIVEKIT_VERSION` in `.env`, `docker compose pull && docker compose up -d`.
  A restart disconnects everyone for a few seconds; the SDK reconnects by itself
  (`ICE restart → resume → full reconnect`). Do it between sessions. Update the
  `livekit-client` vendored in the site in the same pass if the release notes mention
  a protocol change (the client and server versions are tested together).
- **Roll back:** put the previous tag back in `.env`, same two commands.
- **Config change:** edit `.env` or a `.example`, `./render-config.sh`,
  `docker compose up -d --force-recreate`. Compose does not notice a changed
  bind-mounted file by itself.
- **Rotate the keys:** `./gen-keys.sh`, replace both lines in `.env`, re-render,
  recreate, then update the bot's `.env` and restart the bot. Open calls drop and
  rejoin.
- **Caddy image** (`CADDY_L4_VERSION`): same procedure; keep `caddy_data/`.

## Troubleshooting

| Symptom | Likely cause | Look at |
| --- | --- | --- |
| Joins fine, nobody sees anybody, `could not establish pc connection` after ~15 s | Orange cloud on the record, or `ufw` blocking 7882–7889/udp and 7881/tcp | `dig`, `ufw status`; the page console's `pair.proto` / `candidateType` |
| Works on Wi-Fi at home, not on a given network (office, school) | That network drops UDP; it needs TCP 7881 or TURN/TLS on 443 | Does `curl -v https://turn.<domain>` from there answer? Is `turn.<domain>` grey? |
| `caddy` logs `challenge failed` / `no valid A records` | Port 80 closed, wrong or proxied record, or the DNS has not propagated | `ufw`, `dig @1.1.1.1`, `docker compose logs caddy` |
| Browser says certificate error on `wss://livekit...` | Certificate not issued yet, or a stale `caddy_data` from another host name | `docker compose logs caddy`; wait for "certificate obtained" |
| `livekit` exits with `permission denied` on `/etc/livekit.yaml` | `cap_drop: ALL` added to the service, or the file rendered by another user | `ls -l livekit.yaml`; re-run `./render-config.sh` as `deploy` |
| Bot gets 401 from `/twirp/...` | Key pair differs between VPS and bot, or the token's grants lack `roomAdmin` | Compare `LIVEKIT_API_KEY` on both sides |
| Voice roster in the app stale after a bot outage | Webhook events were dropped | Reconcile with `ListParticipants` |
| Someone killed their browser and stays in the list ~20 s | LiveKit detects a silent client by ICE timeout (10 s + 5 s, fixed in the server) | The bot should `RemoveParticipant` when the gateway session closes without resuming |

## Alternatives, in short

- **The NAS:** only after the ISP removes CGNAT. See the stack README.
- **Cloudflare Realtime SFU** (managed, no server to run, no public IP needed):
  billed per GB out of Cloudflare; a different API with no rooms, so the bot would
  own session and track bookkeeping. Prices and limits in `docs/DISKENZY-MIDIA.md`.
- **LiveKit Cloud:** the free tier (5,000 WebRTC minutes and 50 GB/month) is for the
  lab, not the event. It is also the only place `MoveParticipant` exists.
