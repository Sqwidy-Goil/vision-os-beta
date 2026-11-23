export class Orientation{
  constructor(apply){this.apply=apply;this.q={a:0,b:0,g:0};this.enabled=false;}
  async start(){
    if(typeof DeviceOrientationEvent!=='undefined'&&DeviceOrientationEvent.requestPermission){
      try{const p=await DeviceOrientationEvent.requestPermission();if(p!=='granted')throw new Error('Orientation permission denied');}
      catch(e){throw e;}
    }
    this.handler=e=>{if(!this.enabled)return;
      const a=e.alpha??0,b=e.beta??0,g=e.gamma??0;
      this.q={a:this.q.a*.8+a*.2,b:this.q.b*.8+b*.2,g:this.q.g*.8+g*.2};
      this.apply(this.q);};
    addEventListener('deviceorientation',this.handler,{passive:true});this.enabled=true;
  }
  stop(){removeEventListener('deviceorientation',this.handler);this.enabled=false;}
  recenter(){this.q={a:0,b:0,g:0};this.apply(this.q);}
}