# Pokémon Base Set NutFT PoC

NutFT means **Nut Fungible Token**. The store and wallet identify the project explicitly as a Nut Fungible Token PoC. Store copy uses “Gotta cashu ’em all.” as the headline and “Crack a pack. Go nuts.” beside the booster action.

Unofficial test only. Pokémon belongs to its respective owners. No real-money sales.

## Build brief

- Deployment / d-tag: pokemon-poc. New single-purpose automatic Base Set game.
- Substrate: canonical napplet/boilerplate; installed `napplet create` returned zero without creating files three times, including with a local template. Copied the exact template after those failures; CLI init owns metadata.
- Flows: random booster issuance, verified collection, 60-card deck selection, explicit mint-signed ownership reveal, two-person automatic game.
- Store and PWA wallet are ordinary websites. Only the game is a napplet.
- Game NAPs: identity, outbox (required); theme and storage (optional). SDK-first calls. No relay escape hatch. No wallet keys or spendable proofs enter the napplet.
- Layout: responsive stacked board on narrow screens; two play areas at larger widths. Theme maps background, text, primary, surface, border and muted across the whole document.
- Engine: MIT ryuu-play, pinned 9cd20b6a3232b77ac114fb45a3979d51a4332850; common rules and all 102 Base Set definitions only. Original license in vendor/ryuu/LICENSE. Vintage-rule differences are tested locally.
- Rules ship as program code; catalog metadata is never executed.

## Run and verify

Node 22+ with `node:sqlite`, npm and pnpm are required. Run `npm ci`, `npm run build:pokemon`, then `npm run pokemon`. Open `http://localhost:8778/pokemon/`. `npm run test:js` builds the integration and runs the existing suite plus mint, engine and signed replay tests. The napplet also has `pnpm verify` and `pnpm test:conformance`.

`node tests/pokemon-browser.mjs` uses installed Google Chrome in disposable profiles to verify NIP-07 and test sign-in, theme deck purchases and automatic 60-card selection, two-player certificate imports, setup, signed moves, resume, replay and offline PWA. For conformance with an installed browser, run `PLAYWRIGHT_CHANNEL=chrome pnpm test:conformance` inside `pokemon-napplet`. Conformance 0.2.19 passes all five measured runtime/degradation checks; unsigned local artifacts do not exercise manifest-event, wire or lifecycle checks. The browser integration separately exercises real SDK envelopes against the local shell.

The installed `napplet paja` wrapper loses its arguments. Use the built single-file artifact (the installed Paja does not load Vite’s external development modules): `kehto paja --target-url http://127.0.0.1:4173 --relay-mode memory --storage-mode memory -- pnpm vite preview --host 127.0.0.1`. Open its **runtime** URL, `http://127.0.0.1:5197/`, for the developer preview. The fully integrated store's game shell is `/pokemon/game.html`.

Vintage adjustments include optional 0–2 mulligan bonus cards, 20-point confusion self-damage with weakness/resistance, and repeated retreats with confusion cost paid before the flip. The Wizards-era mulligan rule is documented in the [Wizards Judge Handbook, Pokémon floor rules](https://hudecekpetr.cz/other/rulebooks/judgehandbook-2001-12.pdf), pages 267–268. Regression tests cover these differences; this is not an exhaustive independent certification of every possible card interaction.

The server uses `.pokemon-state/mint.db` for issuer keys, committed purchases, card issuance and signed match events. Back up that directory. Set `POKEMON_ORIGIN` to a stable shared HTTPS origin and bind the server through an HTTPS reverse proxy for two devices. Changing the origin changes the catalog URI. The default listens only on loopback.

The store issues random 11-card boosters: five common, three uncommon, one rare and two Basic Energy. These are synthetic PoC quantities and odds, not an authentic first-edition print run or collation. There is no Lightning/payment connection. Basic Energy has no four-copy deck limit. The catalog contains the 102 English Base Set cards; illustrations are Base Set reference art, not a guarantee of first-edition print artwork.

The Pokémon PoC has unlimited supply. Each booster slot uses fresh Node `crypto.randomInt` randomness with replacement and fixed weights; the existing census copy numbers are weights, not issuance limits. `/nutft/state` publishes those weights and slot counts and reports `supply: unlimited`, with no remaining-stock or pack limit. Past purchases do not reduce future odds. This is mint-generated randomness: signatures prove card authenticity, not an independently verifiable fair draw.

Quotes reveal neither booster contents nor a random seed. After an explicit purchase click, the wallet first persists a random 256-bit purchase capability. `POST /nutft/purchase` commits the free purchase and its contents atomically before replying. Reusing that capability returns the same purchase across retries and restarts. The wallet then prepares the card-bound blind outputs and claims them through `/nutft/booster`; the claim must use the same purchase ID, so alternate idempotency keys cannot issue it again. Protocol clients receive the card IDs after the purchase commits because Cashu output construction needs them; the UI reveals cards only in the wallet after proof verification. Interrupted purchases remain recoverable. This opt-in mode requires a persistent free mint; other mints retain their existing issuance modes.

The store also issues the four original 60-card theme decks: Blackout, Brushfire, Overgrowth and Zap!. Their fixed lists are in `cards/pokemon-decks.json`, transcribed from [the Base Set theme deck lists](https://www.pokebeach.com/tcg/base-set/theme-decks). Complete decks also have unlimited supply; individual cards cannot be purchased. The wallet shows only theme decks whose complete lists are currently owned, and selects all 60 cards after purchase. Any owned card in the deck builder opens its verified image and properties. Custom 60-card lists can be named and saved in local wallet storage for later selection. Fixed decks reuse the test mint’s atomic issuance, pending-purchase recovery and proof verification. They are unavailable on paid mints. The shared wallet uses binary serialization with one Base64 pass in browsers, avoiding the installed cashu-ts encoder’s invalid padding on tokens larger than 32 KiB. The original signed 102-card catalog remains unchanged, preserving existing proofs. Historical finite stock counters are retained in the database but are not used as limits by this mode.

## Signed play and replay

The ordinary shell signs in using a NIP-07 extension and a one-time Nostr authentication challenge. An explicit local test identity is available for development. The napplet only receives the public identity through NAP-IDENTITY. The wallet exports a mint-signed 60-card certificate scoped to that player and room; spending secrets and wallet keys never enter the game. Certificates expire after 24 hours and attest ownership at reveal time; they do not lock cards against subsequent transfer.

Offers, joins and chained moves are signed kind-1031 events. Each move names its predecessor. Replay verifies signatures, mint certificates at their event time, both decks and every move through the same deterministic engine. The table presents pending choices in a shared order, advances its local history after a signed acknowledgement, and discards stale synchronization responses. Conflicting branches stop the match. A finished game produces a signed kind-30078 note with `d=pokemon:<offer-id>`, both players, final event, and the winner (null for a draw). The server replays the game before accepting that note. Events and notes persist in SQLite; the archive exports an independently verifiable JSON transcript and offers a move-by-move viewer.

This is casual, fully disclosed play: both decks and deterministic randomness are public. Hidden-hand fairness and adversarial matchmaking are outside this PoC. It is not a production mint or tournament service. Clearing browser data destroys an unbacked-up local test signing identity; wallet mnemonic backup and server backup are separate.

## Sources

- MIT engine: https://github.com/keeshii/ryuu-play at `9cd20b6a3232b77ac114fb45a3979d51a4332850`; license is preserved in `pokemon-napplet/vendor/ryuu/LICENSE`.
- Base Set catalog: https://github.com/PokemonTCG/pokemon-tcg-data/blob/master/cards/en/base1.json.
- Card image source URLs and SHA-256 digests are recorded per card. Content-addressed PNG files are served through the local Blossom-compatible read endpoint.
- No Pokémon affiliation or authenticity is implied. Every surface and card presentation carries a visible PoC mark.
