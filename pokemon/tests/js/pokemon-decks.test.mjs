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
import {validateDeck} from '../../site/pokemon/engine.mjs';
const {createPokemonServer}=createRequire(import.meta.url)('../../server/pokemon.js');

test('fixed Base Set decks issue verified cards, recover once, and never exhaust supply',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pokemon-decks-'));
  let server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const request=(url,options)=>fetch(String(url).replace('http://pokemon.test',`http://127.0.0.1:${server.server.address().port}`),options);
  const response=await request('http://pokemon.test/nutft/decks');assert.equal(response.status,200);
  const decks=await response.json();assert.deepEqual(decks.map(d=>d.id).sort(),['blackout','brushfire','overgrowth','zap']);
  for(const deck of decks){assert.equal(deck.cards.length,60);validateDeck(deck.cards.map(c=>c.asset_id));}
  const brushfire=decks.find(d=>d.id==='brushfire');
  assert.equal(brushfire.cards.filter(c=>c.asset_id==='base1-98').length,18);
  assert.equal(brushfire.cards.filter(c=>c.asset_id==='base1-12').length,1);
  assert.equal((await request('http://pokemon.test/nutft/quote?deck=charizard')).status,400);
  const saved=new Map();let drop=true,lastBody;
  const context={btoa:globalThis.btoa,NUTFT_UNIT:'POKEMON-BASE-POC',NUTFT_STORE:'pokemon:deck-test',__cashu:cashu,__walletCrypto:{...bip39,wordlist,HDKey},crypto:globalThis.crypto,TextEncoder,TextDecoder,Uint8Array,URL,setTimeout,localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},fetch:async(url,options)=>{
    const result=await request(url,options);
    if(String(url).endsWith('/nutft/booster')){lastBody=JSON.parse(options.body);if(drop){drop=false;throw new Error('Simulated dropped response');}}
    return result;
  }};
  vm.runInNewContext(await readFile(new URL('../../site/nutft-wallet.js',import.meta.url),'utf8'),context);
  const wallet=context.NutFTWallet,initial={...server.mint.state.counts},pack=server.mint.state.nextPack;
  await assert.rejects(wallet.buyDeck('http://pokemon.test','brushfire'),/dropped response/);
  assert.equal((await wallet.read()).pending.body.deck_id,'brushfire');
  await assert.rejects(wallet.buyDeck('http://pokemon.test','zap'),/pending purchase/);
  await wallet.recoverPending();const retry=lastBody;
  const encoded=(await wallet.read()).tokens[0];assert.doesNotThrow(()=>atob(encoded.slice(6).replace(/-/g,'+').replace(/_/g,'/')));
  const first=await wallet.snapshot('http://pokemon.test');assert.equal(first.owned.length,60);assert.equal(first.invalid.length,0);
  assert.equal(server.mint.state.nextPack,pack);assert.equal(server.mint.state.counts['base1-98'],initial['base1-98']);
  const post=body=>request('http://pokemon.test/nutft/booster',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(retry)).status,200);
  assert.equal((await post({...retry,deck_id:'zap'})).status,400);
  assert.equal((await post({...retry,idempotency_key:'partial-deck',outputs:retry.outputs.slice(1)})).status,400);
  assert.equal(server.mint.state.counts['base1-98'],initial['base1-98']);
  for(const deck of decks.filter(d=>d.id!=='brushfire'))await wallet.buyDeck('http://pokemon.test',deck.id);
  const all=await wallet.snapshot('http://pokemon.test');assert.equal(all.owned.length,240);assert.equal(all.invalid.length,0);assert.equal(new Set(all.owned.map(c=>c.proof.secret)).size,240);
  await wallet.buyBooster('http://pokemon.test');assert.equal(server.mint.state.nextPack,pack+1);
  const uri=server.catalogUri;await server.close();server=await createPokemonServer({port:0,stateDir:dir,origin:'http://pokemon.test'});
  assert.equal(server.catalogUri,uri);assert.equal((await wallet.snapshot('http://pokemon.test')).owned.length,251);
  server.mint.state.counts['base1-12']=0;
  const stock=(await(await request('http://pokemon.test/nutft/decks')).json()).find(d=>d.id==='brushfire');assert.equal(stock.supply,'unlimited');
  await wallet.buyDeck('http://pokemon.test','brushfire');assert.equal((await wallet.snapshot('http://pokemon.test')).owned.length,311);
});
