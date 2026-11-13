// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { raceSourceQueries } from '../src/source-race.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const source = label => ({ variants: [{ url: 'https://cdn.example/' + label }] });

test('first successful source starts before the other response finishes', async () => {
  const web = deferred(), app = deferred();
  let appFinished = false;
  const running = raceSourceQueries([
    { route: 'web', run: () => web.promise },
    { route: 'app', run: () => app.promise.then(result => { appFinished = true; return result; }) }
  ]);
  web.resolve(source('web'));
  const { winner, later } = await running;
  assert.equal(winner.route, 'web');
  assert.equal(appFinished, false, 'Must not wait for slower App source');
  app.resolve(source('app'));
  assert.deepEqual((await later).map(item => item.route), ['app']);
});

test('a fast failed web probe must not hide the valid App response', async () => {
  const app = deferred();
  const running = raceSourceQueries([
    { route: 'web', run: async () => { throw Object.assign(new Error('404'), { code: 'PUBLIC_SOURCE_UNAVAILABLE' }); } },
    { route: 'app', run: () => app.promise }
  ]);
  app.resolve(source('app'));
  const { winner, later } = await running;
  assert.equal(winner.route, 'app');
  assert.deepEqual(await later, []);
});

test('both failed queries propagate the App error rather than AggregateError', async () => {
  const error = Object.assign(new Error('App unavailable'), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(raceSourceQueries([
    { route: 'web', run: async () => { throw new Error('no public source'); } },
    { route: 'app', run: async () => { throw error; } }
  ]), thrown => thrown === error);
});

test('empty source result is treated as failure, not the winning response', async () => {
  const result = await raceSourceQueries([
    { route: 'web', run: async () => ({ variants: [] }) },
    { route: 'app', run: async () => source('valid') }
  ]);
  assert.equal(result.winner.route, 'app');
});
