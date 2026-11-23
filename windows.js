const Z={top:0};
export class WindowManager{
  constructor(host){this.host=host;this.wins=new Map();}
  open({id,title,icon,html,onMount}){
    if(this.wins.has(id)){this.focus(id);this.restore(id);return this.wins.get(id);}
    const el=document.createElement('section');el.className='win';el.dataset.id=id;
    el.innerHTML=`<header class="bar"><span>${icon}</span><h2>${title}</h2>
      <button class="dot minb" data-a="min"></button><button class="dot close" data-a="close"></button></header>
      <div class="body">${html}</div>`;
    const n=this.wins.size;const x=8+ (n%3)*8, y=12+(n%2)*8;
    el.style.left=x+'vw';el.style.top=y+'vh';
    this.host.append(el);this.wins.set(id,{el,open:true});
    this.drag(el);this.focus(id);
    onMount?.(el.querySelector('.body'),el);
    el.addEventListener('click',e=>{const a=e.target.dataset.a;
      if(a==='close')this.close(id);if(a==='min')this.minimize(id);});
    return this.wins.get(id);
  }
  focus(id){const w=this.wins.get(id);if(!w)return;Z.top++;w.el.style.zIndex=Z.top;
    this.wins.forEach(x=>x.el.classList.remove('focused'));w.el.classList.add('focused');}
  close(id){this.wins.get(id)?.el.remove();this.wins.delete(id);}
  minimize(id){this.wins.get(id)?.el.classList.add('min');}
  restore(id){this.wins.get(id)?.el.classList.remove('min');this.focus(id);}
  drag(el){const bar=el.querySelector('.bar');let sx,sy,ox,oy;
    bar.addEventListener('pointerdown',e=>{if(e.target.dataset.a)return;
      sx=e.clientX;sy=e.clientY;ox=parseFloat(el.style.left);oy=parseFloat(el.style.top);
      bar.setPointerCapture(e.pointerId);this.focus(el.dataset.id);});
    bar.addEventListener('pointermove',e=>{if(sx===undefined)return;
      el.style.left=Math.max(0,Math.min(92,ox+(e.clientX-sx)/innerWidth*100))+'vw';
      el.style.top=Math.max(0,Math.min(70,oy+(e.clientY-sy)/innerHeight*100))+'vh';});
    bar.addEventListener('pointerup',()=>{sx=undefined;});
  }
}