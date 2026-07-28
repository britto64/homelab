# Runbook — migrating to the split stacks

One-time migration. Takes the britticobot from a single loose `compose.txt` to
three stacks in this repository, and moves the site's analytics into its own
service.

Nothing here is reversible by accident, but every step is reversible on purpose:
the old compose keeps working until you replace it, and the analytics data is
copied rather than moved.

**Roughly 40 minutes.** Read it through once before starting.

---

## What changes

| Before | After |
| --- | --- |
| One `compose.txt` with the bot and the tunnel inside it | Three stacks: `britticobot`, `cloudflared`, `brittinho-backend` |
| Restarting the bot cycled the tunnel | The tunnel comes up once and stays |
| `image: ...:latest` + `pull_policy: always` | A pinned version you choose |
| ~35 secrets in the compose body | An `.env` beside each compose |
| Analytics inside the bot's process | Its own container, its own database |

---

## Before you start

- [ ] The three filled-in `.env` files (from `local/` on your machine)
- [ ] SSH access to the NAS, or the Dockge terminal
- [ ] Both images on Docker Hub — see step 1

---

## 1. Get the images built

Dockge pulls from Docker Hub; it never builds. Both repositories have to reach
GitHub for there to be anything to deploy.

Already done:

- `britto64/britticobot` — merged to `main`, built, published as `1.2.0`,
  `sha-431ba9c` and `latest`
- `britto64/brittinho.com` — merged to `main`
- `britto64/homelab` — merged to `main`
- `britto64/brittinho-backend` — created and pushed

**Still to do: the backend's build fails at the Docker Hub login**, because a
new repository starts with no secrets. Everything before that step passed,
including the typecheck — this is the only thing missing.

Go to **github.com/britto64/brittinho-backend → Settings → Secrets and
variables → Actions → New repository secret** and add the same two the bot
already has:

| Name | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | `brittinho` |
| `DOCKERHUB_TOKEN` | an access token from hub.docker.com → Account Settings → Personal access tokens |

Then **Actions → the failed run → Re-run all jobs**.

Confirm the image exists before continuing:

```sh
curl -s https://hub.docker.com/v2/repositories/brittinho/brittinho-backend/tags | head -c 200
```

> **If you would rather not use Docker Hub for this**, build on the NAS instead:
> clone the repository there and
> `docker build --target runner -t brittinho/brittinho-backend:1.0.0 .`.
> The stack then finds the image locally. You lose the build-on-push.

> ⚠️ **The clock is running.** Publishing the bot moved the `:latest` tag, and
> your current production stack still uses `:latest` with
> `pull_policy: always`. Nothing changes until that stack restarts — but if it
> does restart before you finish this runbook, it will pull a bot with no
> analytics in it, and the `/britto/` panel will break until step 6. The bot
> itself keeps working.

---

## 2. Put the stacks on the NAS

Following ADR 002 — the repository is cloned outside the Dockge directory and
each migrated stack is symlinked in.

```sh
cd /mnt/StorageHD1/<wherever homelab is cloned>
git pull

ln -s "$PWD/stacks/britticobot"        /mnt/StorageHD1/stacks/britticobot
ln -s "$PWD/stacks/cloudflared"        /mnt/StorageHD1/stacks/cloudflared
ln -s "$PWD/stacks/brittinho-backend"  /mnt/StorageHD1/stacks/brittinho-backend
```

Copy the three filled-in `.env` files up from your machine, then lock them down —
they hold every credential the services use:

```sh
# from your machine, in the homelab clone
scp local/britticobot.env        NAS:/mnt/StorageHD1/<homelab>/stacks/britticobot/.env
scp local/cloudflared.env        NAS:/mnt/StorageHD1/<homelab>/stacks/cloudflared/.env
scp local/brittinho-backend.env  NAS:/mnt/StorageHD1/<homelab>/stacks/brittinho-backend/.env

# then, on the NAS
chmod 600 stacks/*/.env
```

No SSH? Dockge has a per-stack environment editor, and its built-in terminal
takes a paste. `local/SECRETS.md` lists every value.

Check that compose resolves with no blanks. An empty variable here becomes a
service that starts and misbehaves rather than one that fails loudly:

```sh
cd stacks/britticobot && docker compose config | grep -i "=$"    # expect nothing
```

---

## 3. Move the analytics data

**Stop the bot first.** Copying a live SQLite database gives you a torn file.

```sh
docker stop britticobot

mkdir -p /mnt/StorageHD1/configs/brittinho_backend/data

# .backup is safe even mid-write, and it collapses the -wal into the .db
sqlite3 /mnt/StorageHD1/configs/brittico_bot/db/analytics/analytics.db \
  ".backup '/mnt/StorageHD1/configs/brittinho_backend/data/analytics.db'"

cp -r /mnt/StorageHD1/configs/brittico_bot/db/analytics/gb_snaps \
      /mnt/StorageHD1/configs/brittinho_backend/data/
```

Confirm the rows came across before trusting it:

```sh
sqlite3 /mnt/StorageHD1/configs/brittinho_backend/data/analytics.db \
  "SELECT COUNT(*) FROM sessions;"
```

The original stays where it is. Leave it until you are satisfied, then delete.

---

## 4. Start the new stacks

```sh
docker compose -f stacks/cloudflared/compose.yaml up -d
docker compose -f stacks/brittinho-backend/compose.yaml up -d
docker compose -f stacks/britticobot/compose.yaml up -d
```

`docker ps` should show **healthy**, not just **up**. That distinction is the
whole point of the healthcheck: it queries the database before answering, so
`healthy` means the service can actually do its job.

If a container sits in `starting` for more than a minute, read its logs — the
new configuration fails at boot on purpose rather than running half-working.

---

## 5. Route the tunnel by path

Until this step the new service is running but nothing reaches it.

Cloudflare Zero Trust is where the tunnel's routing rules live. Your tunnel is
the token-based kind, so the rules are held in Cloudflare's dashboard rather
than in a config file on the NAS.

Go to **one.dash.cloudflare.com → Networks → Tunnels → your tunnel → Public
Hostname**.

There is one rule there today, sending everything on `api.brittinho.com` to the
bot. Add three more **above** it — first match wins, so order matters:

| Hostname | Path | Service |
| --- | --- | --- |
| `api.brittinho.com` | `api/track` | `http://brittinho-backend:3002` |
| `api.brittinho.com` | `api/gbtrack` | `http://brittinho-backend:3002` |
| `api.brittinho.com` | `api/analytics/*` | `http://brittinho-backend:3002` |
| `api.brittinho.com` | *(empty — leave last)* | `http://britticobot:3000` |

For the container names to resolve, the two stacks must share a Docker network.
If Dockge puts each stack on its own, use the NAS's own address
(`http://<nas-ip>:3002` and `http://<nas-ip>:3000`) instead.

---

## 6. Update the site

One file, uploaded by FTP like any other site change:

`api/analytics/_config.php` → set `ANALYTICS_API_KEY` to the new value.

**The dashboard breaks if this does not match the backend's `API_KEY`.** It is
the single most likely thing to go wrong in this whole migration.

While you are uploading, the Minecraft removal goes up too:

- `kennzy/assets/js/shell.js`
- `kennzy/assets/css/shell.css`
- delete the `kennzy/minecraft/` directory

---

## 7. Check it actually works

- [ ] `docker ps` — three containers, all **healthy**
- [ ] Open `brittinho.com`, then check the visit appears in the `/britto/` panel
- [ ] `docker restart britticobot` — **the visit counter must not stop.** This is
      the test that proves the split worked
- [ ] Send `!ping` in Twitch chat
- [ ] Open `/kennzy/` and confirm login still works
- [ ] `/kennzy/` has no Minecraft item in the sidebar

---

## If something goes wrong

The old `compose.txt` still exists and still works. Bringing it back:

```sh
docker compose -f stacks/britticobot/compose.yaml down
docker compose -f stacks/brittinho-backend/compose.yaml down
# then start the old stack from Dockge as before
```

The analytics data was copied, not moved, so the original is untouched.

Rolling back only the bot's version is a one-line edit of `BOT_VERSION` in
`stacks/britticobot/.env`, followed by `docker compose up -d`. That is what the
pinned tags bought.

---

## Afterwards

Two things are worth doing once this has settled:

- **Let WAL soak.** The database now runs in WAL mode, which is a prerequisite
  for splitting the bot into separate chat and web processes. Give it a few days
  of real use before taking that step.
- **Update the backup script.** WAL means `-wal` and `-shm` files sit beside the
  `.db`. Copying only the `.db` captures an incomplete snapshot — the backup has
  to use `sqlite3 .backup`, exactly as step 3 does.
