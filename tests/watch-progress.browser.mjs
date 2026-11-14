// Verify actual renderEpisodes() using saved localStorage playback history.
// Independent of media decoding; mock only the Hongguo API.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({headless:true,
  ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
const page = await browser.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(() => {
  const store={
    '42:1000': {seconds:35,duration:100,completed:false,viewedAt:100},
    '42:1001': {seconds:100,duration:100,completed:true,viewedAt:200},
    '42:1002': {seconds:62,duration:100,completed:false,viewedAt:300}
  };
  localStorage.setItem('hongguo-dl-playback-history-v1',JSON.stringify(store));
});
await page.route(url=>url.pathname.startsWith('/api/'), async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/health')
    return route.fulfill({json:{ok:true,sourceChannels:false}});
  if(path==='/api/series')
    return route.fulfill({json:{
      kind:'series',seriesId:'42',title:'Playback history fixture',
      total:4,accessible:4,
      episodes:Array.from({length:4},(_,i)=>({index:i+1,vid:String(1000+i),available:true}))
    }});
  if(path==='/api/source') return route.fulfill({status:503,
    json:{error:{code:'SOURCE_UNAVAILABLE',message:'Fixture has no video'}}});
  return route.fulfill({status:404,body:'No fixture'});
});
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:4173/?id=42');
  await page.locator('#series:not([hidden])').waitFor();
  await page.locator('#mode-play').click();
  await page.locator('#episodes .play-episode').first().waitFor();
  const items=await page.locator('#episodes .play-episode').evaluateAll(nodes=>
    nodes.map(node=>({
      percent:node.dataset.watchPercent,
      progress:node.style.getPropertyValue('--watch-progress'),
      image:getComputedStyle(node).backgroundImage,
      watched:node.classList.contains('watched'),
      completeMark:Boolean(node.querySelector('.watched-check')),
      current:node.classList.contains('current'),
      ariaCurrent:node.getAttribute('aria-current'),
      label:node.getAttribute('aria-label')
    })));
  assert.deepEqual(items.map(x=>x.percent),['35','100','62','0']);
  assert.deepEqual(items.map(x=>x.progress),['35%','100%','62%','0%']);
  assert(items[1].watched && items[1].completeMark && items[1].label.includes('已看完'));
  assert(items[0].label.includes('35%') && items[2].label.includes('62%'));
  assert(items.every(x=>x.image.includes('linear-gradient(')));
  // The currently playing episode retains its percentage when selected.
  const current=items.find(x=>x.current);
  assert(current && current.ariaCurrent==='true');
  assert(current.progress==='35%' || current.progress==='62%');
  await page.locator('#mode-download').click();
  const labels=await page.locator('#episodes .episode').count();
  assert.equal(labels,4);
  assert.equal(await page.locator('#download-controls').isVisible(),true);
  assert.equal(await page.locator('#queue-panel').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS saved episode fill 35/100/62/0, completed mark, current percent, download switch');
} finally { await browser.close(); }
