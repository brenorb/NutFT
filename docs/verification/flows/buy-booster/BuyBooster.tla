----------------------------- MODULE BuyBooster -----------------------------
\* Buying a paid booster in the browser: the shop page asks /nutft/quote,
\* shows the Lightning invoice, and site/nutft-wallet.js claimBooster keeps a
\* pending claim in localStorage until /nutft/booster answers.
VARIABLES screen, paid, ownPackSold, pending

vars == <<screen, paid, ownPackSold, pending>>

Init == screen = "shop" /\ paid = FALSE /\ ownPackSold = FALSE /\ pending = FALSE

YouBuy ==
  /\ screen = "shop" /\ screen' = "invoice"
  /\ UNCHANGED <<paid, ownPackSold, pending>>

ShopBusy ==
  /\ screen = "shop" /\ screen' = "busy"
  /\ UNCHANGED <<paid, ownPackSold, pending>>

TryLater ==
  /\ screen = "busy" /\ screen' = "shop"
  /\ UNCHANGED <<paid, ownPackSold, pending>>

YouPay ==
  /\ screen = "invoice" /\ screen' = "claiming" /\ paid' = TRUE /\ pending' = TRUE
  /\ UNCHANGED ownPackSold

InvoiceExpires ==
  /\ screen = "invoice" /\ screen' = "expired"
  /\ UNCHANGED <<paid, ownPackSold, pending>>

YouLeave ==
  /\ screen = "claiming" /\ screen' = "away"
  /\ UNCHANGED <<paid, ownPackSold, pending>>

\* While you are away past the claim grace, another buyer takes your pack.
SomeoneTakesYourPack ==
  /\ screen = "away" /\ ~ownPackSold /\ ownPackSold' = TRUE
  /\ UNCHANGED <<screen, paid, pending>>

YouReturn ==
  /\ screen = "away" /\ screen' = "claiming"
  /\ UNCHANGED <<paid, ownPackSold, pending>>

MintIssues ==
  /\ screen = "claiming" /\ pending
  /\ screen' = (IF ownPackSold THEN "nextPack" ELSE "opened") /\ pending' = FALSE
  /\ UNCHANGED <<paid, ownPackSold>>

Done == screen \in {"opened", "nextPack", "expired"} /\ UNCHANGED vars

Next == YouBuy \/ ShopBusy \/ TryLater \/ YouPay \/ InvoiceExpires \/ YouLeave
        \/ SomeoneTakesYourPack \/ YouReturn \/ MintIssues \/ Done

Spec == Init /\ [][Next]_vars

\* If you paid, you end up holding a pack.
PaidMeansCards == screen \in {"expired"} => ~paid
PaidIsCollectable == paid /\ screen \in {"opened", "nextPack", "expired"} => ~pending
=============================================================================
