import {schnorr} from '@noble/curves/secp256k1';
import {Game,E,validateDeck} from './engine';
import type {Move} from './engine';
export {Game,E};
const canonical=(v:any):string=>Array.isArray(v)?`[${v.map(canonical)}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`)}}`:JSON.stringify(v);
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
export async function verifySignedEvent(e:any) {
  if(!e||!Number.isInteger(e.created_at)||!Array.isArray(e.tags)||typeof e.content!=='string')throw new Error('Invalid event');
  const id=await hash(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content]));
  if(id!==e.id||!schnorr.verify(e.sig,id,e.pubkey))throw new Error('Invalid event signature');
}
export async function verifyCertificate(c:any,player:string,room:string,at:number,issuer?:string) {
  if(!c||c.schema!=='nutft-play-v1'||c.collection_id!=='POKEMON-BASE-POC'||c.player!==player||c.room!==room||!Number.isInteger(c.expires)||c.expires<at||c.assets?.length!==60||new Set(c.assets.map((a:any)=>a.serial)).size!==60||c.assets.some((a:any)=>!/^[a-f0-9]{64}$/.test(a.serial)))throw new Error('Invalid ownership certificate');
  if(issuer&&issuer!==c.issuer_pubkey)throw new Error('Different mint');
  const {signature,issuer_pubkey,...payload}=c;
  if(!schnorr.verify(signature,await hash(canonical(payload)),issuer_pubkey))throw new Error('Invalid mint signature');
  validateDeck(c.assets.map((a:any)=>a.asset_id));
}
export async function verifyMatch(input:any[],offerId:string) {
  if(!Array.isArray(input)||input.length>2000)throw new Error('Invalid transcript size');
  const offer=input.find(e=>e.id===offerId&&e.kind===1031);if(!offer)throw new Error('Missing offer');
  await verifySignedEvent(offer);
  const room=offer.tags.find((t:string[])=>t[0]==='d')?.[1],body=JSON.parse(offer.content);
  if(!/^[a-z0-9-]{8,64}$/.test(room||'')||body.type!=='offer')throw new Error('Invalid offer');
  await verifyCertificate(body.certificate,offer.pubkey,room,offer.created_at);
  const events=[];
  for(const e of input.filter(e=>e.kind===1031&&e.tags?.some((t:string[])=>t[0]==='d'&&t[1]===room))) {
    await verifySignedEvent(e);events.push({...e,body:JSON.parse(e.content)});
  }
  const joins=events.filter(e=>e.body.type==='join'&&e.body.offer===offerId&&e.pubkey!==offer.pubkey);
  const valid=[];
  for(const e of joins) {
    try {
      await verifyCertificate(e.body.certificate,e.pubkey,room,e.created_at,body.certificate.issuer_pubkey);
      const serials=new Set(body.certificate.assets.map((a:any)=>a.serial));
      if(e.body.certificate.catalog_uri!==body.certificate.catalog_uri||e.body.certificate.assets.some((a:any)=>serials.has(a.serial)))continue;
      valid.push(e);
    }catch{/* An unrelated join cannot claim a player slot. */}
  }
  if(valid.length!==1)throw new Error(valid.length?'Conflicting opponents':'Waiting for opponent');
  const joined=valid[0],players=[offer.pubkey,joined.pubkey];
  const decks=[body.certificate,joined.body.certificate].map(c=>c.assets.map((a:any)=>a.asset_id));
  const moves:Move[]=[],chain=[offer, input.find(e=>e.id===joined.id)];let tip=joined.id;
  for(let i=0;i<2000;i++) {
    const next=events.filter(e=>e.body.type==='move'&&e.body.offer===offerId&&e.body.previous===tip&&players[e.body.move?.seat-1]===e.pubkey);
    if(next.length>1)throw new Error('Conflicting signed moves');
    if(!next.length)break;
    moves.push(next[0].body.move);tip=next[0].id;chain.push(input.find(e=>e.id===tip));
  }
  const seed=offer.id+joined.id,game=new Game(decks,seed,moves);
  return {offer:offer.id,room,players,decks,seed,moves,tip,game,events:chain,issuer:body.certificate.issuer_pubkey};
}
export function resultPayload(m:Awaited<ReturnType<typeof verifyMatch>>) {
  if(m.game.state.phase!==E.GamePhase.FINISHED)throw new Error('Match is not finished');
  return {schema:'pokemon-match-result-v1',engine:'base-poc-v1',offer:m.offer,room:m.room,tip:m.tip,players:m.players,winner:m.game.state.winner===3?null:m.players[m.game.state.winner],moves:m.moves.length};
}
export async function verifyResult(note:any,match:Awaited<ReturnType<typeof verifyMatch>>) {
  await verifySignedEvent(note);
  if(note.kind!==30078||!match.players.includes(note.pubkey)||!note.tags.some((t:string[])=>t[0]==='d'&&t[1]==='pokemon:'+match.offer)||!note.tags.some((t:string[])=>t[0]==='room'&&t[1]===match.room)||canonical(JSON.parse(note.content))!==canonical(resultPayload(match)))throw new Error('Invalid match result');
  return true;
}
