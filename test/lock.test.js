import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolLock } from '../server/tools/lock.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('swap waits for running scans, and new scans wait for the swap', async () => {
  const lock = createToolLock();
  const events = [];
  const release = await lock.shared('trivy');
  events.push('scan1 start');
  const swap = lock.withExclusive('trivy', async () => {
    events.push('swap');
    await sleep(20);
    events.push('swap done');
  });
  await sleep(10);
  // a scan arriving while the swap waits must not start before it
  const scan2 = lock.shared('trivy').then((rel) => { events.push('scan2 start'); rel(); });
  await sleep(10);
  assert.deepEqual(events, ['scan1 start']);
  events.push('scan1 end');
  release();
  await Promise.all([swap, scan2]);
  assert.deepEqual(events, ['scan1 start', 'scan1 end', 'swap', 'swap done', 'scan2 start']);
});

test('other tools are not blocked, and the wait has a timeout', async () => {
  const lock = createToolLock();
  const rel = await lock.shared('grype');
  const other = await lock.shared('trivy');
  other();
  await assert.rejects(lock.withExclusive('grype', async () => {}, 30), /30 นาที/);
  rel();
  // after the timeout the lock is usable again
  await lock.withExclusive('grype', async () => {});
  assert.equal(lock.inUse('grype'), false);
});
