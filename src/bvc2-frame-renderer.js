// SPDX-License-Identifier: GPL-3.0-only
// Direct ByteVC2 presentation: the media Worker decodes pictures (8-bit I420)
// and this module draws them with WebGL2 over the player's <video>. That
// <video> keeps playing the AAC track through MSE, so it stays the media
// element Video.js controls and its clock drives which picture is shown:
// seeking, speed, volume and fullscreen are unchanged.

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D planeY, planeU, planeV;
uniform bool bt709, fullRange;
out vec4 color;
void main() {
  float y = texture(planeY, uv).r;
  float u = texture(planeU, uv).r - 0.5;
  float v = texture(planeV, uv).r - 0.5;
  if (!fullRange) {
    y = (y - 16.0 / 255.0) * (255.0 / 219.0);
    u *= 255.0 / 224.0;
    v *= 255.0 / 224.0;
  }
  vec3 rgb = bt709
    ? vec3(y + 1.5748 * v, y - 0.1873 * u - 0.4681 * v, y + 1.8556 * u)
    : vec3(y + 1.402 * v, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u);
  color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;
const FLAG_BT709 = 1, FLAG_FULL_RANGE = 2;
// Decoded pictures are large (1080p ≈ 3 MiB): keep only a short queue, but
// let decoding continue while the audio buffer is nearly empty, so audio
// interleaved behind video in the file can never stall both.
const QUEUE_BYTES = 48 * 1024 * 1024;
const MIN_QUEUE_FRAMES = 3;
const STARVED_AUDIO_SECONDS = 1;
const MAX_QUEUE_BYTES = 160 * 1024 * 1024;
const SHOW_EARLY_SECONDS = 0.004;

let available = null;
/** Whether this browser can create the WebGL2 context the renderer needs. */
export function frameRendererAvailable() {
  if (available !== null) return available;
  try {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const gl = canvas?.getContext?.('webgl2');
    available = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { available = false; }
  return available;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error('WebGL2 shader compile failed');
  return shader;
}

function createGlRenderer(canvas) {
  // The last drawn picture is kept so a restored context can show it again
  // while paused or ended, when no new picture would arrive.
  let gl = null, state = null, lost = false, last = null;
  const init = () => {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false,
      stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL2 link failed');
    gl.useProgram(program);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const textures = ['planeY', 'planeU', 'planeV'].map((name, unit) => {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, key, value);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
      return texture;
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    state = { textures, width: 0, height: 0,
      bt709: gl.getUniformLocation(program, 'bt709'),
      fullRange: gl.getUniformLocation(program, 'fullRange') };
  };
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true; state = null; });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    try { init(); } catch { state = null; return; }
    if (last) renderer.draw(last);
  });
  init();
  const renderer = {
    draw(frame) {
      if (lost || !state) return false;
      const { width, height, bytes } = frame;
      const chromaWidth = (width + 1) >> 1, chromaHeight = (height + 1) >> 1;
      const lumaSize = width * height, chromaSize = chromaWidth * chromaHeight;
      if (bytes.byteLength < lumaSize + 2 * chromaSize) return false;
      const planes = [
        [width, height, new Uint8Array(bytes.buffer, bytes.byteOffset, lumaSize)],
        [chromaWidth, chromaHeight, new Uint8Array(bytes.buffer, bytes.byteOffset + lumaSize, chromaSize)],
        [chromaWidth, chromaHeight, new Uint8Array(bytes.buffer, bytes.byteOffset + lumaSize + chromaSize, chromaSize)]
      ];
      const resized = state.width !== width || state.height !== height;
      if (resized) {
        canvas.width = width; canvas.height = height;
        state.width = width; state.height = height;
      }
      planes.forEach(([w, h, data], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, state.textures[unit]);
        if (resized) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
      });
      gl.uniform1i(state.bt709, frame.flags & FLAG_BT709 ? 1 : 0);
      gl.uniform1i(state.fullRange, frame.flags & FLAG_FULL_RANGE ? 1 : 0);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      last = frame;
      return true;
    },
    forget() { last = null; }
  };
  return renderer;
}

const renderers = new WeakMap();
/** The single renderer layered over one <video>; streams claim it in turn. */
export function frameRendererFor(video) {
  let renderer = renderers.get(video);
  if (!renderer) renderers.set(video, renderer = createFrameRenderer(video));
  return renderer;
}

/** Intrinsic size of the picture the renderer currently shows, if any. */
export function renderedFrameSize(video) {
  return renderers.get(video)?.size || null;
}

function createFrameRenderer(video) {
  let canvas = null, gl = null, owner = null, raf = 0, timer = 0, size = null;
  const ensureCanvas = () => {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'bvc2-frame-canvas';
    canvas.hidden = true;
    canvas.setAttribute('aria-hidden', 'true');
    // Pictures drawn so far; read by diagnostics and browser tests.
    canvas.renderedFrames = 0;
    video.insertAdjacentElement('afterend', canvas);
    gl = createGlRenderer(canvas);
  };
  const setSize = (width, height) => {
    if (size?.width === width && size?.height === height) return;
    size = width && height ? { width, height } : null;
    // Lets the page follow the picture's aspect ratio (audio-only MSE has none).
    video.dispatchEvent(new Event('resize'));
  };
  const schedule = () => {
    if (!owner) return;
    if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
    // Hidden pages pause animation frames; still drop late pictures and let
    // waiting decoders continue so the audio clock never stalls.
    if (!timer) timer = setInterval(() => owner ? owner.check() : stop(), 200);
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearInterval(timer);
    raf = 0; timer = 0;
  };
  function tick() {
    raf = 0;
    if (!owner) return;
    owner.present();
    schedule();
  }
  return {
    get size() { return owner ? size : null; },
    /** Make a stream the visible one; a previous owner is detached. */
    claim(onFirstFrame = () => {}) {
      ensureCanvas();
      owner?.detach();
      const queue = [];
      let queuedBytes = 0, shownPts = null, received = false, firstShown = false;
      let waiters = [], audioAhead = () => Infinity;
      const dropUntil = index => {
        for (const frame of queue.splice(0, index)) queuedBytes -= frame.bytes.byteLength;
      };
      const roomy = () => {
        if (queuedBytes < QUEUE_BYTES || queue.length < MIN_QUEUE_FRAMES) return true;
        return audioAhead() < STARVED_AUDIO_SECONDS && queuedBytes < MAX_QUEUE_BYTES;
      };
      const presenter = {
        get ready() { return received; },
        get queued() { return queue.length; },
        push(frame) {
          if (owner !== presenter) return;
          received = true;
          queue.push(frame);
          queuedBytes += frame.bytes.byteLength;
          schedule();
          presenter.check();
        },
        /** Pictures known to cover `seconds` (queued, or the one on screen). */
        covers(seconds) {
          const low = shownPts ?? queue[0]?.pts;
          const high = queue.length ? queue[queue.length - 1].pts : shownPts;
          return low !== undefined && low !== null && low <= seconds + 0.05 && seconds <= high + 0.1;
        },
        /** Resolve when one more picture may be decoded. */
        waitRoom(signal, ahead) {
          if (ahead) audioAhead = ahead;
          if (owner !== presenter || roomy()) return Promise.resolve();
          return new Promise(resolve => {
            const waiter = () => { signal?.removeEventListener('abort', waiter); resolve(); };
            waiters.push(waiter);
            signal?.addEventListener('abort', waiter, { once: true });
          });
        },
        check() {
          if (owner !== presenter) return;
          if (typeof document !== 'undefined' && document.hidden) {
            // No animation frames: keep only pictures that are still ahead.
            const now = video.currentTime;
            let late = 0;
            while (late < queue.length - 1 && queue[late + 1].pts <= now) late++;
            if (late) dropUntil(late);
          }
          if (waiters.length && roomy()) {
            const pending = waiters; waiters = [];
            for (const resolve of pending) resolve();
          }
        },
        present() {
          if (owner !== presenter || !queue.length) return presenter.check();
          const now = video.currentTime;
          let pick = -1;
          for (let i = 0; i < queue.length && queue[i].pts <= now + SHOW_EARLY_SECONDS; i++) pick = i;
          // Show the first picture after a start or seek before its exact
          // instant, so a paused player never displays a stale picture.
          if (pick < 0 && shownPts === null) pick = 0;
          if (pick >= 0) {
            const frame = queue[pick];
            if (gl.draw(frame)) {
              shownPts = frame.pts;
              canvas.renderedFrames++;
              setSize(frame.width, frame.height);
              canvas.hidden = false;
              if (!firstShown) { firstShown = true; try { onFirstFrame(); } catch { /* diagnostics only */ } }
            }
            dropUntil(pick + 1);
          }
          presenter.check();
        },
        /** A new position: discard queued pictures, keep showing the last one. */
        reset() {
          dropUntil(queue.length);
          shownPts = null; received = false;
          presenter.check();
        },
        detach() {
          if (owner !== presenter) return;
          owner = null;
          dropUntil(queue.length);
          const pending = waiters; waiters = [];
          for (const resolve of pending) resolve();
        },
        /** Give up the renderer: hide the picture unless another stream owns it. */
        release() {
          if (owner !== presenter) return;
          presenter.detach();
          stop();
          gl.forget();
          canvas.hidden = true;
          setSize(0, 0);
        }
      };
      owner = presenter;
      schedule();
      return presenter;
    }
  };
}
