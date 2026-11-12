const { chromium, firefox } = require('playwright');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
(async()=>{
 const server=createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<video muted></video>');return;}try{const b=readFileSync(process.env.CENC_FIXTURE_DIR+req.url);const m=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');let a=m?+m[1]:0,z=m&&m[2]?Math.min(+m[2],b.length-1):b.length-1;res.writeHead(m?206:200,{'Content-Type':'video/mp4','Content-Length':z-a+1,'Accept-Ranges':'bytes',...(m?{'Content-Range':`bytes ${a}-${z}/${b.length}`}:{})});res.end(b.subarray(a,z+1));}catch{res.writeHead(404).end();}}).listen(4189,'127.0.0.1');
 const engine=process.env.CENC_BROWSER || 'chromium';
 const browser=await (engine==='firefox'?firefox:chromium).launch({headless:true,...(engine==='firefox'?{firefoxUserPrefs:{'media.autoplay.default':0,'media.eme.enabled':true}}:{args:['--autoplay-policy=no-user-gesture-required']})});
 console.log(JSON.stringify({engine,version:browser.version()}));
 try{for(const file of process.argv.slice(2))for(const mode of ['direct','mse']){
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4189');
 const r=await page.evaluate(async({file,mode})=>{
 const v=document.querySelector('video'),events=[];for(const e of ['error','encrypted','waitingforkey','loadedmetadata','loadeddata','playing'])v.addEventListener(e,()=>events.push({e,error:v.error?.message,code:v.error?.code}));
 try{if(!file.startsWith('clear')){const a=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['keyids'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42c01e"'}]}]);const k=await a.createMediaKeys();await v.setMediaKeys(k);const s=k.createSession();s.addEventListener('message',async()=>{await s.update(new TextEncoder().encode(JSON.stringify({keys:[{kty:'oct',kid:'ESIzRFVmd4iZAKq7zN3u_w',k:'ABEiM0RVZneImaq7zN3u_w'}],type:'temporary'})));events.push({keyStatus:[...s.keyStatuses.values()]});});await s.generateRequest('keyids',new TextEncoder().encode(JSON.stringify({kids:['ESIzRFVmd4iZAKq7zN3u_w']})));}
 if(mode==='direct')v.src='/'+file;
 else{const ms=new MediaSource();v.src=URL.createObjectURL(ms);await new Promise(r=>ms.addEventListener('sourceopen',r,{once:true}));const sb=ms.addSourceBuffer('video/mp4; codecs="avc1.42c01e"');sb.addEventListener('error',()=>events.push({sbError:true}));const b=await(await fetch('/'+file)).arrayBuffer();sb.appendBuffer(b);}
 v.play().catch(e=>events.push({play:e.message}));await Promise.race([new Promise(r=>setTimeout(r,3000)),new Promise(r=>v.addEventListener('error',r,{once:true}))]);return{time:v.currentTime,width:v.videoWidth,frames:v.getVideoPlaybackQuality().totalVideoFrames,events};}catch(e){return{error:e.message,events};}
 },{file,mode});console.log(JSON.stringify({engine,file,mode,...r}));await page.close();}
 }finally{await browser.close();server.close();}
})();
