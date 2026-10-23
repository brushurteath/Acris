// Procedural artwork. One data beacon per visible career record; stars are scenery.
// No third-party image, game asset, renderer dependency or tracking service.
export function mountGalaxy(canvas, records, {onSelect=()=>{},onFocus=()=>{},demo=false}={}) {
  const ctx=canvas.getContext('2d');if(!ctx)return {destroy(){}};
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const colors=[[164,205,221],[193,178,224],[211,189,145],[141,187,177]];
  let width=0,height=0,frame=0,stopped=false,last=0,hover=null,points=[];
  const start=performance.now();
  let seed=71;const random=()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};
  const stars=Array.from({length:390},()=>({x:random(),y:random(),r:random()**4*1.2+.16,a:random()*.4+.08,phase:random()*6.28}));
  const surface=Array.from({length:640},()=>({x:random(),y:random(),r:random(),a:random()}));
  const group = r=>r.major==='计算机类'||r.major==='工学类'?0:r.major==='经济与管理'?1:r.status==='升学'||r.major==='理学'?2:3;
  const lanes=colors.map((color,i)=>({color,count:records.filter(r=>group(r)===i).length}));
  const beacons=records.map((r,i)=>({record:r,lane:group(r),spread:((i*37)%19-9)/9,phase:i*1.71,age:Math.max(0,Math.min(10,new Date().getFullYear()-r.year))}));
  const rgba=(c,a)=>`rgba(${c.join(',')},${Math.min(1,Math.max(0,a))})`;
  function curve(lane,t,spread=0){
    const mobile=width<650;
    const x0=width*(mobile?.07:.2)+lane*width*.018,y0=height*(mobile?.455:.87)+lane*height*.013;
    const x1=width*(mobile?.36:.46),y1=height*(mobile?.30-lane*.02:.79-lane*.045);
    const x2=width*(mobile?.55:.64),y2=height*(mobile?.22+lane*.08:.26+lane*.13)+spread*height*.018;
    const x3=width*(mobile?.95:.91),y3=height*(mobile?.10+lane*.12:.12+lane*.175)+spread*height*.025;
    const a=1-t;return {x:a*a*a*x0+3*a*a*t*x1+3*a*t*t*x2+t*t*t*x3,y:a*a*a*y0+3*a*a*t*y1+3*a*t*t*y2+t*t*t*y3};
  }
  function line(lane,from,to,spread,color,lineWidth=1){ctx.beginPath();for(let i=0;i<=65;i++){const p=curve(lane,from+(to-from)*i/65,spread);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);}ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.stroke();}
  function light(x,y,r,color,power=1){const gradient=ctx.createRadialGradient(x,y,0,x,y,r);gradient.addColorStop(0,rgba(color,.8*power));gradient.addColorStop(.08,rgba(color,.45*power));gradient.addColorStop(.3,rgba(color,.12*power));gradient.addColorStop(1,rgba(color,0));ctx.fillStyle=gradient;ctx.fillRect(x-r,y-r,r*2,r*2);}
  function planet(time){
    const mobile=width<650;
    const cx=width*.02,cy=height*(mobile?1.3:1.73),r=height*(mobile?.9:1.04);
    // A huge, unlit homeworld fills the foreground; the viewer looks past its rim.
    ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.clip();
    const dark=ctx.createRadialGradient(cx+r*.55,cy-r*.95,0,cx,cy,r*1.1);dark.addColorStop(0,'#0b111a');dark.addColorStop(.5,'#05080e');dark.addColorStop(1,'#020305');ctx.fillStyle=dark;ctx.fillRect(0,0,width,height);
    // Night-side land texture, deliberately subtle.
    for(const p of surface){const x=cx-r+2*r*p.x,y=cy-r+p.y*r*.55;ctx.fillStyle=`rgba(45,53,65,${p.a*.08})`;ctx.fillRect(x,y,30+p.r*100,1);}
    const cities=records.length?[...new Set(records.map(r=>r.startCity||r.region))].slice(0,5):[];
    cities.forEach((city,i)=>{const x=width*(.10+i*.045);const y=cy-Math.sqrt(Math.max(0,r*r-(x-cx)**2))+height*.07;light(x,y,30,[204,170,116],.34);for(let j=0;j<31;j++){const a=j*2.4,dist=(j%9)*1.4;ctx.fillStyle=`rgba(236,200,148,${.18+(j%4)*.12})`;ctx.fillRect(x+Math.cos(a)*dist*1.7,y+Math.sin(a)*dist*.5,.6+(j%2),.6);}if(!mobile){ctx.font='8px "Microsoft YaHei",sans-serif';ctx.fillStyle='rgba(205,184,147,.48)';ctx.fillText(city,x+17,y+4);}});
    ctx.restore();
    ctx.beginPath();ctx.arc(cx,cy,r,Math.PI,2*Math.PI);ctx.strokeStyle='rgba(126,156,183,.3)';ctx.shadowBlur=10;ctx.shadowColor='#6988a8';ctx.lineWidth=.7;ctx.stroke();ctx.shadowBlur=0;
    ctx.beginPath();ctx.arc(cx,cy,r+3,Math.PI,2*Math.PI);ctx.strokeStyle='rgba(102,136,171,.055)';ctx.lineWidth=5;ctx.stroke();
    // The central launch city remains a small fixed symbolic light, not a data count.
    const p=curve(0,0);light(p.x,p.y,42,[216,181,129],.8);ctx.fillStyle='#edcf9c';ctx.fillRect(p.x-1,p.y-1,2,2);
    ctx.font='10px "Microsoft YaHei",sans-serif';ctx.fillStyle='rgba(214,196,164,.6)';ctx.fillText('母星 / HOME',width*.065,height*.965);
  }
  function draw(now){
    if(stopped)return;frame=requestAnimationFrame(draw);if(now-last<40&&!reduce)return;last=now;
    const time=reduce?0:(now-start)/1000;
    ctx.clearRect(0,0,width,height);ctx.fillStyle='#030509';ctx.fillRect(0,0,width,height);
    // Sparse distant starlight; the composition stays mostly black.
    for(const s of stars){ctx.fillStyle=`rgba(195,208,225,${s.a*(.85+Math.sin(time*.13+s.phase)*.15)})`;ctx.beginPath();ctx.arc(s.x*width,s.y*height,s.r,0,Math.PI*2);ctx.fill();}
    const haze=ctx.createRadialGradient(width*.77,height*.34,0,width*.77,height*.34,width*.49);haze.addColorStop(0,'rgba(44,54,78,.055)');haze.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=haze;ctx.fillRect(0,0,width,height);
    lanes.forEach((l,i)=>{
      const brightness=Math.min(.7,.065+Math.log10(l.count+1)*.15);
      line(i,0,1,0,rgba(l.color,brightness*.36),.5);
      if(l.count){ctx.save();ctx.globalCompositeOperation='screen';for(let j=0;j<Math.min(l.count,22);j++)line(i,0,.96,((j*7)%13-6)/6,rgba(l.color,brightness*.17),.45);line(i,0,1,0,rgba(l.color,brightness),.75);ctx.restore();}
      const p=curve(i,1);ctx.font='9px ui-monospace,monospace';ctx.fillStyle=rgba(l.color,.42);ctx.fillText(['技术与建造','商业与协作','研究与探索','生活与转向'][i],p.x-55,p.y-13);
    });
    // The year markers are a poetic time coordinate, not physical distance.
    for(const [year,t]of [[1,.13],[2,.27],[5,.54],[10,.88]]){const p=curve(0,t);ctx.beginPath();ctx.moveTo(p.x,p.y-8);ctx.lineTo(p.x,p.y+8);ctx.strokeStyle='rgba(181,194,208,.25)';ctx.lineWidth=.5;ctx.stroke();ctx.font='9px ui-monospace,monospace';ctx.fillStyle='rgba(189,202,215,.58)';ctx.fillText(`${String(year).padStart(2,'0')} LY`,p.x+5,p.y-12);}
    points=[];
    for(const b of beacons){
      const t=.08+b.age/10*.8;const p=curve(b.lane,t,b.spread);const color=colors[b.lane],selected=hover===b.record.id;
      const power=.63+Math.sin(time*.5+b.phase)*.12;line(b.lane,Math.max(0,t-.09),t,b.spread,rgba(color,selected?.75:.22),selected?1.3:.7);light(p.x,p.y,selected?25:12,color,selected?1:power);
      ctx.fillStyle=selected?'#fff':rgba(color,.9);ctx.beginPath();ctx.arc(p.x,p.y,selected?2.4:1.2,0,Math.PI*2);ctx.fill();
      if(selected){ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.lineWidth=.5;ctx.strokeStyle=rgba(color,.6);ctx.stroke();}
      points.push({...p,record:b.record});
    }
    planet(time);
    if(reduce){cancelAnimationFrame(frame);frame=0;}
  }
  function resize(){const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(reduce)draw(performance.now());}
  function locate(e){const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;let found=null,min=20;for(const p of points){const d=Math.hypot(p.x-x,p.y-y);if(d<min){min=d;found=p.record;}}return found;}
  const move=e=>{const r=locate(e);hover=r?.id||null;canvas.style.cursor=r?'pointer':'default';onFocus(r);if(reduce)draw(performance.now());};
  const click=e=>{const r=locate(e);if(r)onSelect(r);};
  canvas.addEventListener('pointermove',move);canvas.addEventListener('click',click);
  const observer=new ResizeObserver(resize);observer.observe(canvas);resize();frame=requestAnimationFrame(draw);
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else if(!frame)frame=requestAnimationFrame(draw);};document.addEventListener('visibilitychange',visibility);
  return {destroy(){stopped=true;cancelAnimationFrame(frame);observer.disconnect();canvas.removeEventListener('pointermove',move);canvas.removeEventListener('click',click);document.removeEventListener('visibilitychange',visibility);},focus(id){hover=id;if(reduce)draw(performance.now());}};
}
