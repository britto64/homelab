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
- [ ] `brittico-site` on **1.37.0 or newer** — the pages that ask for the voice.
- [ ] ~300 MB free on the pool for the voice models.
- [ ] A real terminal, for the `sudo` on the NAS.

---

## 1. Pull the stack change on the NAS

The compose file gains a service and a network. `scripts/deploy` bumps versions;
it does not carry a new service across, so the repo has to arrive on the NAS
first — the usual discipline from ADR 002.

```sh
ssh truenas_admin@192.168.0.82
sudo -i
cd /mnt/StorageHD1/homelab
git pull
```

`sudo -i` first: `/mnt/StorageHD1/stacks` cannot be entered without it, so
everything below assumes root. If git refuses on dubious ownership, use
`git -c safe.directory=/mnt/StorageHD1/homelab pull`.

## 2. Make the directory for the models

A plain directory beside the bot's `db`, inside the dataset that already
exists — **not a new ZFS dataset**. Docker would create it on its own at first
`up`, but creating it here keeps it on the intended pool and visible before
anything depends on it, the same as the backend's data directory in the
split-stacks migration.

```sh
mkdir -p /mnt/StorageHD1/configs/brittico_bot/vozes
```

## 3. Add the three variables to the stack's `.env`

```sh
cd /mnt/StorageHD1/stacks/britticobot
cat >> .env <<'EOF'

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

## 4. Download the voices before deploying

Do this as its own step rather than letting the deploy do it. The first boot
downloads ~250 MB before the server binds its port, and `scripts/deploy` waits
only 60 seconds for a container to report healthy before calling the rollout
failed and printing rollback instructions. Nothing would actually be broken, but
the message says otherwise, and that is a bad thing to read mid-deploy.

**Not `docker compose up -d piper`.** The .env still carries the *old*
`BOT_VERSION` at this point — the bump is step 5 — and the voice image only
exists from 1.22.0 onward, so compose would try to pull a tag that was never
published. Name the tag directly instead, and skip compose entirely:

```sh
for v in pt_BR-faber-medium pt_BR-cadu-medium pt_BR-jeff-medium pt_BR-edresson-low; do
  docker run --rm \
    -v /mnt/StorageHD1/configs/brittico_bot/vozes:/data \
    --entrypoint python3 brittinho/britticobot-piper:1.22.0 \
    -m piper.download_voices --data-dir /data "$v"
done
```

`Downloaded: <voice>` four times, and the volume is ready. The container that
step 5 starts finds them there and binds in a few seconds — the entrypoint skips
whatever it already has.

## 5. Roll the stack

Back on your own machine. This is the step that bumps `BOT_VERSION`, and `up -d`
creates the new `piper` container along with the bot:

```sh
scripts/deploy britticobot 1.22.0
```

It verifies the tag on the registry before touching the .env, and keeps the old
one as `.env.bak` for a rollback.

## 6. Roll the site too — it is half the change

The overlay page and the editor are in `brittico-site`, a different stack with
its own version. The bot alone gets you a synthesizer nothing calls.

```sh
scripts/deploy brittico-site 1.37.0
```

No `.env` work here: the site stack has exactly one variable, and it is the
version.

**Bot first, site second.** The other order gives new pages calling routes an
old bot does not serve — an empty voice picker and silent alerts, which looks
exactly like a broken install rather than a half-finished one.

## 7. Clear the Cloudflare cache for `overlay-core.js`

Do not skip this, or the fix will not appear for up to four hours.

`overlay-core.js` deliberately carries no `?v=`, because nginx sends it
`no-cache` — and Cloudflare's Browser Cache TTL, at its 4 h default, *raises*
any smaller value. Measured in production on 2026-08-05: the file goes out with
`max-age=14400` no matter what nginx says. This has already cost one incident,
where an OBS source held new HTML (which revalidates) against a stale
`overlay-core.js` and rendered a saved widget as nothing at all.

Here the stale copy is silent rather than blank: the old file still routes the
voice through `speechSynthesis`, which is the bug being fixed.

- **Cloudflare dashboard → Caching → Configuration → Purge cached content.** A
  single-file purge of `https://brittico.xyz/assets/js/overlay-core.js` is
  enough; purge everything if it is quicker to find.
- **In OBS**, on each source with an overlay: *Properties → Refresh cache of the
  current page*. The browser source has its own cache and the purge above does
  not reach it.

The real fix is a Cloudflare setting, not a step in a runbook: Browser Cache TTL
set to *Respect Existing Headers*, or a Cache Rule covering these paths. Until
that happens, every change to `overlay-core.js` needs this step.

---

## Checking it worked

From the NAS, straight at the synthesizer:

```sh
docker compose exec piper python3 -c "
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
docker compose stop piper
```

To turn it off without removing anything, put `TTS_ENABLED=false` in the `.env`
and recreate the bot. The editor then reports the voice as switched off, which is
a clearer answer than a synthesizer that never replies.

The models stay on the volume either way. They are not part of the backup — an
empty directory costs a slow first boot, nothing more.
