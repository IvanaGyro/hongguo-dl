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
      (i === 12 ? 'current' : i < 12 ? 'watched' : '') +
      '" aria-label="第 ' + (i+1) + ' 集" style="--watch-progress:' +
      (i < 12 ? 100 : 0) + '%"><span>' + (i+1) + '</span></button>').join('');
  });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({width, height: 900});
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
  assert.deepEqual(errors, [], 'unexpected page errors');
} finally { await browser.close(); }
