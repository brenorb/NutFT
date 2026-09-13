"use strict";

/* Where the mint's money comes from.
 *
 * The mint needs exactly two things from a funding source: give me an invoice,
 * and tell me whether it was paid. Everything else — which node, whose custody,
 * what protocol — is somebody else's problem. Keeping that surface to two
 * functions is what lets the backend change without the mint noticing, and the
 * backend WILL change: an own LND, a wallet API and ecash are all live options
 * and the choice is not settled.
 *
 * Backends:
 *   lnd   — the operator's own node over REST (server/lnd.js)
 *   mock  — virtual sats. Invoices that are not real and settle on demand.
 *   none  — no funding source at all; the mint gives boosters away.
 *
 * `mock` exists for staging. A staging deployment must exercise the whole
 * payment path — quote, invoice, settle, claim, the double-claim guard — while
 * being unable to move a single real satoshi, because a bug in that path is
 * exactly what staging is for. It is refused in production by the caller. */

const crypto = require("node:crypto");
const lnd = require("./lnd.js");

/* Not a real bolt11 and deliberately not shaped like one: a staging invoice
 * that looked payable would eventually be pasted into a real wallet by a tired
 * person. The prefix says what it is. */
function mockInvoice(amountMsat, paymentHash) {
  return `lnbcmock${amountMsat}n1${paymentHash.slice(0, 40)}`;
}

function createMockFunding(options = {}) {
  /* settleAfterMs = 0 means "already paid the moment it is created", which is
     what an automated staging run wants. A positive value leaves a window so a
     human can watch the unpaid state in the UI before it flips. */
  const settleAfterMs = Number(options.settleAfterMs ?? process.env.NUTFT_MOCK_SETTLE_MS ?? 0);
  const issuedAt = new Map();

  return {
    name: "mock",
    virtual: true,
    async createInvoice({ amountMsat }) {
      const paymentHash = crypto.randomBytes(32).toString("hex");
      issuedAt.set(paymentHash, Date.now());
      return { paymentRequest: mockInvoice(amountMsat, paymentHash), paymentHash };
    },
    async isSettled(paymentHash) {
      const at = issuedAt.get(paymentHash);
      if (at === undefined) return false;
      return Date.now() - at >= settleAfterMs;
    },
    /* Lets a test drive settlement explicitly rather than waiting on a clock. */
    settle(paymentHash) { issuedAt.set(paymentHash, 0); },
  };
}

function createLndFunding(config) {
  return {
    name: "lnd",
    virtual: false,
    createInvoice: (args) => lnd.createInvoice(config, args),
    isSettled: (paymentHash) => lnd.isSettled(config, paymentHash),
  };
}

/* Returns null when the mint has no funding source, which is the free-demo
 * case and must stay the default: an unconfigured mint charges nobody. */
/* A node of our own. The Cashu source needs none, which is why it exists, but
 * between a sale and the sweep those sats sit with somebody else's mint. With
 * phoenixd that trade simply stops being one -- and paying money OUT becomes
 * possible, which neither of the other two backends could do and which a
 * marketplace cannot work without. */
function createPhoenixdFunding(config) {
  const phoenixd = require("./phoenixd.js");
  return {
    name: "phoenixd",
    virtual: false,
    custodial: false,
    createInvoice: (args) => phoenixd.createInvoice(config, args),
    /* expectMsat travels with the question. phoenixd reports what actually
       arrived, and only the caller knows what was asked for -- without both
       numbers in one place nothing in the system ever compares them. */
    isSettled: (paymentHash, expectMsat) => phoenixd.isSettled(config, paymentHash, expectMsat),
    balance: () => phoenixd.balance(config),
    balanceSat: () => phoenixd.balanceSat(config),
  };
}

function createFunding(options = {}) {
  const explicit = options.funding;
  if (explicit) return explicit;

  const backend = String(options.backend || process.env.NUTFT_FUNDING || "").toLowerCase();
  if (backend === "mock") return createMockFunding(options);
  if (backend === "phoenixd" || (!backend && process.env.PHOENIXD_URL)) {
    const config = require("./phoenixd.js").readConfig(options.phoenixd || {});
    if (!config && backend === "phoenixd") {
      throw new Error("NUTFT_FUNDING=phoenixd needs PHOENIXD_URL (e.g. http://127.0.0.1:9740)");
    }
    if (config) return createPhoenixdFunding(config);
  }
  if (backend === "cashu") {
    const { createCashuFunding } = require("./funding-cashu.js");
    return createCashuFunding(options);
  }
  if (backend === "lnd" || (!backend && (options.lnd || process.env.LND_REST_URL))) {
    const config = options.lnd || lnd.readConfig(options.lndOptions || {});
    return config ? createLndFunding(config) : null;
  }
  if (backend && backend !== "none") throw new Error(`unknown NUTFT_FUNDING backend: ${backend}`);
  return null;
}

module.exports = { createFunding, createMockFunding, createLndFunding, createPhoenixdFunding };
