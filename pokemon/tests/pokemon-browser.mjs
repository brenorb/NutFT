// Run after npm run build:pokemon: node tests/pokemon-browser.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyMatch,E} from '../site/pokemon/replay.mjs';
import * as cashu from '@cashu/cashu-ts';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=createRequire(require.resolve('../pokemon-napplet/node_modules/@napplet/conformance-cli/package.json'))('playwright');
const {createPokemonServer}=require('../server/pokemon.js');
const dir=await mkdtemp(join(tmpdir(),'pokemon-browser-'));
const origin='http://127.0.0.1:18779',server=await createPokemonServer({port:18779,origin,stateDir:dir});
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
try {
  const sessions=[];
  for(let i=0;i<2;i++) {
    const context=await browser.newContext({viewport:{width:i?390:1280,height:850}}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    if(!i)await context.addInitScript(()=>{
      // A deterministic NIP-07 test signer, injected only in this disposable test profile.
      const key='04'.repeat(32),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
      window.nostr={getPublicKey:async()=>hex(window.__cashu.getPubKeyFromPrivKey(Uint8Array.from(key.match(/../g),h=>parseInt(h,16)))).slice(-64),signEvent:async template=>{const e={...template,pubkey:await window.nostr.getPublicKey()};e.id=await window.E1Schnorr.eventId(e);e.sig=window.__cashu.schnorrSignDigest(e.id,key);return e;}};
    });
    await page.goto(origin+'/pokemon/game.html');
    await page.locator(i?'#test-identity':'#sign-in').click();
    const frame=page.frameLocator('#game');await frame.locator('#reveal').waitFor();
    const pub=await page.locator('#game-identity').textContent();assert.match(pub,/^[a-f0-9]{64}$/);
    const wallet=await context.newPage();await wallet.goto(origin+'/pokemon/');
    assert.match(await wallet.locator('.test-strip').textContent(),/Nut Fungible Token \(NutFT\) PoC/);
    const product=i?'brushfire':'blackout';
    await wallet.locator(`[data-buy-deck="${product}"]`).waitFor({timeout:5000});
    assert.equal(await wallet.locator('[data-buy-deck]').count(),4);
    assert.equal(await wallet.locator('.hero h1').textContent(),'Gotta cashu ’em all.');
    assert.match(await wallet.locator('.hero').textContent(),/Crack a pack\. Go nuts\./);
    await wallet.locator(`[data-buy-deck="${product}"]`).click();
    await wallet.locator('#deck-count').filter({hasText:'60 / 60 selected'}).waitFor().catch(async error=>{console.log('Deck purchase diagnostics',await wallet.locator('#status').textContent(),await wallet.locator('#deck').textContent(),wallet.url(),await wallet.evaluate(async()=>{const s=await window.NutFTWallet.snapshot(location.origin);return {owned:s.owned.length,counts:s.owned.reduce((a,i)=>(a[i.asset.asset_id]=(a[i.asset.asset_id]||0)+1,a),{}),invalid:s.invalid.map(i=>i.error),unreadable:s.unreadable.map(i=>i.error)};}));throw error;});
    assert.equal(await wallet.locator('#deck-preset option').filter({hasText:'Brushfire'}).count(),i?1:0);
    assert.equal(await wallet.locator('#deck-preset option').filter({hasText:'Blackout'}).count(),i?0:1);
    await wallet.locator('.deck-card').first().hover();
    assert.equal(await wallet.locator('.deck-card').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    await wallet.locator('.deck-card').first().click();
    await wallet.locator('#detail[open]').waitFor();
    assert.match(await wallet.locator('#detail-body').textContent(),/BASE SET/);
    await wallet.locator('#close-detail').click();
    await wallet.locator('#deck-name').fill('My saved deck');
    await wallet.locator('#save-deck').click();
    await wallet.locator('#deck-preset option').filter({hasText:'My saved deck'}).waitFor({state:'attached'});
    await wallet.locator('#deck-preset').selectOption('custom:My saved deck');
    await wallet.locator('#deck-count').filter({hasText:'60 / 60 selected'}).waitFor();
    await wallet.reload();
    await wallet.locator('#deck-toggle').click();
    await wallet.locator('#deck-preset option').filter({hasText:'My saved deck'}).waitFor({state:'attached'});
    const cert=await wallet.evaluate(async pub=>{
      const snapshot=await window.NutFTWallet.snapshot(location.origin);
      if(snapshot.owned.length!==60||snapshot.invalid.length)throw new Error('Deck was not issued correctly');
      return window.NutFTWallet.revealDeck(location.origin,snapshot.owned.map(row=>row.proof.secret),pub,'browser-match-test');
    },pub);
    if(!i) {
      await wallet.goto(origin+'/pokemon/#store');await wallet.locator('#mint').waitFor();
      const quote=await wallet.evaluate(async()=>await(await fetch('/nutft/quote')).json());
      assert.equal(quote.cards,null);assert.equal(quote.beacon,undefined);
      await wallet.locator('#mint').click();
      await wallet.locator('#app').filter({hasText:'71 cards'}).waitFor();
      assert.equal(new URL(wallet.url()).hash,'#wallet');
      assert.match(await wallet.locator('#status').textContent(),/11 cards.*verified/);
      assert.equal((await wallet.evaluate(()=>window.NutFTWallet.snapshot(location.origin))).owned.length,71);
    }
    await frame.locator('#reveal').setInputFiles({name:'certificate.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({certificate:cert}))});
    await frame.locator('#create').waitFor();sessions.push({page,context,frame,wallet,pub});
  }
  const [a,b]=sessions;
  await a.frame.locator('#create').click();
  const invite=await a.frame.getByLabel('Share this invitation').inputValue();
  await b.frame.locator('#invite').fill(invite);await b.frame.locator('#join').click();
  await a.frame.locator('.matchbar').waitFor();await b.frame.locator('.matchbar').waitFor();
  assert.equal(await a.frame.locator('#confirm').count()+await b.frame.locator('#confirm').count(),1,'Only one player can answer the next setup choice');
  for(let step=0;step<20;step++) {
    let answered=false;
    for(const {frame} of sessions) {
      if(await frame.locator('#confirm').isVisible()) {
        await frame.locator('#options button').first().click();await frame.locator('#confirm').click();answered=true;
      }
    }
    if(await a.frame.locator('.matchbar b').filter({hasText:'Turn 1'}).count()&&await b.frame.locator('.matchbar b').filter({hasText:'Turn 1'}).count()&&!answered&&!(await a.frame.locator('.decision').count())&&!(await b.frame.locator('.decision').count()))break;
    await new Promise(r=>setTimeout(r,1000));
  }
  await a.frame.getByText('Your hand',{exact:true}).waitFor();await b.frame.getByText('Your hand',{exact:true}).waitFor();
  assert.equal(await a.frame.locator('#notice').textContent(),'');assert.equal(await b.frame.locator('#notice').textContent(),'');
  const turn=await a.frame.locator('.matchbar b').textContent();
  const first=turn.includes('Player 1')?a:b;await first.frame.locator('#pass').click();
  await a.frame.locator('.matchbar b').filter({hasText:'Turn 2'}).waitFor({timeout:10000}).catch(async e=>{console.log('Game diagnostics',await a.frame.locator('.matchbar,#notice,#prompt').allTextContents(),await b.frame.locator('.matchbar,#notice,#prompt').allTextContents());throw e;});
  await a.page.reload();await a.page.locator('#sign-in').click();await a.frame.locator('.matchbar b').filter({hasText:'Turn 2'}).waitFor();
  const endpoint=origin+'/pokemon/events?room=browser-match-test';
  const recorded=await(await fetch(endpoint)).json(),match=await verifyMatch(recorded,invite.split(':')[1]);
  const keys=['04'.repeat(32),await b.page.evaluate(()=>localStorage.getItem('pokemon:game:key'))];
  let tip=match.tip;
  // Finish a legal deck-out transcript; then exercise automatic result signing in BOTH actual shells.
  while(match.game.state.phase!==E.GamePhase.FINISHED){
    const move={seat:match.game.state.players[match.game.state.activePlayer].id,type:'pass'};match.game.apply(move);
    const e={pubkey:match.players[move.seat-1],kind:1031,tags:[['d','browser-match-test']],created_at:Math.floor(Date.now()/1000),content:JSON.stringify({type:'move',offer:match.offer,previous:tip,move})};
    e.id=createHash('sha256').update(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])).digest('hex');e.sig=cashu.schnorrSignDigest(e.id,keys[move.seat-1]);
    assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(e)})).status,200);tip=e.id;
  }
  await a.frame.getByText(/Signed and saved. Note/).waitFor();await b.frame.getByText(/Signed and saved. Note/).waitFor();
  assert.equal((await(await fetch(endpoint)).json()).filter(e=>e.kind===30078).length,2);
  assert.equal(await a.frame.locator('#new-match').count(),1);
  await a.frame.locator('#new-match').click();await a.frame.locator('#reveal').waitFor();
  await a.page.goto(origin+'/pokemon/replay.html');await a.page.locator('#reference').fill(invite);await a.page.locator('#load').click();await a.page.locator('#viewer').waitFor();assert.match(await a.page.locator('#status').textContent(),/Verified .*signed moves/);
  await a.wallet.reload();await a.wallet.locator('#deck-toggle').waitFor();await a.wallet.evaluate(()=>navigator.serviceWorker.ready);
  await a.context.setOffline(true);await a.wallet.reload();await a.wallet.getByText(/Offline collection/).waitFor();assert.match(await a.wallet.locator('#app').textContent(),/cards ·/);
  assert.deepEqual(errors,[]);
  console.log('PASS: theme deck purchases and selection, NIP-07 and test sign-in, two certificate reveals, serialized automatic setup, signed move, resume, automatic winner notes from both players, replay and offline PWA.');
}finally{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});}
