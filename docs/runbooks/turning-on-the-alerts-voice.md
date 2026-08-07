# Runbook — turning on the alerts' voice

One-time. Adds the `piper` service to the `britticobot` stack, which is what
makes an alert's text-to-speech come out of OBS at all.

**Roughly 20 minutes**, nearly all of it the first download of the voice models.
Nothing here touches the bot's database or any existing container's state.

---

## Why there is a new container

The alerts read their text with the browser's speech API. OBS's browser source
is CEF, and **CEF does not carry Chrome's speech service**: `getVoices()` returns
an empty list, `speak()` does nothing, and no error is raised anywhere. The voice
worked in the editor, in Chrome, in every check made before going live — and the
stream went out silent. `&teste=` never caught it, because whoever tested was in
a real browser.

So the synthesis moved to the server. `piper` generates a WAV, the overlay plays
it with `new Audio()` — the same path the alert's sound already used, which
always worked inside OBS.

It is in the bot's stack rather than one of its own because it has the bot's
lifecycle exactly (ADR 003): nothing else calls it, it is useless without the
bot, and the two roll out together.

---

## Before you start

- [ ] `britticobot` on **1.22.0 or newer** — older images do not know `TTS_URL`
      and have no `/api/overlays/.../tts` route.
- [ ] Both images published. The workflow pushes `britticobot` and
      `britticobot-piper` under the same tag, in the same run.
- [ ] ~300 MB free on the pool for the voice models.
- [ ] A real terminal, for the `sudo` on the NAS.

---

## 1. Pull the stack change on the NAS

The compose file gains a service and a network. `scripts/deploy` bumps versions;
it does not carry a new service across, so the repo has to arrive on the NAS
first — the usual discipline from ADR 002.

```sh
ssh truenas_admin@192.168.0.82
cd <the homelab clone on the NAS>
git pull
```

## 2. Add the three variables to the stack's `.env`

```sh
cd /mnt/StorageHD1/stacks/britticobot
sudo tee -a .env >/dev/null <<'EOF'

PIPER_DATA_HOST_PATH=/mnt/StorageHD1/configs/brittico_bot/vozes
PIPER_VOICES=pt_BR-faber-medium,pt_BR-cadu-medium,pt_BR-jeff-medium,pt_BR-edresson-low
PIPER_DEFAULT_VOICE=pt_BR-faber-medium
EOF
```

**No `PIPER_VERSION`, and this is the one thing not to improvise.** The voice
image is pinned to `${BOT_VERSION}` because `scripts/deploy` bumps exactly one
`*_VERSION` per stack — it reads the first `^[A-Z_]+VERSION=` out of the `.env`.
A second version variable here would be one the script never touches, and the
voice would silently stay on an old image every time the bot rolled.

`TTS_URL` is **not** here either: it is in the compose body, because it is an
address between two containers in this stack and not a secret.

## 3. Download the voices before deploying

Do this as its own step rather than letting the deploy do it. The first boot
downloads ~250 MB before the server binds its port, and `scripts/deploy` waits
only 60 seconds for a container to report healthy before calling the rollout
failed and printing rollback instructions. Nothing would actually be broken, but
the message says otherwise, and that is a bad thing to read mid-deploy.

```sh
sudo docker compose up -d piper
sudo docker compose logs -f piper
```

Wait for `[piper] servindo em :5000`. Later boots take a few seconds — the models
are on the volume, and the entrypoint skips what it already has.

## 4. Roll the stack

From your machine, once both images are on the registry:

```sh
scripts/deploy britticobot 1.22.0
```

---

## Checking it worked

From the NAS, straight at the synthesizer:

```sh
sudo docker compose exec piper python3 -c "
import json,urllib.request
print(list(json.load(urllib.request.urlopen('http://localhost:5000/voices'))))"
```

Four voice names means the volume is populated. Then, in the site's overlay
editor: open an alert, turn on **Ler em voz alta**, and the voice picker should
list them as "Faber — português do Brasil (médio)" and so on. An empty picker
with "Nenhuma voz respondeu" means the bot cannot reach `piper` — check that both
services are on the `interna` network.

Last, press **Testar** with the overlay open as a source in OBS. That is the only
check that proves the thing this whole exercise exists for.

---

## If it has to come off

The voice is not load-bearing: without it an alert still draws and still plays
its sound, and the editor says the synthesizer is down instead of failing
silently.

```sh
cd /mnt/StorageHD1/stacks/britticobot
sudo docker compose stop piper
```

To turn it off without removing anything, put `TTS_ENABLED=false` in the `.env`
and recreate the bot. The editor then reports the voice as switched off, which is
a clearer answer than a synthesizer that never replies.

The models stay on the volume either way. They are not part of the backup — an
empty directory costs a slow first boot, nothing more.
