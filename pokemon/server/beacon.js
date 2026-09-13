"use strict";

/* The block-commitment beacon — the fairness core of the mint.
 *
 * The problem it solves: pack contents are a deterministic function of
 * (beacon, pack_id, remaining counts). With a fixed beacon that function is
 * computable by anyone holding the public census, so the whole 62,775-pack box
 * can be worked out offline in seconds and a buyer can simply wait for the pack
 * that holds a Genesis card. A secret beacon is no better — it moves the same
 * power to the operator, who can then grind one.
 *
 * The fix is a value neither side can predict or choose: a Bitcoin block that
 * has not been mined yet. A sale commits to a target height ABOVE the current
 * tip. When that block exists, its hash is the beacon and the pack resolves.
 * Nobody can know the cards at the moment money changes hands, and everybody
 * can verify the result afterwards against the public chain.
 *
 * The chain is read from the mint's own lnd, which is already there to take the
 * payment. That matters: a third-party block API would be a party that could
 * lie about a hash, and the whole point is to depend on nobody.
 *
 * Heights are recorded as the chain advances, so a reveal can look up the hash
 * that was committed to rather than trusting whatever the tip happens to be at
 * reveal time. */

const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");

const DDL = `
CREATE TABLE IF NOT EXISTS nutft_beacon (
  height     INTEGER PRIMARY KEY,
  block_hash TEXT NOT NULL,
  seen_at    TEXT NOT NULL
);
`;

/* One getinfo. lnd reports the tip it has actually validated, so this is the
 * mint's own view of the chain and not somebody's API. */
function getInfo(config) {
  const target = new URL(`${config.url}/v1/getinfo`);
  const transport = target.protocol === "https:" ? https : http;
  const options = {
    method: "GET",
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname,
    headers: { "Grpc-Metadata-macaroon": config.macaroon },
    timeout: config.timeoutMs || 8000,
  };
  if (target.protocol === "https:") {
    if (config.ca) options.ca = config.ca;
    if (config.insecure) options.rejectUnauthorized = false;
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let body;
        try { body = JSON.parse(text || "{}"); } catch { body = {}; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`lnd getinfo failed (${response.statusCode})`));
          return;
        }
        const height = Number(body.block_height);
        const hash = String(body.block_hash || "");
        if (!Number.isInteger(height) || height <= 0 || !/^[0-9a-f]{64}$/i.test(hash)) {
          reject(new Error("lnd getinfo returned no usable block height or hash"));
          return;
        }
        resolve({ height, hash: hash.toLowerCase() });
      });
    });
    request.on("timeout", () => request.destroy(new Error("lnd getinfo timed out")));
    request.on("error", reject);
    request.end();
  });
}

/* `confirmations` is how far ahead of the tip a sale commits. One block is
 * enough to make the value unknowable at purchase time, which is the property
 * that matters; more only makes the buyer wait longer. */
function createBeacon(options = {}) {
  const db = options.db || null;
  const lndConfig = options.lnd || null;
  const confirmations = Math.max(1, Number(options.confirmations || process.env.NUTFT_BEACON_CONFIRMATIONS || 1));
  const readInfo = options.getInfo || getInfo;
  if (db) db.exec(DDL);

  const q = db ? {
    get: db.prepare("SELECT block_hash FROM nutft_beacon WHERE height = ?"),
    put: db.prepare("INSERT OR IGNORE INTO nutft_beacon (height, block_hash, seen_at) VALUES (?, ?, ?)"),
    tip: db.prepare("SELECT height, block_hash FROM nutft_beacon ORDER BY height DESC LIMIT 1"),
  } : null;

  const record = (height, hash) => {
    if (q) q.put.run(height, hash, new Date().toISOString());
  };

  /* Reads the tip and remembers it. Called on every quote and every reveal, so
   * the record fills in as the mint is used; a dedicated poller is not needed
   * for a mint that is being bought from. */
  async function tip() {
    if (!lndConfig) throw new Error("the beacon needs a chain source: configure lnd");
    const info = await readInfo(lndConfig);
    record(info.height, info.hash);
    return info;
  }

  /* The height a sale made now must resolve against. */
  async function commitHeight() {
    const info = await tip();
    return { targetHeight: info.height + confirmations, tipHeight: info.height, confirmations };
  }

  /* The beacon for a committed height, or null while the block does not exist
   * yet. Never invents a value and never falls back to the tip: resolving
   * against a different block than the one committed to would silently hand the
   * buyer a different pack than the one they paid for. */
  async function beaconFor(targetHeight) {
    if (!Number.isInteger(targetHeight) || targetHeight <= 0) throw new Error("target height is invalid");
    const known = q ? q.get.get(targetHeight) : null;
    if (known) return known.block_hash;
    const info = await tip();
    if (info.height < targetHeight) return null;            // not mined yet
    if (info.height === targetHeight) return info.hash;     // the tip IS the block
    /* The chain moved past the committed height between polls. lnd's REST
     * surface has no historical block lookup we can rely on being enabled, so
     * say so plainly rather than substituting a hash that was not committed
     * to. The sale stays claimable once the height is recorded. */
    const late = q ? q.get.get(targetHeight) : null;
    if (late) return late.block_hash;
    throw new Error(`block ${targetHeight} passed before the mint recorded it; `
      + "the sale is still valid and can be resolved once that hash is supplied");
  }

  return { tip, commitHeight, beaconFor, confirmations, record, DDL };
}

module.exports = { createBeacon, getInfo, DDL };
