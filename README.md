# NutFT

NutFT is the first small prototype for private collectible digital cards:
built on top of Cashu/Nutshell primitives.

This repository is experimental. It does not claim production privacy, ZK
security, marketplace support, persistent recovery, fair booster draws, or
solvency. The current local cut demonstrates:

```text
catalog → booster policy → card credentials → possession proof → atomic transfer
```

## Development

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```sh
uv sync --dev
uv run pytest
uv run nutft-demo
```

The implementation reuses `cashu==0.20.2` (Nutshell) for Cashu's blind
Diffie–Hellman signature primitives. It does not start a network mint or move
real ecash.

The current extended-token shape is documented in [NUT-FT-01](docs/nuts/NUT-FT-01-card-credentials.md).
It is a local experimental proposal, not an official Cashu NUT.

## Scope and limits

- The catalog and booster policy are local and signed by the in-memory mint.
- The mint is an in-memory authority with in-memory spent sets.
- Card tokens use a Cashu `Proof`-shaped section plus NutFT metadata; the
  public envelope excludes the card opening, owner secret, and salt.
- Possession uses a fresh owner-key challenge-response and a mint state check.
- Booster draws follow the configured policy, but fairness proofs are optional
  future work; this cut trusts the mint to draw honestly.
- The local transfer path still validates the full credential inside the mint;
  hiding the card identity during transfer requires the future ZK relation.
- Nostr, persistence, crash recovery, and production threat-model work remain
  future work.
