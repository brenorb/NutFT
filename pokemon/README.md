# NutFT Pokemon PoC

This is the Pokemon Base Set proof of concept migrated from
`600BillionTimelockTCG`. It belongs to the private NutFT repository because it
is an application built on the NutFT asset protocol, not part of the 600B
timelock TCG.

The subproject contains the catalog, Cashu/NutFT mint, signed battle napplet,
replay verifier, web shell, artwork and tests. Runtime state is deliberately
not tracked: `.pokemon-state/`, generated `site/pokemon/*` build outputs,
`node_modules/`, and `pokemon-napplet/node_modules/` are recreated locally.

## Run

```bash
npm ci
npm test
npm run pokemon
```

Open `http://localhost:8778/pokemon/`. The napplet build is produced by
`npm run build:pokemon`; its dependencies are pinned by the nested pnpm lockfile.

This remains an unofficial test-only Pokemon implementation with no monetary
value and no affiliation with Pokemon, Nintendo, Creatures or GAME FREAK.
