// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const { retryEmptyResponse } = require('../worker/vendor/empty-response-retry');
const empty = () => Object.assign(new Error('Upstream HTTP 200 empty'), {code:'EMPTY_RESPONSE',status:200});
const fail = (code,status) => Object.assign(new Error(code),{code,status});
const noop = async()=>{};
test('two 200-empty replies trigger up to three signed source attempts', async()=>{
  const seen=[];
  const result=await retryEmptyResponse(async attempt=>{
    seen.push(attempt);
    if(attempt<2) throw empty();
    return {variants:['ok']};
  },{wait:noop,deadline:Date.now()+12000});
  assert.deepEqual(seen,[0,1,2]);
  assert.deepEqual(result,{variants:['ok']});
});
test('successful first attempt needs no retries',async()=>{
  let count=0;
  assert.equal(await retryEmptyResponse(async()=>{count++;return 200},{wait:noop}),200);
  assert.equal(count,1);
});
test('three consecutive empty bodies fail after bounded attempts',async()=>{
  let count=0;
  await assert.rejects(retryEmptyResponse(async()=>{count++;throw empty()},{
    wait:noop,deadline:Date.now()+12000
  }),e=>e.code==='EMPTY_RESPONSE'&&e.status===200);
  assert.equal(count,3);
});
test('403, 429 and explicit business denial are never retried',async()=>{
  for(const [code,status] of [['HTTP_403',403],['HTTP_429',429],['BUSINESS_REJECTED',undefined],['INVALID_RESPONSE',200],['ERR_NETWORK',undefined]]){
    let count=0;
    await assert.rejects(retryEmptyResponse(async()=>{
      count++;throw fail(code,status)
    },{wait:noop}),e=>e.code===code);
    assert.equal(count,1,code);
  }
});
test('exhausted deadline and cancellation stop empty-response retries',async()=>{
  let count=0;
  await assert.rejects(retryEmptyResponse(async()=>{count++;throw empty()},{
    deadline:Date.now()+100,wait:noop
  }),e=>e.code==='EMPTY_RESPONSE');
  assert.equal(count,1);
  const controller=new AbortController();
  await assert.rejects(retryEmptyResponse(async()=>{
    controller.abort();throw empty()
  },{signal:controller.signal,wait:noop}),e=>e.code==='ERR_CANCELED');
});
