// WCAG A/AA checks on the Vite-built app in Chromium with mock API/media.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const browser=await chromium.launch({headless:true,
  ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{ok:true,sourceChannels:false}});
  if(path==='/api/series')return route.fulfill({json:{
    kind:'series',seriesId:'42',title:'無障礙測試影集',
    total:120,accessible:120,
    episodes:Array.from({length:120},(_,i)=>({index:i+1,vid:String(i+1000),available:true}))
  }});
  if(path==='/api/source')return route.fulfill({status:503,json:{
    error:{code:'SOURCE_UNAVAILABLE',message:'A11y fixture has no video'}}});
  return route.fulfill({status:404,body:'not in fixture'});
});
async function scan(label){
  const r=await new AxeBuilder({page})
    .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
  const issues=r.violations.map(v=>({
    id:v.id,impact:v.impact,help:v.help,
    nodes:v.nodes.slice(0,8).map(n=>({target:n.target,reason:n.failureSummary}))
  }));
  console.log('AXE '+label+' passed='+r.passes.length+' violations='+JSON.stringify(issues));
  assert.equal(issues.length,0,label+': WCAG A/AA violations: '+JSON.stringify(issues));
}
try{
  await page.goto((process.env.TEST_BASE_URL||'http://127.0.0.1:4173/')+'?id=42',{
    waitUntil:'domcontentloaded'
  });
  await page.locator('#series:not([hidden])').waitFor();
  const info=await page.evaluate(()=>({
    stack:getComputedStyle(document.documentElement).fontFamily,
    href:document.querySelector('link[href*="fonts.googleapis.com/css2"]')?.href,
    sage:getComputedStyle(document.documentElement).getPropertyValue('--brand-middle').trim().toUpperCase(),
    lang:document.documentElement.lang
  }));
  assert(info.stack.includes('Space Grotesk')&&info.stack.includes('Noto Sans TC'));
  assert(info.href?.includes('display=swap'));
  assert.equal(info.sage,'#BEC891');
  assert.equal(info.lang,'zh-Hant');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.className),'skip-to-content');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'main-content');
  await scan('download desktop');
  await page.locator('#mode-play').click();
  await page.locator('#player-settings-toggle').click();
  await scan('playback menu desktop');
  await page.locator('[data-settings-target="quality"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-settings-view="quality"]').isVisible(),true);
  await scan('quality submenu');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-settings-view="root"]').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.settingsTarget),'quality');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#player-settings').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'player-settings-toggle');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#mode-download').click();
  await scan('download mobile');
  await page.locator('#mode-play').click();
  await page.locator('#player-settings-toggle').click();
  await scan('playback menu mobile');
  const targets=await page.locator(
    '#episode-prev-range,#episode-next-range,#episode-jump,'+
    '#player-prev,#player-next,#player-settings-toggle,'+
    '#player-fullscreen,#player-settings-close'
  ).evaluateAll(nodes=>nodes.map(n=>{
    const b=n.getBoundingClientRect();
    return {id:n.id,w:b.width,h:b.height};
  }));
  for(const t of targets)if(t.w>0&&t.h>0)
    assert(t.w>=43.5&&t.h>=43.5,t.id+' needs 44px target '+JSON.stringify(t));
  assert.deepEqual(errors,[]);
  console.log('PASS a11y WCAG A/AA, keyboard, font loading link, logo hue and controls');
}finally{await browser.close();}