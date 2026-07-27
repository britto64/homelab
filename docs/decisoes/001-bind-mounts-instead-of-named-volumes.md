# 001 — Bind mounts instead of named volumes

**Status:** accepted · 2026-07-27

## Context

The guideline I started from said every absolute host path in a compose
file should become a named volume. Named volumes are portable and Docker
manages their lifecycle.

This server is TrueNAS. Docker's default volume location lives on the
system dataset, not on `StorageHD1` — the pool where storage is supposed
to go. Two of the paths are also not app data at all: the course library
already exists on the NAS and is shared with other services.

## Decision

Bind mounts, with the host path externalized to `.env`.

## Consequences

- Data stays on the intended pool instead of silently migrating to the
  system dataset, where it would compete for space and fall outside the
  snapshot policy.
- Backup scripts can read the files directly, without `docker run` tricks
  to reach inside a managed volume.
- The compose file is no longer portable on its own: a new machine needs
  its `.env` filled in first. `.env.example` documents what is required.
- Revisit if a service ever needs data that is genuinely private to it and
  has no reason to be browsable from the host.
