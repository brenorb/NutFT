import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as cashu from '@cashu/cashu-ts';
import * as bip39 from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {HDKey} from '@scure/bip32';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {DatabaseSync}=require('node:sqlite');
const {createPokemonServer}=require('../../server/pokemon.js');
const {createNutftMint}=require('../../server/nutft-mint.js');

/* BoosterSale.tla PaidBuyerCanClaim, replayed on the real mint: Alice pays
   and does not claim within the grace window, Bob is quoted the same pack,
   Alice claims it, then Bob pays. Bob's settled invoice must still buy a pack. */
test('a paid invoice whose pack was sold after its grace lapsed still buys the next pack',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pokemon-paid-'));
  const free=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  const mapped=(url,options)=>fetch(String(url).replace('http://pokemon.test',`http://127.0.0.1:${free.server.address().port}`),options);
  const issuer=new DatabaseSync(join(dir,'mint.db')).prepare('SELECT value FROM pokemon_meta WHERE key=?').get('issuer').value;
  const manifest=await(await mapped(free.catalogUri)).json();
  const settled=new Set();
  const funding={name:'mock',virtual:true,
    async createInvoice({amountMsat}){const paymentHash=crypto.randomBytes(32).toString('hex');return {paymentRequest:`lnbcrt${amountMsat}`,paymentHash};},
    async isSettled(paymentHash){return settled.has(paymentHash);}};
  const mint=createNutftMint({db:new DatabaseSync(':memory:'),censusPath:join(dir,'census.json'),collectionId:'POKEMON-BASE-POC',
    catalogUri:free.catalogUri,catalogPrivateKey:issuer,catalogManifest:manifest,beacon:'11'.repeat(32),funding,allowVirtual:'1',sales:'open',invoiceTtlSeconds:60,claimGraceSeconds:60});
  const server=http.createServer((req,res)=>mint.handle(req,res,new URL(req.url,'http://mint.test')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.close();mint.stop?.();await free.close();await rm(dir,{recursive:true,force:true});});
  const mintUrl=`http://127.0.0.1:${server.address().port}`;
  const walletFor=async name=>{
    const saved=new Map();
    const context={NUTFT_UNIT:'POKEMON-BASE-POC',NUTFT_STORE:`pokemon:${name}`,__cashu:cashu,__walletCrypto:{...bip39,wordlist,HDKey},crypto:globalThis.crypto,fetch:mapped,
      localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},TextEncoder,TextDecoder,Uint8Array,URL,setTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64')};
    vm.runInNewContext(await readFile(new URL('../../site/nutft-wallet.js',import.meta.url),'utf8'),context);
    return context.NutFTWallet;
  };
  const alice=await walletFor('alice'),bob=await walletFor('bob');

  const quoteA=await mint.payableQuote({});
  settled.add(quoteA.payment_hash);
  const realNow=Date.now;
  t.after(()=>{Date.now=realNow;});
  Date.now=()=>realNow()+61_000;                 // Alice's claim grace lapses
  const quoteB=await mint.payableQuote({});
  assert.equal(quoteB.pack_id,quoteA.pack_id,'the lapsed pack is offered again');

  await alice.claimBooster(mintUrl,quoteA.payment_hash);
  assert.equal((await alice.snapshot(mintUrl)).owned.length,quoteA.cards.length);

  settled.add(quoteB.payment_hash);              // Bob pays for the same pack
  await bob.claimBooster(mintUrl,quoteB.payment_hash);
  const bobCards=(await bob.snapshot(mintUrl)).owned;
  assert.equal(bobCards.length,quoteB.cards.length);
  assert.equal(mint.state.nextPack,3);
  await assert.rejects(mint.revealFor(quoteB.payment_hash),/already been claimed/);
});
