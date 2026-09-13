import { identity, outbox, storage, themeGet, themeOnChanged } from '@napplet/sdk';
import { schnorr } from '@noble/curves/secp256k1';
import { Game, E, catalog, definitions, validateDeck, choices, targets, own } from './engine';
import type { Move } from './engine';
declare global { interface Window { napplet?: { identity?: unknown; outbox?: unknown; storage?: unknown; theme?: unknown } } }
import {verifyMatch,resultPayload,verifyResult} from './match';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical)}]` : v && typeof v==='object' ? `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`)}}` : JSON.stringify(v);
const digest = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const human = (s: string) => s.replace(/^(GAME_|PROMPT_|CHOOSE_)/,'').replaceAll('_',' ').toLowerCase();
type Certificate = {schema:string;player:string;room:string;expires:number;collection_id:string;catalog_uri:string;issuer_pubkey:string;signature:string;assets:{asset_id:string;serial:string}[]};
let me = '', cert: Certificate | null = null, offer: any = null, joined: any = null, game: Game | null = null;
let history: Move[] = [], tip = '', busy = false, room = '', notice = '', timer: ReturnType<typeof setInterval> | undefined;
let selectedHand = -1, resultNote = '', resultAttempted = false;
let currentMatch: Awaited<ReturnType<typeof verifyMatch>> | null = null;
async function verifyCertificate(value: Certificate, player: string, expectedIssuer?: string) {
  if (!value || value.schema!=='nutft-play-v1' || value.collection_id!=='POKEMON-BASE-POC' || value.player!==player || value.room!==room || value.expires < Date.now()/1000 || value.assets?.length!==60 || new Set(value.assets.map(a=>a.serial)).size!==60 || value.assets.some(a=>!/^[a-f0-9]{64}$/.test(a.serial))) throw new Error('Invalid, expired, or wrong-player ownership certificate');
  const {signature,issuer_pubkey,...payload}=value;
  if (expectedIssuer && expectedIssuer!==issuer_pubkey) throw new Error('Opponent used a different mint');
  if (!schnorr.verify(signature,await digest(canonical(payload)),issuer_pubkey)) throw new Error('Mint signature is invalid');
  validateDeck(value.assets.map(a=>a.asset_id));
}
async function verifyEvent(e: any) {
  if (!e || e.kind!==1031 || !Array.isArray(e.tags) || !e.tags.some((t: string[])=>t[0]==='d'&&t[1]===room)) return false;
  const hash=await digest(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content]));
  return hash===e.id && schnorr.verify(e.sig,hash,e.pubkey);
}
function seat() { return offer?.pubkey===me ? 1 : joined?.pubkey===me ? 2 : 0; }
async function publish(payload: any) {
  const result=await outbox.publish({kind:1031,created_at:Math.floor(Date.now()/1000),tags:[['d',room],['t','pokemon-poc']],content:JSON.stringify(payload)});
  if (!result.ok || !result.event) throw new Error(result.error || 'Game message was not delivered');
  return result.event;
}
async function sync() {
  if (!offer || busy) return;
  const requestedTip=tip;
  const response=await outbox.query([{kinds:[1031],'#d':[room],limit:2000}],{timeoutMs:5000});
  if (response.error || response.incomplete) throw new Error('Game history unavailable or incomplete; retry before playing');
  const events=[];
  for (const result of response.events) {
    const e=result.event;
    try { if (await verifyEvent(e)) events.push({...e,body:JSON.parse(e.content)}); } catch { /* Ignore unrelated malformed events. */ }
  }
  const joins=events.filter(e=>e.body.type==='join'&&e.body.offer===offer.id&&e.pubkey!==offer.pubkey);
  if (!joins.length) { render(); return; }
  const match=await verifyMatch(events,offer.id);
  if(busy||tip!==requestedTip)return;
  joined=events.find(e=>e.id===match.events[1].id);
  currentMatch=match;
  if(tip!==match.tip) { game=match.game;history=match.moves;tip=match.tip;render(); }
  if(game?.state.phase===E.GamePhase.FINISHED&&!resultAttempted) { resultAttempted=true;await saveResult(); }
}
async function saveResult() {
  if(!currentMatch)return;
  const existing=await outbox.query([{kinds:[30078],'#room':[room],limit:100}],{timeoutMs:5000});
  for(const {event} of existing.events) {
    if(event.pubkey!==me)continue;
    try { await verifyResult(event,currentMatch);resultNote=event.id;render();return; }catch{/* Ignore invalid result claims. */}
  }
  const result=await outbox.publish({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['d','pokemon:'+offer.id],['room',room],['e',tip],...currentMatch.players.map(p=>['p',p])],content:JSON.stringify(resultPayload(currentMatch))});
  if(!result.ok||!result.event)throw new Error(result.error||'Result not saved. Retry signing the result.');
  await verifyResult(result.event,currentMatch);resultNote=result.event.id;render();
}

async function sendMove(move: Move) {
  if (!game || !joined || busy) return;
  busy=true;
  try {
    const decks=[offer.body.certificate.assets,joined.body.certificate.assets].map(a=>a.map((x: any)=>x.asset_id));
    const next=new Game(decks,offer.id+joined.id,[...history,move]);
    const event=await publish({type:'move',offer:offer.id,previous:tip,move});
    game=next;history=[...history,move];tip=event.id;
    selectedHand=-1; notice='';render();
  } finally { busy=false; }
  await sync();
}
function cardLabel(card: E.Card) {
  const entry=catalog.find(c=>definitions.get(c.id)?.fullName===card.fullName);
  return `<b>${esc(card.name)}</b><small>${entry ? `${esc(entry.types?.join(' · ') || entry.supertype)} · ${entry.number}/102` : 'Base Set'}</small>`;
}
function slotMarkup(slot: E.PokemonSlot, index: number, playerId: number) {
  const card=slot.getPokemonCard();
  const mine=playerId===seat();
  return `<section class="slot ${index<0?'active':''}"><small>${index<0?'ACTIVE':`BENCH ${index+1}`}</small>${card?`${cardLabel(card)}<p>${slot.damage} damage / ${card.hp} HP</p><p>${slot.specialConditions.map(c=>esc(E.SpecialCondition[c])).join(' · ')}</p><small>${slot.energies.cards.map(c=>esc(c.name)).join(', ')||'No Energy'}</small><details><summary>Card effects</summary>${card.attacks.map(a=>`<p><b>${esc(a.name)} ${esc(a.damage)}</b><br>${esc(a.cost.map(c=>E.CardType[c]).join(' · '))}<br>${esc(a.text)}</p>`).join('')}${card.powers.map(p=>`<p><b>${esc(p.name)}</b> ${esc(p.text)}</p>`).join('')}</details>`:'<span class="empty">Empty slot</span>'}${mine&&game?.state.phase===E.GamePhase.PLAYER_TURN?`<div class="actions">${selectedHand>=0?`<button data-place="${index}">Play selected here</button>`:''}${card?`${index<0?card.attacks.map(a=>`<button data-attack="${esc(a.name)}">${esc(a.name)}</button>`).join(''):`<button data-retreat="${index}">Retreat here</button>`}${card.powers.filter(p=>p.useWhenInPlay).map(p=>`<button data-power="${esc(p.name)}" data-slot="${index}">${esc(p.name)}</button>`).join('')}${slot.pokemons.cards.filter(c=>(c as any).useWhenInPlay).map(c=>`<button data-trainer="${esc(c.name)}" data-slot="${index}">Use ${esc(c.name)}</button>`).join('')}`:''}</div>`:''}</section>`;
}
function render() {
  app.innerHTML=`<div class="watermark">POC · TEST ONLY · NO MONETARY VALUE</div><header><span class="eyebrow">NUTFT / NAPPLET / BASE SET</span><h1>Battle table<span>01</span></h1><p>All 102 Base Set cards. Programmed attacks, Trainers, Powers, and game rules.</p></header><p role="status" id="notice">${esc(notice)}</p><main id="content"></main>`;
  const content=app.querySelector('#content')!;
  if (!me) { content.innerHTML='<p>Open this game in a napplet shell with identity and outbox enabled.</p>'; return; }
  if (!cert) {
    content.innerHTML=`<section class="panel"><h2>Reveal your deck</h2><p>In your wallet, select 60 cards and export a play certificate for this identity. Importing reveals only those cards. Wallet keys and spending secrets stay in the wallet.</p><label>Your game identity<input readonly value="${esc(me)}"></label><label>Import wallet play certificate<input id="reveal" type="file" accept="application/json,.json"></label><p>Casual PoC: signed decks and deterministic game history are visible to both players. This is not a private-hand or ranked protocol.</p></section>`;
    content.querySelector<HTMLInputElement>('#reveal')!.onchange=async e=>{
      try {
        const file=(e.target as HTMLInputElement).files?.[0]; if (!file || file.size>150000) throw new Error('Invalid certificate file');
        const bundle=JSON.parse(await file.text()); const value=bundle.certificate || bundle;
        room=value.room; await verifyCertificate(value,me); cert=value; render();
      } catch(error) { fail(error); }
    }; return;
  }
  if (!game) {
    content.innerHTML=`<section class="panel"><h2>${offer?'Waiting for your opponent':'Your deck is verified'}</h2><p>60 cards · ${esc(room)}</p><details><summary>Mint fingerprint</summary><code>${esc(cert.issuer_pubkey)}</code><p>Only an opponent using this same mint and catalog can join.</p></details>${offer?`<label>Share this invitation<input readonly value="${esc(room+':'+offer.id)}"></label>`:`<button id="create">Create game</button><label>Opponent’s invitation<input id="invite" placeholder="room:offer-event-id"></label><button id="join">Join game</button>`}</section>`;
    content.querySelector('#create')?.addEventListener('click',()=>task(async()=>{const event=await publish({type:'offer',certificate:cert});offer={...event,body:JSON.parse(event.content)};watch();render();}));
    content.querySelector('#join')?.addEventListener('click',()=>task(async()=>{
      const [code,id]=(content.querySelector<HTMLInputElement>('#invite')!.value).trim().split(':');
      if (code!==room || !/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Create a wallet certificate for the same room as this invitation');
      const response=await outbox.query([{ids:[id],kinds:[1031],'#d':[room]}],{timeoutMs:5000});
      const event=response.events.find(r=>r.event.id===id)?.event;
      if (!event || !(await verifyEvent(event))) throw new Error('Invitation not found');
      const b=JSON.parse(event.content); if(b.type!=='offer'||event.pubkey===me) throw new Error('Invalid opponent');
      await verifyCertificate(b.certificate,event.pubkey,cert!.issuer_pubkey);
      if(b.certificate.catalog_uri!==cert!.catalog_uri) throw new Error('Catalog differs');
      offer={...event,body:b}; await publish({type:'join',offer:id,certificate:cert}); watch(); await sync();
    })); return;
  }
  const state=game.state; const player=state.players[seat()-1];
  content.innerHTML=`<div class="matchbar"><b>${state.phase===E.GamePhase.FINISHED?`Game over · ${state.winner===3?'draw':`Player ${state.winner+1} wins`}`:`Turn ${state.turn} · Player ${state.activePlayer+1}`}</b><span>You are Player ${seat()}</span><button id="pass">End turn</button></div>${state.phase===E.GamePhase.FINISHED?`<section class="panel"><h2>Persistent result</h2>${resultNote?`<p>Signed and saved. Note <code>${esc(resultNote)}</code></p><button id="new-match">Start another match</button>`:'<button id="save-result">Sign &amp; save result</button>'}<p>Replay reference: <code>${esc(room+':'+offer.id)}</code></p></section>`:''}<div id="prompt"></div>${[...state.players].sort((a)=>a.id===seat()?1:-1).map(p=>`<section class="board"><h2>${p.id===seat()?'Your field':'Opponent'} <small>${p.deck.cards.length} deck · ${p.hand.cards.length} hand · ${p.getPrizeLeft()} prizes</small></h2>${slotMarkup(p.active,-1,p.id)}<div class="bench">${p.bench.map((s,i)=>slotMarkup(s,i,p.id)).join('')}</div><details><summary>Discard (${p.discard.cards.length})</summary>${p.discard.cards.map(c=>esc(c.name)).join(', ')}</details></section>`).join('')}<section class="panel"><h2>Your hand</h2><div class="hand">${player.hand.cards.map((c,i)=>`<button class="handcard ${selectedHand===i?'selected':''}" data-hand="${i}">${cardLabel(c)}</button>`).join('')}</div>${selectedHand>=0?`<p>Choose a destination above for Pokémon or Energy.</p><button id="play-trainer">Play selected Trainer</button>`:''}</section><details><summary>Game log</summary>${state.logs.slice(-30).reverse().map(l=>`<p>${esc(human(l.message))} ${esc(JSON.stringify(l.params || {}))}</p>`).join('')}</details>`;
  content.querySelector('#new-match')?.addEventListener('click',()=>task(async()=>{
    if(window.napplet?.storage)await storage.setItem('match:'+me,'');
    if(timer)clearInterval(timer);
    cert=null;offer=null;joined=null;game=null;currentMatch=null;history=[];tip='';room='';notice='';resultNote='';resultAttempted=false;selectedHand=-1;render();
  }));
  content.querySelector('#save-result')?.addEventListener('click',()=>task(saveResult));
  content.querySelector('#pass')!.addEventListener('click',()=>task(()=>sendMove({seat:seat(),type:'pass'})));
  content.querySelectorAll<HTMLButtonElement>('[data-hand]').forEach(b=>b.onclick=()=>{selectedHand=Number(b.dataset.hand);render();});
  const move=(m: Omit<Move,'seat'>)=>task(()=>sendMove({seat:seat(),...m}));
  content.querySelectorAll<HTMLButtonElement>('[data-place]').forEach(b=>b.onclick=()=>move({type:'play',index:selectedHand,target:own(Number(b.dataset.place))}));
  content.querySelector('#play-trainer')?.addEventListener('click',()=>move({type:'play',index:selectedHand,target:{player:2,slot:0,index:0}}));
  content.querySelectorAll<HTMLButtonElement>('[data-attack]').forEach(b=>b.onclick=()=>move({type:'attack',name:b.dataset.attack}));
  content.querySelectorAll<HTMLButtonElement>('[data-retreat]').forEach(b=>b.onclick=()=>move({type:'retreat',index:Number(b.dataset.retreat)}));
  content.querySelectorAll<HTMLButtonElement>('[data-power]').forEach(b=>b.onclick=()=>move({type:'power',name:b.dataset.power,target:own(Number(b.dataset.slot))}));
  content.querySelectorAll<HTMLButtonElement>('[data-trainer]').forEach(b=>b.onclick=()=>move({type:'trainer',name:b.dataset.trainer,target:own(Number(b.dataset.slot))}));
  const prompt=state.prompts.find(p=>p.result===undefined);
  if(prompt?.playerId===seat()) renderPrompt(prompt,content.querySelector('#prompt')!);
  else if(state.prompts.some(p=>p.result===undefined)) content.querySelector('#prompt')!.innerHTML='<p class="panel">Waiting for your opponent’s choice.</p>';
}
function renderPrompt(p: any, container: Element) {
  const opts=choices(p,game!.state); const selected: any[]=[];
  const complex=['Move energy','Attach energy','Move damage','Put damage'].includes(p.type);
  container.innerHTML=`<section class="decision"><h2>${esc(p.type)}</h2><p>${esc(human(p.message || 'Choose an option'))}</p>${p.cards?.cards?`<small>${p.cards.cards.map((c: E.Card)=>esc(c.name)).join(' · ')}</small>`:''}<div id="options"></div><p id="selection"></p><button id="confirm">Confirm selection</button>${p.options?.allowCancel?'<button id="cancel">Cancel effect</button>':''}</section>`;
  const area=container.querySelector('#options')!;
  const selection=container.querySelector('#selection')!;
  if (complex) {
    const ts=targets(game!.state,seat(),p);
    const select=(id: string)=>`<select id="${id}" aria-label="${id}">${ts.map((t,i)=>`<option value="${i}">${esc(t.label)}</option>`).join('')}</select>`;
    area.innerHTML=`${p.type==='Move energy'||p.type==='Move damage'?`<label>From ${select('from')}</label>`:''}<label>To ${select('to')}</label>${p.type==='Move energy'||p.type==='Attach energy'?'<label>Energy card<select id="energy"></select></label>':''}<button id="add">Add ${p.type.includes('damage')?'10 damage':'Energy'} transfer</button><button id="clear">Clear transfers</button>`;
    const refresh=()=>{
      const list=p.type==='Attach energy'?p.cardList.cards:ts[Number(area.querySelector<HTMLSelectElement>('#from')?.value || 0)]?.slot.energies.cards;
      const energy=area.querySelector<HTMLSelectElement>('#energy'); if(energy) energy.innerHTML=(list||[]).map((c: E.Card,i: number)=>`<option value="${i}">${esc(c.name)}</option>`).join('');
    }; refresh(); area.querySelector('#from')?.addEventListener('change',refresh);
    area.querySelector('#add')!.addEventListener('click',()=>{
      const to=ts[Number(area.querySelector<HTMLSelectElement>('#to')!.value)]?.value;
      const from=ts[Number(area.querySelector<HTMLSelectElement>('#from')?.value||0)]?.value;
      if(!to) return;
      selected.push(p.type==='Put damage'?{target:to,damage:10}:p.type==='Move damage'?{from,to}:p.type==='Attach energy'?{to,index:Number(area.querySelector<HTMLSelectElement>('#energy')!.value)}:{from,to,index:Number(area.querySelector<HTMLSelectElement>('#energy')!.value)});
      selection.textContent=`${selected.length} transfers selected`;
    });
    area.querySelector('#clear')!.addEventListener('click',()=>{selected.length=0;selection.textContent='';});
  } else {
    opts.forEach((opt: any)=>{const b=document.createElement('button');b.textContent=opt.label;b.onclick=()=>{
      const single=['Select','Choose attack','Confirm','Alert','Show cards'].includes(p.type);
      if(single) { selected.length=0;area.querySelectorAll('button').forEach(x=>x.classList.remove('selected')); }
      const at=selected.findIndex(x=>JSON.stringify(x)===JSON.stringify(opt.value));
      if(at>=0){selected.splice(at,1);b.classList.remove('selected');}else{selected.push(opt.value);b.classList.add('selected');}
      selection.textContent=selected.map((v,i)=>`${i+1}. ${opts.find((o: any)=>JSON.stringify(o.value)===JSON.stringify(v))?.label}`).join(' → ');
    };area.append(b);});
  }
  container.querySelector('#confirm')!.addEventListener('click',()=>task(()=>sendMove({seat:seat(),type:'answer',prompt:p.id,result:['Select','Choose attack','Confirm','Alert','Show cards'].includes(p.type)?selected[0]:selected})));
  container.querySelector('#cancel')?.addEventListener('click',()=>task(()=>sendMove({seat:seat(),type:'answer',prompt:p.id,result:null})));
}
function fail(error: unknown) { notice=error && typeof error==='object' && 'message' in error ? String(error.message):String(error); const el=document.querySelector('#notice');if(el)el.textContent=notice; }
async function task(fn: ()=>Promise<unknown>) { try {await fn();} catch(error){fail(error);} }
function watch() {
  if(timer)clearInterval(timer); timer=setInterval(()=>task(sync),2000);
  if(window.napplet?.storage) storage.setItem('match:'+me,JSON.stringify({room,offer:offer?.id,certificate:cert})).catch(fail);
}
function theme(t: any) { for(const [k,v] of Object.entries(t.colors||{})) if(typeof v==='string')document.documentElement.style.setProperty(`--${k}`,v); }
render();
if(window.napplet?.identity && window.napplet?.outbox) task(async()=>{me=await identity.getPublicKey();
  if(window.napplet?.storage) {
    const saved=await storage.getItem('match:'+me);
    if(saved) {
      const last=JSON.parse(saved);room=last.room;
      const response=await outbox.query([{kinds:[1031],ids:[last.offer],'#d':[room]}],{timeoutMs:5000});
      const event=response.events.find(r=>r.event.id===last.offer)?.event;
      if(event&&await verifyEvent(event)) {offer={...event,body:JSON.parse(event.content)};cert=last.certificate;watch();await sync();}
    }
  }
  render();});
if(window.napplet?.theme) task(async()=>{theme(await themeGet());themeOnChanged(theme);});
window.addEventListener('pagehide',()=>{if(timer)clearInterval(timer);});
