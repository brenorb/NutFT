"use strict";

/* A minimal LND REST client — just enough for the mint to sell a booster.
 *
 * Two calls, both documented at https://lightning.engineering/api-docs/api/lnd/:
 *   POST /v1/invoices          AddInvoice     -> payment_request + r_hash
 *   GET  /v1/invoice/{r_hash}  LookupInvoice  -> settled
 *
 * No gRPC and no new dependency: LND's REST gateway is plain HTTPS with the
 * macaroon in a header, and node's fetch already speaks that.
 *
 * The mint never sees a payment credential. It holds an invoice-scoped macaroon
 * that can create and read invoices and nothing else — no send, no channel, no
 * wallet. Generate one with:
 *
 *   lncli bakemacaroon invoices:read invoices:write --save_to=tcg.macaroon
 *
 * Credentials are read from disk at startup and never logged. */

const fs = require("node:fs");
const https = require("node:https");
const { URL } = require("node:url");

/* LND signs its REST endpoint with its own CA, so the system trust store will
 * reject it. Pinning that CA is the correct fix; disabling verification is not,
 * because it also accepts anyone else on the path. LND_TLS_CERT_PATH is
 * therefore the supported route and LND_INSECURE exists only for a local
 * throwaway regtest node, and says so out loud when used. */
function readConfig(options = {}) {
  const url = options.url || process.env.LND_REST_URL || "";
  if (!url) return null;

  const macaroonHex = options.macaroon || process.env.LND_MACAROON || "";
  const macaroonPath = options.macaroonPath || process.env.LND_MACAROON_PATH || "";
  let macaroon = macaroonHex;
  if (!macaroon && macaroonPath) macaroon = fs.readFileSync(macaroonPath).toString("hex");
  if (!macaroon) throw new Error("LND_REST_URL is set but no macaroon: set LND_MACAROON_PATH or LND_MACAROON");
  if (!/^[0-9a-f]+$/i.test(macaroon)) throw new Error("LND macaroon must be hex");

  const certPath = options.certPath || process.env.LND_TLS_CERT_PATH || "";
  const insecure = String(options.insecure ?? process.env.LND_INSECURE ?? "") === "1";
  let ca = null;
  if (certPath) ca = fs.readFileSync(certPath);
  else if (!insecure && new URL(url).protocol === "https:") {
    throw new Error("LND uses a self-signed certificate: set LND_TLS_CERT_PATH to its tls.cert "
      + "(or LND_INSECURE=1 for a throwaway local node, which accepts any certificate)");
  }

  return { url: url.replace(/\/$/, ""), macaroon, ca, insecure, timeoutMs: Number(options.timeoutMs || 8000) };
}

/* node:https rather than fetch. LND signs its REST endpoint with its own CA, and
 * the global fetch is undici, which takes a `dispatcher` and ignores the `agent`
 * option node-fetch used to accept — passing a CA there fails silently and the
 * request dies on certificate verification instead. node:https takes `ca`
 * directly, so the pinned certificate is unambiguous. */
function call(config, path, init = {}) {
  const target = new URL(`${config.url}${path}`);
  const body = init.body;
  const options = {
    method: init.method || "GET",
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    headers: {
      "Grpc-Metadata-macaroon": config.macaroon,
      ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
      ...(init.headers || {}),
    },
    timeout: config.timeoutMs,
  };
  if (target.protocol === "https:") {
    if (config.ca) options.ca = config.ca;
    if (config.insecure) options.rejectUnauthorized = false;
  }
  const transport = target.protocol === "https:" ? https : require("node:http");

  return new Promise((resolve, reject) => {
    const request = transport.request(options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          /* lnd puts the real reason in the body; the bare status hides it. */
          reject(new Error(`lnd ${path} failed (${response.statusCode}): `
            + `${parsed.message || parsed.error || text.slice(0, 180)}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`lnd ${path} timed out after ${config.timeoutMs}ms`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

/* Returns { paymentRequest, paymentHash } — paymentHash hex, which is what
 * LookupInvoice wants and what the buyer sends back to claim the pack. */
async function createInvoice(config, { amountMsat, memo, descriptionHash, expirySeconds = 900 }) {
  /* LNURL-pay commits sha256(metadata) into the invoice, and wallets verify it.
     When a description hash is supplied it replaces the memo entirely — lnd
     rejects an invoice that carries both, and the hash is the one the wallet
     will check. */
  const payload = { value_msat: String(amountMsat), expiry: String(expirySeconds) };
  if (descriptionHash) payload.description_hash = Buffer.from(descriptionHash).toString("base64");
  else payload.memo = memo;
  const body = await call(config, "/v1/invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!body.payment_request) throw new Error("lnd did not return a payment_request");
  /* r_hash comes back base64 in the REST gateway; the lookup path wants hex. */
  const paymentHash = Buffer.from(body.r_hash, "base64").toString("hex");
  return { paymentRequest: body.payment_request, paymentHash };
}

async function isSettled(config, paymentHash) {
  if (!/^[0-9a-f]{64}$/i.test(paymentHash)) throw new Error("payment_hash must be 32-byte hex");
  const body = await call(config, `/v1/invoice/${paymentHash}`);
  return body.settled === true || body.state === "SETTLED";
}

module.exports = { readConfig, createInvoice, isSettled };
