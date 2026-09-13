"use strict";
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { schnorr } = require('@noble/curves/secp256k1');
const { createNutftMint } = require('./nutft-mint');
const { censusHash } = require('./nutft-draw');
const ROOT = path.resolve(__dirname, '..');
const canonical = v => Array.isArray(v) ? `[${v.map(canonical)}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)}}` : JSON.stringify(v);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const json = (res, code, value) => { res.writeHead(code, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(value)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 512000) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function createPokemonServer(options = {}) {
  const port = options.port ?? Number(process.env.POKEMON_PORT || 8778);
  const origin = options.origin || process.env.POKEMON_ORIGIN || `http://localhost:${port}`;
  const stateDir = options.stateDir || path.join(ROOT, '.pokemon-state');
  fs.mkdirSync(stateDir, {recursive:true, mode:0o700});
  const db = new DatabaseSync(path.join(stateDir,'mint.db'));
  db.exec('CREATE TABLE IF NOT EXISTS pokemon_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pokemon_events (id TEXT PRIMARY KEY,room TEXT NOT NULL,event TEXT NOT NULL);');
  let key = db.prepare('SELECT value FROM pokemon_meta WHERE key=?').get('issuer')?.value;
  if (!key) { key = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO pokemon_meta VALUES (?,?)').run('issuer',key); }
  const cards = require('../cards/pokemon-base.json');
  const payload = {schema:'pokemon-nutft-catalog-v1',collection_id:'POKEMON-BASE-POC',name:'Pokémon Base Set — unofficial PoC',watermark:'POC · TEST ONLY · NO VALUE',assets:cards};
  const manifest = {...payload, issuer_pubkey:Buffer.from(schnorr.getPublicKey(key)).toString('hex'), signature:Buffer.from(schnorr.sign(hash(canonical(payload)),key,new Uint8Array(32))).toString('hex')};
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const digest = hash(manifestBytes);
  const catalogUri = `${origin}/blossom/${digest}`;
  const counts = {};
  const census = {tiers:{},mint:{packs:10000,cards_per_pack:11,paid_cards_per_pack:11,slots:{common:5,uncommon:3,prime:1,energy:2}},cards:cards.map(c => {
    const pool = c.supertype === 'Energy' && c.subtypes.includes('Basic') ? 'energy' : c.rarity === 'Common' ? 'common' : c.rarity === 'Uncommon' ? 'uncommon' : 'prime';
    const copies = pool === 'prime' ? (c.rarity === 'Rare Holo' ? 200 : 700) : 20000;
    counts[c.id] = copies;
    return {...c,pool,copies};
  })};
  census.census_sha256 = censusHash(counts);
  const censusPath = path.join(stateDir,'census.json'); fs.writeFileSync(censusPath,JSON.stringify(census));
  const beaconKey = 'beacon'; let beacon = db.prepare('SELECT value FROM pokemon_meta WHERE key=?').get(beaconKey)?.value;
  if (!beacon) { beacon=crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO pokemon_meta VALUES (?,?)').run(beaconKey,beacon); }
  const mint = createNutftMint({db,censusPath,collectionId:payload.collection_id,catalogUri,catalogPrivateKey:key,catalogManifest:manifest,beacon,lnd:null,sales:'open',unlimitedPurchases:true,decks:require('../cards/pokemon-decks.json')});
  const allowed = new Map([
    ['/pokemon/decks.json',path.join(ROOT,'cards/pokemon-decks.json')],
    ['/nutft-wallet.js',path.join(ROOT,'site/nutft-wallet.js')],
    ['/schnorr.js',path.join(ROOT,'site/schnorr.js')],
  ]);
  const mime = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url,origin);
      if (!['GET','HEAD','POST'].includes(req.method)) return json(res,405,{error:'Method not allowed'});
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin && req.headers.origin !== `http://${req.headers.host}`) return json(res,403,{error:'Origin refused'});
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/nutft/')) return mint.handle(req,res,url);
      if (url.pathname === '/pokemon/config') return json(res,200,{origin,catalog_uri:catalogUri,issuer:manifest.issuer_pubkey,collection_id:payload.collection_id,watermark:payload.watermark});
      if (url.pathname === '/pokemon/events') {
        const room = url.searchParams.get('room');
        if (!/^[a-z0-9-]{8,64}$/.test(room || '')) return json(res,400,{error:'Invalid room'});
        if (req.method === 'GET') return json(res,200,db.prepare('SELECT event FROM pokemon_events WHERE room=? ORDER BY rowid LIMIT 2000').all(room).map(row=>JSON.parse(row.event)));
        const event = await body(req);
        if (![1031,30078].includes(event.kind) || !Number.isInteger(event.created_at) || Math.abs(event.created_at - Date.now()/1000)>86400 || typeof event.content!=='string' || event.content.length>100000 || !Array.isArray(event.tags) || !event.tags.some(t=>Array.isArray(t)&&t[0]===(event.kind===1031?'d':'room')&&t[1]===room)) throw new Error('Invalid game event');
        const id = hash(JSON.stringify([0,event.pubkey,event.created_at,event.kind,event.tags,event.content]));
        if (id !== event.id || !schnorr.verify(event.sig,id,event.pubkey)) throw new Error('Invalid event signature');
        if(event.kind===30078) {
          const {verifyMatch,verifyResult}=await import('../site/pokemon/replay.mjs');
          const events=db.prepare('SELECT event FROM pokemon_events WHERE room=?').all(room).map(row=>JSON.parse(row.event));
          await verifyResult(event,await verifyMatch(events,JSON.parse(event.content).offer));
        }
        if (db.prepare('SELECT count(*) AS n FROM pokemon_events WHERE room=?').get(room).n >= 2000) throw new Error('Game event limit reached');
        db.prepare('INSERT OR IGNORE INTO pokemon_events VALUES (?,?,?)').run(id,room,JSON.stringify(event));
        return json(res,200,event);
      }
      if (url.pathname === `/blossom/${digest}`) { res.writeHead(200,{'content-type':'application/json','content-length':manifestBytes.length,'cache-control':'public,max-age=31536000,immutable','access-control-allow-origin':'*'}); return res.end(manifestBytes); }
      if (/^\/blossom\/[a-f0-9]{64}$/.test(url.pathname)) {
        const file = path.join(ROOT,'art/pokemon-blossom',url.pathname.split('/').pop());
        if (!fs.existsSync(file)) return json(res,404,{error:'Blob not found'});
        res.writeHead(200,{'content-type':'image/png','cache-control':'public,max-age=31536000,immutable','access-control-allow-origin':'*'}); return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname === '/pokemon/runtime.html') {
        const artifact = fs.readFileSync(path.join(ROOT,'pokemon-napplet/dist/index.html'),'utf8');
        const prelude = fs.readFileSync(path.join(ROOT,'site/pokemon/runtime-prelude.js'),'utf8');
        const injection = `<script>${prelude.replaceAll('</script','<\\/script')}\nglobalThis.NappletShimPrelude.install({domains:['identity','outbox','theme','storage']});</script>`;
        res.writeHead(200,{'content-type':'text/html','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'"});
        return res.end(artifact.replace('<head>','<head>'+injection));
      }
      let file = allowed.get(url.pathname);
      const name = url.pathname === '/' || url.pathname === '/pokemon/' ? 'index.html' : url.pathname.startsWith('/pokemon/') ? url.pathname.slice(9) : '';
      if (!file && /^[a-zA-Z0-9_.-]+$/.test(name)) file = path.join(ROOT,'site/pokemon',name);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res,404,{error:'Not found'});
      res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff'});
      fs.createReadStream(file).pipe(res);
    } catch(error) { if (!res.headersSent) json(res,400,{error:error.message}); else res.end(); }
  });
  await new Promise(resolve=>server.listen(port,options.host || process.env.POKEMON_HOST || '127.0.0.1',resolve));
  return {server,db,mint,origin,catalogUri,manifest,close:()=>new Promise(resolve=>server.close(()=>{mint.stop();db.close();resolve();}))};
}
if (require.main===module) createPokemonServer().then(app=>console.log(`Pokémon PoC · TEST ONLY · ${app.origin}/pokemon/`));
module.exports={createPokemonServer,canonical};
