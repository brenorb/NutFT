import { validateDeck } from './engine.mjs';
const wallet=window.NutFTWallet, c=window.__cashu;
const app=document.querySelector('#app'), status=document.querySelector('#status');
const esc=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const canonical=v=>Array.isArray(v)?`[${v.map(canonical)}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`)}}`:JSON.stringify(v);
const sha=async bytes=>wallet.hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
const digest=s=>sha(new TextEncoder().encode(s));
let config, manifest, themeDecks=[], owned=[], cachedCounts={}, offline=false, busy=false, installPrompt;
const images=new Map(), deck=new Map();
const customDeckKey='pokemon:custom-decks';
const tell=text=>{status.textContent=text;};
async function run(fn) {if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(error){tell(error.message);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
const count=id=>offline?(cachedCounts[id]||0):owned.filter(i=>i.asset.asset_id===id).length;
function download(name,value) {const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
async function loadCatalog() {
  try {const response=await fetch('/pokemon/config');if(!response.ok)throw new Error('Mint unavailable');config=await response.json();localStorage.setItem('pokemon:config',JSON.stringify(config));}
  catch(error){const saved=localStorage.getItem('pokemon:config');if(!saved)throw error;config=JSON.parse(saved);offline=true;}
  const response=await fetch(config.catalog_uri);if(!response.ok)throw new Error('Catalog unavailable');
  const bytes=await response.arrayBuffer();const hash=await sha(bytes);
  if(!config.catalog_uri.endsWith('/'+hash))throw new Error('Blossom catalog hash mismatch');
  manifest=JSON.parse(new TextDecoder().decode(bytes));const {signature,issuer_pubkey,...payload}=manifest;
  if(issuer_pubkey!==config.issuer||manifest.collection_id!=='POKEMON-BASE-POC'||!c.schnorrVerifyDigest(signature,await digest(canonical(payload)),issuer_pubkey))throw new Error('Catalog signature is invalid');
  const pin=localStorage.getItem('pokemon:issuer');if(pin&&pin!==issuer_pubkey)throw new Error('Mint identity changed. Restore the original mint database before using this wallet.');
  localStorage.setItem('pokemon:issuer',issuer_pubkey);
  const products=await fetch('/pokemon/decks.json');if(!products.ok)throw new Error('Deck lists unavailable');themeDecks=await products.json();
}
async function refresh() {
  if(offline){cachedCounts=JSON.parse(localStorage.getItem('pokemon:last-verified')||'{}');return;}
  const result=await wallet.snapshot(location.origin);owned=result.owned;
  cachedCounts=Object.fromEntries(manifest.assets.map(a=>[a.id,count(a.id)]));localStorage.setItem('pokemon:last-verified',JSON.stringify(cachedCounts));
  if(result.invalid.length||result.unreadable.length)tell(`${result.invalid.length} invalid and ${result.unreadable.length} unreadable tokens excluded. Preserve your backup.`);
}
async function image(card) {
  if(!images.has(card.image_sha256))images.set(card.image_sha256,(async()=>{
    const url=new URL('/blossom/'+card.image_sha256,config.origin);const response=await fetch(url);if(!response.ok)throw new Error('Card image unavailable');
    const bytes=await response.arrayBuffer();if(await sha(bytes)!==card.image_sha256)throw new Error('Card image hash mismatch');
    return URL.createObjectURL(new Blob([bytes],{type:'image/png'}));
  })());
  return images.get(card.image_sha256);
}
function cardMarkup(card,badge='') {return `<button class="collectible" data-card="${esc(card.id)}"><div class="card-image"><img data-image="${esc(card.id)}" alt="${esc(card.name)} · PoC test card" loading="lazy"></div>${badge?`<span class="owned-badge">${esc(badge)}</span>`:''}<b>${esc(card.name)}</b><small>${String(card.number).padStart(3,'0')} / 102 · ${esc(card.rarity)}</small></button>`;}
function hydrate(root=app) {
  root.querySelectorAll('[data-image]').forEach(img=>{const card=manifest.assets.find(c=>c.id===img.dataset.image);image(card).then(src=>{img.src=src;}).catch(error=>{img.alt=error.message;});});
  root.querySelectorAll('[data-card]').forEach(b=>b.onclick=()=>detail(manifest.assets.find(c=>c.id===b.dataset.card)));
}
function detail(card) {
  const dialog=document.querySelector('#detail');document.querySelector('#detail-body').innerHTML=`<div class="card-image"><img data-image="${esc(card.id)}" alt="${esc(card.name)} PoC"></div><div><span class="kicker">BASE SET / ${esc(card.number)} OF 102</span><h2>${esc(card.name)}</h2><p>${esc(card.supertype)} · ${esc(card.types?.join(' / '))} ${card.hp?`· ${esc(card.hp)} HP`:''}</p>${(card.abilities||[]).map(a=>`<p><b>${esc(a.name)}</b><br>${esc(a.text)}</p>`).join('')}${(card.attacks||[]).map(a=>`<p><b>${esc(a.name)} · ${esc(a.damage)}</b><br><small>${esc(a.cost?.join(' / '))}</small><br>${esc(a.text)}</p>`).join('')}${(card.rules||[]).map(t=>`<p>${esc(t)}</p>`).join('')}<p>Weakness: ${esc(card.weaknesses?.map(w=>w.type+' '+w.value).join(', ')||'none')}<br>Resistance: ${esc(card.resistances?.map(w=>w.type+' '+w.value).join(', ')||'none')}<br>Retreat: ${card.retreatCost?.length||0}</p><p class="fine">POC · TEST ONLY · NO VALUE<br>Art SHA-256: ${esc(card.image_sha256)}</p></div>`;hydrate(dialog);dialog.showModal();
}
document.querySelector('#close-detail').onclick=()=>document.querySelector('#detail').close();
function store() {
  app.innerHTML=`<section class="hero"><div><span class="kicker"><span class="dot"></span> THE ORIGINAL 102. A NEW WAY TO COLLECT.</span><h1>Gotta <br>cashu <br><em>’em all.</em></h1><p>Meet your next favorite card. Open a random Base Set booster, keep its testnuts in your own wallet, and bring your collection to the battle table.</p><p><b>Crack a pack. Go nuts.</b></p><button class="primary" id="mint">Mint a booster ↗</button><p class="fine">11 random cards · free test mint · no individual sales</p></div><div class="pack-scene" aria-label="Base Set proof-of-concept booster"><div class="pack"><div class="wordmark">Pokémon</div><small>TRADING CARD GAME</small><div class="badge">01</div><small>BASE SET</small><span class="poc">PROOF OF CONCEPT</span><span class="count">11 RANDOM TESTNUT CARDS</span></div><div class="round-note">YOUR CARDS.<br>YOUR WALLET.<br>JUST A TEST.</div></div></section><div class="factline"><div><b>102</b><span>BASE SET CARDS</span></div><div><b>11</b><span>CARDS PER BOOSTER</span></div><div><b>Yours.</b><span>HELD AS CASHU PROOFS</span></div></div><section><div class="sectionhead"><div><span class="kicker">BASE SET / READY TO PLAY</span><h2>Start with a complete deck.</h2><p>60 fixed cards · free test mint · held in your wallet</p></div></div><div class="theme-decks">${themeDecks.map(d=>`<article class="theme-deck"><span class="kicker">${esc(d.types.join(' / '))}</span><h2>${esc(d.name)}</h2>${cardMarkup(manifest.assets.find(c=>c.id===d.featured))}<details><summary>View all 60 cards</summary><ul>${Object.entries(d.cards).map(([id,n])=>`<li>${n} × ${esc(manifest.assets.find(c=>c.id===id).name)}</li>`).join('')}</ul></details><button class="primary" data-buy-deck="${esc(d.id)}">Mint ${esc(d.name)} deck ↗</button></article>`).join('')}</div><p><button id="recover-purchase">Recover interrupted purchase</button></p></section><section class="minted"><div class="sectionhead"><h2>Some old friends.</h2><a href="#catalog">Explore all 102 cards ↗</a></div><div class="grid">${manifest.assets.filter(c=>['base1-4','base1-2','base1-15','base1-58'].includes(c.id)).map(c=>cardMarkup(c)).join('')}</div></section><details><summary>What’s in a booster?</summary><p>5 common, 3 uncommon, 1 rare or holo rare, and 2 Basic Energy cards. Unlimited supply, fixed odds. Every slot uses fresh mint-generated randomness; cards can repeat. Your cards appear in your wallet after the purchase completes. This PoC relies on the mint to draw honestly. These are PoC odds, not physical First Edition print collation.</p><p class="fine">Signed catalog verified · ${esc(config.issuer.slice(0,16))}…</p></details>`;
  document.querySelector('#mint').onclick=()=>run(async()=>{
    if(offline)throw new Error('Go online to mint a booster');tell('Completing your booster purchase and verifying its 11 cards…');
    const before=new Set(owned.map(i=>i.proof.secret));await wallet.buyBooster(location.origin);await refresh();
    const received=owned.filter(i=>!before.has(i.proof.secret)).length;history.replaceState(null,'','#wallet');await route();tell(`${received} cards minted and verified. Your booster is now in your wallet.`);
  });
  app.querySelectorAll('[data-buy-deck]').forEach(button=>button.onclick=()=>run(async()=>{
    if(offline)throw new Error('Go online to mint a deck');const product=themeDecks.find(d=>d.id===button.dataset.buyDeck);
    tell(`Minting and verifying all 60 ${product.name} cards…`);await wallet.buyDeck(location.origin,product.id);await refresh();
    history.replaceState(null,'','#wallet');await route();selectDeck(product.id);tell(`${product.name} · 60 cards minted and verified. Your deck is selected below.`);
  }));
  document.querySelector('#recover-purchase').onclick=()=>run(async()=>{
    if(offline)throw new Error('Go online to recover a purchase');const result=await wallet.recoverPending();await refresh();
    if(!result){tell('No interrupted purchase to recover.');return;}history.replaceState(null,'','#wallet');await route();if(result.deck_id)selectDeck(result.deck_id);tell('Purchase recovered; cards verified in your wallet.');
  });hydrate();
}
function collection(view) {
  const isWallet=view==='wallet';
  app.innerHTML=`<div class="sectionhead"><div><span class="kicker">${isWallet?'SELF-CUSTODY / TESTNUTS':'SIGNED BY THE MINT / STORED ON BLOSSOM'}</span><h1>${isWallet?'Your little universe.':'The original 102.'}</h1><p>${isWallet?`${Object.values(cachedCounts).reduce((a,b)=>a+b,0)} cards · ${Object.values(cachedCounts).filter(Boolean).length} discovered`:'A complete Base Set archive, shared by the wallet and store.'}</p></div>${isWallet?'<button id="install">Install wallet ↗</button>':''}</div>${offline?'<p class="panel">Offline collection · last verified balances. Reconnect to recheck proofs before playing or transferring.</p>':''}${isWallet?'<div class="wallet-tools"><button id="backup">Export wallet backup</button><label>Restore backup<input id="restore" type="file" accept="application/json,.json"></label><button id="deck-toggle">Build a battle deck</button></div><div id="deck"></div>':''}<div class="toolbar"><label>Find a card<input id="search" type="search" placeholder="Name, type or card number"></label><label>Rarity<select id="rarity"><option value="">Every rarity</option><option>Common</option><option>Uncommon</option><option>Rare</option><option>Rare Holo</option></select></label></div><div id="cards" class="grid"></div><details><summary>Catalog verification</summary><code>${esc(config.catalog_uri)}</code><p class="fine">Signature and content hash verified. Issuer: ${esc(config.issuer)}</p></details>`;
  const draw=()=>{
    const q=document.querySelector('#search').value.toLowerCase(), rarity=document.querySelector('#rarity').value;
    const found=manifest.assets.filter(c=>(!isWallet||count(c.id))&&(!rarity||c.rarity===rarity)&&`${c.name} ${c.types?.join(' ')} ${c.number}`.toLowerCase().includes(q));
    document.querySelector('#cards').innerHTML=found.length?found.map(c=>cardMarkup(c,count(c.id)?`${count(c.id)} OWNED`:'')).join(''):'<div class="empty-state"><h2>No cards here yet.</h2><p>Every collection starts with a pack.</p><a href="#store">Open your first booster ↗</a></div>';hydrate();
  };
  document.querySelector('#search').oninput=draw;document.querySelector('#rarity').onchange=draw;draw();
  if(!isWallet)return;
  document.querySelector('#install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;}else tell('Use your browser menu: Install app or Add to Home Screen. The wallet works offline after your first visit.');};
  document.querySelector('#backup').onclick=()=>run(async()=>{await wallet.destination();download('pokemon-wallet-SECRET-backup.json',await wallet.exportBackup());tell('Backup exported. It contains wallet secrets: keep it private.');});
  document.querySelector('#restore').onchange=e=>run(async()=>{const file=e.target.files?.[0];if(!file||file.size>5000000)throw new Error('Invalid backup');await wallet.restoreBackup(await file.text());await refresh();collection('wallet');tell('Backup restored; cards verified.');});
  document.querySelector('#deck-toggle').onclick=deckBuilder;
}
function savedDecks() { try { const value=JSON.parse(localStorage.getItem(customDeckKey)||'[]'); return Array.isArray(value)?value.filter(d=>d&&typeof d.name==='string'&&d.cards&&typeof d.cards==='object'):[]; } catch { return []; } }
function completeDecks() { return themeDecks.filter(d=>Object.entries(d.cards).every(([id,n])=>count(id)>=n)); }
function sameDeck(cards) { return Object.entries(cards).every(([id,n])=>deck.get(id)===n)&&[...deck].every(([id,n])=>!n||cards[id]===n); }
function setDeckCards(cards) { if(Object.entries(cards).some(([id,n])=>count(id)<n))throw new Error('You do not own all cards in this deck yet.'); deck.clear();Object.entries(cards).forEach(([id,n])=>deck.set(id,n));deckBuilder(); }
function applyPreset(value) {
  if(!value){deck.clear();deckBuilder();return;}
  if(value.startsWith('theme:'))return selectDeck(value.slice(6));
  const custom=savedDecks().find(d=>`custom:${d.name}`===value);if(!custom)throw new Error('Saved deck not found');setDeckCards(custom.cards);
}
function selectDeck(id) {
  const product=themeDecks.find(d=>d.id===id);if(!product)return;
  if(Object.entries(product.cards).some(([id,n])=>count(id)<n))throw new Error(`You do not own all 60 cards for ${product.name}. Mint the complete deck in the store.`);
  deck.clear();Object.entries(product.cards).forEach(([id,n])=>deck.set(id,n));deckBuilder();
}
function deckBuilder() {
  const container=document.querySelector('#deck');const cards=manifest.assets.filter(c=>count(c.id)),complete=completeDecks(),custom=savedDecks();
  const presetOptions=[...complete.map(d=>`<option value="theme:${esc(d.id)}" ${sameDeck(d.cards)?'selected':''}>${esc(d.name)}</option>`),...custom.map(d=>`<option value="custom:${esc(d.name)}" ${sameDeck(d.cards)?'selected':''}>${esc(d.name)} (saved)</option>`)].join('');
  container.innerHTML=`<div class="deck-panel"><h2>Bring 60 cards to the table.</h2><p>Choose owned copies. Maximum four per name, except Basic Energy. You need at least one Basic Pokémon.</p><label>Choose a deck<select id="deck-preset"><option value="">Custom selection</option>${presetOptions}</select></label><p id="deck-count"></p>${cards.map(c=>`<div class="deck-row"><button type="button" class="deck-card" data-card="${esc(c.id)}">${esc(c.name)} <small>(${count(c.id)} owned)</small></button><label>Copies<input data-deck="${c.id}" type="number" min="0" max="${c.supertype==='Energy'&&c.subtypes?.includes('Basic')?count(c.id):Math.min(4,count(c.id))}" value="${deck.get(c.id)||0}"></label></div>`).join('')}<div class="deck-save"><label>Save custom deck<input id="deck-name" maxlength="40" placeholder="e.g. My first deck"></label><button type="button" id="save-deck">Save deck</button></div><label>Game room (share this with your opponent)<input id="room" value="${crypto.randomUUID().slice(0,18)}" pattern="[a-z0-9-]{8,64}"></label><label>Your game identity (shown on the Battle page)<input id="player" placeholder="64-character public key"></label><p>Reveal consent: the selected card IDs and their mint-signed possession certificate will be visible to the game and opponent for 24 hours. Your wallet keys and spending secrets will not be included.</p><button class="primary" id="reveal">Reveal selected deck to the napplet ↗</button><p><a href="game.html" target="_blank" rel="noopener">Open battle table to get your identity ↗</a></p></div>`;
  document.querySelector('#deck-preset').onchange=e=>run(()=>applyPreset(e.target.value));
  const update=()=>document.querySelector('#deck-count').textContent=`${[...deck.values()].reduce((a,b)=>a+b,0)} / 60 selected`;
  container.querySelectorAll('[data-deck]').forEach(input=>input.oninput=()=>{const n=Number(input.value);if(Number.isInteger(n)&&n>=0&&n<=Number(input.max))deck.set(input.dataset.deck,n);update();});update();
  document.querySelector('#save-deck').onclick=()=>run(async()=>{const name=document.querySelector('#deck-name').value.trim();if(!name)throw new Error('Name your custom deck first');const ids=[...deck].flatMap(([id,n])=>Array(n).fill(id));validateDeck(ids);const cards=Object.fromEntries([...deck].filter(([,n])=>n>0));const decks=savedDecks().filter(d=>d.name!==name);decks.push({name,cards});localStorage.setItem(customDeckKey,JSON.stringify(decks));deckBuilder();tell(`${name} saved in this wallet.`);});
  hydrate(container);
  const savedKey=localStorage.getItem('pokemon:game:pubkey');if(savedKey)document.querySelector('#player').value=savedKey;
  document.querySelector('#reveal').onclick=()=>run(async()=>{
    if(offline)throw new Error('Reconnect to verify ownership');
    const room=document.querySelector('#room').value.trim(),player=document.querySelector('#player').value.trim();
    if(!/^[a-f0-9]{64}$/.test(player)||!/^[a-z0-9-]{8,64}$/.test(room))throw new Error('Enter a valid game identity and room');
    const ids=[...deck].flatMap(([id,n])=>Array(n).fill(id));validateDeck(ids);await refresh();
    const secrets=[...deck].flatMap(([id,n])=>{const items=owned.filter(i=>i.asset.asset_id===id);if(items.length<n)throw new Error('Selected cards are no longer owned');return items.slice(0,n).map(i=>i.proof.secret);});
    const certificate=await wallet.revealDeck(location.origin,secrets,player,room);download('pokemon-play-certificate.json',{certificate});tell('Play certificate exported. Import it in the napplet; share the room with your opponent.');
  });
}
async function route(){const view=location.hash.slice(1)||'store';document.querySelectorAll('nav a').forEach(a=>a.getAttribute('href')==='#'+view?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current'));if(view==='store')store();else collection(view==='wallet'?'wallet':'catalog');}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;});
window.addEventListener('hashchange',()=>run(route));
if('serviceWorker'in navigator)navigator.serviceWorker.register('/pokemon/sw.js').catch(error=>tell(error.message));
try{await loadCatalog();await refresh();await route();}catch(error){app.innerHTML='<section class="panel"><h1>Could not verify your collection.</h1><p>Keep your wallet backup. Reload after the mint is available.</p></section>';tell(error.message);}
