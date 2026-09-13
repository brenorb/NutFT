(function (root) {
  "use strict";

  const UNIT = root.NUTFT_UNIT || "600B-E1";
  const STORE = root.NUTFT_STORE || "600b:nutft-wallet";
  const CASHU_URL = "https://esm.sh/@cashu/cashu-ts@4.7.2?bundle";
  const BIP39_URL = "https://esm.sh/@scure/bip39@2.3.0?bundle";
  const ENGLISH_URL = "https://esm.sh/@scure/bip39@2.3.0/wordlists/english.js?bundle";
  const BIP32_URL = "https://esm.sh/@scure/bip32@2.3.0?bundle";
  let cashuPromise;
  let walletCryptoPromise;
  const seedCache = new Map();
  let memory = null;
  let queue = Promise.resolve();

  const cashu = () => (cashuPromise ||= root.__cashu ? Promise.resolve(root.__cashu) : import(CASHU_URL));
  const walletCrypto = () => (walletCryptoPromise ||= root.__walletCrypto
    ? Promise.resolve(root.__walletCrypto)
    : Promise.all([import(BIP39_URL), import(ENGLISH_URL), import(BIP32_URL)]).then(([bip39, english, bip32]) => ({ ...bip39, wordlist: english.wordlist, HDKey: bip32.HDKey })));
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const bytes = (value) => Uint8Array.from(value.match(/.{2}/g).map((part) => parseInt(part, 16)));
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const digest = async (value) => hex(new Uint8Array(await root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const reference = (tag) => ({ collection_id: tag[1], asset_id: tag[2], catalog_uri: tag[3] });
  const binding = async (tag) => digest(`Cashu_NutFT_v1${canonical(reference(tag))}`);
  const validState = (state) => state && typeof state === "object" && typeof state.privateKey === "string" && typeof state.pubkey === "string" && (state.seedPhrase == null || typeof state.seedPhrase === "string") && (state.counters == null || (typeof state.counters === "object" && !Array.isArray(state.counters))) && Array.isArray(state.tokens) && state.tokens.every((token) => typeof token === "string") && (state.pending == null || typeof state.pending === "object");

  /* ALWAYS re-read storage. The cache used to be returned outright, so this
   * function could not see a write made by another TAB — and every decision
   * about `pending` is made from what it returns.
   *
   * The loss that made this urgent: the shop opens a booster pending in one
   * tab; the wallet, opened earlier, still holds a cached state with no pending;
   * a send there passes the "is a transfer already running" guard, and its
   * write() then overwrites the booster pending with the trade's. For a PAID
   * booster that destroys the outputs, so the sats are gone with nothing left to
   * claim — precisely the loss the comment in submitPending warns about, reached
   * by a route it never considered. The site actively moves players between
   * shop.html and wallet.html, so two open tabs is the normal case, not an edge.
   *
   * `memory` stays as the parse target and as the fallback for a shell with no
   * storage at all, where it is the only place a wallet can live. Re-parsing a
   * few kilobytes per call is not a cost worth a correctness hole. */
  async function read() {
    let saved = null;
    try { saved = root.localStorage.getItem(STORE); }
    catch { return memory || (memory = { privateKey: "", pubkey: "", seedPhrase: "", counters: {}, tokens: [], outgoing: [] }); }
    if (saved === null && memory) return memory;
    if (!saved) return (memory = { privateKey: "", pubkey: "", seedPhrase: "", counters: {}, tokens: [], outgoing: [] });
    try { memory = JSON.parse(saved); }
    catch { throw new Error("Wallet storage is corrupted. Preserve 600b:nutft-wallet before making changes."); }
    if (!validState(memory)) {
      memory = null;
      throw new Error("Wallet storage has an invalid shape. Preserve 600b:nutft-wallet before making changes.");
    }
    return memory;
  }

  function write(state) {
    root.localStorage.setItem(STORE, JSON.stringify(state));
    memory = state;
  }

  /* Transfers this wallet has sent and not yet marked delivered. Newest first.
     Read-only copies: a caller mutating the array must not be able to drop a
     token that is still the only claim on a card. */
  async function outgoing() {
    const state = await read();
    return (Array.isArray(state.outgoing) ? state.outgoing : []).map((entry) => ({ ...entry }));
  }

  /* Forget one, once it is known to be in the recipient's hands. Deliberately
     explicit and deliberately not automatic: this wallet cannot observe whether
     the other side claimed it, so only a person can say so. */
  async function forgetOutgoing(token) {
    const state = await read();
    const kept = (Array.isArray(state.outgoing) ? state.outgoing : []).filter((entry) => entry.token !== token);
    write({ ...state, outgoing: kept });
    return kept.length;
  }

  function locked(work) {
    if (root.navigator?.locks) return root.navigator.locks.request(STORE, work);
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  }

  async function identity(c) {
    const state = await read();
    if (!state.privateKey) {
      const wc = await walletCrypto();
      const seedPhrase = wc.generateMnemonic(wc.wordlist, 128);
      const privateKey = wc.HDKey.fromMasterSeed(wc.mnemonicToSeedSync(seedPhrase)).derive("m/129373'/10'/0'/0'/0").privateKey;
      const next = { ...state, seedPhrase, counters: {}, privateKey: hex(privateKey), pubkey: hex(c.getPubKeyFromPrivKey(privateKey)) };
      write(next);
      return next;
    }
    return state;
  }

  async function getKeyset(mintUrl, c) {
    const [infoResponse, response] = await Promise.all([fetch(`${mintUrl}/v1/info`), fetch(`${mintUrl}/v1/keys`)]);
    if (!infoResponse.ok) throw new Error(`mint capabilities unavailable (${infoResponse.status})`);
    if (!response.ok) throw new Error(`mint keys unavailable (${response.status})`);
    const info = await infoResponse.json();
    const capability = info.nuts && info.nuts[31];
    if (!capability || capability.supported !== true || !capability.versions?.includes(1) || capability.output_openings !== true || capability.p2bk !== true || capability.dleq !== true || typeof capability.catalog_issuer !== "string") {
      throw new Error("mint does not advertise the required NUT-31/P2BK/DLEQ capabilities");
    }
    if (!info.nuts?.[9]?.supported) throw new Error("mint does not advertise NUT-09 restore support");
    const data = await response.json();
    const keyset = data.keysets && data.keysets.find((entry) => entry.active !== false);
    if (!keyset || keyset.unit !== UNIT) throw new Error("mint does not advertise the 600B-E1 NutFT unit");
    return { id: keyset.id, keys: keyset.keys, catalogIssuer: capability.catalog_issuer, catalogUri: UNIT === "600B-E1" ? undefined : capability.catalog_uri };
  }

  async function getCatalog(mintUrl, c, keyset) {
    const response = await fetch(keyset.catalogUri || `${mintUrl}/nutft/catalog`);
    if (!response.ok) throw new Error(`catalog unavailable (${response.status})`);
    const catalog = await response.json();
    return verifyCatalog(keyset.catalogUri || catalog.catalog_uri, catalog, c, keyset.catalogIssuer);
  }

  const opening = (output) => ({
    secret: new TextDecoder().decode(output.secret),
    blinding_factor: output.blindingFactor.toString(16).padStart(64, "0"),
    p2pk_e: output.ephemeralE,
  });
  const savedOutput = (output) => ({ id: output.blindedMessage.id, B_: output.blindedMessage.B_, ...opening(output) });
  const restoreOutput = (saved, c) => new c.OutputData(
    { amount: c.Amount.from(1), id: saved.id, B_: saved.B_ },
    BigInt(`0x${saved.blinding_factor}`),
    new TextEncoder().encode(saved.secret),
    saved.p2pk_e,
  );
  const requestOutput = (saved) => ({ amount: 1, id: saved.id, B_: saved.B_, nutft: { secret: saved.secret, blinding_factor: saved.blinding_factor, p2pk_e: saved.p2pk_e } });
  const counterKey = (mintUrl, keysetId) => `${mintUrl}|${keysetId}`;
  const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

  async function seedContext(seedPhrase) {
    if (!seedCache.has(seedPhrase)) {
      const wc = await walletCrypto();
      const seed = wc.mnemonicToSeedSync(seedPhrase);
      seedCache.set(seedPhrase, {
        seed,
        hmacKey: root.crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      });
    }
    const context = seedCache.get(seedPhrase);
    return { seed: context.seed, hmacKey: await context.hmacKey };
  }

  async function deterministicOutput(card, state, c, keyset, counter) {
    const { seed, hmacKey } = await seedContext(state.seedPhrase);
    const derived = c.deriveSecretAndBlindingFactor(seed, keyset.id, counter);
    const eDigest = new Uint8Array(await root.crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`600B_NutFT_P2BK_E_v1${keyset.id}${counter}`)));
    const e = BigInt(`0x${hex(eDigest)}`) % SECP256K1_N;
    if (!e) throw new Error("derived invalid P2BK key");
    const { blinded, Ehex } = c.deriveP2BKBlindedPubkeys([state.pubkey], bytes(e.toString(16).padStart(64, "0")));
    const secret = JSON.stringify(["P2PK", {
      nonce: hex(derived.secret),
      data: blinded[0],
      tags: [["nutft", "1", card.collection_id, card.asset_id, card.catalog_uri, card.asset_binding]],
    }]);
    const encoded = new TextEncoder().encode(secret);
    const r = BigInt(`0x${hex(derived.blindingFactor)}`);
    const B_ = c.blindMessage(encoded, r).B_.toHex(true);
    return new c.OutputData({ amount: c.Amount.from(1), id: keyset.id, B_ }, r, encoded, Ehex);
  }

  async function outputsFor(cards, mintUrl, state, c, keyset) {
    if (!state.seedPhrase) {
      return { outputs: cards.map((card) => c.OutputData.createSingleP2PKData({
        pubkey: state.pubkey,
        blindKeys: true,
        additionalTags: [["nutft", "1", card.collection_id, card.asset_id, card.catalog_uri, card.asset_binding]],
      }, 1, keyset.id)), counters: state.counters || {} };
    }
    const catalog = await getCatalog(mintUrl, c, keyset);
    const key = counterKey(mintUrl, keyset.id);
    const counters = { ...(state.counters || {}) };
    let counter = Number(counters[key] || 0);
    const outputs = [];
    for (const card of cards) {
      const index = catalog.assets.findIndex((asset) => asset.asset_id === card.asset_id);
      if (index < 0) throw new Error(`catalog has no asset ${card.asset_id}`);
      counter += (index - (counter % catalog.assets.length) + catalog.assets.length) % catalog.assets.length;
      outputs.push({ card, counter });
      counter += 1;
    }
    counters[key] = counter;
    return { outputs: await Promise.all(outputs.map((item) => deterministicOutput(item.card, state, c, keyset, item.counter))), counters };
  }

  async function finishPending(state, pending, response, c, keyset) {
    if (pending.type === "booster") {
      const outputs = pending.outputs.map((saved) => restoreOutput(saved, c));
      const proofs = outputs.map((output, index) => output.toProof({ ...response.signatures[index], amount: c.Amount.from(1) }, keyset));
      for (let i = 0; i < proofs.length; i += 1) {
        const tag = c.getTag(proofs[i].secret, "nutft");
        if (!tag || tag.length !== 5 || tag[0] !== "1" || tag[2] !== response.cards[i].asset_id || tag[4] !== response.cards[i].asset_binding || await binding(tag) !== tag[4] || !c.hasValidDleq(proofs[i], keyset, { require: true }) || proofs[i].amount.toString() !== "1" || !proofs[i].p2pk_e) {
          throw new Error(`wallet rejected issued proof ${i + 1}`);
        }
      }
      const token = encodeToken(c, { mint: pending.mintUrl, unit: response.unit, proofs });
      write({ ...state, tokens: [...state.tokens, token], pending: null });
      return { ...response, token, proofs };
    }
    const all = readableProofs(state, keyset, c);
    const index = all.findIndex((proof) => proof.secret === pending.input_secret);
    if (index < 0) throw new Error("pending transfer input is no longer in this wallet");
    const output = restoreOutput(pending.outputs[0], c);
    const proof = output.toProof({ ...response.signature, amount: c.Amount.from(1) }, keyset);
    const oldTag = c.getTag(all[index].secret, "nutft");
    const newTag = c.getTag(proof.secret, "nutft");
    if (!newTag || newTag[4] !== oldTag[4] || !proof.p2pk_e || !c.hasValidDleq(proof, keyset, { require: true })) throw new Error("wallet rejected replacement proof");
    const remaining = all.filter((_, itemIndex) => itemIndex !== index);
    /* CARRY THE UNREADABLE TOKENS THROUGH. This line rebuilds the whole token
       list out of the proofs it could read, so anything it could not read would
       be dropped on the floor by a write it never mentioned. That did not
       matter while an unreadable token threw; it matters now that one is
       tolerated, because those tokens are the only record a person has of cards
       bought from a mint this one cannot open. Losing them silently, during a
       trade of an unrelated card, would be the worst kind of data loss: quiet,
       and triggered by something that looked unrelated. */
    const { opaque } = splitTokens(state, keyset, c);
    const rebuilt = remaining.length
      ? [encodeToken(c, { mint: pending.mintUrl, unit: response.unit, proofs: remaining })]
      : [];
    const token = encodeToken(c, { mint: pending.mintUrl, unit: response.unit, proofs: [proof] });
    /* PERSIST THE OUTGOING TOKEN. It is the only thing that can ever claim this
       card: the sender no longer holds it, the recipient does not have it yet,
       and it is locked to a key only the recipient has. Returning it and writing
       nothing meant the single copy lived in whatever variable the caller kept —
       so a reload, a closed tab or a crash between the trade and the hand-off
       destroyed the card outright. Nobody could claim it, ever. That is not a
       hypothetical: it happened to a card during development.
       Kept until the sender says it was delivered. They are a few hundred bytes
       each, and an undelivered transfer nobody can find is the worse trade. */
    const outgoing = [
      { token, asset_id: response.asset_id || null, at: new Date().toISOString() },
      ...(Array.isArray(state.outgoing) ? state.outgoing : []),
    ];
    write({ ...state, tokens: [...rebuilt, ...opaque], outgoing, pending: null });
    return { ...response, token, proof };
  }

  /* "not settled yet" is not a rejection, it is a wait. Treating it as one was
     dangerous: the pending outputs were discarded, and a buyer who then paid had
     nothing left to claim with — their sats gone and no way to ask again. */
  const AWAITING_PAYMENT = /not settled yet|is still sealed|not mined yet/i;

  async function submitPending(state, c, keyset) {
    let pending = state.pending;
    if (pending.type === 'booster' && !pending.outputs.length && pending.body.purchase_id) {
      const response = await postSigned(`${pending.mintUrl}/nutft/purchase`, {
        idempotency_key:pending.body.purchase_id,...(pending.body.deck_id ? {deck_id:pending.body.deck_id} : {}),
      });
      if (!response.ok) throw new Error(response.detail || `purchase unavailable (${response.status})`);
      const opened = await response.json();
      if (opened.purchase_id !== pending.body.purchase_id || opened.status !== 'purchased' || !Array.isArray(opened.cards)) throw new Error('invalid purchase receipt');
      const prepared = await outputsFor(opened.cards,pending.mintUrl,state,c,keyset);
      const outputs = prepared.outputs.map(savedOutput);
      pending = {...pending,outputs,body:{...pending.body,pack_id:opened.pack_id,state:opened.state,outputs:outputs.map(requestOutput)}};
      state = {...state,counters:prepared.counters,pending};write(state);
    }
    if (pending.type === "booster" && !pending.outputs.length && pending.body.payment_hash) {
      const response = await fetch(`${pending.mintUrl}/nutft/reveal?payment_hash=${encodeURIComponent(pending.body.payment_hash)}`);
      if (!response.ok) throw new Error(`sealed booster unavailable (${response.status})`);
      const opened = await response.json();
      if (!Array.isArray(opened.cards)) {
        const wait = new Error(opened.note || "the booster is still sealed");
        wait.awaitingPayment = true;
        throw wait;
      }
      const prepared = await outputsFor(opened.cards, pending.mintUrl, state, c, keyset);
      const outputs = prepared.outputs.map(savedOutput);
      pending = { ...pending, outputs, body: { ...pending.body, pack_id: opened.pack_id, state: opened.state, outputs: outputs.map(requestOutput) } };
      state = { ...state, counters: prepared.counters, pending };
      write(state);
    }
    const path = pending.type === "booster" ? "/nutft/booster" : "/nutft/trade";
    /* Signed only if the mint refuses without one, and retried BEFORE the
       pending is discarded below — an early-access refusal must never cost a
       buyer their outputs, least of all on a mint they have already paid. */
    const response = await postSigned(`${pending.mintUrl}${path}`, pending.body);
    if (!response.ok) {
      const detail = response.detail || `mint refused ${pending.type} (${response.status})`;
      if (AWAITING_PAYMENT.test(detail)) {
        /* Keep the pending exactly as it is. The same outputs must be resubmitted
           once the invoice settles, and the idempotency key makes that safe. */
        const wait = new Error(detail);
        wait.awaitingPayment = true;
        throw wait;
      }
      // A committed purchase still owns its cards, even if delivery is refused temporarily.
      if (!pending.body.purchase_id) write({ ...state, pending: null });
      throw new Error(detail);
    }
    return finishPending(state, pending, await response.json(), c, keyset);
  }

  function encodeToken(c, value) {
    // cashu-ts browser Base64 chunks introduce padding inside tokens over 32 KiB.
    // Use its binary serializer and encode the entire payload once.
    if (!root.btoa) return c.getEncodedToken(value);
    const bytes = c.getEncodedTokenBinary(value).slice(5); // strip crawB header
    return "cashuB" + root.btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function recoverPending() {
    const state = await read();
    if (!state.pending) return null;
    const c = await cashu();
    return submitPending(state, c, await getKeyset(state.pending.mintUrl, c));
  }

  /* Resubmit until the mint stops saying "not yet". The mint is the authority on
     settlement, so there is nothing else to ask and no state to guess at. */
  async function awaitSettlement(state, c, keyset, opts) {
    const deadline = Date.now() + Number(opts.timeoutMs || 900_000);
    let delay = 1500;
    for (;;) {
      try {
        return await submitPending(state, c, keyset);
      } catch (error) {
        if (!error.awaitingPayment) throw error;
        if (Date.now() > deadline) {
          /* The pending survives on purpose: the invoice may still settle, and
             recoverPending() can finish the sale later. */
          throw new Error("the invoice was not paid in time — reopen the shop to finish this booster");
        }
        if (typeof opts.onWaiting === "function") opts.onWaiting();
        await new Promise((done) => setTimeout(done, delay));
        delay = Math.min(delay * 1.4, 8000);
      }
    }
  }

  /* NIP-98: prove to the mint that we hold a key it will recognise.
   *
   * Only used when the mint refuses an anonymous request — see requestQuote.
   * Signing every purchase would pop the extension on every booster and hand
   * the mint an identity it does not need for an open sale. Early access is the
   * one case where the mint genuinely has to know who is asking. */
  async function nip98Header(url, method) {
    const signer = root.nostr;
    if (!signer || typeof signer.signEvent !== "function") return null;
    const unsigned = {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [["u", url], ["method", method]],
    };
    const signed = await signer.signEvent(unsigned);
    if (!signed || !signed.sig) return null;
    /* THE PAGE MUST NOT SAY "signed out" WHILE ACTING AS YOU.
     *
     * The signer is read straight off the extension, deliberately — that is what
     * NIP-98 needs. But the site keeps its own idea of who is signed in under
     * 600b:pubkey, and the two came apart: after a sign-out the nav chip read
     * "Sign in with Nostr", the shop offered to sign you in, and pressing Buy
     * still completed a purchase under the extension's key. Nothing silent
     * happened — the extension asks — but the page claimed one thing and did
     * another, and on a one-per-key mint that spends somebody's allocation
     * under a name the page never showed.
     *
     * So the key that just signed is adopted. Whoever bought is now who the
     * page says bought. Wrapped because storage can refuse in private mode, and
     * a purchase must not fail over a display detail. */
    try {
      if (/^[0-9a-f]{64}$/i.test(signed.pubkey || "")) {
        root.localStorage.setItem("600b:pubkey", signed.pubkey);
      }
    } catch (error) { /* private mode: the sale still stands */ }
    /* btoa is byte-wise; a non-ASCII byte anywhere in the event would throw.
       Encode as UTF-8 first so the header survives any content the signer adds. */
    const bytes = new TextEncoder().encode(JSON.stringify(signed));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Nostr ${root.btoa(binary)}`;
  }

  /* Ask for a quote anonymously, and only reach for the signer if the mint says
     this is an early-access sale. The mint's own words are carried through on
     failure: "this key is not on the list yet" tells a buyer what to do, where
     a bare 403 tells them nothing. */
  async function requestQuote(mintUrl, deckId) {
    const target = new URL(`${mintUrl}/nutft/quote${deckId === undefined ? '' : '?deck=' + encodeURIComponent(deckId)}`, root.location ? root.location.href : undefined).href;
    const read = async (response) => {
      if (response.ok) return { quote: await response.json() };
      let reason = `booster quote unavailable (${response.status})`;
      try {
        const body = await response.json();
        if (body && body.error) reason = body.error;
      } catch { /* not JSON: keep the status line */ }
      return { reason };
    };

    let attempt = await read(await fetch(target));
    if (attempt.quote) return attempt.quote;

    if (/early access/i.test(attempt.reason)) {
      let header = null;
      let declined = false;
      try { header = await nip98Header(target, "GET"); } catch { declined = true; }
      if (!header) throw new Error(earlyAccessAdvice(attempt.reason, declined));
      attempt = await read(await fetch(target, { headers: { Authorization: header } }));
      if (attempt.quote) return attempt.quote;
    }
    throw new Error(attempt.reason);
  }

  /* Read the mint's own refusal out of a failed response -- or THROW, because
     anything that is not the mint refusing must not be treated as one.
   *
   * submitPending discards the pending on a refusal, since a refusal means
   * those outputs will never be signed. A proxy's HTML 502, a captive-portal
   * page or a truncated body is NOT a refusal: the mint may well have accepted,
   * and on a trade the input proof is already spent, so the outputs have to
   * survive for a retry under the same idempotency key.
   *
   * Found twice independently -- once here, once in review -- which is the best
   * evidence a bug of this shape gets. */
  async function refusal(response) {
    let body;
    try { body = await response.json(); }
    catch {
      /* A proxy's HTML 502 is not the mint refusing the request. Keep the
         pending bearer outputs so the same idempotent request can be retried. */
      throw new Error(`mint gateway returned a non-JSON error (${response.status}); request preserved for retry`);
    }
    if (!body || typeof body.error !== "string" || !body.error) {
      throw new Error(`mint returned an invalid error response (${response.status}); request preserved for retry`);
    }
    return body.error;
  }

  /* POST a body, and if the mint answers "early access", sign a NIP-98 proof
     and send it once more. The mint's own words are carried through: they tell a
     buyer whether to install an extension, switch keys, or simply wait. */
  async function postSigned(target, body) {
    const url = new URL(target, root.location ? root.location.href : undefined).href;
    const send = (header) => fetch(url, {
      method: "POST",
      headers: header
        ? { "content-type": "application/json", Authorization: header }
        : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const first = await send(null);
    if (first.ok) return first;
    const detail = await refusal(first);
    if (!/early access/i.test(detail)) return { ok: false, status: first.status, detail };

    let header = null;
    let declined = false;
    try { header = await nip98Header(url, "POST"); } catch { declined = true; }
    if (!header) {
      return { ok: false, status: first.status, detail: earlyAccessAdvice(detail, declined) };
    }
    const second = await send(header);
    if (second.ok) return second;
    return { ok: false, status: second.status, detail: await refusal(second) };
  }

  /* Telling someone to install what they already have is worse than saying
     nothing, so a declined prompt gets its own sentence. */
  const earlyAccessAdvice = (detail, declined) => {
    if (declined) {
      return "early access: your nostr extension did not sign the request — the signature is "
        + "what proves your key is on the list, so the sale cannot go ahead without it";
    }
    return /sign the request/i.test(detail)
      ? "early access: this sale is open to a few keys first — install a nostr extension "
        + "and sign in with a key that is on the list"
      : detail;
  };

  async function buyBoosterUnlocked(mintUrl, opts = {}) {
    const c = await cashu();
    let state = await identity(c);
    if (state.pending) {
      if (state.pending.type === 'booster' && state.pending.body.deck_id !== opts.deckId) throw new Error('finish the pending purchase before choosing another product');
      const keysetForPending = await getKeyset(state.pending.mintUrl, c);
      return awaitSettlement(state, c, keysetForPending, opts);
    }
    const keyset = await getKeyset(mintUrl, c);
    const quote = await requestQuote(mintUrl, opts.deckId);
    const prepared = Array.isArray(quote.cards) ? await outputsFor(quote.cards, mintUrl, state, c, keyset) : { outputs: [], counters: state.counters || {} };
    const saved = prepared.outputs.map(savedOutput);
    const purchaseId = quote.purchase_required ? hex(root.crypto.getRandomValues(new Uint8Array(32))) : null;
    const pending = { type: "booster", mintUrl, outputs: saved, body: {
      idempotency_key: purchaseId || root.crypto.randomUUID(),
      ...(purchaseId ? {purchase_id:purchaseId} : {}),
      pack_id: quote.pack_id,
      ...(quote.deck_id ? {deck_id:quote.deck_id} : {}),
      state: quote.state,
      /* Absent on a free mint, required on a paid one. Carried inside the
         pending so a resumed sale claims the invoice it was quoted against. */
      payment_hash: quote.payment_hash,
      outputs: saved.map(requestOutput),
    } };
    state = { ...state, counters: prepared.counters, pending };
    write(state);
    /* A paid mint hands back an invoice the buyer settles in their own wallet.
       Show it, then wait — nothing here ever touches their credentials. */
    if (quote.paid && quote.payment_request && typeof opts.onInvoice === "function") {
      opts.onInvoice({
        paymentRequest: quote.payment_request,
        paymentHash: quote.payment_hash,
        priceMsat: quote.price_msat,
        testMint: Boolean(quote.test_mint),
      });
    }
    return awaitSettlement(state, c, keyset, opts);
  }

  const buyBooster = (mintUrl, opts) => locked(() => buyBoosterUnlocked(mintUrl, opts || {}));
  const buyDeck = (mintUrl, deckId) => locked(() => {
    if (typeof deckId !== 'string' || !/^[a-z0-9-]+$/.test(deckId)) throw new Error('invalid deck id');
    return buyBoosterUnlocked(mintUrl, {deckId});
  });

  /* Decode PER TOKEN, and survive one that cannot be decoded.
   *
   * This used to be a bare flatMap over getDecodedToken, so a single token this
   * mint cannot read threw and took the WHOLE wallet with it. That is not a
   * rare state: a token minted before a mint's keyset rotated, or one bought
   * from a different mint entirely — staging, say — can never decode against
   * this keyset, ever. One of those made snapshot() throw, which blanked the
   * wallet page, permanently dropped the Stack Builder out of OG mode, and made
   * every trade impossible. The only escape was clearing storage, which throws
   * away every good card along with the bad one.
   *
   * A card this mint cannot read is not the same as a card that does not exist.
   * The unreadable ones are counted and handed back so the page can say how
   * many there are and where they probably came from, instead of a wallet full
   * of cards silently reporting nothing at all. */
  async function claimBoosterUnlocked(mintUrl, paymentHash, opts = {}) {
    const c = await cashu();
    let state = await identity(c);
    if (state.pending) {
      if (state.pending.body.payment_hash !== paymentHash) throw new Error("finish the pending wallet operation before claiming another booster");
      return awaitSettlement(state, c, await getKeyset(state.pending.mintUrl, c), opts);
    }
    const keyset = await getKeyset(mintUrl, c);
    const pending = { type: "booster", mintUrl, outputs: [], body: {
      idempotency_key: root.crypto.randomUUID(), pack_id: null, state: null,
      payment_hash: paymentHash, outputs: [],
    } };
    state = { ...state, pending };
    write(state);
    return awaitSettlement(state, c, keyset, opts);
  }

  const claimBooster = (mintUrl, paymentHash, opts) => locked(() => claimBoosterUnlocked(mintUrl, paymentHash, opts || {}));

  async function decodeTokens(mintUrl) {
    const c = await cashu();
    const state = await read();
    const keyset = await getKeyset(mintUrl, c);
    const list = [];
    const unreadable = [];
    for (const token of state.tokens) {
      try {
        list.push(...c.getDecodedToken(token, [keyset.id]).proofs);
      } catch (error) {
        unreadable.push({ token, error: error && error.message ? error.message : String(error) });
      }
    }
    return { proofs: list, unreadable };
  }

  async function proofs(mintUrl) {
    return (await decodeTokens(mintUrl)).proofs;
  }

  /* The synchronous half of the same rule, for the paths that already hold a
     state and a keyset.
   *
   * Every one of these asks "what does this wallet hold", and every one of them
   * used its own bare flatMap. Fixing only decodeTokens left the TRADE path
   * still throwing on a dead token — which is the worst place for it, because a
   * trade is the operation a person reaches for to move a card OUT of a wallet
   * they cannot otherwise use. It was found by trying a trade with one dead
   * token in storage, not by reading the code. */
  function splitTokens(state, keyset, c) {
    const proofs = [];
    const opaque = [];
    for (const token of state.tokens) {
      try { proofs.push(...c.getDecodedToken(token, [keyset.id]).proofs); }
      catch { opaque.push(token); }
    }
    return { proofs, opaque };
  }

  const readableProofs = (state, keyset, c) => splitTokens(state, keyset, c).proofs;

  async function verifyCatalog(catalogUri, catalog, c, issuerExpected) {
    const { issuer_pubkey: issuer, signature, ...payload } = catalog || {};
    const digestHex = await digest(canonical(payload));
    if (!catalog || catalog.collection_id !== UNIT || (catalog.catalog_uri && catalog.catalog_uri !== catalogUri) || issuer !== issuerExpected || !signature || !c.schnorrVerifyDigest(signature, digestHex, issuer)) {
      throw new Error("catalog signature or collection validation failed");
    }
    if (catalog.schema === "pokemon-nutft-catalog-v1") {
      const hash = await digest(JSON.stringify(catalog));
      if (!catalogUri.endsWith('/' + hash)) throw new Error("Blossom catalog hash mismatch");
      return { ...catalog, assets: await Promise.all(catalog.assets.map(async asset => {
        const ref = { collection_id: UNIT, asset_id: asset.id, catalog_uri: catalogUri };
        return { ...asset, ...ref, asset_binding: await digest(`Cashu_NutFT_v1${canonical(ref)}`) };
      })) };
    }
    return catalog;
  }

  async function inspectProof(mintUrl, proof, c, keyset, catalogs) {
    const parsed = JSON.parse(proof.secret);
    const tags = parsed?.[1]?.tags?.filter((tag) => Array.isArray(tag) && tag[0] === "nutft") || [];
    const tag = tags[0] && tags[0].slice(1);
    if (JSON.stringify(parsed) !== proof.secret || tags.length !== 1 || !tag || tag.length !== 5 || tag[0] !== "1" || proof.id !== keyset.id || proof.amount.toString() !== "1" || !proof.p2pk_e || !c.hasValidDleq(proof, keyset, { require: true }) || await binding(tag) !== tag[4]) throw new Error("invalid NutFT proof");
    let catalog = catalogs.get(tag[3]);
    if (!catalog) {
      const catalogResponse = await fetch(tag[3]);
      if (!catalogResponse.ok) throw new Error(`catalog unavailable (${catalogResponse.status})`);
      catalog = await catalogResponse.json();
      catalog = await verifyCatalog(tag[3], catalog, c, keyset.catalogIssuer);
      catalogs.set(tag[3], catalog);
    }
    const asset = catalog.assets.find((card) => card.asset_id === tag[2]);
    if (!asset || asset.asset_binding !== tag[4]) throw new Error(`catalog has no verified asset ${tag[2]}`);
    const stateResponse = await fetch(`${mintUrl}/v1/checkstate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Ys: [c.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true)] }) });
    if (!stateResponse.ok) throw new Error(`proof state unavailable (${stateResponse.status})`);
    return { proof, tag, asset, state: (await stateResponse.json()).states[0].state };
  }

  async function snapshot(mintUrl) {
    /* A pending the mint refuses must not hide the cards that are fine. This ran
       uncaught, so one stuck transfer threw before a single proof was inspected
       and the whole collection vanished behind an error — the same shape as the
       unreadable-token bug, one level up. The recovery is still attempted, and
       the page has its own route to retry it. */
    try { await locked(recoverPending); } catch { /* reported by recoverPending's own caller */ }
    const c = await cashu();
    const walletState = await read();
    const keyset = await getKeyset(mintUrl, c);
    const catalogs = new Map();
    const owned = [];
    const spent = [];
    const invalid = [];
    const { proofs: readable, unreadable } = await decodeTokens(mintUrl);
    for (const proof of readable) {
      try {
        const item = await inspectProof(mintUrl, proof, c, keyset, catalogs);
        if (!c.maybeDeriveP2BKPrivateKeys(walletState.privateKey, proof).length) throw new Error("proof is not addressed to this wallet");
        (item.state === "SPENT" ? spent : owned).push(item);
      } catch (error) {
        invalid.push({ proof, error: error.message });
      }
    }
    /* `unreadable` is deliberately its own bucket and not folded into
       `invalid`: an invalid proof is one this mint HAS an opinion about and
       rejects, while an unreadable token is one it cannot even open. A page
       that conflates them tells a buyer their card is bad when the truth is
       that they are looking at the wrong mint. */
    return { catalog: catalogs.values().next().value || null, owned, spent, invalid, unreadable };
  }

  async function tradeProofUnlocked(mintUrl, secret, recipientPubkey) {
    const c = await cashu();
    let state = await identity(c);
    /* REFUSE, do not silently finish something else. This used to call
       submitPending and hand back THAT token — so asking to send card X while an
       older transfer was unfinished completed the older trade and returned a
       token for card Y. The caller had every reason to believe it had just sent
       X. Finishing a pending is a deliberate act with its own entry point. */
    if (state.pending) {
      throw new Error("finish the transfer already in progress before starting another");
    }
    const keyset = await getKeyset(mintUrl, c);
    const all = readableProofs(state, keyset, c);
    const index = all.findIndex((proof) => proof.secret === secret);
    if (index < 0) throw new Error("card is not in this wallet");
    const oldProof = all[index];
    const keys = c.maybeDeriveP2BKPrivateKeys(state.privateKey, oldProof);
    if (!keys.length) throw new Error("wallet cannot derive the P2BK spending key");
    const signed = c.signP2PKProof(oldProof, keys[0]);
    const tag = c.getTag(oldProof.secret, "nutft");
    if (typeof recipientPubkey !== "string") throw new Error("recipient P2BK public key is required");
    c.pointFromHex(recipientPubkey);
    let output;
    let counters = state.counters || {};
    if (state.seedPhrase && recipientPubkey === state.pubkey) {
      const prepared = await outputsFor([{
        collection_id: tag[1], asset_id: tag[2], catalog_uri: tag[3], asset_binding: tag[4],
      }], mintUrl, state, c, keyset);
      [output] = prepared.outputs;
      counters = prepared.counters;
    } else {
      output = c.OutputData.createSingleP2PKData({
        pubkey: recipientPubkey,
        blindKeys: true,
        additionalTags: [["nutft", ...tag]],
      }, 1, keyset.id);
    }
    const saved = savedOutput(output);
    const pending = { type: "trade", mintUrl, input_secret: oldProof.secret, outputs: [saved], body: { idempotency_key: root.crypto.randomUUID(), inputs: c.serializeProofs([signed]), outputs: [requestOutput(saved)] } };
    state = { ...state, counters, pending };
    write(state);
    return submitPending(state, c, keyset);
  }

  const tradeProof = (mintUrl, secret, recipientPubkey) => locked(() => tradeProofUnlocked(mintUrl, secret, recipientPubkey));

  async function destinationUnlocked() {
    const c = await cashu();
    return (await identity(c)).pubkey;
  }

  const destination = () => locked(destinationUnlocked);

  async function importTokenUnlocked(mintUrl, token) {
    const c = await cashu();
    let state = await identity(c);
    if (state.pending) await submitPending(state, c, await getKeyset(state.pending.mintUrl, c));
    state = await read();
    const keyset = await getKeyset(mintUrl, c);
    const decoded = c.getDecodedToken(token, [keyset.id]);
    if (decoded.mint !== mintUrl || decoded.unit !== UNIT || !decoded.proofs.length) throw new Error("token mint, unit, or proofs are invalid");
    /* The token being imported above may still throw — a caller pasting a
       broken token deserves to hear so. But the wallet it is landing in must
       not: a dead token already in storage cannot be allowed to block an
       import, or a person is stuck with it forever. */
    const existing = new Set(readableProofs(state, keyset, c).map((proof) => proof.secret));
    const incoming = new Set();
    const catalogs = new Map();
    for (const proof of decoded.proofs) {
      if (existing.has(proof.secret)) throw new Error("token is already in this wallet");
      if (incoming.has(proof.secret)) throw new Error("token contains a duplicate proof");
      incoming.add(proof.secret);
      const item = await inspectProof(mintUrl, proof, c, keyset, catalogs);
      if (item.state !== "UNSPENT" || !c.maybeDeriveP2BKPrivateKeys(state.privateKey, proof).length) throw new Error("token is spent or not addressed to this wallet");
    }
    write({ ...state, tokens: [...state.tokens, token] });
    /* Received proofs were made by the sender, so their random output material
       cannot be recovered from this wallet's NUT-13 seed. Reissue each one to
       our own destination immediately; the old token remains stored if a
       request fails, and the normal pending/outgoing records cover a lost
       response after the mint spends it. */
    if (state.seedPhrase) {
      for (const proof of decoded.proofs) {
        try {
          const moved = await tradeProofUnlocked(mintUrl, proof.secret, state.pubkey);
          const current = await read();
          write({
            ...current,
            tokens: [...current.tokens, moved.token],
            outgoing: (current.outgoing || []).filter((entry) => entry.token !== moved.token),
          });
        } catch { break; }
      }
    }
    return decoded.proofs.length;
  }

  const importToken = (mintUrl, token) => locked(() => importTokenUnlocked(mintUrl, token));

  async function recoveryPhraseUnlocked() {
    const c = await cashu();
    const phrase = (await identity(c)).seedPhrase;
    if (!phrase) throw new Error("this wallet predates recovery phrases; keep using its backup file");
    return phrase;
  }

  const recoveryPhrase = () => locked(recoveryPhraseUnlocked);

  async function restoreSeedUnlocked(mintUrl, phrase) {
    const current = await read();
    if (current.tokens.length || current.pending || (current.outgoing || []).length) {
      throw new Error("recovery requires an empty wallet so bearer assets are not overwritten");
    }
    const wc = await walletCrypto();
    const seedPhrase = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!wc.validateMnemonic(seedPhrase, wc.wordlist)) throw new Error("recovery phrase is not a valid 12-word BIP39 phrase");
    const seed = wc.mnemonicToSeedSync(seedPhrase);
    const c = await cashu();
    const privateKey = wc.HDKey.fromMasterSeed(seed).derive("m/129373'/10'/0'/0'/0").privateKey;
    const state = {
      privateKey: hex(privateKey), pubkey: hex(c.getPubKeyFromPrivKey(privateKey)), seedPhrase,
      counters: {}, tokens: [], outgoing: [], pending: null,
    };
    const keyset = await getKeyset(mintUrl, c);
    const catalog = await getCatalog(mintUrl, c, keyset);
    const recovered = [];
    let counter = 0;
    let emptyBatches = 0;
    let lastCounterWithSignature = -1;
    const gapBatches = Math.max(3, Math.ceil(catalog.assets.length / 100));

    while (emptyBatches < gapBatches) {
      const candidates = await Promise.all(Array.from({ length: 100 }, (_, i) => {
        const at = counter + i;
        return deterministicOutput(catalog.assets[at % catalog.assets.length], state, c, keyset, at);
      }));
      const response = await fetch(`${mintUrl}/v1/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputs: candidates.map((output) => ({
          amount: 1, id: output.blindedMessage.id, B_: output.blindedMessage.B_,
        })) }),
      });
      if (!response.ok) throw new Error(`signature restore failed (${response.status})`);
      const restored = await response.json();
      if (!Array.isArray(restored.outputs) || !Array.isArray(restored.signatures) || restored.outputs.length !== restored.signatures.length) {
        throw new Error("mint returned an invalid NUT-09 restore response");
      }
      const signatures = new Map(restored.outputs.map((output, index) => [output.B_, restored.signatures[index]]));
      const batch = [];
      for (let i = 0; i < candidates.length; i += 1) {
        const signature = signatures.get(candidates[i].blindedMessage.B_);
        if (!signature) continue;
        lastCounterWithSignature = counter + i;
        const proof = candidates[i].toProof({ ...signature, amount: c.Amount.from(signature.amount) }, keyset);
        if (!proof.p2pk_e || !c.hasValidDleq(proof, keyset, { require: true }) || !c.maybeDeriveP2BKPrivateKeys(state.privateKey, proof).length) {
          throw new Error("mint returned an invalid restored NutFT proof");
        }
        batch.push(proof);
      }
      if (batch.length) {
        const Ys = batch.map((proof) => c.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true));
        const checked = await fetch(`${mintUrl}/v1/checkstate`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Ys }),
        });
        if (!checked.ok) throw new Error(`restored proof state unavailable (${checked.status})`);
        const states = (await checked.json()).states;
        batch.forEach((proof, index) => { if (states[index]?.state === "UNSPENT") recovered.push(proof); });
        emptyBatches = 0;
      } else {
        emptyBatches += 1;
      }
      counter += 100;
    }

    state.counters[counterKey(mintUrl, keyset.id)] = lastCounterWithSignature + 1;
    if (recovered.length) state.tokens = [encodeToken(c, { mint: mintUrl, unit: UNIT, proofs: recovered })];
    write(state);
    return recovered.length;
  }

  const restoreSeed = (mintUrl, phrase) => locked(() => restoreSeedUnlocked(mintUrl, phrase));

  async function exportBackup() {
    const state = await read();
    return JSON.stringify({ format: "600b-nutft-wallet-v1", wallet: state }, null, 2);
  }

  async function restoreBackupUnlocked(text) {
    let backup;
    try { backup = JSON.parse(text); }
    catch { throw new Error("wallet backup is not valid JSON"); }
    if (backup?.format !== "600b-nutft-wallet-v1" || !validState(backup.wallet)) throw new Error("wallet backup has an invalid format");
    const current = await read();
    if (current.tokens.length || current.pending) throw new Error("restore requires an empty wallet so existing bearer assets are not overwritten");
    write(backup.wallet);
    return backup.wallet.tokens.length;
  }

  const restoreBackup = (text) => locked(() => restoreBackupUnlocked(text));

  async function revealDeck(mintUrl, secrets, player, room) {
    return locked(async () => {
      const c = await cashu();
      const state = await identity(c);
      const all = await proofs(mintUrl);
      if (!Array.isArray(secrets) || secrets.length !== 60 || new Set(secrets).size !== 60) throw new Error("Choose 60 distinct owned cards");
      const inputs = secrets.map(secret => {
        const proof = all.find(p => p.secret === secret);
        if (!proof) throw new Error("Card is not in this wallet");
        return proof;
      });
      const authorizations = inputs.map(proof => {
        const keys = c.maybeDeriveP2BKPrivateKeys(state.privateKey, proof);
        if (!keys.length) throw new Error("Card is not addressed to this wallet");
        return c.schnorrSignMessage(canonical({ domain: "NutFT-play-v1", player, room, secret: proof.secret }), keys[0]);
      });
      const res = await fetch(`${mintUrl}/nutft/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ player, room, inputs: c.serializeProofs(inputs), authorizations }) });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    });
  }

  root.NutFTWallet = { revealDeck, buyBooster, buyDeck, claimBooster, snapshot, tradeProof, importToken, destination, recoverPending, outgoing, forgetOutgoing, recoveryPhrase, restoreSeed, exportBackup, restoreBackup, read, cashu, hex, bytes };
})(globalThis);
