import {Space} from './core/space.js';
import {WindowManager} from './core/windows.js';
import {glass} from './core/glass.js';
import {Orientation} from './tracking/orientation.js';
import {HandTracking} from './tracking/hands.js';
import {apps} from './apps/index.js';

const stage=document.getElementById('stage'),windows=document.getElementById('windows');
const wm=new WindowManager(windows);const space=new Space(document.getElementById('scene'));
const toast=(msg)=>{const t=document.createElement('div');t.className='glass toast';t.textContent=msg;
 document.getElementById('toasts').append(t);setTimeout(()=>t.remove(),3500);};

const envs=['dark','future','light','work'];let envIndex=0;
document.getElementById('envBtn').onclick=()=>{envIndex=(envIndex+1)%envs.length;
 const e=envs[envIndex];space.build(e);glass.set(e);toast('Environment: '+e);};

const orientation=new Orientation(q=>{stage.style.transform=`rotateX(${q.b*.15}deg) rotateY(${q.g*.15}deg)`;});
document.getElementById('trackBtn').onclick=async()=>{try{
 if(orientation.enabled){orientation.stop();toast('Orientation tracking stopped');}
 else{await orientation.start();toast('Orientation tracking enabled');}}catch(e){toast(e.message)}};

let stream;
document.getElementById('camBtn').onclick=async()=>{try{
 if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;toast('Camera stopped');return;}
 stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
 const v=document.createElement('video');v.srcObject=stream;v.autoplay=true;v.playsInline=true;v.muted=true;
 wm.open({id:'camera',title:'Camera',icon:'📷',html:'',onMount:b=>b.append(v)});
 toast('Rear camera active');}catch(e){toast('Camera unavailable: '+e.message)}};

const dock=document.getElementById('dock');
apps.forEach(a=>{const b=document.createElement('button');b.className='glass';b.textContent=a.icon;b.title=a.title;
 b.onclick=()=>{wm.open({id:a.id,title:a.title,icon:a.icon,html:a.html,onMount:b=>a.mount?.(b)});};dock.append(b);});

if('serviceWorker' in navigator&&location.protocol==='https:'){
 navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
}
