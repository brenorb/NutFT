# NutFT verification

Project-local skills under `.claude/skills` check the Pokémon mint (`pokemon/server/nutft-mint.js`) where a bug costs buyers money or duplicates cards:

| Skill | What it checks | Scope |
| --- | --- | --- |
| [verify-nutft-booster-sale](../../.claude/skills/verify-nutft-booster-sale/SKILL.md) | A paid invoice can always collect a pack; one payment buys one pack | 64 states: two buyers, quote, pay, expiry, claim-grace lapse, claim |
| [verify-nutft-card-trade](../../.claude/skills/verify-nutft-card-trade/SKILL.md) | One card proof is replaced at most once | 15 states: two trades of one card and a retry |

The booster model found a bug, now fixed with a regression test (commit 2381605). After a paid invoice's claim grace lapsed, the mint quoted the same pack again but accepted claims only for the pack on sale. Whichever paid buyer claimed second was refused forever.

## Buy a paid booster

Generated with pstack `/statechart` from [BuyBooster.tla](flows/buy-booster/BuyBooster.tla) ([TLC report](flows/buy-booster/report.md)). The chart hides terminal stuttering.

```mermaid
---
title: "Buy a paid booster"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: settled
    lg1: stopped
    lg2: working
  }
  class lg0 teal
  class lg1 orange
  class lg2 blue
  s0: Shop open
  s1: Pack reserved by another buyer
  s2: Lightning invoice shown
  s3: Invoice expired, nothing paid
  s4: Paid, collecting cards
  s5: Your quoted pack opened
  s6: Paid, tab closed
  s7: Away, your pack sold to someone else
  s8: Collecting with a sold pack
  s9: Next pack opened for your payment
  [*] --> s0
  s0 --> s1: someone else holds the next pack
  s0 --> s2: you press buy
  s1 --> s0: you try again later
  s2 --> s3: the invoice expires
  s2 --> s4: you pay the invoice
  s4 --> s5: the mint signs your cards
  s4 --> s6: you close the tab
  s6 --> s4: you come back
  s6 --> s7: the claim grace lapses and someone else claims your pack
  s7 --> s8: you come back
  s8 --> s7: you close the tab
  s8 --> s9: the mint signs your cards
  class s0 blue
  class s1 orange
  class s2 blue
  class s3 orange
  class s4 blue
  class s5 teal
  class s6 blue
  class s7 blue
  class s8 blue
  class s9 teal
```
