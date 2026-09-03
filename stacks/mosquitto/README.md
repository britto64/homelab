# mosquitto

The MQTT broker behind diskenzy's live sync — presence, call member cards,
chat, WebRTC signaling, the Rift map. Reached as `wss://mqtt.brittico.xyz/mqtt`
through the cloudflared tunnel; the site keeps the three public brokers as
fallback for when this box is down.

## Why it exists

Diskenzy rotated through public brokers (emqx, hivemq, mosquitto) with
failover. MQTT retained state is per-broker, and the round-robin put different
people on different brokers: one person joined a call and the other never saw
the card — the "I am alone in the call" bug — and leave/goodbye messages were
lost the same way, leaving tiles up for up to a minute. One broker of our own
removes the split-brain; the fallback list only exists for outages, where a
split is the degraded mode, not the norm.

The code side of the fix lives in the site repo
(`1.servidor/1.site_brittico/public/diskenzy/`): a "who is here" handshake and
a 15s member-card heartbeat. This stack is only the broker.

## Bringing it up

```sh
mkdir -p data && chown 1883:1883 data   # mosquitto's uid in the container
cp .env.example .env
docker compose up -d
```

Mosquitto also wants the config files it reads to be owned by its user and not
world-readable — it warns now and future versions will refuse to load the ACL
altogether (which would leave the broker without its only fence):

```sh
chown 1883:1883 acl mosquitto.conf && chmod 600 acl
```

## Publishing the hostname

The tunnel is remotely managed, so the route lives in the Zero Trust
dashboard, not in this repo (same as every other hostname):

1. Networks > Tunnels > the brittico tunnel > Public Hostname > Add.
2. Hostname `mqtt.brittico.xyz`, service `ws://brittico-mqtt:9001`.
   The container name resolves because cloudflared and this stack share the
   external `edge` network. WebSocket is on by default for public hostnames.

The site expects the path `/mqtt` (the Paho default); mosquitto accepts any
path on its websockets listener, so nothing needs configuring here.

## Checking it

From the NAS shell, through the debug listener:

```sh
mosquitto_sub -h 127.0.0.1 -t 'diskenzy/#' -v
```

Join a call on the site and you should see presence and member cards scroll
by. The `-v` form prints topic and payload, which is how you tell a live
publish from a retained delivery.

The ACL confines every client to `diskenzy/#`; `$SYS` is not readable.
