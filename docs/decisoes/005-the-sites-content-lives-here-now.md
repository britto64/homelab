# 005 — The site's content lives here now, and its files with it

**Status:** accepted · 2026-08-11

## Context

`brittinho.com` is static files and PHP on shared hosting, and every piece of
data it shows was a file in `public_html`: the gallery was a directory of images
whose *filenames* encoded their categories, comments were one JSON array
rewritten in full on every submission, posts were markdown with hand-parsed
frontmatter, and the guestbox moderation queue was three directories where
approving something meant renaming it into a different one.

That worked. What it could not do is change: renaming a gallery image broke its
URL *and* moved it to a different filter tab, because `p_IMG_0740.PNG` was
simultaneously the identity, the caption and the category. There was no admin
screen for any of it, and there could not usefully be one.

ADR 004 split `brittinho-backend` out of the bot and gave the site a server-side
of its own. Analytics was its first tenant. This is the rest of it.

The open question was not whether the *data* should move — a database is
obviously better than a JSON file rewritten under a lock — but whether the
**image files** should. 164 MB of gallery, 13 MB of guestbox drawings, all
currently served by a CDN-fronted shared host with no bandwidth worries.

## Decision

Both move. The data goes into `content.db` beside `analytics.db`, and the files
go into `media/` in the same volume, served by the same service through the
existing tunnel.

Four things fall out of that, and they are the actual content of this decision:

**An id owns the URL; the name is a column.** Files on disk are `<id>.<ext>` and
nothing else. This is what makes rename, recategorise and replace-the-file
possible at all, and it is why the admin gallery tab could be built in the first
place.

**Media URLs carry a version, so they can be immutable.** `?v=3` bumps when the
bytes are replaced. Responses are `max-age=31536000, immutable`, so Cloudflare's
edge absorbs the repeat traffic and the home upstream serves each file roughly
once per PoP. Without the version, replacing a file would appear to do nothing
for up to a year.

**Three fixed path prefixes: `/api/content`, `/api/admin`, `/media`.** The
tunnel's routing lives in the Cloudflare dashboard, not in this repository, so a
deploy cannot create a rule and a missing one fails as somebody else's 404.
Three prefixes means three rules, added once, and the dashboard is never touched
again as endpoints are added.

**One login, bridged by a proxy.** The admin panel keeps its existing PHP
session on the shared host; `api/admin/proxy.php` checks it and adds the bearer
token server-side. The browser never holds a token and there is no second
account to keep in sync — at the cost of uploads taking an extra hop through
PHP's `upload_max_filesize`.

## Consequences

The site now degrades when this box does. Not catastrophically — the pages, the
layout and the navigation are still static files on Hostinger — but the gallery
grid, the comments and the blog list come back empty. Each section ships an
explicit empty state rather than a spinner that never resolves.

`content.db` and `media/` are now the only genuinely irreplaceable state in the
homelab. Analytics is pruned at 180 days and losing it costs history; losing
`media/` costs the images themselves. This changed what a missed backup means
here, and the backup section of the operating runbook says so explicitly.

The shared host keeps the pages, the admin login, and the proxy. Retiring it
entirely is now a much smaller job than it was — but it is not this decision,
and nothing here assumes it will happen.

## Alternatives considered

**Metadata here, files left on Hostinger.** Zero bandwidth risk and the images
survive this box being down. Rejected because it leaves the admin panel unable
to write the one thing it most needs to write, and "upload a file" would have
gone back through PHP to the shared host anyway — two systems owning one
gallery, which is the arrangement being escaped.

**Cloudflare R2 for the bytes.** Genuinely better on availability and egress,
and 164 MB is far inside the free tier. Rejected for now as one more external
account and binding to operate, for a personal site whose images are already
behind a cache that absorbs most of the reads. The `MEDIA_BASE` variable exists
partly so this stays a change of address rather than a migration.

**One SQLite file for everything.** Rejected: analytics is pruned on a schedule
and is regenerable in spirit; content is not. Different lifecycles, different
backup value, different files — the same reasoning as ADR 003, one level down.
