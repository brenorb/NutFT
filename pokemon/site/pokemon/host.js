// Shell-owned signing, persistence and network; never bundled in the napplet.
const c=window.__cashu,hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const unhex=s=>Uint8Array.from(s.match(/../g),h=>parseInt(h,16));
const frame=document.querySelector('#game'),status=document.querySelector('#shell-status');
let pub='',signer=null;
const send=data=>frame.contentWindow.postMessage(data,'*');
const palette={background:'#f4f0dc',text:'#182b40',primary:'#d84432',surface:'#fffdf3',border:'#233a50',muted:'#596877'};
async function enter(test=false) {
  try {
    let sign;
    if(test) {
      let key=localStorage.getItem('pokemon:game:key');
      if(!key){key=hex(c.createRandomSecretKey());localStorage.setItem('pokemon:game:key',key);}
      pub=hex(c.getPubKeyFromPrivKey(unhex(key))).slice(-64);
      sign=async template=>{const e={...template,pubkey:pub};e.id=await window.E1Schnorr.eventId(e);e.sig=c.schnorrSignDigest(e.id,key);return e;};
    } else {
      if(!window.nostr?.getPublicKey||!window.nostr?.signEvent)throw new Error('Install or enable a NIP-07 Nostr signer, then retry.');
      pub=await window.nostr.getPublicKey();sign=e=>window.nostr.signEvent(e);
    }
    const challenge={kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['challenge',crypto.randomUUID()],['relay',location.origin]],content:'Sign in to Pokémon Base Set PoC. This challenge is not published.'};
    const proof=await sign(challenge);
    if(proof.pubkey!==pub||proof.kind!==challenge.kind||proof.created_at!==challenge.created_at||proof.content!==challenge.content||JSON.stringify(proof.tags)!==JSON.stringify(challenge.tags)||!await window.E1Schnorr.verifyEvent(proof))throw new Error('Invalid sign-in signature');
    signer=sign;localStorage.setItem('pokemon:game:pubkey',pub);
    document.querySelector('#game-identity').textContent=pub;
    document.querySelector('#login').hidden=true;status.textContent=test?'Signed in with a local test identity.':'Signed in with your Nostr identity.';
    frame.src='/pokemon/runtime.html';frame.hidden=false;
  }catch(error){status.textContent=error.message;}
}
document.querySelector('#sign-in').onclick=()=>enter();
document.querySelector('#test-identity').onclick=()=>enter(true);
window.addEventListener('message',async message=>{
  if(message.source!==frame.contentWindow||!signer||!message.data||typeof message.data.type!=='string')return;
  const e=message.data;
  try {
    switch(e.type){
      case 'identity.getPublicKey':return send({type:e.type+'.result',id:e.id,pubkey:pub});
      case 'theme.get':return send({type:e.type+'.result',id:e.id,theme:{mode:'light',colors:palette}});
      case 'storage.get':return send({type:e.type+'.result',id:e.id,value:localStorage.getItem('pokemon:napplet:'+pub+':'+e.key)});
      case 'storage.set':if(typeof e.key!=='string'||typeof e.value!=='string'||e.value.length>512000)throw new Error('Storage quota exceeded');localStorage.setItem('pokemon:napplet:'+pub+':'+e.key,e.value);return send({type:e.type+'.result',id:e.id});
      case 'outbox.query': {
        const filter=e.filters?.[0],room=filter?.['#d']?.[0]||filter?.['#room']?.[0];if(!/^[a-z0-9-]{8,64}$/.test(room||''))throw new Error('Invalid game query');
        const response=await fetch('/pokemon/events?room='+encodeURIComponent(room));if(!response.ok)throw new Error('Game history unavailable');
        const events=[];for(const event of await response.json())if((!filter.ids||filter.ids.includes(event.id))&&(!filter.kinds||filter.kinds.includes(event.kind))&&await window.E1Schnorr.verifyEvent(event))events.push({event,relays:[]});
        return send({type:'outbox.query.result',id:e.id,events});
      }
      case 'outbox.publish': {
        const template=e.event,room=template?.tags?.find(t=>t[0]===(template.kind===1031?'d':'room'))?.[1];
        if(![1031,30078].includes(template.kind)||typeof template.content!=='string'||template.content.length>100000||!/^[a-z0-9-]{8,64}$/.test(room||''))throw new Error('Only Pokémon PoC game messages are allowed');
        const event=await signer(template);
        if(event.pubkey!==pub||event.kind!==template.kind||event.created_at!==template.created_at||event.content!==template.content||JSON.stringify(event.tags)!==JSON.stringify(template.tags)||!await window.E1Schnorr.verifyEvent(event))throw new Error('Signer returned a different or invalid event');
        const response=await fetch('/pokemon/events?room='+encodeURIComponent(room),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});if(!response.ok)throw new Error(await response.text());
        const matches=JSON.parse(localStorage.getItem('pokemon:matches')||'[]'),body=JSON.parse(event.content),offer=body.type==='offer'?event.id:body.offer;
        if(offer&&!matches.some(m=>m.offer===offer)){matches.push({room,offer});localStorage.setItem('pokemon:matches',JSON.stringify(matches));}
        return send({type:'outbox.publish.result',id:e.id,ok:true,event,relays:[]});
      }
    }
  }catch(error){status.textContent=error.message;send({type:e.type+'.result',id:e.id,ok:false,error:error.message});}
});
