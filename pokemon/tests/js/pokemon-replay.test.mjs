import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {schnorr} from '@noble/curves/secp256k1';
import {verifyMatch,resultPayload,verifyResult} from '../../site/pokemon/replay.mjs';
import {Game,E,choices} from '../../site/pokemon/engine.mjs';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {createPokemonServer,canonical}=createRequire(import.meta.url)('../../server/pokemon.js');
const hash=v=>createHash('sha256').update(v).digest('hex');
const keys=['01'.repeat(32),'02'.repeat(32)],issuer='03'.repeat(32);
const pub=k=>Buffer.from(schnorr.getPublicKey(k)).toString('hex');
const room='signed-match-test';
const deck=[...Array(4).fill('base1-58'),...Array(56).fill('base1-100')];
function sign(key,body,kind=1031,tags=[['d',room]]) {
  const e={pubkey:pub(key),kind,tags,created_at:Math.floor(Date.now()/1000),content:JSON.stringify(body)};
  e.id=hash(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content]));e.sig=Buffer.from(schnorr.sign(e.id,key)).toString('hex');return e;
}
function certificate(seat) {
  const p={schema:'nutft-play-v1',player:pub(keys[seat]),room,collection_id:'POKEMON-BASE-POC',catalog_uri:'http://mint.test/blossom/'+hash('catalog'),expires:Math.floor(Date.now()/1000)+3600,assets:deck.map((id,i)=>({asset_id:id,serial:hash(`${seat}:${i}`)}))};
  return {...p,issuer_pubkey:pub(issuer),signature:Buffer.from(schnorr.sign(hash(canonical(p)),issuer)).toString('hex')};
}
function transcript() {
  const offer=sign(keys[0],{type:'offer',certificate:certificate(0)});
  const joined=sign(keys[1],{type:'join',offer:offer.id,certificate:certificate(1)});
  const events=[offer,joined],g=new Game([deck,deck],offer.id+joined.id);let tip=joined.id;
  while(g.state.phase!==E.GamePhase.FINISHED) {
    const p=g.state.prompts.find(p=>p.result===undefined);
    const move=p?{seat:p.playerId,type:'answer',prompt:p.id,result:p.type==='Choose cards'?[choices(p,g.state)[0].value]:p.type==='Select'?0:true}:{seat:g.state.players[g.state.activePlayer].id,type:'pass'};
    g.apply(move);const event=sign(keys[move.seat-1],{type:'move',offer:offer.id,previous:tip,move});events.push(event);tip=event.id;
  }
  return {events,g,offer};
}
test('signed match replays to its actual winner and rejects forged moves/results',async()=>{
  const {events,g,offer}=transcript();const match=await verifyMatch(events,offer.id);
  assert.equal(match.game.state.winner,g.state.winner);assert.equal(match.game.state.phase,E.GamePhase.FINISHED);
  const payload=resultPayload(match);assert.equal(payload.winner,keys.map(pub)[g.state.winner]);
  const note=sign(keys[0],payload,30078,[['d','pokemon:'+offer.id],['room',room]]);
  assert.equal(await verifyResult(note,match),true);
  await assert.rejects(verifyResult(sign(keys[0],{...payload,winner:'f'.repeat(64)},30078,note.tags),match),/result/i);
  const tampered=structuredClone(events);tampered[2].content+=' ';
  await assert.rejects(verifyMatch(tampered,offer.id),/signature/i);
  const fork=sign(keys[0],{...JSON.parse(events[2].content),move:{seat:1,type:'pass'}});
  await assert.rejects(verifyMatch([...events,fork],offer.id),/conflict/i);
});
test('signed game history and winner note survive server restart; forged winner is refused',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pokemon-replay-'));let server=await createPokemonServer({port:0,stateDir:dir});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const url=()=>`http://127.0.0.1:${server.server.address().port}/pokemon/events?room=${room}`;
  const post=event=>fetch(url(),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});
  const {events,offer}=transcript();for(const e of events)assert.equal((await post(e)).status,200);
  const match=await verifyMatch(events,offer.id),payload=resultPayload(match),tags=[['d','pokemon:'+offer.id],['room',room]];
  const note=sign(keys[0],payload,30078,tags);
  assert.equal((await post(sign(keys[0],{...payload,winner:'f'.repeat(64)},30078,tags))).status,400);
  assert.equal((await post(note)).status,200);
  await server.close();server=await createPokemonServer({port:0,stateDir:dir});
  const saved=await (await fetch(url())).json();assert.ok(saved.some(e=>e.id===note.id));
  assert.equal((await verifyMatch(saved,offer.id)).game.state.winner,match.game.state.winner);
});
