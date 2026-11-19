'use strict';
const SHELL='shell-v1',IMG='img-v1',STATE='state-v1';
const FILES=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(SHELL).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>![SHELL,IMG,STATE].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    // network-first so updates arrive, fall back to cache offline
    e.respondWith(fetch(req).then(r=>{const cp=r.clone();caches.open(SHELL).then(c=>c.put(req,cp));return r}).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html'))));
  }else if(req.destination==='image'){
    e.respondWith(caches.open(IMG).then(async c=>{
      const hit=await c.match(req);
      const net=fetch(req).then(r=>{if(r.ok||r.type==='opaque')c.put(req,r.clone());return r}).catch(()=>hit);
      return hit||net;
    }));
  }
});

self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='snapshot'){
    e.waitUntil(caches.open(STATE).then(c=>c.put('./__snapshot',new Response(JSON.stringify(e.data.items)))));
  }
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if('focus' in c)return c.focus()}
    return self.clients.openWindow('./');
  }));
});

/* ---- background check (Chrome Periodic Background Sync, installed PWA only) ---- */
self.addEventListener('periodicsync',e=>{if(e.tag==='check-anime')e.waitUntil(bgCheck())});

const Q=`query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id status nextAiringEpisode{episode airingAt}
 relations{edges{relationType node{id type format status title{romaji english}}}}}}}`;
const tt=m=>m.title.english||m.title.romaji;

async function bgCheck(){
  const c=await caches.open(STATE);
  const r=await c.match('./__snapshot');if(!r)return;
  const items=await r.json();if(!items.length)return;
  const pr=await c.match('./__pending');const pending=pr?await pr.json():[];
  const add=a=>{if(!pending.some(x=>x.key===a.key)){pending.push(Object.assign({ts:Date.now(),read:false},a));
    self.registration.showNotification(a.title,{body:a.text,icon:'icon-192.png',badge:'icon-192.png',tag:a.key,data:{url:'./'}})}};
  for(let k=0;k<items.length;k+=50){
    const ids=items.slice(k,k+50).map(i=>i.id);
    let d;try{
      const res=await fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({query:Q,variables:{ids}})});
      d=(await res.json()).data;
    }catch(e){return}
    if(!d)return;
    for(const m of d.Page.media){
      const it=items.find(i=>i.id===m.id);if(!it)continue;
      const seq=(m.relations?.edges||[]).filter(e=>e.relationType==='SEQUEL'&&e.node.type==='ANIME'&&e.node.format!=='MUSIC')
        .map(e=>({id:e.node.id,title:tt(e.node),format:e.node.format,status:e.node.status}));
      for(const s of seq){
        const old=(it.sequels||[]).find(x=>x.id===s.id);
        if(!old)add({key:`seq-${it.id}-${s.id}`,type:'season',animeId:it.id,title:'Новий сезон: '+s.title,text:`Продовження «${it.title}» ${s.status==='NOT_YET_RELEASED'?'анонсовано':'вже виходить'}`});
        else if(old.status==='NOT_YET_RELEASED'&&s.status!=='NOT_YET_RELEASED')add({key:`seqrel-${it.id}-${s.id}`,type:'season',animeId:it.id,title:'Вийшов сезон: '+s.title,text:`Почав виходити продовження «${it.title}»`});
      }
      it.sequels=seq;
      if(it.nextEp&&it.nextEp.airingAt*1000<=Date.now()&&['watching','planned'].includes(it.status))
        add({key:`ep-${it.id}-${it.nextEp.episode}`,type:'episode',animeId:it.id,title:`${it.title}: серія ${it.nextEp.episode}`,text:'Вийшла нова серія'});
      it.nextEp=m.nextAiringEpisode||null;
    }
  }
  await c.put('./__snapshot',new Response(JSON.stringify(items)));
  await c.put('./__pending',new Response(JSON.stringify(pending)));
}
