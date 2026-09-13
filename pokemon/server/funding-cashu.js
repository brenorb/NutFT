"use strict";

/* A funding source that needs no Lightning node at all.
 *
 * A public Cashu mint will hand anyone a real BOLT11 invoice on request — that
 * is what a NUT-4 mint quote IS. So the shop asks a mint for an invoice, the
 * buyer pays it with any Lightning wallet (Phoenix included), and when it
 * settles the mint issues ecash to us. No channels, no macaroon, no node, no
 * account, no API key. Verified live against a public mint: min_amount 1 sat.
 *
 * WHAT THIS COSTS, said plainly: between "invoice paid" and "we melt out", the
 * sats are held by the mint operator, not by us. They can go offline, lose the
 * database, or refuse to pay out. This is the same trust a custodial wallet
 * asks for. It is a reasonable trade at 21 sats a pack and an unreasonable one
 * for a treasury, so sweep regularly and never let a balance grow large.
 *
 * The rule that is easy to get wrong: checking that a quote is PAID is NOT
 * taking the money. The mint owes us ecash at that point and quotes expire —
 * if we never call mintProofs the payment is confirmed and lost. So isSettled()
 * mints and persists the proofs before it reports true, and reports false if
 * minting failed. Proofs are bearer instruments: the row IS the money. */

const DDL = `
/* Every quote we hand out, so a payment can be collected even if the buyer
   never comes back to claim their pack. Without this the only trigger for
   taking the money is the buyer's own claim request, and a buyer who pays and
   then closes the tab leaves a PAID quote nobody ever mints — it expires, and
   the sats stay with the mint operator. That is a 100% loss on that sale. */
CREATE TABLE IF NOT EXISTS nutft_quotes (
  quote_id   TEXT PRIMARY KEY,
  amount_sat INTEGER NOT NULL,
  expiry     INTEGER,
  taken      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nutft_treasury (
  quote_id    TEXT PRIMARY KEY,
  amount_sat  INTEGER NOT NULL,
  mint_url    TEXT NOT NULL,
  proofs_json TEXT NOT NULL,
  minted_at   TEXT NOT NULL
);
`;

function createCashuFunding(options = {}) {
  const mintUrl = (options.mintUrl || process.env.NUTFT_CASHU_MINT || "").replace(/\/$/, "");
  if (!mintUrl) throw new Error("NUTFT_FUNDING=cashu needs NUTFT_CASHU_MINT (a mint URL)");
  if (!/^https:\/\//i.test(mintUrl)) throw new Error("NUTFT_CASHU_MINT must be https");
  const db = options.db || null;
  if (db) db.exec(DDL);

  const q = db ? {
    get: db.prepare("SELECT quote_id FROM nutft_treasury WHERE quote_id = ?"),
    put: db.prepare("INSERT OR IGNORE INTO nutft_treasury (quote_id, amount_sat, mint_url, proofs_json, minted_at) VALUES (?, ?, ?, ?, ?)"),
    putQuote: db.prepare("INSERT OR REPLACE INTO nutft_quotes (quote_id, amount_sat, expiry, taken, created_at) VALUES (?, ?, ?, 0, ?)"),
    takeQuote: db.prepare("UPDATE nutft_quotes SET taken = 1 WHERE quote_id = ?"),
    /* Only quotes still worth asking about: not yet collected, and not past the
       mint's own expiry. An unbounded scan would grow with every sale forever
       and hammer the mint for quotes that can never pay again. */
    pending: db.prepare("SELECT quote_id FROM nutft_quotes WHERE taken = 0 AND (expiry IS NULL OR expiry > ?) ORDER BY created_at LIMIT ?"),
  } : null;

  /* One in-flight collection per quote. minting is not idempotent at the mint:
     two concurrent calls for one quote mean one wins and one errors, and if the
     winner's write is the one that fails the proofs are gone with no retry that
     can recover them. The claim path and the reconciler share this map, so they
     can never both be minting the same quote. */
  const inFlight = new Map();
  const singleflight = (key, run) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = (async () => { try { return await run(); } finally { inFlight.delete(key); } })();
    inFlight.set(key, task);
    return task;
  };

  /* An injected wallet is an explicit seam for tests: the collection and
     double-mint guarantees are the whole point of this file, and they cannot be
     tested against a real mint without spending real money on every run. */
  let walletPromise = null;
  const wallet = () => (walletPromise ||= (async () => {
    if (options.wallet) {
      await options.wallet.loadMint();
      return { w: options.wallet, cashu: { MintQuoteState: { PAID: "PAID", ISSUED: "ISSUED" } } };
    }
    const cashu = await import("@cashu/cashu-ts");
    const w = new cashu.Wallet(mintUrl, { unit: "sat" });
    await w.loadMint();
    return { w, cashu };
  })());

  const sats = (amountMsat) => {
    if (amountMsat % 1000 !== 0) {
      /* A mint quote is denominated in whole sats. Rounding here would silently
       * charge a different price than the one advertised. */
      throw new Error(`a Cashu mint can only price whole sats; ${amountMsat} msat is not a whole number of sats`);
    }
    return amountMsat / 1000;
  };

  /* A test mint issues invoices nobody can pay and settles them itself. That is
     exactly what we want for a rehearsal — and it is dangerous to leave unsaid,
     because the best-known test mint hands out invoices with the MAINNET prefix
     lnbc. A real wallet will try to pay one. Nothing is lost (there is no route
     to a node that does not exist) but a buyer deserves to be told before they
     scan, not after. Flagged explicitly rather than sniffed from the URL: a
     guess here fails open, and failing open means lying about money. */
  const testMint = String(options.testMint ?? process.env.NUTFT_TEST_MINT ?? "") === "1";

  return {
    name: "cashu",
    virtual: false,
    testMint,
    custodial: true,
    mintUrl,

    async createInvoice({ amountMsat }) {
      /* Validate the amount before opening a connection: a bad price is a
       * configuration error and should surface as one, not as a network fault
       * from a mint that was never going to be asked a sensible question. */
      const amountSat = sats(amountMsat);
      const { w } = await wallet();
      const quote = await w.createMintQuoteBolt11(amountSat);
      if (!quote || !quote.request || !quote.quote) throw new Error("mint returned no usable quote");
      /* Recorded BEFORE the caller sees it. A quote we handed out but did not
         write down is one we could never collect if the buyer disappears. */
      if (q) q.putQuote.run(quote.quote, amountSat, Number(quote.expiry) || null, new Date().toISOString());
      /* The identifier is the QUOTE ID, not a payment hash — a mint quote is
       * not addressed by payment hash. The funding interface treats it as an
       * opaque handle, which is why the mint's validation accepts both shapes. */
      return { paymentRequest: quote.request, paymentHash: quote.quote };
    },

    /* Take possession of one quote if it has been paid. Returns true only when
       the ecash is minted AND written down — never on "the mint says PAID",
       because that only means the mint owes us, and an unminted debt expires. */
    async collect(quoteId) {
      if (q && q.get.get(quoteId)) return true;      // already ours
      return singleflight(quoteId, async () => {
        if (q && q.get.get(quoteId)) return true;    // won by the other caller
        const { w, cashu } = await wallet();
        let state;
        try {
          state = await w.checkMintQuoteBolt11(quoteId);
        } catch (error) {
          console.error(`[nutft] cashu quote lookup failed for ${quoteId}:`, error && error.message);
          return false;
        }
        const paid = state && (state.state === cashu.MintQuoteState.PAID || state.state === "PAID");
        const issued = state && (state.state === cashu.MintQuoteState.ISSUED || state.state === "ISSUED");

        /* ISSUED with nothing in the treasury means we minted and lost the
           proofs. No retry recovers that — the mint considers the quote spent.
           Say so loudly and refuse: handing over a pack for money we cannot
           show would turn one loss into two. */
        if (issued) {
          console.error(`[nutft] cashu quote ${quoteId} is ISSUED but no proofs are stored — money may be lost, investigate`);
          if (q) q.takeQuote.run(quoteId);           // stop re-checking a dead quote
          return false;
        }
        if (!paid) return false;

        const amount = Number(state.amount || 0);
        let proofs;
        try {
          proofs = await w.mintProofsBolt11(amount, quoteId);
        } catch (error) {
          console.error(`[nutft] cashu mintProofs failed for ${quoteId}:`, error && error.message);
          return false;                               // left un-taken, retried later
        }
        if (!Array.isArray(proofs) || !proofs.length) return false;

        if (!q) {
          /* The proofs would exist only in this reply and vanish on restart.
             Refuse rather than quietly burn the buyer's sats. */
          throw new Error("the Cashu funding source needs a database to store the ecash it receives");
        }
        q.put.run(quoteId, amount, mintUrl, JSON.stringify(proofs), new Date().toISOString());
        q.takeQuote.run(quoteId);
        return true;
      });
    },

    async isSettled(quoteId) {
      return this.collect(quoteId);
    },

    /* The safety net. Collection used to happen only when a buyer claimed their
       pack, so anyone who paid and then closed the tab — or bought a sealed pack
       whose block was not mined yet — left a PAID quote that nobody collected.
       It expired and the sats stayed with the mint operator: a total loss on a
       sale that had already succeeded. This sweeps those up.
       Bounded on purpose: only quotes not yet collected and not yet expired,
       oldest first, a handful per pass. */
    async reconcile({ limit = 25 } = {}) {
      if (!q) return { checked: 0, collected: 0 };
      const now = Math.floor(Date.now() / 1000);
      const rows = q.pending.all(now, limit);
      let collected = 0;
      for (const row of rows) {
        try {
          if (await this.collect(row.quote_id)) collected += 1;
        } catch (error) {
          console.error(`[nutft] reconcile failed for ${row.quote_id}:`, error && error.message);
        }
      }
      if (collected) console.log(`[nutft] reconcile collected ${collected} unclaimed payment(s)`);
      return { checked: rows.length, collected };
    },

    /* What the mint currently holds for us, so a sweep can be scheduled and the
     * balance never becomes a surprise. */
    balanceSat() {
      if (!db) return 0;
      const row = db.prepare("SELECT COALESCE(SUM(amount_sat), 0) AS total FROM nutft_treasury").get();
      return Number(row ? row.total : 0);
    },
  };
}

module.exports = { createCashuFunding, DDL };
