---
name: verify-nutft-booster-sale
description: Check that a buyer who paid a NutFT booster invoice can always collect a pack, and that one payment buys one pack. Use when changing payableQuoteOnce, requireSettled, revealFor, signBoosterOnce, packAlreadySold, claimGraceSeconds, invoiceTtlSeconds, or the nutft_invoices table in pokemon/server/nutft-mint.js.
---

# Verify NutFT booster sales

**Property.** `PaidBuyerCanClaim`: every settled, unclaimed invoice can be claimed for a pack. `OnePackPerPayment`: packs issued equal invoices claimed.

**Harm if broken.** A buyer's sats are taken and the mint refuses their cards forever, or one payment collects two packs.

## Run

```sh
export TLA2TOOLS=/absolute/path/to/tla2tools.jar   # TLC 1.7.4 release
export JAVA=/path/to/java                          # Java 11 or later
bash scripts/verification/check-model.sh .claude/skills/verify-nutft-booster-sale/model/BoosterSale.tla
bash scripts/verification/check-model.sh .claude/skills/verify-nutft-booster-sale/model/BoosterSale.tla --mutant
cd pokemon && node --test tests/js/pokemon-paid-claim.test.mjs
```

The model must pass (64 distinct states). The `--mutant` run replays the code before commit 2381605 and must report `PaidBuyerCanClaim` violated on this path: Alice pays, her grace lapses, Bob is quoted the same pack, Alice claims it, Bob pays, and Bob's invoice is bound to a sold pack. The test replays that path on the real mint, with two wallets from `site/nutft-wallet.js`. Read every TLC result with the pstack `/statechart` skill.

## Coverage

Synced with the code at commit `2381605`. Move this forward only after you confirm that the model still describes the code at the new commit.

| Model step | Code (`pokemon/server/nutft-mint.js`) |
| --- | --- |
| `Quote`, `Holds` | `payableQuoteOnce` and its `activeInvoices` loop |
| `Pay`, `Expire` | the funding source; the invoice expires after `invoiceTtlSeconds` |
| `Lapse` | `claimGraceSeconds` in the `paidHeld` check |
| `Claimable` | `requireSettled`, `packAlreadySold`, the `rebound` check in `revealFor` |
| `Claim` | `signBoosterOnce` → `claimInvoice` inside `atomic` |

## When the check fails

A failing model after a change is a real bug until you show the model is wrong. Replay the path in `pokemon-paid-claim.test.mjs`, moving time with `Date.now` and settling invoices through the fake funding source.

## Not covered

Deck sales, unlimited (free) purchases, the one-per-key allowlist, sealed packs against a block beyond reusing `row.target_height`, price tiers, and the server restarting between steps. With the beacon off, a rebound buyer receives the next pack rather than the cards shown at their quote.
