// SPDX-License-Identifier: GPL-3.0-only
// EXPERIMENT ONLY, LOCAL WORKER. Real registration upstream, NO media endpoint.
// Captures exact response ID values in response to the local runner, NEVER logs them.
import { registerPlaybackDevice } from './vendor/playback-device.js';
import { requestJson, preserveLargeJsonIntegers } from './vendor/app-source.js';

const FIELDS = ['device_id_str', 'device_id', 'install_id_str', 'install_id'];
let isolate = null;
const present = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const valueType = x => x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x;
const accepted = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value === 'string') return /^\d{1,30}$/.test(value) && /[1-9]/.test(value);
  return false;
};

function snapshot(raw) {
  // JSON.parse by itself silently rounds long unquoted integer IDs. Preserve
  // integer spellings in a separate copy, while recording ORIGINAL JSON types.
  const original = JSON.parse(raw);
  const lossless = JSON.parse(preserveLargeJsonIntegers(raw, ['device_id','install_id']));
  const fields = Object.fromEntries(FIELDS.map(key => {
    const found = present(original, key);
    const rawType = found ? valueType(original[key]) : 'absent';
    const exact = !found ? null : lossless[key] == null ? lossless[key] : String(lossless[key]);
    const jsValue = found && original[key] != null ? String(original[key]) : null;
    return [key, {
      present: found, jsonType: rawType, exactValue: exact,
      jsParsedValue: jsValue,
      precisionChanged: rawType === 'number' && exact !== jsValue,
      validAsCurrentlyParsed: found && accepted(original[key]),
      validLosslessly: found && accepted(typeof lossless[key] === 'number'
        ? lossless[key] : lossless[key]),
    }];
  }));
  const preferred = (name) => {
    const str = original[name + '_str'];
    const v = str === undefined || str === null || str === '' ? original[name] : str;
    return accepted(v);
  };
  return {
    // Do not capture full JSON (could contain unrelated credentials).
    keys: Object.keys(original).slice(0, 40),
    code: present(original,'code') ? original.code : null,
    Code: present(original,'Code') ? original.Code : null,
    // Non-identifying top-level diagnostics to check server-side time windows.
    serverTime: ['number', 'string'].includes(valueType(original.server_time))
      ? original.server_time : null,
    newUser: ['number', 'boolean', 'string'].includes(valueType(original.new_user))
      ? String(original.new_user).slice(0,32) : null,
    fields,
    currentValidator: {
      deviceIdAccepted: preferred('device_id'),
      installIdAccepted: preferred('install_id')
    }
  };
}
export default {
  async fetch(request) {
    const u = new URL(request.url);
    // Prevent accidental deployment as an unauthenticated real-registration API.
    if (!['localhost','127.0.0.1'].includes(u.hostname))
      return new Response('Local experiment only', { status: 403 });
    isolate ||= crypto.randomUUID();
    if (u.pathname === '/health') return Response.json({ok:true, isolate});
    if (u.pathname !== '/register' || request.method !== 'POST')
      return new Response('Not found', { status: 404 });
    const startedAt = Date.now();
    let upstreamCalls=0, upstreamStatus=null, upstreamError=null, responseSnapshot=null;
    let upstreamStart=null, upstreamEnd=null, captureError=null;
    const transport=async(url,options,deadline,signal)=>{
      upstreamCalls++;
      upstreamStart=Date.now();
      try {
        const data=await requestJson(url,{
          ...options,
          onResponseRawJson(raw) {
            try { responseSnapshot=snapshot(raw); }
            catch(e) { captureError=e?.name||'CAPTURE_ERROR'; }
          }
        },deadline,signal);
        upstreamStatus=200;
        return data;
      } catch(e) {
        upstreamStatus=Number.isInteger(e?.status)?e.status:null;
        upstreamError=String(e?.code||'UNKNOWN').slice(0,64);
        throw e;
      } finally { upstreamEnd=Date.now(); }
    };
    let ok=false, registrationFailure=null;
    try { await registerPlaybackDevice(transport); ok=true; }
    catch(e){registrationFailure=String(e?.registrationFailure||e?.code||'UNKNOWN').slice(0,64);}
    return Response.json({
      ok, isolate, startedAt, completedAt:Date.now(), upstreamCalls,
      upstreamStatus, upstreamError, upstreamStart, upstreamEnd,
      registrationFailure, captureError, responseSnapshot
    }, {headers:{'Cache-Control':'no-store'}});
  }
};
