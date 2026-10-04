# livekit

The SFU behind Diskenzy 2: voice, camera and **screen share** for the training
rooms. Everyone sends one set of streams to this server and the server forwards
each viewer only the layer that fits their tile, so the sharer's upload does not
grow with the number of viewers (the old peer-to-peer mesh sent one stream per
viewer — 7 encoders and ~28 Mbps for a sharer in a room of 8).

It runs on a **VPS with a public IPv4**, not on the NAS. Media is UDP and raw
TCP on fixed ports; the Cloudflare tunnel carries HTTP only, and the house sits
behind CGNAT. The plan and the measurements live in the site repo:
`docs/DISKENZY-V2.md` (decisions D1–D3) and `docs/DISKENZY-MIDIA.md`.

- **Putting it on the VPS, step by step:** [`DEPLOY.md`](DEPLOY.md)
- **Why each choice, DNS/TLS/webhook/sizing/updates/troubleshooting:**
  [`docs/runbooks/livekit-on-the-vps.md`](../../docs/runbooks/livekit-on-the-vps.md)
- **The VPS itself (SSH, firewall, Docker):**
  [`docs/runbooks/hardening-a-fresh-vps.md`](../../docs/runbooks/hardening-a-fresh-vps.md)

## What is in here

| File | What it is |
| --- | --- |
| `compose.yaml` | Two services, both `network_mode: host`: `livekit` (the SFU) and `caddy` (certificates + `:443` routing by SNI) |
| `.env.example` | Every variable, documented. Image tags are pinned here, never `latest` |
| `livekit.yaml.example` | The server config with `@@MARKERS@@` instead of values |
| `caddy.yaml.example` | The Caddy (layer4) config, same markers |
| `render-config.sh` | Fills the two `.example` files from `.env` into `livekit.yaml` / `caddy.yaml` (never committed) |
| `gen-keys.sh` | Prints a fresh API key and secret; reads and writes nothing |

## Ports

Opened on the VPS firewall (the host-network containers are subject to `ufw`,
unlike published ports):

| Port | Protocol | Who uses it | Behind |
| --- | --- | --- | --- |
| 443 | TCP | `wss://livekit.<domain>` (signalling + admin API) and `turn.<domain>` (TURN over TLS) | Caddy, by SNI |
| 80 | TCP | Let's Encrypt HTTP-01 challenge, only while issuing/renewing | Caddy |
| 7881 | TCP | WebRTC over TCP, for clients whose UDP is blocked | LiveKit, raw |
| 7882–7889 | UDP | WebRTC media (ICE/UDP, muxed onto 8 ports) | LiveKit, raw |
| 3478 | UDP | TURN/UDP and STUN | LiveKit, raw |

Never open: `7880` (the API; it listens on loopback) and `5349` (plain TURN that
Caddy hands off to).

## Where it runs

**The VPS (default).** `COMPOSE_PROFILES=tls` in `.env`. DNS `livekit.<domain>`
and `turn.<domain>` as grey-cloud A records. Nothing in the house is exposed.

**The NAS (documented, not recommended today).** The same files work, with
`COMPOSE_PROFILES=` empty (no Caddy) — but only if the ISP takes the connection
out of CGNAT. As measured from the house, the path goes
`192.168.0.1 → 192.168.150.1 → 100.78.0.1` (the shared `100.64.0.0/10` range) and
the public address (`191.36.227.242`) is shared with other customers, so a port
forwarded on the router reaches nobody. What the variant takes, once the ISP
gives a real public IPv4 (or puts its box in bridge mode):

1. Forward `7881/tcp` and `7882-7889/udp` on **every** router in the path (two,
   while the double NAT lasts) to the NAS.
2. A DNS-only record kept up to date by DDNS for the house's IP (only needed if
   the IP is not static); set `LIVEKIT_NODE_IP` to the current public IP, or
   leave it empty so LiveKit finds it by STUN at start. Re-render and restart
   when the ISP changes it.
3. Signalling (`wss`) through the existing Cloudflare tunnel — it is plain
   HTTP/WebSocket, which the tunnel does carry — to `http://<nas-lan-ip>:7880`
   (set `LIVEKIT_HTTP_BIND=0.0.0.0`). No certificate then lives on the NAS.
4. Skip TURN/TLS on `:443` (no Caddy, so no SNI router): the built-in TURN stays
   on `3478/udp` only, so a client that can reach nothing but 443 cannot use it.
5. The house's upload (measured 120–150 Mbps) is shared with everything else at
   home. The room of 8 with 5 screens needs ~73 Mbps typical, ~81 at the
   configured ceilings and up to ~122 in the worst case (thumbnails on the medium
   layer); see the hosting section of `docs/DISKENZY-MIDIA.md` for the arithmetic.

Questions to put to the ISP, verbatim:

> 1. Minha conexão está atrás de CGNAT (IP compartilhado, faixa 100.64.0.0/10)?
> 2. Vocês oferecem IPv4 público dedicado (fixo ou dinâmico) para esta linha? Qual o custo mensal?
> 3. Posso colocar o aparelho de vocês em modo bridge e discar o PPPoE no meu próprio roteador?
> 4. O IPv6 nativo (com delegação de prefixo) está disponível para esta linha?
> 5. Há bloqueio de alguma porta de entrada (TCP/UDP) ou limite de upload sustentado?

**Cloudflare Realtime SFU** is the managed alternative with no public IP needed
at all; it is a different API (no rooms: sessions and tracks are ours to manage),
so it is not a drop-in swap. See the hosting section of `docs/DISKENZY-MIDIA.md`.

## Troubleshooting in one line each

- `livekit` restarts with `open /etc/livekit.yaml: permission denied` — the file
  was rendered by a user the container's root cannot read as; do not add
  `cap_drop: ALL` to the service (see the comment in `compose.yaml`).
- Everyone connects but there is no video — a firewall port above is closed, or
  the DNS record is orange (proxied). Media never reaches the SFU.
- `caddy` loops on `challenge failed` — port 80 closed, or a record points
  somewhere else; see the runbook ("TLS").
