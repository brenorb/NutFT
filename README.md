# NutFC

NutFC is the first small prototype for NutsFT: a collectible credential flow
built on top of Cashu/Nutshell primitives.

This repository is experimental. The first cut is intentionally local and
does not claim production privacy, ZK security, marketplace support, or
solvency. It demonstrates the core state transition before those layers are
added:

```text
issue → verify → consume old credential + issue new credential → reject reuse
```

## Development

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```sh
uv sync --dev
uv run pytest
uv run nutfc-demo
```

The implementation reuses `cashu==0.20.2` (Nutshell) for Cashu's blind
Diffie–Hellman signature primitives. It does not start a network mint or move
real ecash.

## Scope and limits

- The catalog is local and static.
- The mint is an in-memory authority with an in-memory spent set.
- The credential's local opening contains the asset identity; this prototype
  does not yet implement the zero-knowledge relation needed to hide that
  identity during every transfer check.
- Nostr, boosters, persistence, recovery, and production threat-model work are
  deliberately out of scope for this first implementation.
