/* 600B Timelock TCG — BIP-340 Schnorr verification over secp256k1, from scratch.
 *
 * WHY THIS EXISTS. The ladder is computed in the reader's browser out of signed
 * result events pulled off public relays. A relay is not a witness. It can drop
 * events, reorder them, replay them, or hand back a row whose `id` and `sig`
 * nobody ever checked — relays are not required to verify anything, and several
 * popular ones don't. If the leaderboard counted what it was given, forging a
 * season would cost one cooperative relay and no cryptography at all. So every
 * event that moves a number on screen is verified HERE, locally, first.
 *
 * WHY IT IS HAND-ROLLED. site/ has no bundler and no build step: each file is a
 * plain <script> tag, and node_modules never reaches the browser. A verifier we
 * cannot ship is not a verifier. This is ~200 lines of BigInt; the alternative
 * was trusting the relay, which is not an alternative.
 *
 * THIS IS NOT SIGNING CODE AND MUST NEVER BECOME SIGNING CODE.
 * Nothing here is constant time — not the modular inverse (extended Euclid,
 * data-dependent loop count), not the scalar multiplication (plain
 * double-and-add, branches on secret bits), not the BigInt arithmetic itself
 * (V8 BigInts are variable-time and allocate). That is deliberate and it is
 * safe, because every input this file touches is PUBLIC: a signature, a message
 * hash and an x-only pubkey, all of which the attacker already has. There is no
 * secret to leak. Private keys live in the player's NIP-07 extension and never
 * enter this process. If you are ever tempted to add sign() here — don't; a
 * timing side channel on a nonce is how you hand over the key.
 *
 * SPEC: BIP-340 (schnorr sigs for secp256k1) and NIP-01 (event id).
 * API: globalThis.E1Schnorr — see the export block at the bottom for the exact
 * shape and for why verify() is async. */
(() => {
  "use strict";

  // --------------------------------------------------------------- the curve

  /* secp256k1: y² = x³ + 7 over F_p, prime order n, cofactor 1. */
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const CURVE_B = 7n;
  const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

  /* JS `%` keeps the sign of the dividend, so a bare `a % P` on a subtraction
   * result can be negative and every downstream comparison then silently lies.
   * Every field op in this file goes through here. */
  const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
  const modN = (a) => { const r = a % N; return r >= 0n ? r : r + N; };

  /* Extended Euclid, not Fermat: ~256 tiny steps instead of 256 full 256-bit
   * modular squarings. Returns null when the value is not invertible (only
   * reachable for 0, which we treat as "point at infinity" upstream). */
  function inverse(number) {
    let a = mod(number), b = P, x = 0n, u = 1n;
    while (a !== 0n) {
      const q = b / a, r = b % a;
      const m = x - u * q;
      b = a; a = r; x = u; u = m;
    }
    return b === 1n ? mod(x) : null;
  }

  function powMod(base, exponent) {
    let result = 1n, b = mod(base), e = exponent;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % P;
      b = (b * b) % P;
      e >>= 1n;
    }
    return result;
  }

  /* p ≡ 3 (mod 4), so the square root is a single exponentiation. There is no
   * such shortcut for a general prime — this is a secp256k1 fact, not a
   * universal one. */
  const SQRT_EXP = (P + 1n) / 4n;

  /* BIP-340 lift_x. An x-only pubkey names TWO curve points; the spec picks the
   * one with even Y, unconditionally. Getting this wrong does not fail loudly —
   * it fails as "half of all valid signatures are rejected", which looks like a
   * flaky relay. Returns a Jacobian point, or null when x is not on the curve
   * (powMod always returns *something*; only the y² === c check proves it is a
   * real root rather than a root of a non-residue). */
  function liftX(x) {
    if (x >= P) return null;
    const c = mod(mod(mod(x * x) * x) + CURVE_B);
    const y = powMod(c, SQRT_EXP);
    if (mod(y * y) !== c) return null;
    return { x, y: (y & 1n) === 0n ? y : P - y, z: 1n };
  }

  // ------------------------------------------------------ Jacobian point math

  /* Affine addition needs a modular inverse PER STEP — ~512 of them for one
   * scalar multiplication. Jacobian coordinates (X/Z², Y/Z³) defer all of that
   * to a single inverse at the very end. Z === 0n is the point at infinity;
   * there is no other sentinel, so every code path must check it. */
  const ZERO = { x: 0n, y: 1n, z: 0n };
  const G = { x: Gx, y: Gy, z: 1n };

  // dbl-2009-l (a = 0). Cheap because secp256k1's `a` coefficient is zero.
  function double(p1) {
    if (p1.z === 0n || p1.y === 0n) return ZERO;
    const A = mod(p1.x * p1.x);
    const B = mod(p1.y * p1.y);
    const C = mod(B * B);
    const t = mod(p1.x + B);
    const D = mod(2n * mod(mod(t * t) - A - C));
    const E = mod(3n * A);
    const F = mod(E * E);
    const X3 = mod(F - 2n * D);
    return {
      x: X3,
      y: mod(mod(E * mod(D - X3)) - 8n * C),
      z: mod(2n * mod(p1.y * p1.z)),
    };
  }

  // add-2007-bl. The H === 0n branch is the whole reason this is not a one-liner:
  // the addition formulas produce 0/0 for P + P and for P + (-P), so those two
  // cases have to be split out by hand or the result is a garbage point that
  // still looks like a point.
  function add(p1, p2) {
    if (p1.z === 0n) return p2;
    if (p2.z === 0n) return p1;
    const Z1Z1 = mod(p1.z * p1.z);
    const Z2Z2 = mod(p2.z * p2.z);
    const U1 = mod(p1.x * Z2Z2);
    const U2 = mod(p2.x * Z1Z1);
    const S1 = mod(mod(p1.y * p2.z) * Z2Z2);
    const S2 = mod(mod(p2.y * p1.z) * Z1Z1);
    const H = mod(U2 - U1);
    const r = mod(2n * mod(S2 - S1));
    if (H === 0n) return r === 0n ? double(p1) : ZERO;
    const I = mod(mod(2n * H) * mod(2n * H));
    const J = mod(H * I);
    const V = mod(U1 * I);
    const X3 = mod(mod(r * r) - J - 2n * V);
    const Zs = mod(mod(mod(p1.z + p2.z) * mod(p1.z + p2.z)) - Z1Z1 - Z2Z2);
    return {
      x: X3,
      y: mod(mod(r * mod(V - X3)) - mod(2n * mod(S1 * J))),
      z: mod(Zs * H),
    };
  }

  const bitLength = (k) => (k > 0n ? k.toString(2).length : 0);

  /* Shamir's trick: k1·p1 + k2·p2 in ONE pass. Verification always needs a sum
   * of two scalar multiplications, and sharing the doubling ladder between them
   * halves the work — ~256 doublings instead of ~512. Order of the two adds is
   * irrelevant; the group is abelian. */
  function mulAdd(k1, p1, k2, p2) {
    let acc = ZERO;
    for (let i = Math.max(bitLength(k1), bitLength(k2)) - 1; i >= 0; i--) {
      const bit = BigInt(i);
      acc = double(acc);
      if ((k1 >> bit) & 1n) acc = add(acc, p1);
      if ((k2 >> bit) & 1n) acc = add(acc, p2);
    }
    return acc;
  }

  function toAffine(p1) {
    if (p1.z === 0n) return null; // infinity has no x, and BIP-340 says reject
    const iz = inverse(p1.z);
    if (iz === null) return null;
    const iz2 = mod(iz * iz);
    return { x: mod(p1.x * iz2), y: mod(p1.y * mod(iz2 * iz)) };
  }

  // ------------------------------------------------------------------ hashing

  /* Strict lowercase. A relay that hands back uppercase hex is handing back
   * something no NIP-01 signer produced, and quietly accepting it would mean an
   * event has two spellings and therefore two ids. Returns null, never throws;
   * `expectBytes` omitted means "any even-length hex", which is what BIP-340
   * messages are (0, 1, 17, 100 bytes are all legal — see the spec's own test
   * vectors). */
  const HEX = /^[0-9a-f]*$/;
  function fromHex(hex, expectBytes) {
    if (typeof hex !== "string") return null;
    if (hex.length % 2 !== 0) return null;
    if (expectBytes !== undefined && hex.length !== expectBytes * 2) return null;
    if (!HEX.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  const toHex = (bytes) => {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
  };

  function fromBytes(bytes) {
    let out = 0n;
    for (const b of bytes) out = (out << 8n) | BigInt(b);
    return out;
  }

  function concat(...parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  const sha256 = async (bytes) =>
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));

  /* BIP-340 tagged hash: sha256(sha256(tag) || sha256(tag) || data). The tag is
   * hashed and REPEATED — the doubling is what fixes the prefix at 64 bytes, one
   * full SHA-256 block, so a chosen `data` can never be crafted to collide with
   * a different tag's domain. Computing sha256(tag) once and caching it is worth
   * it: this runs per event, and the leaderboard reads hundreds. */
  const CHALLENGE_TAG = "BIP0340/challenge";
  let challengePrefix = null;
  async function challengeHash(data) {
    if (!challengePrefix) {
      const h = await sha256(new TextEncoder().encode(CHALLENGE_TAG));
      challengePrefix = concat(h, h); // benign race: two callers compute the same 64 bytes
    }
    return sha256(concat(challengePrefix, data));
  }

  // ------------------------------------------------------------ BIP-340 verify

  /* Verify(pk, m, sig) straight out of the spec, in spec order, because every
   * one of these rejections is a real published attack vector:
   *   px >= p — an x-only key that is not a field element at all
   *   r  >= p — a signature whose R.x could never be produced by a real point
   *   s  >= n — malleability: s and s+n would otherwise both verify
   *   lift_x failure — x with no square root, i.e. not on the curve
   *   R infinite — sG = eP exactly; treating infinity as (0, even) accepts junk
   *   R.y odd — the other half of the x-only convention
   *
   * ASYNC BECAUSE WEBCRYPTO IS. crypto.subtle.digest returns a Promise and
   * there is no synchronous SHA-256 in a browser. The choice was: ship a second,
   * hand-written SHA-256 so this could be sync, or await. Two hash
   * implementations that can disagree is a worse bug than a Promise. */
  async function verify(sigHex, msgHex, pubkeyHex) {
    try {
      const sig = fromHex(sigHex, 64);
      const pub = fromHex(pubkeyHex, 32);
      const msg = fromHex(msgHex);
      if (!sig || !pub || !msg) return false;

      const rBytes = sig.subarray(0, 32);
      const r = fromBytes(rBytes);
      const s = fromBytes(sig.subarray(32, 64));
      const px = fromBytes(pub);
      if (r >= P || s >= N || px >= P) return false;

      const point = liftX(px);
      if (!point) return false;

      const e = modN(fromBytes(await challengeHash(concat(rBytes, pub, msg))));

      /* R = s·G − e·P. Negation on this curve is just (x, −y), so the
       * subtraction folds into the same one-pass ladder as the addition. */
      const negated = { x: point.x, y: mod(P - point.y), z: 1n };
      const R = toAffine(mulAdd(s, G, e, negated));
      if (!R) return false;                 // sG − eP is the point at infinity
      if ((R.y & 1n) === 1n) return false;  // has_even_y(R) is false
      return R.x === r;
    } catch (err) {
      return false; // malformed input is a rejected signature, never an exception
    }
  }

  // ------------------------------------------------------------- NIP-01 events

  /* The canonical form is a JSON ARRAY, not the event object: field order is
   * positional and therefore cannot drift between implementations. We lean on
   * JSON.stringify rather than hand-rolling the escaping because its output is
   * already exactly NIP-01's rule — no whitespace, `\n \" \\ \r \t \b \f`
   * escaped and nothing else, non-ASCII passed through verbatim as UTF-8. Two
   * caveats worth knowing rather than discovering: JSON.stringify also escapes
   * C0 control characters as \u00xx (NIP-01's list omits them, but valid JSON
   * requires it and every signer does the same), and since ES2019 it escapes
   * lone surrogates as \udxxx instead of emitting invalid UTF-8. Both match what
   * nostr-tools produces, which is what actually signed the event.
   *
   * Returns the 64-char lowercase id, or null for anything that is not a
   * well-formed event — a relay row missing `pubkey` must not get an id. */
  async function eventId(event) {
    try {
      if (!event || typeof event !== "object") return null;
      if (!/^[0-9a-f]{64}$/.test(event.pubkey || "")) return null;
      if (!Number.isInteger(event.created_at) || !Number.isInteger(event.kind)) return null;
      if (!Array.isArray(event.tags) || typeof event.content !== "string") return null;
      const serial = JSON.stringify([
        0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
      ]);
      return toHex(await sha256(new TextEncoder().encode(serial)));
    } catch (err) {
      return null;
    }
  }

  /* BOTH halves, in this order, and neither is optional. Checking only the
   * signature lets a relay swap `content` for anything it likes as long as the
   * id it also supplies is the one that was signed; checking only the id lets it
   * hand over an event nobody signed. The id must be RECOMPUTED — the `id` field
   * on the wire is a claim, not evidence. */
  async function verifyEvent(event) {
    try {
      if (!event || typeof event !== "object") return false;
      const id = await eventId(event);
      if (!id || id !== event.id) return false;
      return await verify(event.sig, id, event.pubkey);
    } catch (err) {
      return false;
    }
  }

  // ------------------------------------------------------------------ exports

  /* verify(sigHex, msgHex, pubkeyHex) -> Promise<boolean>
   *     sigHex    128 lowercase hex chars (64 bytes)
   *     msgHex    any even-length lowercase hex, "" included (BIP-340 messages
   *               are variable length; nostr always passes a 64-char event id)
   *     pubkeyHex 64 lowercase hex chars (32-byte x-only key)
   *     Resolves false on any malformed input. Never rejects, never throws.
   * eventId(event) -> Promise<string|null>   NIP-01 id, null if not an event
   * verifyEvent(event) -> Promise<boolean>   id recomputed AND signature checked */
  globalThis.E1Schnorr = { verify, eventId, verifyEvent };
})();
