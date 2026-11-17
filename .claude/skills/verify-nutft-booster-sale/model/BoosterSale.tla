----------------------------- MODULE BoosterSale -----------------------------
\* Paid booster sales on the NutFT mint (pokemon/server/nutft-mint.js) with
\* two buyers. Packs are sold in order: quote() always prices the pack at
\* state.nextPack, and only a claim advances it.
\*   Quote(b)  -> payableQuoteOnce: refused while another invoice holds the pack
\*   Pay(b)    -> the buyer pays the Lightning invoice
\*   Expire(b) -> the invoice expires unpaid (invoiceTtlSeconds)
\*   Lapse(b)  -> a paid, unclaimed invoice outlives claimGraceSeconds
\*   Claim(b)  -> signBoosterOnce -> requireSettled + claimInvoice
\* Broken = TRUE is the code before the fix: requireSettled accepted only an
\* invoice bound to the pack currently for sale.
EXTENDS Naturals

CONSTANT Broken

Buyers == {"alice", "bob"}

VARIABLES nextPack, inv, lapsed, issued

vars == <<nextPack, inv, lapsed, issued>>

Init ==
  /\ nextPack = 1
  /\ inv = [b \in Buyers |-> [state |-> "none", pack |-> 0]]
  /\ lapsed = [b \in Buyers |-> FALSE]
  /\ issued = 0

\* The activeInvoices loop in payableQuoteOnce.
Holds(o) ==
  /\ inv[o].pack = nextPack
  /\ \/ inv[o].state = "open"
     \/ inv[o].state = "paid" /\ ~lapsed[o]

Quote(b) ==
  /\ inv[b].state = "none"
  /\ ~\E o \in Buyers : Holds(o)
  /\ inv' = [inv EXCEPT ![b] = [state |-> "open", pack |-> nextPack]]
  /\ UNCHANGED <<nextPack, lapsed, issued>>

Pay(b) ==
  /\ inv[b].state = "open"
  /\ inv' = [inv EXCEPT ![b].state = "paid"]
  /\ UNCHANGED <<nextPack, lapsed, issued>>

Expire(b) ==
  /\ inv[b].state = "open"
  /\ inv' = [inv EXCEPT ![b].state = "expired"]
  /\ UNCHANGED <<nextPack, lapsed, issued>>

Lapse(b) ==
  /\ inv[b].state = "paid" /\ ~lapsed[b]
  /\ lapsed' = [lapsed EXCEPT ![b] = TRUE]
  /\ UNCHANGED <<nextPack, inv, issued>>

\* requireSettled: the old code required the invoice's own pack to be the one
\* for sale. The fix also accepts a settled invoice whose pack was already sold
\* to someone else, and gives it the pack now for sale.
Claimable(b) ==
  /\ inv[b].state = "paid"
  /\ IF Broken THEN inv[b].pack = nextPack ELSE inv[b].pack <= nextPack

Claim(b) ==
  /\ Claimable(b)
  /\ inv' = [inv EXCEPT ![b].state = "claimed"]
  /\ nextPack' = nextPack + 1
  /\ issued' = issued + 1
  /\ UNCHANGED lapsed

\* Nothing is waiting on the Lightning network; buyers may stop here.
Done == (\A b \in Buyers : inv[b].state # "open") /\ UNCHANGED vars

Next == Done \/ \E b \in Buyers :
  Quote(b) \/ Pay(b) \/ Expire(b) \/ Lapse(b) \/ Claim(b)

Spec == Init /\ [][Next]_vars

\* A buyer whose payment settled can always collect a pack.
PaidBuyerCanClaim == \A b \in Buyers : inv[b].state = "paid" => Claimable(b)

\* One settled payment buys one pack: packs issued equal invoices claimed.
OnePackPerPayment ==
  issued = (IF inv["alice"].state = "claimed" THEN 1 ELSE 0)
         + (IF inv["bob"].state = "claimed" THEN 1 ELSE 0)
=============================================================================
