---
name: verify-nutft-card-trade
description: Check that a NutFT card proof sent through /nutft/trade is replaced by at most one new card, even under concurrent requests or retries. Use when changing trade(), isSpent, putSpent, getOperation, getSignature, atomic, or adding any await inside trade() in pokemon/server/nutft-mint.js.
---

# Verify NutFT card trades

**Property.** `OneReplacementPerCard`: one card proof yields at most one newly signed card, whatever the order of two trades with different idempotency keys and a retry of the first.

**Harm if broken.** A card is duplicated: the sender keeps a copy while the recipient gets one too, inflating a supply that is meant to be fixed.

## Run

```sh
bash scripts/verification/check-model.sh .claude/skills/verify-nutft-card-trade/model/CardTrade.tla
bash scripts/verification/check-model.sh .claude/skills/verify-nutft-card-trade/model/CardTrade.tla --mutant
cd pokemon && node --test tests/js/pokemon-trade-once.test.mjs
```

(Set `TLA2TOOLS` and `JAVA` as for the other NutFT checks.) The model must pass (15 distinct states). The `--mutant` run lets another request run between the checks and the commit, as an added `await` would, and must report `OneReplacementPerCard` violated. The test sends the same card from two copies of one wallet to two recipients at once; removing the `isSpent(y)` line in `trade()` makes it fail. Read every TLC result with the pstack `/statechart` skill.

## Coverage

Synced with the code at commit `2381605`. Move this forward only after you confirm that the model still describes the code at the new commit.

| Model step | Code (`pokemon/server/nutft-mint.js`) |
| --- | --- |
| `Start` | `trade()` up to `await ready` and the `getOperation("trade", ...)` replay |
| `Check` | `isSpent(y)`, signature, owner witness, binding, `getSignature(output.B_)` |
| `Commit` | `atomic(putSpent, putOperation, putSignature)` |

The model relies on there being no `await` between `Check` and `Commit`, so Node runs them as one step. Adding one breaks this unless the commit rechecks inside `atomic`.

## Not covered

Multiple Node processes sharing one database, `revealDeck`, booster outputs signed by `signBoosterOnce`, and the wallet's pending-transfer recovery.
