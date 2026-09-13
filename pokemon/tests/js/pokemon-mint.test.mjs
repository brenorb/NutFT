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
const {createPokemonServer,canonical}=require('../../server/pokemon.js');
const {loadCensus}=require('../../server/nutft-draw.js');
const {createNutftMint}=require('../../server/nutft-mint.js');
const {schnorr}=require('@noble/curves/secp256k1');
const {createHash}=require('node:crypto');
const hash=s=>createHash('sha256').update(s).digest('hex');

test('unlimited draws use fresh CSPRNG calls at the published weights, without depletion',t=>{
  const crypto=require('node:crypto'),{openUnlimitedPack}=require('../../server/nutft-draw.js');
  const weights={a:1,b:3},pools={common:['a','b']},slots=[['common',4]],rolls=[0,1,2,3,3,2,1,0];
  const random=t.mock.method(crypto,'randomInt',total=>{assert.equal(total,4);return rolls.shift();});
  assert.deepEqual(openUnlimitedPack(weights,pools,slots),['a','b','b','b']);
  assert.deepEqual(openUnlimitedPack(weights,pools,slots),['b','b','b','a']);
  assert.deepEqual(weights,{a:1,b:3});assert.equal(random.mock.callCount(),8);
});

test('a hidden booster purchase is committed once and survives a dropped response and restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pokemon-purchase-'));
  let server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const mapped=(url,options)=>fetch(String(url).replace('http://pokemon.test',`http://127.0.0.1:${server.server.address().port}`),options);
  const post=(path,body)=>mapped('http://pokemon.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const purchaseId='ab'.repeat(32),before=server.mint.state.nextPack;
  const first=await Promise.all([post('/nutft/purchase',{idempotency_key:purchaseId}),post('/nutft/purchase',{idempotency_key:purchaseId})]);
  const receipts=await Promise.all(first.map(r=>r.json()));assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].cards.length,11);assert.equal(server.mint.state.nextPack,before+1);
  assert.equal((await post('/nutft/purchase',{idempotency_key:purchaseId,deck_id:'zap'})).status,400);
  assert.equal((await post('/nutft/purchase',{idempotency_key:'cd'.repeat(32),cards:['base1-4']})).status,400);
  assert.equal((await post('/nutft/booster',{idempotency_key:'ef'.repeat(32),purchase_id:'ef'.repeat(32),outputs:[]})).status,400);
  const saved=new Map();let dropPurchase=true,refuseClaim=false,lastClaim;
  const context={NUTFT_UNIT:'POKEMON-BASE-POC',NUTFT_STORE:'pokemon:purchase-test',__cashu:cashu,__walletCrypto:{...bip39,wordlist,HDKey},crypto:globalThis.crypto,TextEncoder,TextDecoder,Uint8Array,URL,setTimeout,localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},fetch:async(url,options)=>{
    if(String(url).endsWith('/nutft/booster')&&refuseClaim){refuseClaim=false;return new Response(JSON.stringify({error:'Delivery temporarily unavailable'}),{status:400});}
    const response=await mapped(url,options);
    if(String(url).endsWith('/nutft/purchase')&&dropPurchase){dropPurchase=false;assert.equal(response.status,200);throw new Error('Dropped committed purchase response');}
    if(String(url).endsWith('/nutft/booster'))lastClaim=JSON.parse(options.body);
    return response;
  }};
  vm.runInNewContext(await readFile(new URL('../../site/nutft-wallet.js',import.meta.url),'utf8'),context);
  const wallet=context.NutFTWallet;
  await assert.rejects(wallet.buyBooster('http://pokemon.test'),/Dropped/);
  assert.equal((await wallet.read()).tokens.length,0);assert.equal(server.mint.state.nextPack,before+2);
  const pending=(await wallet.read()).pending.body.purchase_id;assert.match(pending,/^[a-f0-9]{64}$/);
  await server.close();server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  assert.deepEqual(await(await post('/nutft/purchase',{idempotency_key:purchaseId})).json(),receipts[0]);
  refuseClaim=true;await assert.rejects(wallet.recoverPending(),/Delivery temporarily unavailable/);
  assert.equal((await wallet.read()).pending.body.purchase_id,pending);
  await wallet.recoverPending();assert.equal(server.mint.state.nextPack,before+2);
  const snapshot=await wallet.snapshot('http://pokemon.test');assert.equal(snapshot.owned.length,11);assert.equal(snapshot.invalid.length,0);
  assert.equal((await post('/nutft/booster',lastClaim)).status,200);
  assert.equal((await post('/nutft/booster',{...lastClaim,idempotency_key:'12'.repeat(32)})).status,400);
  const weights=(await(await mapped('http://pokemon.test/nutft/state')).json()).weights;
  Object.keys(server.mint.state.counts).forEach(id=>server.mint.state.counts[id]=0);
  const second=await wallet.buyBooster('http://pokemon.test');assert.equal(second.cards.length,11);
  assert.deepEqual((await(await mapped('http://pokemon.test/nutft/state')).json()).weights,weights);
  assert.equal((await wallet.snapshot('http://pokemon.test')).owned.length,22);
});

test('legacy virtual Basic slot remains outside paid draw pools',()=>{
  const old=loadCensus(require('../../cards/nutft-census.json'));
  assert.deepEqual(old.slots.map(([p])=>p),['common','uncommon','prime']);
});
test('an external immutable catalog must be signed by this mint',()=>{
  assert.throws(()=>createNutftMint({catalogManifest:{schema:'forged'},catalogPrivateKey:'01'.repeat(32)}),/catalog.*signature/i);
});
test('Pokémon catalog, booster-only proofs, scoped reveal, and restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pokemon-poc-'));
  let server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const origin=()=>`http://127.0.0.1:${server.server.address().port}`;
  const mapped=(url,options)=>fetch(String(url).replace('http://pokemon.test',origin()),options);
  const quote=await(await mapped('http://pokemon.test/nutft/quote')).json();
  assert.equal(quote.cards,null,'quotes must not reveal booster contents');
  assert.equal(quote.beacon,undefined,'no reusable seed is published');
  assert.equal(quote.purchase_required,true);
  const stock=await(await mapped('http://pokemon.test/nutft/state')).json();
  assert.equal(stock.supply,'unlimited');assert.equal(stock.remaining,null);
  const response=await mapped(server.catalogUri);const bytes=await response.text();
  assert.ok(server.catalogUri.endsWith('/'+hash(bytes)));
  const {signature,issuer_pubkey,...payload}=JSON.parse(bytes);
  assert.equal(payload.assets.length,102);
  assert.ok(schnorr.verify(signature,hash(canonical(payload)),issuer_pubkey));
  const saved=new Map();
  const context={NUTFT_UNIT:'POKEMON-BASE-POC',NUTFT_STORE:'pokemon:test',__cashu:cashu,__walletCrypto:{...bip39,wordlist,HDKey},crypto:globalThis.crypto,fetch:mapped,localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},TextEncoder,TextDecoder,Uint8Array,URL,setTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64')};
  vm.runInNewContext(await readFile(new URL('../../site/nutft-wallet.js',import.meta.url),'utf8'),context);
  const wallet=context.NutFTWallet;
  for(let i=0;i<6;i++)await wallet.buyBooster('http://pokemon.test');
  const snapshot=await wallet.snapshot('http://pokemon.test');
  assert.equal(snapshot.invalid.length,0);assert.equal(snapshot.owned.length,66);
  assert.ok(snapshot.owned.every(i=>i.proof.amount.toString()==='1'&&i.tag[1]==='POKEMON-BASE-POC'));
  const selected=snapshot.owned.slice(0,60).map(i=>i.proof.secret);
  const pub=Buffer.from(schnorr.getPublicKey('02'.repeat(32))).toString('hex');
  const cert=await wallet.revealDeck('http://pokemon.test',selected,pub,'room-test-01');
  assert.equal(cert.assets.length,60);assert.equal(cert.player,pub);
  const {signature:sig,issuer_pubkey:issuer,...rest}=cert;
  assert.ok(schnorr.verify(sig,hash(canonical(rest)),issuer));
  assert.ok(selected.every(secret=>!JSON.stringify(cert).includes(secret)));
  await assert.rejects(wallet.revealDeck('http://pokemon.test',Array(60).fill(selected[0]),pub,'room-test-01'),/distinct/);
  const bad=await mapped('http://pokemon.test/nutft/reveal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room:'room-test-01',player:pub,inputs:cashu.serializeProofs(snapshot.owned.slice(0,60).map(i=>i.proof)),authorizations:Array(60).fill('00'.repeat(64))})});
  assert.equal(bad.status,400);assert.match(await bad.text(),/authorization/);
  const uri=server.catalogUri;
  await server.close();server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  assert.equal(server.catalogUri,uri);
  assert.equal((await wallet.snapshot('http://pokemon.test')).owned.length,66);
});
