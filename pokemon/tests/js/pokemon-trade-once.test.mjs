import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import * as cashu from '@cashu/cashu-ts';
import * as bip39 from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {HDKey} from '@scure/bip32';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPokemonServer}=require('../../server/pokemon.js');
const {schnorr}=require('@noble/curves/secp256k1');

/* CardTrade.tla OneReplacementPerCard on the real mint: the same card proof
   sent twice at once under different idempotency keys is replaced once, and a
   retry of the winning key replays the same signature. */
test('one card proof is replaced at most once',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pokemon-trade-'));
  const server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const base=()=>`http://127.0.0.1:${server.server.address().port}`;
  const mapped=(url,options)=>fetch(String(url).replace('http://pokemon.test',base()),options);
  const walletFor=async saved=>{
    const context={NUTFT_UNIT:'POKEMON-BASE-POC',NUTFT_STORE:'pokemon:trade',__cashu:cashu,__walletCrypto:{...bip39,wordlist,HDKey},crypto:globalThis.crypto,fetch:mapped,
      localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},TextEncoder,TextDecoder,Uint8Array,URL,setTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64')};
    vm.runInNewContext(await readFile(new URL('../../site/nutft-wallet.js',import.meta.url),'utf8'),context);
    return context.NutFTWallet;
  };
  const saved=new Map();
  const alice=await walletFor(saved);
  await alice.buyBooster('http://pokemon.test');
  const card=(await alice.snapshot('http://pokemon.test')).owned[0];
  // A copy of the same wallet: same card proof, different destination, so the
  // mint sees a fresh output and only the spent-proof check can refuse it.
  const copy=await walletFor(new Map(saved));
  const elsewhere='02'+Buffer.from(schnorr.getPublicKey('03'.repeat(32))).toString('hex');
  const results=await Promise.allSettled([
    alice.tradeProof('http://pokemon.test',card.proof.secret,await alice.destination()),
    copy.tradeProof('http://pokemon.test',card.proof.secret,elsewhere),
  ]);
  const fulfilled=results.filter(r=>r.status==='fulfilled');
  assert.equal(fulfilled.length,1,JSON.stringify(results.map(r=>r.reason?.message)));
  assert.match(results.find(r=>r.status==='rejected').reason.message,/already spent/);
});
