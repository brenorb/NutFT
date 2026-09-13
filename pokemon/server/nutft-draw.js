"use strict";

const crypto = require("node:crypto");

function hashParts(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest();
}

function censusHash(counts) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(counts).sort()));
  return hashParts(canonical).toString("hex");
}

function draw(counts, order, rho, slot) {
  const remaining = order.reduce((sum, id) => sum + counts[id], 0);
  if (remaining <= 0) throw new Error("pool exhausted");
  let x = Number(BigInt(`0x${hashParts(rho, slot).toString("hex")}`) % BigInt(remaining));
  for (const id of order) {
    if (x < counts[id]) {
      counts[id] -= 1;
      return id;
    }
    x -= counts[id];
  }
  throw new Error("draw failed");
}

/* SEQUENTIAL DRAW: the census order IS the queue.
 *
 * draw() above picks by hash, which is a shuffle -- right for boosters, where
 * nobody should be able to work out which pack holds what. It cannot express
 * "the first twenty-one get the good ones", because a hash has no notion of
 * first.
 *
 * This does: it takes the earliest card in the pool that still has copies. Packs
 * are issued strictly in order (state.nextPack only moves on a claim), so pack 1
 * takes the first card the census lists, pack 2 the next, and so on. A card with
 * several copies simply fills several consecutive packs.
 *
 * It is MORE checkable than the hashed draw, not less: an announced rule like
 * "the first twenty-one sets carry a Genesis card" can be verified against the
 * published census by counting, with no beacon and no hashing. The pool for a
 * sequential slot therefore keeps its census order rather than being sorted.
 */
function drawSequential(counts, order) {
  for (const id of order) {
    if (counts[id] > 0) {
      counts[id] -= 1;
      return id;
    }
  }
  throw new Error("pool exhausted");
}

function openPack(counts, pools, slots, beacon, packId, sequential) {
  const rho = hashParts(Buffer.from(beacon, "hex"), packId);
  const cards = [];
  let slot = 0;
  for (const [pool, amount] of slots) {
    for (let i = 0; i < amount; i += 1) {
      cards.push(sequential && sequential.has(pool)
        ? drawSequential(counts, pools[pool])
        : draw(counts, pools[pool], rho, slot));
      slot += 1;
    }
  }
  return cards;
}

// Unlimited PoCs draw with replacement; weights never become stock counters.
function openUnlimitedPack(weights, pools, slots) {
  return slots.flatMap(([pool, amount]) => Array.from({length:amount}, () => {
    const ids = pools[pool];
    let roll = crypto.randomInt(ids.reduce((sum,id) => sum + weights[id], 0));
    return ids.find(id => { roll -= weights[id]; return roll < 0; });
  }));
}

/* MANIFEST ISSUANCE: the census names the contents instead of describing odds.
 *
 * E1 is a box — a pack is a draw from weighted pools, and what makes it fair is
 * that the odds are published and the order was fixed before the first pack
 * opened. A G starter set is the opposite kind of object: a precon, a known
 * list chosen to be playable straight out of the box against the set beside it.
 * There is nothing to draw and therefore nothing to be fair about in that
 * sense; what has to be checkable is the CONTENT.
 *
 * So a manifest census lists every set. Set N is entry N, and an announced rule
 * like "the first twenty-one carry a Genesis card" can be verified against the
 * published file by counting — no beacon, no hashing, no trust in this code.
 *
 * counts are still decremented, because `remaining` and the commitment are what
 * the shop reads and re-hashes, and a manifest edition has to answer those
 * questions the same way a drawn one does.
 */
function openManifestPack(counts, manifest, packId) {
  const entry = manifest.get(packId);
  if (!entry) throw new Error(`no manifest entry for ${packId}`);
  for (const id of entry) {
    /* A manifest that promises more copies than the census declares would hand
       out cards the edition never printed. Louder than a silent negative. */
    if (!(counts[id] > 0)) throw new Error(`${packId} asks for ${id}, which the census has none of left`);
    counts[id] -= 1;
  }
  return [...entry];
}

function loadCensus(census) {
  const counts = {};
  const pools = {};
  const basic = [];
  for (const card of census.cards) {
    if (card.copies) {
      counts[card.id] = card.copies;
      (pools[card.pool] ||= []).push(card.id);
    } else if (card.pool === "none") {
      basic.push(card.id);
    }
  }
  /* Sorting a sequential pool would throw its meaning away: its ORDER is the
     rule. Hashed pools are still sorted, so the draw does not depend on the
     order cards happen to appear in the file. */
  const sequential = new Set(Array.isArray(census.mint.sequential) ? census.mint.sequential : []);
  /* Keyed by pack_id rather than positional, so a set keeps its identity even if
     the file is ever reordered — the id is what the mint quotes and the buyer
     later checks, and an index is not an identity. */
  const manifest = new Map();
  for (const entry of Array.isArray(census.manifest) ? census.manifest : []) {
    manifest.set(entry.pack_id, entry.cards);
  }
  for (const [pool, ids] of Object.entries(pools)) {
    if (!sequential.has(pool)) ids.sort();
  }
  return {
    counts,
    pools,
    basic,
    sequential,
    manifest,
    issuance: census.mint.issuance === "manifest" ? "manifest" : "draw",
    /* A manifest census declares no slots, because it draws nothing. Defaulting
       to an empty shape rather than throwing lets one loader serve both kinds of
       edition; openPack would still refuse a census that meant to draw and
       forgot to say from where, because every slot would be zero. */
    slots: Object.entries(census.mint.slots || {}).filter(([pool]) => pool !== "basic" || pools.basic),
  };
}

function selfTest(vector) {
  const counts = { ...vector.census };
  const pools = vector.pools;
  const slots = vector.slots;
  if (censusHash(counts) !== vector.commitment) return false;
  let state = Buffer.from(vector.commitment, "hex");
  for (const expected of vector.packs) {
    const cards = openPack(counts, pools, slots, vector.beacon, expected.pack_id);
    state = hashParts(state, expected.pack_id, vector.beacon, cards.join(","));
    if (JSON.stringify(cards) !== JSON.stringify(expected.cards) || state.toString("hex") !== expected.state) {
      return false;
    }
  }
  return JSON.stringify(counts) === JSON.stringify(vector.remaining);
}

if (require.main === module) {
  const vector = require("../cards/nutft-testvector.json");
  if (!selfTest(vector)) process.exitCode = 1;
  console.log(selfTest(vector) ? "NutFT draw vector: PASS" : "NutFT draw vector: FAIL");
}

module.exports = { censusHash, hashParts, loadCensus, openPack, openUnlimitedPack, openManifestPack, selfTest };
