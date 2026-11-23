import * as THREE from 'https://esm.sh/three@0.160.0';
export class Space {
  constructor(canvas){
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.scene=new THREE.Scene();
    this.camera=new THREE.PerspectiveCamera(65,1,.1,100);
    this.camera.position.set(0,0,8);
    this.env=new THREE.Group(); this.scene.add(this.env);
    this.build('dark'); this.resize(); addEventListener('resize',()=>this.resize());
    this.loop();
  }
  build(name){
    this.env.clear();
    const c={dark:0x05070d,future:0x040a18,light:0xdfe9f5,work:0x101826}[name];
    this.scene.background=new THREE.Color(c);
    const geo=new THREE.IcosahedronGeometry(5,2);
    const mat=new THREE.MeshStandardMaterial({color:0x224466,wireframe:true,transparent:true,opacity:.25});
    this.env.add(new THREE.Mesh(geo,mat));
    const light=new THREE.PointLight(0x88bbff,30,50); light.position.set(3,4,6); this.env.add(light);
    this.env.add(new THREE.AmbientLight(0xffffff,.25));
  }
  resize(){const w=innerWidth,h=innerHeight;this.renderer.setSize(w,h,false);
    this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  loop(){requestAnimationFrame(()=>this.loop());this.renderer.render(this.scene,this.camera);}
}