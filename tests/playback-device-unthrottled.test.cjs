// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerPlaybackDevice } = require('../worker/vendor/playback-device');

function goodRegistration() {
  return { device_id_str: '1234567890123456789', install_id_str: '9876543210123456789', code: 0 };
}

test('an upstream 429 is reported and does not block an immediate new registration', async () => {
  let attempts=0;
  const api=async () => {
    attempts++;
    if(attempts===1) throw Object.assign(new Error('upstream 429'), { status:429 });
    return goodRegistration();
  };
  await assert.rejects(registerPlaybackDevice(api), e =>
    e.code==='DEVICE_REGISTRATION_FAILED' && e.registrationFailure==='HTTP_429');
  const result=await registerPlaybackDevice(api);
  assert.equal(attempts,2);
  assert.equal(result.device_id,'1234567890123456789');
});

test('a transport failure does not impose a local 10-second cooldown', async () => {
  let attempts=0;
  const api=async()=> {
    attempts++;
    if(attempts===1) throw Object.assign(new Error('transient'),{code:'ERR_NETWORK'});
    return goodRegistration();
  };
  await assert.rejects(registerPlaybackDevice(api),e=>e.code==='DEVICE_REGISTRATION_FAILED');
  assert.equal((await registerPlaybackDevice(api)).iid,'9876543210123456789');
  assert.equal(attempts,2);
});

test('two simultaneous registrations both reach the actual upstream mock independently', async () => {
  let attempts=0;
  const responders=[];
  const mock=async()=>new Promise(resolve=>{attempts++;responders.push(resolve)});
  const first=registerPlaybackDevice(mock);
  const second=registerPlaybackDevice(mock);
  assert.equal(attempts,2,'No local promise queue or shared registration');
  for (const resolve of responders) resolve(goodRegistration());
  const results=await Promise.all([first,second]);
  assert.equal(results.length,2);
  assert.ok(results.every(x=>x.device_id==='1234567890123456789'));
});
