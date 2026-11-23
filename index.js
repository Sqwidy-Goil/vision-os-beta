export const apps=[
 {id:'browser',icon:'🌐',title:'Browser',html:`<input id="url" placeholder="Search or enter URL"><div class="row"><button id="go">Open</button><button id="ext">Safari</button></div><p class="muted">Many sites block embedding. Use Safari for unsupported pages.</p><iframe id="frame" style="width:100%;height:70vh;border:0;border-radius:14px;background:#000"></iframe>`,
  mount(b){const u=b.querySelector('#url'),f=b.querySelector('#frame');
   const norm=q=>/^https?:/i.test(q)?q:'https://'+q.replace(/^\s+|\s+$/g,'');
   b.querySelector('#go').onclick=()=>{f.src=norm(u.value)};
   b.querySelector('#ext').onclick=()=>open(norm(u.value),'_blank');}},
 {id:'video',icon:'🎬',title:'Video Player',html:`<input type="file" accept="video/*"><video controls playsinline></video>`,
  mount(b){const v=b.querySelector('video');b.querySelector('input').onchange=e=>{const f=e.target.files[0];if(f)v.src=URL.createObjectURL(f);};}},
 {id:'photos',icon:'🖼️',title:'Photo Gallery',html:`<input type="file" accept="image/*" multiple><div id="grid" class="row"></div><img id="full" hidden>`,
  mount(b){const g=b.querySelector('#grid'),full=b.querySelector('#full');
   b.querySelector('input').onchange=e=>{g.innerHTML='';[...e.target.files].forEach(f=>{const i=new Image();i.src=URL.createObjectURL(f);i.onclick=()=>{full.src=i.src;full.hidden=false};g.append(i);});};}},
 {id:'viewer3d',icon:'🧊',title:'3D Viewer',html:`<model-viewer src="https://modelviewer.dev/shared-assets/models/Astronaut.glb" ar camera-controls auto-rotate style="width:100%;height:60vh"></model-viewer>`,
  mount(){import('https://esm.sh/@google/model-viewer@3.4.0');}},
 {id:'music',icon:'🎵',title:'Music',html:`<input type="file" accept="audio/*"><audio controls></audio>`,
  mount(b){const a=b.querySelector('audio');b.querySelector('input').onchange=e=>{const f=e.target.files[0];if(f){a.src=URL.createObjectURL(f);a.play()};};}},
 {id:'keyboard',icon:'⌨️',title:'Keyboard',html:`<input id="out" readonly><div id="keys"></div>`,
  mount(b){const o=b.querySelector('#out'),k=b.querySelector('#keys');
   '1234567890 QWERTYUIOP ASDFGHJKL ZXCVBNM'.split(' ').forEach(row=>{
     const r=document.createElement('div');r.className='row';
     [...row].forEach(ch=>{const btn=document.createElement('button');btn.className='glass';btn.textContent=ch;btn.onclick=()=>o.value+=ch;r.append(btn);});k.append(r);});
   const sp=document.createElement('button');sp.className='glass';sp.textContent='Space';sp.onclick=()=>o.value+=' ';
   const bs=document.createElement('button');bs.className='glass';bs.textContent='⌫';bs.onclick=()=>o.value=o.value.slice(0,-1);
   k.append(sp,bs);}},
 {id:'settings',icon:'⚙️',title:'Settings',html:`<label>Quality <select id="q"><option>low</option><option selected>balanced</option><option>high</option></select></label><p id="perm" class="muted"></p>`,
  mount(b){b.querySelector('#perm').textContent='Camera, motion sensors, and hand tracking require explicit iOS permission and HTTPS.';}},
 {id:'game',icon:'🎮',title:'Orb Catch',html:`<canvas width="360" height="420"></canvas><p>Score: <b id="s">0</b></p><button id="start">Start</button>`,
  mount(b){const c=b.querySelector('canvas'),x=c.getContext('2d');let orbs=[],score=0,run=false;
   const draw=()=>{x.clearRect(0,0,360,420);orbs.forEach(o=>{x.beginPath();x.arc(o.x,o.y,14,0,7);x.fillStyle='#7fd4ff';x.fill();});};
   const loop=()=>{if(!run)return;orbs=orbs.filter(o=>o.y<430);orbs.forEach(o=>o.y+=3+score*.02);draw();requestAnimationFrame(loop);};
   c.onpointerdown=e=>{const r=c.getBoundingClientRect();const px=(e.clientX-r.left)*360/r.width,py=(e.clientY-r.top)*420/r.height;
     orbs=orbs.filter(o=>{const hit=Math.hypot(o.x-px,o.y-py)<22;if(hit)score++;return !hit;});b.querySelector('#s').textContent=score;};
   b.querySelector('#start').onclick=()=>{score=0;orbs=[];run=true;for(let i=0;i<6;i++)orbs.push({x:30+Math.random()*300,y:-Math.random()*300});loop();};}}
];