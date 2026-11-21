// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import emptyResponseRetry from '../worker/vendor/empty-response-retry.js';

const { retryEmptyResponse } = emptyResponseRetry;
const empty = (extra) => Object.assign(new Error('Upstream HTTP 200 empty'), {code:'EMPTY_RESPONSE',status:200}, extra);
const fail = (code,status) => Object.assign(new Error(code),{code,status});
test('two 200-empty replies move through up to three distinct signed requests without fixed delays', async()=>{
  const seen=[];
  const started=Date.now();
  const result=await retryEmptyResponse(async attempt=>{
    seen.push(attempt);
    if(attempt<2) throw empty();
    return {variants:['ok']};
  },{deadline:Date.now()+12000});
  assert.deepEqual(seen,[0,1,2]);
  assert.deepEqual(result,{variants:['ok']});
  assert.ok(Date.now()-started<250,'no fixed sleep between different endpoints');
});
test('successful first attempt needs no retries',async()=>{
  let count=0;
  assert.equal(await retryEmptyResponse(async()=>{count++;return 200}),200);
  assert.equal(count,1);
});
test('three consecutive empty bodies fail after bounded attempts',async()=>{
  let count=0;
  await assert.rejects(retryEmptyResponse(async()=>{count++;throw empty()},{
    deadline:Date.now()+12000
  }),e=>e.code==='EMPTY_RESPONSE'&&e.status===200&&e.upstreamStatus===200&&e.emptyResponseCount===3);
  assert.equal(count,3);
});
test('an empty body carrying Retry-After ends recovery immediately',async()=>{
  let count=0;
  await assert.rejects(retryEmptyResponse(async()=>{count++;throw empty({retryAfter:true,retryAfterMs:5000})},{
    deadline:Date.now()+12000
  }),e=>e.code==='EMPTY_RESPONSE'&&e.retryAfterMs===5000&&e.emptyResponseCount===1);
  assert.equal(count,1);
});
test('403, 429 and explicit business denial are never retried',async()=>{
  for(const [code,status] of [['HTTP_403',403],['HTTP_429',429],['BUSINESS_REJECTED',undefined],['INVALID_RESPONSE',200],['ERR_NETWORK',undefined]]){
    let count=0;
    await assert.rejects(retryEmptyResponse(async()=>{
      count++;throw fail(code,status)
    }),e=>e.code===code);
    assert.equal(count,1,code);
  }
});
test('exhausted deadline and cancellation stop empty-response retries',async()=>{
  let count=0;
  await assert.rejects(retryEmptyResponse(async()=>{count++;throw empty()},{
    deadline:Date.now()+100
  }),e=>e.code==='EMPTY_RESPONSE');
  assert.equal(count,1);
  const controller=new AbortController();
  await assert.rejects(retryEmptyResponse(async()=>{
    controller.abort();throw empty()
  },{signal:controller.signal}),e=>e.code==='ERR_CANCELED');
});
