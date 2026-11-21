// SPDX-License-Identifier: GPL-3.0-only
// <bvc2-video>: the Video.js media element for the player. It wraps the
// page's <video slot="media"> and forwards everything to it, so every codec
// keeps its existing playback path. Only while directly rendered ByteVC2
// owns the frame renderer (bvc2-frame-renderer.js) does it answer the
// picture questions the audio-only <video> cannot: buffered picture span,
// readiness, picture size, playback quality and frame callbacks. Video.js
// then shows the same buffer bar, waiting state and quality as for native
// video.
//
// CustomMediaElement, HTMLVideoAdapter and MediaAttachMixin are Video.js
// 10.3 internals (`@internal`); re-check this file on every Video.js update.
import { CustomMediaElement, HTMLVideoAdapter } from '@videojs/media/dom';
import { MediaAttachMixin } from '@videojs/html';
import { frameRendererFor } from './bvc2-frame-renderer.js';

const HAVE_METADATA = 1;
const FRAME_STYLE = `
  <style>
    canvas {
      position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%;
      object-fit: contain; pointer-events: none;
    }
    canvas[hidden] { display: none; }
  </style>
  <canvas part="frame" aria-hidden="true" hidden></canvas>`;

function covered(ranges, seconds) {
  try {
    for (let i = 0; i < ranges.length; i++)
      if (seconds >= ranges.start(i) - 0.15 && seconds <= ranges.end(i) + 0.15) return true;
  } catch { /* MediaSource switching */ }
  return false;
}

export class Bvc2VideoAdapter extends HTMLVideoAdapter {
  #renderer = null;
  #unsubscribe = null;
  // Pending frame callbacks by our handle: { native, frames } backend handles.
  #callbacks = new Map();
  #nextCallback = 0;

  attach(target) {
    if (!target || this.target === target) return;
    super.attach(target);
    this.#renderer = frameRendererFor(target);
    // The pictures bypass the <video>, so it fires no events for them; its
    // own 'resize' already follows the renderer's picture size.
    this.#unsubscribe = this.#renderer.subscribe(type => {
      if (type === 'canplay') this.dispatchEvent(new Event('loadeddata'));
      this.dispatchEvent(new Event(type === 'emptied' ? 'progress' : type));
    });
  }

  detach() {
    for (const entry of this.#callbacks.values()) this.#cancelBoth(entry);
    this.#callbacks.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#renderer = null;
    super.detach();
  }

  /** Directly rendered pictures, or null while the <video> shows its own. */
  get #frames() {
    const state = this.#renderer?.state();
    return state?.active ? state : null;
  }

  get engineName() {
    return this.#frames ? 'bvc2-webgl2' : 'browser';
  }

  get buffered() {
    return this.#frames?.buffered ?? super.buffered;
  }

  get readyState() {
    const native = super.readyState, frames = this.#frames;
    if (!frames) return native;
    // Audio alone is not a playable position: report metadata only until a
    // picture for the current time is decoded.
    return frames.ready && covered(frames.buffered, this.currentTime) ? native
      : Math.min(native, HAVE_METADATA);
  }

  get videoWidth() {
    return this.#frames?.size?.width ?? super.videoWidth;
  }

  get videoHeight() {
    return this.#frames?.size?.height ?? super.videoHeight;
  }

  getVideoPlaybackQuality() {
    if (this.#frames) return this.#renderer.quality();
    return this.target?.getVideoPlaybackQuality?.() ?? { creationTime: 0, totalVideoFrames: 0,
      droppedVideoFrames: 0, corruptedVideoFrames: 0 };
  }

  requestVideoFrameCallback(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    // Register with both the <video> and the renderer: whichever presents the
    // next picture runs it, so a callback requested before direct rendering
    // starts (or before native playback resumes) still fires.
    const handle = ++this.#nextCallback;
    const entry = { native: 0, frames: 0 };
    const run = (now, metadata) => {
      if (!this.#callbacks.delete(handle)) return;
      this.#cancelBoth(entry);
      callback(now, metadata);
    };
    const target = this.target;
    if (typeof target?.requestVideoFrameCallback === 'function')
      entry.native = target.requestVideoFrameCallback(run);
    if (this.#renderer) entry.frames = this.#renderer.requestVideoFrameCallback(run);
    this.#callbacks.set(handle, entry);
    return handle;
  }

  cancelVideoFrameCallback(handle) {
    const entry = this.#callbacks.get(handle);
    if (!entry) return;
    this.#callbacks.delete(handle);
    this.#cancelBoth(entry);
  }

  #cancelBoth(entry) {
    if (entry.native) this.target?.cancelVideoFrameCallback?.(entry.native);
    if (entry.frames) this.#renderer?.cancelVideoFrameCallback(entry.frames);
    entry.native = entry.frames = 0;
  }
}

const Base = typeof HTMLElement === 'undefined' ? null
  : MediaAttachMixin(CustomMediaElement('video', Bvc2VideoAdapter));

export const Bvc2Video = Base && class Bvc2Video extends Base {
  static getTemplateHTML(attrs) {
    return super.getTemplateHTML(attrs) + FRAME_STYLE;
  }

  /** The canvas the frame renderer draws on, inside this element's shadow root. */
  createFrameCanvas() {
    return this.shadowRoot?.querySelector('canvas[part="frame"]') ?? null;
  }
};

/** Define <bvc2-video>; call after the Video.js player element is defined. */
export function defineBvc2Video() {
  if (Bvc2Video && !customElements.get('bvc2-video')) customElements.define('bvc2-video', Bvc2Video);
}
