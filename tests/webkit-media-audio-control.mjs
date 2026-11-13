// SPDX-License-Identifier: GPL-3.0-only
// A known-audible, entirely synthetic H.264/AAC media-element control for
// headless macOS WebKit. Distinguishes unreliable Web Audio capture from a
// source-specific AAC/MSE failure; does NOT test proprietary source content.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function verifyWebKitMediaAudioControl(browser) {
  const tmp = mkdtempSync(join(tmpdir(), 'hongguo-webkit-aac-control-'));
  let server, context;
  try {
    const native = join(tmp, 'sine-h264-aac.mp4');
    const fragmented = join(tmp, 'sine-h264-aac-fmp4.mp4');
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x96:r=15:d=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.0',
      '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac',
      '-b:a', '96k', '-shortest', '-movflags', '+faststart', '-y', native
    ], { timeout: 30000 });
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', native, '-c', 'copy',
      '-movflags', '+empty_moov+frag_keyframe+default_base_moof',
      '-f', 'mp4', '-y', fragmented
    ], { timeout: 30000 });
    const media = {
      '/native.mp4': readFileSync(native),
      '/fragmented.mp4': readFileSync(fragmented)
    };
    server = createServer((req, res) => {
      const bytes = media[(req.url || '').split('?')[0]];
      if (!bytes) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Known-audible synthetic AAC control</title><body></body>');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': bytes.byteLength,
        'Cache-Control': 'no-store'
      });
      res.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    context = await browser.newContext();
    const page = await context.newPage();
    const results = {};
    for (const mode of ['native', 'mse']) {
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      const supported = await page.evaluate(async mode => {
        const mime = 'video/mp4; codecs="avc1.42C01E, mp4a.40.2"';
        if (mode === 'mse' &&
            (!window.MediaSource || !MediaSource.isTypeSupported(mime)))
          return false;
        const video = document.createElement('video');
        video.playsInline = true;
        video.muted = false;
        video.volume = 1;
        document.body.append(video);
        if (mode === 'native') video.src = '/native.mp4';
        else {
          const bytes = await fetch('/fragmented.mp4').then(r => r.arrayBuffer());
          const mediaSource = new MediaSource();
          video.src = URL.createObjectURL(mediaSource);
          await new Promise((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', () => {
              try {
                const buffer = mediaSource.addSourceBuffer(mime);
                buffer.addEventListener('updateend', () => {
                  if (mediaSource.readyState === 'open') mediaSource.endOfStream();
                  resolve();
                }, { once: true });
                buffer.addEventListener('error', () =>
                  reject(new Error('Synthetic MSE append failed')), { once: true });
                buffer.appendBuffer(bytes);
              } catch (error) { reject(error); }
            }, { once: true });
          });
        }
        const button = document.createElement('button');
        button.id = 'start-synthetic-aac-control';
        button.textContent = 'Start synthetic audio control';
        document.body.append(button);
        button.addEventListener('click', event => {
          const trustedClick = event.isTrusted;
          const Context = window.AudioContext || window.webkitAudioContext;
          if (!Context) {
            window.__audioControlResult = Promise.resolve({ unavailable: true });
            return;
          }
          const context = new Context();
          const source = context.createMediaElementSource(video);
          const analyser = context.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          analyser.connect(context.destination);
          // Both calls begin within the actual click activation.
          const resume = context.resume();
          const play = video.play();
          window.__audioControlResult = (async () => {
            try { await Promise.all([resume, play]); }
            catch (error) {
              await context.close();
              return { playbackError: error.name || 'PlaybackFailed', trustedClick };
            }
            const samples = new Float32Array(analyser.fftSize);
            let peakRms = 0, nonSilentWindows = 0;
            const start = video.currentTime;
            for (let i = 0; i < 44; i++) {
              await new Promise(resolve => setTimeout(resolve, 80));
              analyser.getFloatTimeDomainData(samples);
              let power = 0;
              for (const sample of samples) power += sample * sample;
              const rms = Math.sqrt(power / samples.length);
              peakRms = Math.max(peakRms, rms);
              if (rms > 0.002) nonSilentWindows++;
            }
            const result = {
              trustedClick,
              contextState: context.state,
              peakRms: Number(peakRms.toFixed(6)),
              nonSilentWindows,
              playbackSeconds: Number((video.currentTime - start).toFixed(3)),
              videoWidth: video.videoWidth,
              mediaError: video.error?.code ?? null
            };
            await context.close();
            return result;
          })();
        }, { once: true });
        return true;
      }, mode);
      if (!supported) {
        results[mode] = { unsupported: true };
        continue;
      }
      await page.locator('#start-synthetic-aac-control').click();
      const result = await page.evaluate(() => window.__audioControlResult);
      results[mode] = {
        ...result,
        mediaPcmMeasured: result.trustedClick && result.peakRms > 0.004 &&
          result.nonSilentWindows >= 4 && result.playbackSeconds > 2 &&
          result.mediaError == null
      };
    }
    console.log('macOS WebKit known-audible synthetic media-element controls:',
      JSON.stringify(results));
    return results;
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
}
