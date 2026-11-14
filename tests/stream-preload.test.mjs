import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamPreload } from '../src/stream-preload.js';
const unit = (id, type = 'media') => ({ id, type, generation: 0, bytes: new ArrayBuffer(4) });

test('next episode retains ordered fragments and stops ACK at its byte budget until handoff', () => {
  const sent = [], stages = [];
  const p = createStreamPreload({ enabled: true, budget: 12,
    post: m => sent.push(m), onStage: (phase, fields) => stages.push({ phase, ...fields }) });
  assert(p.capture(unit(1, 'init')));
  assert.deepEqual(sent, [], 'CPU must wait while the current episode is processing');
  p.startProcessing();
  assert.deepEqual(sent, [{ type: 'process' }, { type: 'ack', id: 1 }]);
  p.capture(unit(2)); p.capture(unit(3));
  assert.deepEqual(sent.at(-1), { type: 'ack', id: 2 }, 'Budget boundary must withhold ACK');
  assert.deepEqual(p.activate().map(x => x.id), [1, 2, 3]);
  assert.equal(p.active, false);
  assert.equal(p.capture(unit(4)), false);
  assert.equal(sent.filter(m => m.type === 'process').length, 1, 'Handoff must reuse the worker');
  assert(stages.some(s => s.ready && s.bytes === 12));
});

test('current-episode processing can reclaim CPU while next download remains independent', () => {
  const sent = [];
  const p = createStreamPreload({ enabled: true, post: m => sent.push(m) });
  p.startProcessing(); p.pauseProcessing(); p.capture(unit(1, 'init'));
  assert.deepEqual(sent, [{ type: 'process' }]);
  p.startProcessing();
  assert.deepEqual(sent.at(-1), { type: 'ack', id: 1 });
  p.capture({ type: 'done', generation: 0 });
  assert.deepEqual(p.activate().map(x => x.type), ['init', 'done']);
});

test('cancellation discards retained units and never resumes a canceled processor', () => {
  const sent = [];
  const p = createStreamPreload({ enabled: true, post: m => sent.push(m) });
  p.capture(unit(1)); p.close(); p.startProcessing();
  assert.deepEqual(sent, []);
  assert.throws(() => p.activate(), e => e.code === 'CANCELED');
  assert.equal(p.capture(unit(2)), false);
});
