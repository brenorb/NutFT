# NutFT

NutFT is an application-level extension for Cashu proofs representing
individually identifiable bearer assets.

This repository currently contains two drafts:

- [NUT-31](31.md): the general Nut Fungible Token proposal;
- [demo specification](docs/demo-spec.md): the trading-card demo built on top
  of it.

Both documents are exploratory drafts. NUT-31 is not an official Cashu NUT
assignment. Generic Cashu operations that issue a new proof without preserving
NutFT metadata are incompatible.

The private repository also contains the migrated Pokemon proof of concept in
[`pokemon/`](pokemon/). It is an application of NutFT and is kept separate from
the protocol specifications above.
