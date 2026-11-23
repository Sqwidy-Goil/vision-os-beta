export class HandTracking{
  constructor(video,onHand){this.video=video;this.onHand=onHand;this.active=false;}
  async start(){
    if(this.active)return;this.active=true;
    const {Hands,CAMERA}=await import('https://esm.sh/@mediapipe/hands@0.4.1675469240');
    this.hands=new Hands({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`});
    this.hands.setOptions({maxNumHands:1,modelComplexity:0,minDetectionConfidence:.6,minTrackingConfidence:.6});
    this.hands.onResults(r=>{
      const lm=r.multiHandLandmarks?.[0];if(!lm)return this.onHand(null);
      const pinch=Math.hypot(lm[4].x-lm[8].x,lm[4].y-lm[8].y)<.06;
      this.onHand({x:lm[8].x,y:lm[8].y,pinch});
    });
    this.cam=new CAMERA(this.video,{onFrame:async()=>{if(this.active)await this.hands.send({image:this.video});},width:320,height:240});
    await this.cam.start();
  }
  stop(){this.active=false;this.cam?.close?.();}
}