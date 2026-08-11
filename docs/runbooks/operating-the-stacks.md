# Runbook — operating the stacks from a shell

Day-to-day operations for the stacks in this repository: checking, restarting,
updating, changing configuration, rolling back.

Dockge still manages these stacks through the symlinks in
`/mnt/StorageHD1/stacks/`, and its buttons do the same thing as the commands
here. This is the fallback, and the reference for anything the UI does not
expose.

---

## Getting a shell

Two ways in, and **the commands below are identical in both** — the only
difference is whether you are already root:

| | How | Root? |
| --- | --- | --- |
| TrueNAS web Shell | *System → Shell* in the UI | yes |
| SSH | `ssh truenas_admin@192.168.0.82` | no — run `sudo -i` first |

`sudo -i` is worth running either way: `/mnt/StorageHD1/stacks` cannot even be
entered without it, so half the commands here would fail with `sudo` prefixed
onto each one.

Everything below assumes you are root.

---

## Where things live

```
/mnt/StorageHD1/homelab/            the git clone — edit here, or rather, pull here
  stacks/<name>/compose.yaml        committed
  stacks/<name>/.env                NOT committed; only on this machine

/mnt/StorageHD1/stacks/<name>       symlink into the clone, for Dockge

/mnt/StorageHD1/configs/<name>/     the data each service writes
```

Two ways to address a stack. Both are equivalent — the second is what Dockge
does:

```sh
cd /mnt/StorageHD1/homelab && docker compose -f stacks/britticobot/compose.yaml <cmd>
cd /mnt/StorageHD1/stacks/britticobot && docker compose <cmd>
```

The rest of this file uses the second form. Compose reads the `.env` sitting
beside the compose file automatically.

---

## Checking

```sh
# everything at a glance
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

# just ours
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "britt|cloudflared"
```

**Read the status, not just the presence.** `Up` means the process started.
`(healthy)` means the healthcheck passed — for these services that means the
database answered. A container can be `Up` for hours and useless.

```sh
# why is it unhealthy?
docker inspect --format '{{json .State.Health}}' britticobot | head -c 800

# logs
docker logs britticobot --tail 100
docker logs britticobot -f              # follow, Ctrl-C to stop
docker logs britticobot --since 15m
```

---

## Start, stop, restart

```sh
cd /mnt/StorageHD1/stacks/britticobot

docker compose restart      # same image, same config — just bounce it
docker compose stop         # stop, keep the container
docker compose start        # start it again
docker compose down         # stop AND remove the container and its network
docker compose up -d        # create and start from the current compose + .env
```

`restart` does **not** re-read `compose.yaml` or `.env`. After changing either,
use `up -d` — Compose notices the difference and recreates the container.

To bounce one container without touching Compose:

```sh
docker restart britticobot
```

---

## Updating to a new version

The image tag is pinned in `.env`, never `latest`, so an update is deliberate.

**1. Build the new image.** Bump `version` in the application repo's
`package.json`, commit, push to `main`. GitHub Actions publishes
`<version>`, `sha-<commit>` and `latest`. Wait for it to go green.

**2. Point the stack at it.** From your machine, no shell on the NAS needed:

```sh
scripts/deploy britticobot 1.4.0
```

It checks the tag is actually on the registry before editing anything, backs up
the `.env`, pulls, brings the stack up, and waits for the healthcheck instead of
reporting success the moment the container starts. `scripts/deploy` with no
arguments lists every stack and the version it is on.

If it comes up unhealthy it prints the last 30 log lines and the command to go
back — the previous `.env` is at `.env.bak`.

### The same thing by hand

Worth knowing, for when the script is the thing that is broken:

```sh
cd /mnt/StorageHD1/stacks/britticobot
nano .env                     # BOT_VERSION=1.4.0
docker compose pull
docker compose up -d
docker ps --format "{{.Names}}\t{{.Status}}" | grep britt
docker logs britticobot --tail 50
```

Variable names by stack: `BOT_VERSION`, `BACKEND_VERSION`, `SITE_VERSION`,
`CLOUDFLARED_VERSION`. The script finds them by pattern rather than by a list,
so a new stack needs no change there.

### Rolling back

Set the old version back and `up -d`. That is the entire procedure, and it is
the reason tags are pinned:

```sh
nano .env                     # BOT_VERSION=1.2.0
docker compose up -d
```

The old image is still on disk, so this takes seconds and needs no network.

---

## Changing configuration

### A secret or a setting — `.env`

`.env` is not in git and lives only on the NAS, so it is edited in place:

```sh
cd /mnt/StorageHD1/stacks/britticobot
nano .env
docker compose up -d          # NOT restart — that would not re-read the file
```

Keep `local/SECRETS.md` on your own machine in step with what you change here,
or the next migration starts from stale values.

### A compose file — through git

`compose.yaml` is committed, so editing it directly on the NAS puts the clone
out of step with the repository. The discipline is edit-commit-pull:

```sh
# on your machine
cd /mnt/movespeed/claude/homelab
nano stacks/britticobot/compose.yaml
git commit -am "britticobot: <what and why>"
git push

# on the NAS
cd /mnt/StorageHD1/homelab && git pull
cd stacks/britticobot && docker compose up -d
```

Editing on the NAS in a hurry is not fatal — `git status` will show it and
`git stash` or a commit sorts it out — but it is how a change nobody can explain
ends up in production.

### Adding a new environment variable

Three places, and missing one is the usual mistake:

1. `stacks/<name>/.env.example` — committed, documents that it exists
2. `stacks/<name>/.env` on the NAS — the real value
3. `local/<name>.env` on your machine — so it survives the next rebuild

The compose file itself does **not** need a line: `env_file: .env` passes
everything through. Only variables used by compose *itself* — like
`${BOT_VERSION}` in the image tag — get referenced there.

```sh
cd /mnt/StorageHD1/stacks/britticobot
nano .env
docker compose config | grep -i "=$"     # catch empties before restarting
docker compose up -d
```

---

## Things specific to this setup

### The `edge` network

All three stacks join an external network so the tunnel can resolve them by
container name. It is created once and outlives every stack:

```sh
docker network create edge          # only if it is missing
docker network inspect edge --format '{{range .Containers}}{{.Name}} {{end}}'
```

A stack that fails with `network edge declared as external, but could not be
found` means it was removed. Recreate it and `up -d` each stack.

### No published ports

Neither the bot nor the backend publishes a host port — the tunnel is the only
way in, and host port 3000 belongs to `firefly_iii` anyway. So `curl localhost:3000`
on the NAS proves nothing. Test from inside instead:

```sh
docker exec britticobot wget -qO- http://localhost:3000/healthz
docker exec brittinho-backend wget -qO- http://localhost:3002/healthz
```

Or from outside through the tunnel:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://api.brittinho.com/healthz
```

### Routing lives in Cloudflare, not here

Which path reaches which container is configured at
*one.dash.cloudflare.com → Networks → Tunnels → brittico-tunel → Routes*, not in
any file on the NAS. The tunnel is token-based, so its rules are held by
Cloudflare. Rules match in list order and the catch-all must stay last.

### Feed images are recompressed overnight

Anything the bot saves from chat is resized to 1200px on its longest edge and
re-encoded before it is written, so the heavy original never reaches the disk.
Everything that arrived *before* that existed is handled by a job that runs
**between 00:00 and 05:00**, container local time.

It is deliberately bounded. Re-encoding occupies a core per image, and the same
container serves the chat, the site's API and the OBS overlay — so it takes the
hours when nobody is watching and stops when the window closes, continuing the
next night. Progress is per file, so stopping halfway wastes nothing.

```sh
# what it did last night
docker logs britticobot 2>&1 | grep ImageOptim | tail -20

# how much is still queued, and how much has been saved
docker exec britticobot node -e "
const {openDatabase,resolveDbPath}=require('/app/dist/db/connection.js');
openDatabase(resolveDbPath()).then(async db=>{
  console.table(await db.all(\"SELECT status, COUNT(*) files, \
    SUM(bytes_before)/1048576 AS mb_before, SUM(bytes_after)/1048576 AS mb_after \
    FROM feed_image_optim GROUP BY status\"));
  await db.close();
});"
```

`status` values: `done` rewritten, `kept` already optimal, `ingest` arrived
compressed, `missing` file already pruned, `failed` undecodable and left alone.

Nothing is ever replaced by something larger. Animated images stay animated, and
an animated GIF whose re-encode cannot beat the original is left as it is —
above the size cap on purpose, because degrading the animation to hit a number is
the wrong trade. The first night after deploying has the whole backlog to get
through and will almost certainly use the full five hours.

### Backups and WAL

The databases run in WAL mode, so `-wal` and `-shm` files sit beside each `.db`.
**Copying only the `.db` captures an incomplete snapshot.**

```sh
sqlite3 /mnt/StorageHD1/configs/brittico_bot/db/britticobot.db \
  ".backup '/some/where/britticobot-$(date +%F).db'"
```

`.backup` is safe while the service is running. `cp` is not.

#### What actually has to survive

Not all of it matters equally, and it is worth knowing which is which before a
disk does.

| Path | If it is lost |
| --- | --- |
| `brittinho-backend/data/content.db` | The gallery, the posts, the comments. **Not recoverable from anywhere.** |
| `brittinho-backend/data/media/` | The image and drawing files themselves. **Not recoverable from anywhere.** |
| `brittinho-backend/data/analytics.db` | Visit history. Painful, not fatal — it is pruned at 180 days anyway |
| `brittinho-backend/data/gb_snaps/` | Guestbox tracking thumbnails, pruned on the same schedule |
| `britticobot/db/britticobot.db` | The bot's state: shop, game, moderation |

The top two rows arrived with the site's data migration and changed what a
missed backup costs here. `media/` is ordinary files, so it wants a file-level
copy or a snapshot rather than `.backup`; the databases want `.backup`.

Both are still manual. If the NAS is not already snapshotting
`${BACKEND_DATA_HOST_PATH}`, that is the gap worth closing first.

---

## When something is wrong

```sh
# 1. is it running, and is it healthy?
docker ps -a --format "{{.Names}}\t{{.Status}}" | grep -E "britt|cloudflared"

# 2. what did it say?
docker logs <name> --tail 100

# 3. does compose still resolve? empty values are a common cause
cd /mnt/StorageHD1/stacks/<name> && docker compose config | grep -i "=$"

# 4. is the network still there?
docker network inspect edge >/dev/null && echo ok || echo "edge is missing"

# 5. out of disk? SQLite fails in confusing ways when the pool is full
df -h /mnt/StorageHD1
```

A container restarting in a loop is usually configuration: these services fail
at boot on purpose rather than running half-configured, so the reason is in the
first twenty lines of the log.

### Reclaiming space

```sh
docker image prune -a        # images no untagged container uses
docker system df             # what is actually taking room
```

Be careful with `docker system prune -a` — it removes unused images, and the
previous version you might want to roll back to is exactly that.
