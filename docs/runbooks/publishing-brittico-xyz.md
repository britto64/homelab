# Runbook — publishing brittico.xyz

One-time. Takes the `/kennzy/` pages off brittinho.com's shared host and serves
them from this box, on their own domain, behind the tunnel that is already here.

Nothing is deleted from the shared host by this runbook. `brittinho.com/kennzy/`
keeps working throughout, and stays as the fallback until the migration retires
it.

---

## 0. Before touching the NAS: the image has to exist

The stack pins `brittinho/brittico-site:1.0.0`, and that tag is not on Docker
Hub yet. The repository's Action has been failing since the first push because
it has no credentials.

In *github.com/britto64/brittico-site → Settings → Secrets and variables →
Actions*, add:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | `brittinho` |
| `DOCKERHUB_TOKEN` | the same access token `britticobot` uses |

Then re-run the failed workflow (*Actions → the red run → Re-run all jobs*).
There is no need to push a commit to trigger it.

Confirm the tag landed before going further — every step below assumes a pull
will succeed:

```sh
docker manifest inspect brittinho/brittico-site:1.0.0 >/dev/null && echo ok
```

> **Why this comes first.** `docker compose up` with a missing tag fails at the
> pull with a message about the manifest, which reads like a typo in the image
> name rather than a build that never ran. Confirming the tag first turns a
> confusing failure into one you already know the cause of.

---

## 1. Put the stack on the NAS

All of this is in the NAS shell. ADR 002: the repository is cloned outside the
Dockge directory and each stack is symlinked in.

```sh
cd /mnt/StorageHD1/homelab
git pull

ln -s "$PWD/stacks/brittico-site" /mnt/StorageHD1/stacks/brittico-site
```

Confirm the pull brought the new stack and the symlink points somewhere real:

```sh
ls stacks/                              # brittico-site is now in the list
ls -l /mnt/StorageHD1/stacks/brittico-site/   # compose.yaml  .env.example
```

> **`fatal: detected dubious ownership`** — same as every other time:
> `git config --global --add safe.directory /mnt/StorageHD1/homelab`. It
> silences the warning without granting anything; if writes still fail, compare
> `ls -ld /mnt/StorageHD1/homelab` against `id`.

---

## 2. The `.env`

From your machine, in the homelab clone:

```sh
scp local/brittico-site.env NAS:/mnt/StorageHD1/homelab/stacks/brittico-site/.env
```

```sh
# on the NAS
chmod 600 /mnt/StorageHD1/homelab/stacks/brittico-site/.env
```

> **This is the one stack where the transfer is optional.** The file holds a
> single line, `SITE_VERSION=1.0.0`, and no secret — the site is static files
> and everything it calls is a public endpoint reached from the visitor's
> browser. If you would rather not leave the NAS shell:
>
> ```sh
> echo 'SITE_VERSION=1.0.0' > /mnt/StorageHD1/homelab/stacks/brittico-site/.env
> ```
>
> Keep using `scp` for `britticobot` and `cloudflared`, where the contents
> genuinely are credentials and retyping them invites a typo you will debug for
> an hour.

Check that compose resolves with nothing blank. An empty variable here becomes a
container that starts and misbehaves rather than one that fails loudly:

```sh
cd /mnt/StorageHD1/stacks/brittico-site
docker compose config | grep -i "=$"     # expect nothing
```

---

## 3. Bring it up

```sh
cd /mnt/StorageHD1/stacks/brittico-site
docker compose up -d
```

Give it ten seconds for `start_period` to pass, then:

```sh
docker ps --format "{{.Names}}\t{{.Status}}" | grep brittico-site
# expect: brittico-site   Up 30 seconds (healthy)
```

`healthy` here means nginx answered `/healthz`. It does not mean the site is
right, so also ask for a real page — the container publishes no port, so this
has to come from inside:

```sh
docker exec brittico-site wget -qO- http://localhost/ | head -5
```

You should see the opening of the media kit's HTML. A 404 instead means the
files did not land where nginx expects them.

> **`network edge not found`** — the shared network is external and created by
> hand: `docker network create edge`. It should already exist from the other
> stacks; if it does not, nothing else is reachable either.

---

## 4. Cloudflare: the zone

`brittico.xyz` has to be a zone on the same Cloudflare account as
`brittinho.com` before the tunnel can route to it.

1. *dash.cloudflare.com → Add a domain → `brittico.xyz`*, Free plan.
2. Cloudflare gives you two nameservers. Set them at the registrar where you
   bought the domain, replacing what is there.
3. Wait for the zone to read **Active**. Usually minutes, occasionally hours.

Nothing below works until it is Active — the tunnel cannot create a DNS record
in a zone Cloudflare does not yet control.

There is no certificate to buy or configure. Universal SSL covers `brittico.xyz`
and one level of subdomain, which is enough for the `api.brittico.xyz` that
phase 2 will need.

---

## 5. Cloudflare: the tunnel route

The tunnel is token-based, so its rules live in the dashboard rather than in any
file on the NAS.

*one.dash.cloudflare.com → Networks → Tunnels → **brittico-tunel** → Public
Hostname → Add a public hostname*

| Field | Value |
| --- | --- |
| Subdomain | *(empty)* |
| Domain | `brittico.xyz` |
| Path | *(empty)* |
| Type | HTTP |
| URL | `brittico-site:80` |

The URL is the container name, not an IP: cloudflared resolves it over the
`edge` network. HTTP and not HTTPS — TLS terminates at Cloudflare's edge, and
the hop from the tunnel to this container is inside Docker.

Saving it creates the proxied DNS record for you. Do not add one by hand as
well.

> **Rule order.** Rules match top to bottom and the catch-all must stay last.
> This is a new hostname rather than a new path on an existing one, so it does
> not compete with the `api.brittinho.com` rules — but if you later add
> `api.brittico.xyz` with paths, the specific paths go above the catch-all or
> they are never reached.

Optionally repeat for `www` → same URL, so `www.brittico.xyz` does not dead-end.

---

## 6. Verify

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://brittico.xyz/healthz   # 200
curl -sI https://brittico.xyz/ | head -1                               # 200
```

Then open it in a browser and check the shop, the feed and the stats pages load
and the rail navigates between them.

---

## What will still be broken, and should be

The pages will render. **The data will not arrive.** Every panel that fetches
comes up empty, and the login button does nothing useful.

That is not this runbook failing. The bot's `SITE_ORIGIN` is a single origin,
`https://brittinho.com`, passed straight to `cors({ origin })` — so a browser on
`brittico.xyz` is refused every call, including the public ones. And `kz_sess`
is `SameSite=Lax`, which stops being sent the moment the site and the API are no
longer the same site.

Both live in the bot, and both are phase 2. Until then `brittico.xyz` is a
correct deployment of a site whose API does not know about it yet, and
`brittinho.com/kennzy/` remains the working copy.

---

## Rolling back

The site goes back to being served only from the shared host:

```sh
cd /mnt/StorageHD1/stacks/brittico-site && docker compose down
rm /mnt/StorageHD1/stacks/brittico-site
```

Then delete the public hostname in the tunnel. The zone can stay — an Active
zone with no records costs nothing and saves redoing the nameserver wait.

To go back a version rather than remove it, edit `SITE_VERSION` in the `.env`
and `docker compose up -d`. That is the whole point of the pinned tag.
