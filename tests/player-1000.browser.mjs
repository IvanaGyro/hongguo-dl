// Browser-level verification of long series, real playback UI and control states.
// All media/API responses are fixtures: screenshots show the running app, not AI art.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const ID = '7698294694886788121';
const browser = await chromium.launch({headless:true,
  ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const errors=[];
page.on('pageerror',err=>errors.push(err.message));
await page.addInitScript(seriesId => {
  localStorage.setItem('hongguo-dl-playback-history-v1',JSON.stringify({
    [seriesId+':1514']:{seconds:35,duration:100,completed:false,viewedAt:100},
    [seriesId+':1519']:{seconds:100,duration:100,completed:true,viewedAt:200},
    [seriesId+':1520']:{seconds:62,duration:100,completed:false,viewedAt:300}
  }));
},ID);
await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{ok:true,sourceChannels:false}});
  if(path==='/api/series')return route.fulfill({json:{
    kind:'series',seriesId:ID,title:'千集播放器介面測試（模擬資料）',
    total:1000,accessible:1000,
    episodes:Array.from({length:1000},(_,i)=>({
      index:i+1,vid:String(i+1000),available:true
    }))
  }});
  if(path==='/api/source')return route.fulfill({status:503,
    json:{error:{code:'SOURCE_UNAVAILABLE',message:'No real media in UI test'}}});
  return route.fulfill({status:404,body:'No fixture'});
});
await mkdir('test-results/design-layout',{recursive:true});
const poster='<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">'+
  '<rect width="1280" height="720" fill="#19221b"/>'+
  '<rect x="0" y="0" width="1280" height="720" fill="#101911"/>'+
  '<circle cx="890" cy="380" r="345" fill="#253b2c" opacity=".6"/>'+
  '<circle cx="340" cy="150" r="180" fill="#98542d" opacity=".25"/>'+
  '<text x="640" y="352" text-anchor="middle" fill="#f0f1e9" font-family="sans-serif" font-size="40">播放器介面測試</text>'+
  '<text x="640" y="405" text-anchor="middle" fill="#a8bdaa" font-family="sans-serif" font-size="24">模擬集數與觀看進度 · 無實際影片來源</text></svg>';
try {
  await page.goto((process.env.TEST_BASE_URL||'http://127.0.0.1:4173/')+'?id='+ID);
  await page.locator('#series:not([hidden])').waitFor();
  assert.equal(await page.locator('#episodes .episode').count(),100,
    'Only 100 episodes rendered despite 1000 total');
  assert.match(await page.locator('#episode-range').textContent(),/1–100 \/ 1000/);
  assert.match(await page.locator('#series-count').textContent(),/已選 1000 集/);
  assert.equal(await page.locator('#episode-navigation').isVisible(),true);
  await page.locator('#episode-jump').fill('521');
  await page.locator('#episode-jump-form button').click();
  assert.match(await page.locator('#episode-range').textContent(),/501–600/);
  assert.equal(await page.locator('#episodes .episode').count(),100);
  const selected=await page.locator('#episodes .episode.selected').count();
  assert.equal(selected,100,'Selection persists across paged episode grid');
  await page.locator('#episode-next-range').click();
  assert.match(await page.locator('#episode-range').textContent(),/601–700/);
  await page.locator('#episode-prev-range').click();
  assert.match(await page.locator('#episode-range').textContent(),/501–600/);

  await page.locator('#mode-play').click();
  await page.locator('#episodes .play-episode.current').waitFor();
  const current=await page.locator('#episodes .play-episode.current').evaluate(el=>({
    number:el.textContent.trim(),percent:el.dataset.watchPercent,
    progress:el.style.getPropertyValue('--watch-progress'),aria:el.getAttribute('aria-current')
  }));
  assert.equal(current.number,'521');
  assert.equal(current.progress,'62%');
  assert.equal(current.aria,'true');
  assert.equal(await page.locator('#episodes .play-episode').count(),100);
  assert.equal(await page.locator('#player-autonext').count(),0,
    'Automatic next episode has no user toggle');
  assert.equal(await page.locator('#player-fit').count(),0);
  assert.equal(await page.locator('#player-pip').count(),0);
  assert.equal(await page.locator('media-controls').getAttribute('visibility'),'auto');
  assert.equal(await page.locator('media-gesture[pointer="touch"][action="toggleControls"]').count(),1);
  for(const id of ['player-prev','player-next','player-settings-toggle','player-mute','player-fullscreen']){
    assert.equal(await page.locator('#'+id+' svg.player-icon').count()>=1,true,id+' icon should be SVG');
  }

  await page.evaluate(src=>{
    document.getElementById('player-video').poster=src;
    document.getElementById('player-stage').dataset.orientation='landscape';
    document.getElementById('player-stage').style.setProperty('--media-aspect','16 / 9');
  },'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(poster));
  await page.locator('#player-settings-toggle').click();
  assert.equal(await page.locator('#player-settings').isVisible(),true);
  assert.equal(await page.locator('#player-settings [data-settings-view="root"] button.player-settings-row').count(),2);
  assert.equal(await page.locator('#player-settings').getAttribute('hidden'),null);
  await page.locator('#player-settings [data-settings-target="speed"]').click();
  assert.equal(await page.locator('#player-speed-options .player-settings-choice').count(),7);
  await page.locator('#player-speed-options [data-choice-value="1.5"]').click();
  assert.equal(await page.locator('#player-speed').inputValue(),'1.5');
  assert.equal(await page.locator('#player-speed-summary').textContent(),'1.5×');
  await page.locator('#player-settings [data-settings-target="quality"]').click();
  assert.equal(await page.locator('#player-quality-options .player-settings-choice').count()>=1,true);
  await page.locator('#player-settings [data-settings-target="root"]').click();
  assert.equal(await page.locator('#player-settings [data-settings-view="root"] button.player-settings-row').count(),2);
  // The Video.js controls are only visible while active/paused/menu open.
  const controls=await page.evaluate(()=>{
    const el=document.querySelector('media-controls-content.player-bottom-controls');
    const stage=document.getElementById('player-stage');
    stage.dataset.settingsOpen='false';
    el.removeAttribute('data-visible');
    const hidden=getComputedStyle(el).visibility;
    stage.dataset.settingsOpen='true';
    const locked=getComputedStyle(el).visibility;
    el.setAttribute('data-visible','');
    return {hidden,locked};
  });
  assert.deepEqual(controls,{hidden:'hidden',locked:'visible'});

  await page.screenshot({path:'test-results/design-layout/player-1000-desktop.png',fullPage:true});
  console.log('PASS 1000 episodes, 100 DOM nodes, jump 521, download selection, current fill, menu and hide CSS');
  await page.setViewportSize({width:390,height:844});
  const portraitPoster='<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">'+
    '<rect width="720" height="1280" fill="#0c180f"/>'+
    '<circle cx="490" cy="455" r="300" fill="#284432" opacity=".75"/>'+
    '<circle cx="195" cy="820" r="240" fill="#9c542b" opacity=".26"/>'+
    '<text x="360" y="580" text-anchor="middle" fill="#fff5e9" font-family="sans-serif" font-size="37">播放器介面測試</text>'+
    '<text x="360" y="635" text-anchor="middle" fill="#a6c2a8" font-family="sans-serif" font-size="25">模擬畫面 · 非實際影片</text></svg>';
  await page.evaluate(src=>{
    const stage=document.getElementById('player-stage');
    stage.dataset.orientation='portrait';
    stage.style.setProperty('--media-aspect','9 / 16');
    document.getElementById('player-video').poster=src;
  },'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(portraitPoster));
  assert((await page.evaluate(()=>document.documentElement.scrollWidth))<=391,
    '390px player preview overflows horizontally');
  await page.screenshot({path:'test-results/design-layout/player-1000-mobile.png',fullPage:true});
  console.log('PASS 390px portrait player and 1000-episode navigator');
  assert.deepEqual(errors,[],'uncaught browser errors');
} finally {await browser.close();}