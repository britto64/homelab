# 002 — Symlinks into the Dockge stacks directory

**Status:** accepted · 2026-07-27

## Context

Dockge reads stacks from `/mnt/StorageHD1/stacks`, treating every
subdirectory as one stack. This repo cannot simply be cloned there:
`docs/`, `scripts/` and `.github/` would show up as broken stacks.

Eight stacks already run from that directory. Only one is migrated so far.

## Decision

Clone the repo elsewhere on the NAS and symlink each migrated stack into
the Dockge directory, one at a time.

## Consequences

- Migration is incremental: the seven unmigrated stacks are untouched, and
  a failed migration is reverted by restoring one directory.
- Editing a stack through the Dockge UI now writes into the git working
  tree. That is visible in `git status`, but the discipline is to edit in
  the repo and pull on the NAS.
- Two locations to understand instead of one — the cost of doing this
  incrementally.
- Once every stack is migrated, pointing `DOCKGE_STACKS_DIR` straight at
  `homelab/stacks` removes the symlinks and this decision with them.
