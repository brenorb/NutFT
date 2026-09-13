import {verifyMatch,verifyResult,Game,E} from './replay.mjs';
const $=s=>document.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let match,bundle;
const task=async fn=>{try{await fn();}catch(e){$('#status').textContent=e.message||String(e);$('#viewer').hidden=true;}};
async function load(value) {
  match=await verifyMatch(value.events,value.offer);bundle=value;
  const notes=[];for(const note of value.events.filter(e=>e.kind===30078)){try{await verifyResult(note,match);notes.push(note);}catch{/* Never present an unverified winner claim. */}}
  $('#notes').textContent=notes.length?JSON.stringify(notes,null,2):'No signed result note yet.';
  $('#status').textContent=`Verified ${match.moves.length} signed moves. Mint fingerprint: ${match.issuer}. ${match.game.state.phase===E.GamePhase.FINISHED?(match.game.state.winner===3?'Draw.':'Winner: '+match.players[match.game.state.winner]):'Match in progress.'}`;
  $('#viewer').hidden=false;$('#step').max=match.moves.length;$('#step').value=match.moves.length;render();
}
function render() {
  const count=Number($('#step').value),state=new Game(match.decks,match.seed,match.moves.slice(0,count)).state;
  $('#position').textContent=`Move ${count} / ${match.moves.length} · turn ${state.turn} · ${E.GamePhase[state.phase]}`;
  const slot=s=>s.getPokemonCard()?`${esc(s.getPokemonCard().name)} · ${s.damage} damage / ${s.getPokemonCard().hp} HP · ${esc(s.energies.cards.map(c=>c.name).join(', '))}`:'Empty';
  $('#board').innerHTML=state.players.map((p,i)=>`<section class="panel"><h2>Player ${i+1}</h2><code>${esc(match.players[i])}</code><p>${p.deck.cards.length} deck · ${p.getPrizeLeft()} prizes</p><h3>Active</h3><p>${slot(p.active)}</p><h3>Bench</h3>${p.bench.map(s=>`<p>${slot(s)}</p>`).join('')}<h3>Hand</h3><p>${esc(p.hand.cards.map(c=>c.name).join(', '))}</p><h3>Discard</h3><p>${esc(p.discard.cards.map(c=>c.name).join(', '))}</p></section>`).join('');
}
$('#load').onclick=()=>task(async()=>{const [room,offer]=$('#reference').value.trim().split(':');if(!/^[a-z0-9-]{8,64}$/.test(room||'')||!/^[a-f0-9]{64}$/.test(offer||''))throw new Error('Invalid match reference');const response=await fetch('/pokemon/events?room='+encodeURIComponent(room));if(!response.ok)throw new Error('Match unavailable');await load({schema:'pokemon-replay-v1',offer,events:await response.json()});});
$('#import').onchange=e=>task(async()=>{const file=e.target.files[0];if(!file||file.size>16000000)throw new Error('Replay too large');await load(JSON.parse(await file.text()));});
$('#step').oninput=render;
$('#export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(bundle)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='pokemon-replay-'+match.offer+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
for(const m of JSON.parse(localStorage.getItem('pokemon:matches')||'[]').reverse()){const b=document.createElement('button');b.textContent=m.room;b.onclick=()=>{$('#reference').value=m.room+':'+m.offer;$('#load').click();};$('#recent').append(b);}
