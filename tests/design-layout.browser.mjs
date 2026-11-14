// Responsive layout smoke test on the actual Vite-built Hongguo DL page.
// Uses placeholder episode metadata only; does not request external media/CDN.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const shots = 'test-results/design-layout';
await mkdir(shots, { recursive: true });
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:4173/', {waitUntil:'networkidle'});
  await page.evaluate(() => {
    document.body.dataset.mode = 'play';
    document.body.dataset.hasSeries = 'true';
    document.getElementById('queue-panel').hidden = true;
    document.getElementById('download-controls').hidden = true;
    document.getElementById('select-all').hidden = true;
    document.getElementById('select-none').hidden = true;
    const series = document.getElementById('series');
    const player = document.getElementById('player-panel');
    series.hidden = false;
    player.hidden = false;
    document.getElementById('series-title').textContent = '劇集預覽';
    document.getElementById('series-count').textContent = '60 集 · 已看完 12 集';
    document.getElementById('player-episode').textContent = '第 13 集';
    document.getElementById('player-status').textContent = '選擇分集即可播放';
    document.getElementById('mode-play').classList.add('selected');
    document.getElementById('mode-download').classList.remove('selected');
    document.getElementById('episodes').innerHTML = Array.from({length: 60}, (_, i) =>
      '<button type="button" class="episode play-episode ' +
      (i === 12 ? 'current in-progress' : i < 12 ? 'watched' : i === 13 ? 'in-progress' : '') +
      '" aria-label="第 ' + (i+1) + ' 集" style="--watch-progress:' +
      (i < 12 ? 100 : i === 12 ? 35 : i === 13 ? 62 : 0) + '%"><span>' + (i+1) + '</span></button>').join('');
  });
  // Full-tile gradient is a functional watch-progress indicator.
  const progress = await page.locator('#episodes .play-episode').evaluateAll(nodes =>
    [nodes[0], nodes[12], nodes[13], nodes[14]].map(node => ({
      watched: node.classList.contains('watched'),
      current: node.classList.contains('current'),
      progress: node.style.getPropertyValue('--watch-progress'),
      image: getComputedStyle(node).backgroundImage,
      fill: getComputedStyle(node).getPropertyValue('--tile-progress').trim()
    })));
  assert.deepEqual(progress.map(p => p.progress), ['100%', '35%', '62%', '0%']);
  assert(progress[0].watched && progress[1].current);
  assert(progress.every(p => p.image.includes('linear-gradient(')));
  assert.notEqual(progress[0].fill, progress[1].fill);
  const frame = await page.evaluate(() => ({
    panel: getComputedStyle(document.querySelector('.layout > section.panel')).borderTopWidth,
    shadow: getComputedStyle(document.querySelector('.layout > section.panel')).boxShadow,
    video: getComputedStyle(document.getElementById('player-stage')).borderTopWidth
  }));
  assert.deepEqual(frame, { panel: '0px', shadow: 'none', video: '0px' },
    'No outer UI or player cards');

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({width, height: 900});
    if (width <= 390) {
      await page.evaluate(() => {
        const stage = document.getElementById('player-stage');
        stage.dataset.orientation = 'portrait';
        stage.style.setProperty('--media-aspect', '9 / 16');
      });
    }
    const layout = await page.evaluate(() => {
      const rect = id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
      };
      const style = getComputedStyle(document.documentElement);
      return {
        viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        player: rect('player-panel'), episodes: rect('episodes'),
        prev: rect('player-prev'), next: rect('player-next'),
        accent: style.getPropertyValue('--brand-orange').trim(),
        seekFill: getComputedStyle(document.querySelector('.player-seek-fill')).backgroundColor,
        mode: document.body.dataset.mode
      };
    });
    console.log('LAYOUT ' + width + 'px: ' + JSON.stringify(layout));
    await page.screenshot({path: shots + '/hongguo-' + width + '.png', fullPage: true});
    if (width <= 390) {
      const videoRect = await page.locator('#player-video').boundingBox();
      assert(videoRect.height > videoRect.width * 1.4,
        width + 'px: portrait short drama should use a taller player');
    }
    assert(layout.scrollWidth <= width + 1,
      width + 'px: document horizontal overflow '+JSON.stringify(layout));
    if (width > 820) assert(layout.player.right < layout.episodes.left,
      width + 'px: desktop episodes should appear beside player');
    else assert(layout.player.bottom <= layout.episodes.top + 1,
      width + 'px: mobile episodes should appear below player');
    assert.equal(layout.accent.toLowerCase(), '#fd7528');
    assert.equal(layout.mode, 'play');
    assert(layout.prev.width >= 40 && layout.next.width >= 40,
      width + 'px: episode navigation buttons too narrow');
    console.log('PASS ' + width + 'px layout, overflow, nav targets and palette');
  }
  // Download mode: selected episodes, output settings and queue all share the
  // same unboxed visual language and must fit desktop/tablet/mobile widths.
  await page.evaluate(() => {
    document.body.dataset.mode = 'download';
    document.getElementById('mode-download').classList.add('selected');
    document.getElementById('mode-play').classList.remove('selected');
    document.getElementById('player-panel').hidden = true;
    document.getElementById('download-controls').hidden = false;
    document.getElementById('queue-panel').hidden = false;
    document.getElementById('select-all').hidden = false;
    document.getElementById('select-none').hidden = false;
    document.getElementById('series-count').textContent = '60 集 · 已選 14 集';
    document.getElementById('episodes').innerHTML = Array.from({length: 60}, (_, i) =>
      '<label class="episode ' + (i<14?'selected':'') + '">' +
      '<input type="checkbox" aria-label="第 ' + (i+1) + ' 集" ' +
      (i<14?'checked':'') + '><span>' + (i+1) + '</span></label>').join('');
    document.getElementById('queue').innerHTML = Array.from({length: 3}, (_, i) =>
      '<article class="job ' + (i===1?'selected':'') + '">' +
      '<div class="job-layout"><input class="job-select" type="checkbox" ' +
      (i===1?'checked':'') + ' aria-label="下載項目"/><div class="job-body">' +
      '<div class="job-topline"><b>短劇第 ' + (i+1) + ' 集</b><span class="status s-downloading">下載中</span></div>' +
      '<div class="job-meta">H.264 MP4 · 1080p</div>' +
      '<div class="progress-track"><div class="progress-bar" style="width:' +
      ((i+1)*26) + '%"></div></div></div></div></article>').join('');
  });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({width,height:900});
    const state = await page.evaluate(() => ({
      scroll:document.documentElement.scrollWidth,
      width:innerWidth,
      rows:document.querySelectorAll('#episodes .episode.selected').length,
      setting:getComputedStyle(document.getElementById('download-controls')).display,
      queue:getComputedStyle(document.getElementById('queue-panel')).display
    }));
    assert(state.scroll <= width + 1,
      width + 'px: download page overflows horizontally ' + JSON.stringify(state));
    assert.equal(state.rows, 14);
    assert.notEqual(state.setting, 'none');
    assert.notEqual(state.queue, 'none');
    await page.screenshot({path:shots+'/hongguo-download-'+width+'.png',fullPage:true});
    console.log('PASS download '+width+'px, selected episodes, settings and queue');
  }
  assert.deepEqual(errors, [], 'unexpected page errors');
} finally { await browser.close(); }
