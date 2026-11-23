const C='visi0n-v1';const A=['./','./index.html','./manifest.json','./src/main.js','./src/styles/main.css'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim();});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
  if(e.request.url.startsWith(self.location.origin))caches.open(C).then(c=>c.put(e.request,res.clone()));return res;}).catch(()=>caches.match('./index.html'))));});