"use strict";

/* NIP-98 — proving a nostr key over HTTP.
 *
 * The mint's allowlist needs a buyer to prove they hold a listed key. It used
 * to read the key out of the request body, which proves nothing at all: the
 * caller simply stated who they were. This is the replacement.
 *
 * The verification mirrors the NIP-42 path already in server/table.js — the
 * event id is RECOMPUTED from the canonical array and compared, then the
 * signature is checked against that id. Trusting the id a caller sent would let
 * anyone attach a valid signature to different contents.
 *
 * Three things bind a proof to one request, and all three matter:
 *
 *   created_at, within a short window, so a captured header expires.
 *   `u`, so a proof for one endpoint cannot be replayed at another.
 *   `method`, so a GET proof cannot be replayed as a POST.
 *
 * REPLAY IS NOT CHECKED HERE, ON PURPOSE. A header is capturable inside its
 * window, so one proof must mean one request — but the check has to happen
 * AFTER the caller has decided the key is authorised, never before. The first
 * version had verify() consume a replay slot itself, and that was a hole: a
 * signature costs an attacker nothing (anyone can generate a key and sign), so
 * a stranger could burn every slot in the store and, because a full store
 * refuses, lock out every listed buyer. Fail-closed had become the weapon.
 *
 * So the shape is: verify() proves the signature and the binding; the caller
 * checks its own list; and only a caller that has decided "yes, this key may
 * act" calls seen.admit(). Strangers then cost nothing but a signature check.
 * See requireMayBuy() in server/nutft-mint.js for the ordering.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/98.md
 */

const crypto = require("node:crypto");
const { schnorr } = require("@noble/curves/secp256k1");

const KIND_HTTP_AUTH = 27235;
const DEFAULT_MAX_AGE = 60;          // NIP-98 suggests 60s
const MAX_SEEN = 4096;

const isHex = (value, length) =>
  typeof value === "string" && value.length === length && /^[0-9a-f]+$/i.test(value);

const eventId = (event) => crypto.createHash("sha256").update(JSON.stringify([
  0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
])).digest("hex");

/* Exactly one tag of this name, or nothing. A proof carrying two `u` tags is
 * ambiguous about which endpoint it authorises, and ambiguity on an auth path
 * resolves in the attacker's favour. */
function singleTag(event, name) {
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const found = tags.filter((tag) => Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string");
  return found.length === 1 ? found[0][1] : null;
}

function createSeenStore(maxAgeSeconds = DEFAULT_MAX_AGE) {
  const maxAge = Number(maxAgeSeconds) || DEFAULT_MAX_AGE;
  const seen = new Map();            // id -> created_at
  return {
    /* The window this store retains for. verify() is handed this value rather
       than its own default, so the two can never drift apart: a store that
       forgets sooner than proofs stay valid would silently reopen replay. */
    maxAgeSeconds: maxAge,

    /* Returns false when this id has been used already, or when the store is
       full. Full means refuse: dropping entries to make room is the one
       behaviour that would reopen replay under load. Only call this once the
       caller has decided the key is allowed to act — see the header note. */
    admit(id, createdAt, now) {
      /* A FULL sweep, not "delete until the first live entry". created_at comes
         from the client and the acceptance window tolerates a little clock
         skew in both directions, so a single future-dated proof inserted early
         would sit at the head of insertion order looking permanently fresh and
         strand every expired entry behind it. The store is capped at MAX_SEEN,
         so the scan is bounded — and it is trivial next to the signature check
         that already happened before we got here. */
      for (const [key, at] of seen) {
        if (now - at > maxAge) seen.delete(key);
      }
      if (seen.has(id)) return false;
      if (seen.size >= MAX_SEEN) return false;
      seen.set(id, createdAt);
      return true;
    },
    get size() { return seen.size; },
  };
}

/* `expectPath` is compared exactly. `expectHost` is compared only when the
 * caller knows its own public host — behind a proxy the request's own Host
 * header is not trustworthy enough to gate money on, and a wrong guess here
 * would lock out every legitimate buyer. Where it is unknown the proof is
 * still bound to the path, the method and the clock.
 *
 * On success the caller gets back the pubkey, the id and created_at, which are
 * exactly what it needs to authorise and then to call seen.admit(). */
function verify(header, options = {}) {
  const maxAge = Number(options.maxAgeSeconds || DEFAULT_MAX_AGE);
  const now = Math.floor((options.now || Date.now()) / 1000);

  if (typeof header !== "string" || !/^Nostr\s+/i.test(header)) {
    return { ok: false, reason: "missing NIP-98 Authorization header" };
  }
  let event;
  try {
    event = JSON.parse(Buffer.from(header.replace(/^Nostr\s+/i, "").trim(), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "authorization event is not valid base64 JSON" };
  }
  if (!event || typeof event !== "object") return { ok: false, reason: "authorization event is not an object" };
  if (event.kind !== KIND_HTTP_AUTH) return { ok: false, reason: "authorization event is not kind 27235" };
  if (!isHex(event.pubkey, 64) || !isHex(event.id, 64) || !isHex(event.sig, 128)) {
    return { ok: false, reason: "authorization event is malformed" };
  }
  if (!Number.isInteger(event.created_at) || Math.abs(now - event.created_at) > maxAge) {
    return { ok: false, reason: "authorization event is expired or not yet valid" };
  }

  const method = singleTag(event, "method");
  if (!method || method.toUpperCase() !== String(options.method || "GET").toUpperCase()) {
    return { ok: false, reason: "authorization event is for a different method" };
  }

  const raw = singleTag(event, "u");
  if (!raw) return { ok: false, reason: "authorization event has no u tag" };
  let target;
  try { target = new URL(raw); } catch { return { ok: false, reason: "u tag is not an absolute URL" }; }
  if (target.pathname !== options.path) {
    return { ok: false, reason: "authorization event is for a different endpoint" };
  }
  if (options.host && target.host.toLowerCase() !== String(options.host).toLowerCase()) {
    return { ok: false, reason: "authorization event is for a different host" };
  }

  /* Recompute, never trust the supplied id. */
  if (eventId(event) !== event.id.toLowerCase()) {
    return { ok: false, reason: "authorization event id does not match its contents" };
  }
  let signed = false;
  try { signed = schnorr.verify(event.sig, event.id, event.pubkey); } catch { signed = false; }
  if (!signed) return { ok: false, reason: "authorization signature is invalid" };

  return {
    ok: true,
    pubkey: event.pubkey.toLowerCase(),
    id: event.id.toLowerCase(),
    createdAt: event.created_at,
    now,
  };
}

module.exports = { verify, createSeenStore, eventId, KIND_HTTP_AUTH, DEFAULT_MAX_AGE, MAX_SEEN };
