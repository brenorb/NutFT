const CACHE='pokemon-poc-v2';
const SHELL=['/pokemon/','/pokemon/decks.json','/pokemon/app.js','/pokemon/style.css','/pokemon/game-style.css','/pokemon/manifest.webmanifest','/pokemon/icon.svg','/pokemon/wallet-deps.js','/pokemon/engine.mjs','/nutft-wallet.js'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==location.origin)return;
  const immutable=/^\/blossom\/[a-f0-9]{64}$/.test(url.pathname);
  if(!immutable&&!SHELL.includes(url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);const saved=await cache.match(event.request);
    if(immutable&&saved)return saved;
    try{const response=await fetch(event.request);if(response.ok)await cache.put(event.request,response.clone());return response;}catch(error){if(saved)return saved;throw error;}
  })());
});
