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

From your machine, in the homelab clone. Note the two hops: `/mnt/StorageHD1`
cannot be written — or even entered — as `truenas_admin`, so the file lands in
the home directory first and root moves it into place.

```sh
scp local/brittico-site.env truenas_admin@192.168.0.82:~/
```

```sh
# on the NAS, as root
mv ~truenas_admin/brittico-site.env /mnt/StorageHD1/homelab/stacks/brittico-site/.env
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

The domain is registered and nothing else. This section takes it from there to a
zone the tunnel can route to.

Dashboard labels move around between redesigns. What each step is *for* does
not, so go by that when a button has been renamed.

### 4.1 Sign in to the right account

**The same Cloudflare account that holds `brittinho.com`.** Not a new one.

A tunnel can only publish hostnames from zones in its own account, and
`brittico-tunel` lives in that one. Adding `brittico.xyz` to a second account
gives you a perfectly working zone that the tunnel cannot see, and the failure
arrives later as a hostname that refuses to save — at which point the fix is to
delete the zone and start over.

If `brittinho.com` is listed on the account overview after signing in, you are
in the right place.

### 4.2 Add the domain

*Account Home → **Add a domain*** (older wording: "Add site").

Enter `brittico.xyz` — the bare domain, no `www`, no `https://`.

Cloudflare may offer to scan for existing DNS records or to start empty. Either
is fine here: the domain is new, so there is nothing worth importing.

### 4.3 Choose the Free plan

The plan list leads with the paid tiers. Scroll — **Free** is at the bottom.

Everything this site needs is on it: unmetered proxied bandwidth, Universal SSL,
and unlimited tunnel hostnames. Nothing in this runbook asks for a paid feature.

### 4.4 Clean out the registrar's records

Cloudflare shows the records it found. Registrars usually park a new domain on
their own "this domain is registered" page, which leaves behind:

- an `A` record for `@` pointing at the registrar's parking IP
- sometimes a `CNAME` for `www` pointing at the same place
- sometimes `MX` records for a mail service you did not order

**Delete all of them.** The tunnel creates the record it needs in step 5, and a
leftover `A` record on `@` competes with it — the symptom is the parking page
still loading hours after everything else is correct.

Keep `MX` records only if you actually receive mail at `@brittico.xyz`. You do
not.

Ending with an empty record list is the correct outcome, not a mistake.

### 4.5 Point the nameservers at Cloudflare

Cloudflare gives you two, in the shape `<word>.ns.cloudflare.com`. They are
specific to your account — do not copy them from another guide.

Now go to **the registrar where you bought `brittico.xyz`**, find the
nameserver setting, and replace what is there with those two.

| Registrar | Where it lives |
| --- | --- |
| Hostinger | *Domains → brittico.xyz → DNS / Nameservers → Change nameservers → Use custom* |
| Namecheap | *Domain List → Manage → Nameservers → Custom DNS* |
| GoDaddy | *My Products → DNS → Nameservers → Change → I'll use my own* |
| Registro.br | *Painel → o domínio → Alterar servidores DNS* |

Two rules, whichever it is: **replace, do not append** — the registrar's own
nameservers must go — and pick the "custom" option rather than editing
individual DNS records, which is a different screen that does nothing here.

> Changing nameservers moves *all* DNS for the domain to Cloudflare. For a
> domain that serves nothing yet, that costs nothing. It is why this is done
> before there is anything to break.

### 4.6 Wait for Active

Back on Cloudflare, **Check nameservers now**. The zone reads *Pending* until
the change propagates — usually minutes, occasionally up to 24 hours, and
entirely out of your hands either way. Cloudflare emails you when it flips to
**Active**.

Check from a shell rather than reloading the dashboard:

```sh
dig +short NS brittico.xyz
# expect the two *.ns.cloudflare.com names, not the registrar's
```

**Nothing after this works until the zone is Active.** The tunnel creates a DNS
record when you add the hostname, and it cannot write into a zone Cloudflare
does not yet control — it fails with a permissions error that reads like your
account is at fault.

### 4.7 Settings worth setting once

With the zone Active, in *SSL/TLS*:

- **Encryption mode: Full (strict).** This is the one that matters. The default
  on a new zone is often *Flexible*, which makes Cloudflare talk to the origin
  over plain HTTP — with a tunnel that is both unnecessary and a downgrade. The
  tunnel is an authenticated outbound connection, so strict costs nothing.
- **Always Use HTTPS: on.** Sends anyone typing `brittico.xyz` to the `https://`
  version instead of serving them a redirect chain.

There is no certificate to buy, request or install. Universal SSL is issued
automatically and covers `brittico.xyz` plus one level of subdomain — which is
exactly what the `api.brittico.xyz` in phase 2 will need.

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

Saving it creates the proxied DNS record for you — a `CNAME` on `@` pointing at
`<tunnel-id>.cfargotunnel.com`, orange-clouded. **Do not add one by hand as
well**, and if step 4.4 left a parking `A` record behind, this is where it
starts fighting you.

An apex on a CNAME is normally illegal in DNS; Cloudflare flattens it at the
edge, which is why this works on the bare domain without a paid plan.

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
