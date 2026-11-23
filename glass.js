export const glass = {
  set(env){
    const r=document.documentElement.style;
    const presets={
      dark:{tint:'rgba(255,255,255,.07)',blur:'22px',edge:'.55',depth:'28px'},
      future:{tint:'rgba(120,190,255,.10)',blur:'26px',edge:'.75',depth:'34px'},
      light:{tint:'rgba(255,255,255,.22)',blur:'18px',edge:'.35',depth:'18px'},
      work:{tint:'rgba(150,200,255,.09)',blur:'24px',edge:'.6',depth:'26px'}
    }[env]||{};
    r.setProperty('--glass-tint',presets.tint);
    r.setProperty('--glass-blur',presets.blur);
    r.setProperty('--edge',presets.edge);
    r.setProperty('--depth',presets.depth);
  }
};