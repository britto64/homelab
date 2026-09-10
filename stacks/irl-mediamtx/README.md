# irl-mediamtx

The ingest for the IRL stream: Kennzy's phone publishes SRT here, Britto's
OBS pulls the same path as a media source, and the bot polls the API to flip
IRL/Pausa scenes when the signal drops. The full reasoning lives in the
site repo, `docs/IRL-SETUP.md` — this stack is just the server half.

| Port | Protocol | Who uses it |
| --- | --- | --- |
| 8890/udp | SRT ingest | the phone (Larix) — publish via streamid |
| 8888 | HLS preview | any browser, credentials in the URL |
| 9997 (loopback) | control API | the bot's `irl.ts` monitor, via Basic auth |

Right now (ensaio) it runs on the NAS, over the LAN; the bot reaches the API
through the `edge` network as `http://brittico-mediamtx:9997`. When the IRL
goes to the Contabo VPS, these same files move there — on the VPS only the
SRT port faces the internet and the API listens behind an SSH tunnel, so the
bot's `IRL_MTX_URL` becomes `http://127.0.0.1:9997`.

## The streamid is the key to going live

Auth is `authInternalUsers` (the list replaces MediaMTX's catch-all "any"
publisher). The phone's URL carries the credentials inside the streamid:

```
srt://HOST:8890?streamid=#!::r=kennzy,m=publish,u=kennzy,s=SENHA
```

Whoever has IP:port and that string goes live on the channel. So the password
is long, lives in `.env`, and rotates on suspicion — same drill as the OBS
control key.

## Deploy

Ensaio on the NAS (this repo): copy the stack to
`/mnt/StorageHD1/stacks/irl-mediamtx/`, fill `.env` (copy from
`.env.example`, generate two alphanumeric passwords), `docker compose up -d`.
No published ports beyond the LAN; the tunnel does not front this stack.
The container renders `mediamtx.yml` from the template on every start — the
committed file never holds a secret.

## Phase 2, deliberately not built

A `runOnReady` hook that republishes straight to Twitch/Kick/YouTube would
turn the OBS into an optional consumer (the live would survive the PC dying).
It is documented in IRL-SETUP.md and not built: the PC is not the weak link
today, and one stream key = one connection, so normal mode and failover mode
are mutually exclusive — not a switch to leave half-built.
