"use strict";

/* LNURL-pay in front of the mint (LUD-06).
 *
 * Without it a buyer has to copy a bolt11 string out of a web page and paste it
 * into a wallet. With it the shop shows one QR, any Lightning wallet scans it,
 * and the wallet fetches the invoice itself. That is the difference between a
 * demo you can describe and a demo somebody can actually use standing up.
 *
 * The flow the spec defines:
 *   1. wallet GETs the LNURL          -> { tag: "payRequest", callback, min, max, metadata }
 *   2. wallet GETs callback?amount=N  -> { pr: <bolt11> }
 *   3. wallet pays
 *
 * The invoice's description_hash MUST equal sha256 of the exact metadata string
 * served in step 1 — that binding is what stops a mint serving one description
 * and billing for another, and wallets check it. So the metadata string is
 * built once and reused verbatim for both steps; it is never regenerated.
 *
 * bech32 is BIP-173, written out here because the copy in site/net.js is
 * browser-side and not exported. */

const crypto = require("node:crypto");

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const high = [];
  const low = [];
  for (const ch of hrp) {
    high.push(ch.charCodeAt(0) >> 5);
    low.push(ch.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("bech32: value out of range");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error("bech32: invalid padding");
  }
  return out;
}

/* LNURL is the bech32 of the URL's own ASCII bytes, hrp "lnurl", uppercased for
 * QR alphanumeric mode — which is why lnurl QRs are dense but small. */
function encodeLnurl(url) {
  const hrp = "lnurl";
  const words = convertBits(Array.from(Buffer.from(url, "ascii")), 8, 5, true);
  const values = [...hrpExpand(hrp), ...words];
  const checksum = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i += 1) out.push((checksum >> (5 * (5 - i))) & 31);
  return (hrp + "1" + [...words, ...out].map((w) => CHARSET[w]).join("")).toUpperCase();
}

/* The metadata string is part of the protocol, not decoration: its sha256 is
 * committed into the invoice, so it must be byte-stable. */
function metadataFor(description) {
  return JSON.stringify([["text/plain", description]]);
}

function descriptionHash(metadata) {
  return crypto.createHash("sha256").update(Buffer.from(metadata, "utf8")).digest();
}

/* Step 1. min and max are equal because a booster has one price — a wallet that
 * offers a slider here would be offering to overpay for nothing. */
function payRequest({ callbackUrl, amountMsat, metadata }) {
  return {
    tag: "payRequest",
    callback: callbackUrl,
    minSendable: amountMsat,
    maxSendable: amountMsat,
    metadata,
    commentAllowed: 0,
  };
}

const error = (reason) => ({ status: "ERROR", reason });

module.exports = { encodeLnurl, metadataFor, descriptionHash, payRequest, error, convertBits };

/* Decode an npub to the 32-byte hex pubkey. Written here because the encoder
 * and its charset already live in this file, and the copy in site/net.js is
 * browser-side and not exported.
 *
 * Returns null rather than throwing: this reads operator configuration, and a
 * single fat-fingered key in an allowlist should name itself in a log line, not
 * take the whole mint down at boot. */
function decodeNpub(value) {
  const input = String(value || "").trim().toLowerCase();
  if (!input.startsWith("npub1")) return null;
  const pos = input.lastIndexOf("1");
  const hrp = input.slice(0, pos);
  const dataPart = input.slice(pos + 1);
  if (hrp !== "npub" || dataPart.length < 6) return null;
  const data = [];
  for (const ch of dataPart) {
    const index = CHARSET.indexOf(ch);
    if (index < 0) return null;
    data.push(index);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;   // checksum
  try {
    const bytes = convertBits(data.slice(0, -6), 5, 8, false);
    if (bytes.length !== 32) return null;
    return Buffer.from(bytes).toString("hex");
  } catch {
    return null;
  }
}

/* Accepts an npub or a bare 64-hex key, so an operator can paste whichever they
 * have to hand. */
function toPubkeyHex(value) {
  const raw = String(value || "").trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  return decodeNpub(raw);
}

module.exports.decodeNpub = decodeNpub;
module.exports.toPubkeyHex = toPubkeyHex;
