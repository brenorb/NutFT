"use strict";

/* A minimal phoenixd client — just enough for the mint to sell a booster.
 *
 * Two calls, both from https://phoenix.acinq.co/server/api :
 *   POST /createinvoice                     -> serialized (bolt11) + paymentHash
 *   GET  /payments/incoming/{paymentHash}   -> receivedSat / completedAt
 *
 * WHY THIS EXISTS. The mint could already take money two ways, and neither was
 * right for production. The mock is virtual. The Cashu funding source needs no
 * node at all -- it asks a public mint for an invoice and receives ecash -- but
 * between the sale and the sweep those sats are held by that mint's operator,
 * which is a reasonable trade at 21 sats a pack and an unreasonable one for a
 * treasury. With a node of our own the custody question simply stops existing.
 *
 * It also unblocks paying money OUT, which the marketplace needs and neither of
 * the other two could do.
 *
 * CREDENTIALS. phoenixd authenticates with HTTP Basic: empty username, and a
 * password from ~/.phoenix/phoenix.conf. There are TWO, and the difference
 * matters more than the name suggests:
 *
 *   http-password-limited-access   createinvoice, payments/incoming, getbalance
 *   http-password                  all of the above, plus payinvoice,
 *                                  sendtoaddress and closechannel
 *
 * USE THE LIMITED ONE. Everything this file does is covered by it, and a mint
 * process that is compromised then cannot empty the wallet. Handing a shop the
 * full password buys nothing and risks everything in the node.
 *
 * It is read from the environment or from a file at startup, never logged, and
 * never written anywhere.
 *
 * The URL must be a loopback address unless PHOENIXD_ALLOW_REMOTE is set. That
 * password is a bearer credential for a funded node, and plain HTTP across a
 * network hands it to anyone on the path. If phoenixd really is on another
 * host, put it behind TLS or a tunnel and say so deliberately.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i;

function readConfig(options = {}) {
  const url = options.url || process.env.PHOENIXD_URL || "";
  if (!url) return null;

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error("PHOENIXD_URL must be an absolute URL, e.g. http://127.0.0.1:9740"); }

  let password = options.password || process.env.PHOENIXD_PASSWORD || "";
  const passwordPath = options.passwordPath || process.env.PHOENIXD_PASSWORD_PATH || "";
  if (!password && passwordPath) password = fs.readFileSync(passwordPath, "utf8").trim();
  if (!password) {
    throw new Error("PHOENIXD_URL is set but no password: set PHOENIXD_PASSWORD or "
      + "PHOENIXD_PASSWORD_PATH (the http-password line from phoenix.conf)");
  }

  /* Accepts a boolean from a caller and "1"/"true" from the environment, which
     is the only place a string can come from. Comparing String(x) to "1" alone
     silently ignored `allowRemote: true` — an option that looks like it works
     and does not is worse than one that does not exist. */
  const allowRemoteRaw = options.allowRemote ?? process.env.PHOENIXD_ALLOW_REMOTE ?? "";
  const allowRemote = allowRemoteRaw === true || allowRemoteRaw === "1" || allowRemoteRaw === "true";
  const isLoopback = LOOPBACK.test(parsed.hostname);
  if (parsed.protocol === "http:" && !isLoopback && !allowRemote) {
    throw new Error(`phoenixd at ${parsed.hostname} would receive its password in clear over the network. `
      + "Put it behind TLS or a tunnel, or set PHOENIXD_ALLOW_REMOTE=1 if the hop is genuinely private.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PHOENIXD_URL must be http or https");
  }

  return { url: parsed.origin, password, timeoutMs: Number(options.timeoutMs || 15000) };
}

/* node:http rather than fetch. The same reason server/lnd.js uses node:https:
 * this is the code path that decides whether somebody has paid, so it gets an
 * explicit timeout and an explicit body limit rather than whatever the global
 * fetch happens to default to today. */
function request(config, { method, path, body }) {
  const target = new URL(config.url + path);
  const agent = target.protocol === "https:" ? https : http;
  const payload = body === undefined ? null : body;
  const headers = {
    /* Basic with an EMPTY username -- that is what phoenixd expects, and a
       colon with nothing before it is not a mistake. */
    authorization: "Basic " + Buffer.from(":" + config.password).toString("base64"),
    accept: "application/json",
  };
  if (payload !== null) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["content-length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = agent.request(
      { method, hostname: target.hostname, port: target.port, path: target.pathname + target.search, headers },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1 << 20) { req.destroy(new Error("phoenixd response is implausibly large")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw text below */ }
          resolve({ status: res.statusCode, body: parsed, text });
        });
      },
    );
    req.setTimeout(config.timeoutMs, () => req.destroy(new Error("phoenixd did not answer in time")));
    /* The message must never carry the password, and a node error can quote the
       request. Rewrapped rather than passed through. */
    req.on("error", (error) => reject(new Error(`phoenixd request failed: ${error.message}`)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const sats = (amountMsat) => {
  if (amountMsat % 1000 !== 0) {
    /* phoenixd prices in whole sats. Rounding here would quietly charge a
     * different price than the one advertised, so it is a configuration error. */
    throw new Error(`phoenixd can only invoice whole sats; ${amountMsat} msat is not a whole number of sats`);
  }
  return amountMsat / 1000;
};

async function createInvoice(config, { amountMsat, memo, descriptionHash, expirySeconds, externalId }) {
  const form = new URLSearchParams();
  form.set("amountSat", String(sats(amountMsat)));
  /* externalId is not optional and must be RECONSTRUCTIBLE. If the mint's
     database is lost and the node is not, this field is the only record of who
     the sats belong to — a random value would be no record at all. The `acct:`
     prefix belongs to the agent-api on the same node; ours is `tcg:`. */
  if (externalId) form.set("externalId", externalId);
  /* LUD-06 commits the metadata's hash into the invoice, so when a
     descriptionHash is supplied it MUST be used -- a memo instead would produce
     an invoice a LNURL-pay wallet is right to reject. */
  if (descriptionHash) form.set("descriptionHash", descriptionHash);
  else form.set("description", memo || "600B booster");
  if (expirySeconds) form.set("expirySeconds", String(Math.floor(expirySeconds)));

  const res = await request(config, { method: "POST", path: "/createinvoice", body: form.toString() });
  if (res.status !== 200 || !res.body) {
    throw new Error(`phoenixd refused to create an invoice (${res.status}): ${(res.text || "").slice(0, 200)}`);
  }
  const paymentRequest = res.body.serialized;
  const paymentHash = res.body.paymentHash;
  if (typeof paymentRequest !== "string" || !paymentRequest || typeof paymentHash !== "string" || !paymentHash) {
    throw new Error("phoenixd returned an invoice without a serialized bolt11 and a payment hash");
  }
  return { paymentRequest, paymentHash };
}

/* Settled means THE MONEY ARRIVED, and enough of it.
 *
 * Never `isPaid` alone, and never the invoice amount: BOLT 4 lets a payer send
 * up to twice what was asked, and phoenixd sets isPaid without regard to how
 * much actually turned up. So the received figure is the only one worth
 * reading, and `expectMsat` is compared against it rather than assumed.
 *
 * Everything else is false: a 404 means the payment does not exist yet, an
 * error means we do not know. Both leave the invoice open, which is the safe
 * direction -- the buyer keeps their claim and can try again. The opposite
 * default hands out a pack on a network blip. */
async function isSettled(config, paymentHash, expectMsat) {
  const res = await request(config, {
    method: "GET",
    path: `/payments/incoming/${encodeURIComponent(paymentHash)}`,
  });
  if (res.status === 404) return false;
  if (res.status !== 200 || !res.body) {
    throw new Error(`phoenixd could not report on this invoice (${res.status})`);
  }
  const receivedSat = Number(res.body.receivedSat || 0);
  if (!(receivedSat > 0)) return false;
  if (Number.isFinite(expectMsat) && expectMsat > 0 && receivedSat * 1000 < expectMsat) {
    /* Paid, but short. Not an error and not a sale: saying so out loud is the
       only way anyone finds out, because nothing else in the system compares
       these two numbers. */
    console.error(`[phoenixd] ${paymentHash} received ${receivedSat} sat, invoice asked ${expectMsat / 1000}`);
    return false;
  }
  return true;
}

/* What the node holds, and what it merely owes itself.
 *
 * These are NOT the same and the difference decides whether a payout is
 * possible at all. With no channel open, an incoming payment is added to the
 * FEE CREDIT rather than the balance: it counts towards the cost of opening a
 * channel later and it cannot be spent or withdrawn. ACINQ do not refund it.
 *
 * So a shop in this state can sell perfectly well and pay nobody, and at
 * maxFeeCredit (50,000 sat by default) incoming payments start being REFUSED
 * outright -- the shop simply stops taking money, with nothing in our logs to
 * explain it. Both numbers are returned so that wall can be seen coming. */
async function balance(config) {
  const res = await request(config, { method: "GET", path: "/getbalance" });
  if (res.status !== 200 || !res.body) throw new Error(`phoenixd balance unavailable (${res.status})`);
  return {
    balanceSat: Number(res.body.balanceSat || 0),
    feeCreditSat: Number(res.body.feeCreditSat || 0),
  };
}

const balanceSat = async (config) => (await balance(config)).balanceSat;

module.exports = { readConfig, createInvoice, isSettled, balance, balanceSat };
