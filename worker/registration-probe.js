// SPDX-License-Identifier: GPL-3.0-only
// EXPERIMENT ONLY: real anonymous registration, NO media/source calls.
// Local workerd only; do not deploy or expose this endpoint publicly.
import { registerPlaybackDevice } from './vendor/playback-device.js';
import { requestJson } from './vendor/app-source.js';

let isolate = null;
export default {
  async fetch(request) {
    isolate ||= crypto.randomUUID();
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') return Response.json({ ok: true, isolate });
    if (pathname !== '/register' || request.method !== 'POST')
      return new Response('Not found', { status: 404 });
    const enteredAt = Date.now();
    let upstreamCalls = 0;
    let upstreamHttp = null;
    let upstreamErrorCode = null;
    let upstreamStartedAt = null;
    let upstreamFinishedAt = null;
    const transport = async (url, options, deadline, signal) => {
      upstreamCalls++;
      upstreamStartedAt = Date.now();
      try {
        const data = await requestJson(url, options, deadline, signal);
        upstreamHttp = 200;
        return data;
      } catch (error) {
        upstreamHttp = Number.isInteger(error?.status) ? error.status : null;
        upstreamErrorCode = String(error?.code || 'UNKNOWN').slice(0, 50);
        throw error;
      } finally {
        upstreamFinishedAt = Date.now();
      }
    };
    try {
      // Never return device_id / iid / cdid.
      await registerPlaybackDevice(transport);
      return Response.json({ ok: true, isolate,
        enteredAt, finishedAt: Date.now(),
        upstreamCalls, upstreamHttp, upstreamErrorCode,
        upstreamStartedAt, upstreamFinishedAt });
    } catch (error) {
      return Response.json({ ok: false, isolate,
        enteredAt, finishedAt: Date.now(),
        upstreamCalls, upstreamHttp, upstreamErrorCode,
        upstreamStartedAt, upstreamFinishedAt,
        registrationFailure: String(error?.registrationFailure || error?.code || 'UNKNOWN').slice(0,50) });
    }
  }
};
