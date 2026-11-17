------------------------------ MODULE CardTrade ------------------------------
\* Two /nutft/trade requests (pokemon/server/nutft-mint.js trade()) that spend
\* the same card proof with different idempotency keys, plus a retry of the
\* first. trade() awaits only `ready`; every check after it and the commit run
\* without yielding, so Node runs them as one step:
\*   Start(r)  -> `await ready` and the getOperation replay lookup
\*   Check(r)  -> isSpent(y), signature, witness, binding, getSignature(B_)
\*   Commit(r) -> atomic(putSpent, putOperation, putSignature)
\* Broken = TRUE lets another request run between Check and Commit, as it
\* would if an await were added between them.
EXTENDS Naturals

CONSTANT Broken

Reqs == {"first", "second", "retry"}
Key == [r \in Reqs |-> IF r = "second" THEN "k2" ELSE "k1"]

VARIABLES pc, spent, ops, signed, answer

vars == <<pc, spent, ops, signed, answer>>

Init ==
  /\ pc = [r \in Reqs |-> "start"]
  /\ spent = FALSE
  /\ ops = {}
  /\ signed = 0
  /\ answer = [r \in Reqs |-> "none"]

Start(r) ==
  /\ pc[r] = "start"
  /\ r = "retry" => answer["first"] # "none"
  /\ IF Key[r] \in ops
     THEN pc' = [pc EXCEPT ![r] = "done"] /\ answer' = [answer EXCEPT ![r] = "replayed"]
     ELSE pc' = [pc EXCEPT ![r] = "checking"] /\ UNCHANGED answer
  /\ UNCHANGED <<spent, ops, signed>>

Check(r) ==
  /\ pc[r] = "checking"
  /\ IF spent
     THEN pc' = [pc EXCEPT ![r] = "done"] /\ answer' = [answer EXCEPT ![r] = "refused"]
          /\ UNCHANGED <<spent, ops, signed>>
     ELSE IF Broken
          THEN pc' = [pc EXCEPT ![r] = "checked"] /\ UNCHANGED <<answer, spent, ops, signed>>
          ELSE /\ pc' = [pc EXCEPT ![r] = "done"] /\ answer' = [answer EXCEPT ![r] = "signed"]
               /\ spent' = TRUE /\ ops' = ops \cup {Key[r]} /\ signed' = signed + 1

Commit(r) ==
  /\ pc[r] = "checked"
  /\ pc' = [pc EXCEPT ![r] = "done"] /\ answer' = [answer EXCEPT ![r] = "signed"]
  /\ spent' = TRUE /\ ops' = ops \cup {Key[r]} /\ signed' = signed + 1

Done == (\A r \in Reqs : pc[r] = "done" \/ (r = "retry" /\ answer["first"] = "none"))
        /\ UNCHANGED vars

Next == Done \/ \E r \in Reqs : Start(r) \/ Check(r) \/ Commit(r)

Spec == Init /\ [][Next]_vars

\* One card proof is replaced by at most one newly signed card.
OneReplacementPerCard == signed <= 1
=============================================================================
