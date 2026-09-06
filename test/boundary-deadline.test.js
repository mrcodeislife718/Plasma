import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry, createBoundaryCall } from '../src/index.js';

function delay(ms, value) { return new Promise((resolve) => setTimeout(resolve, ms, value)); }

const DEADLINE_WINDOW_MS = 250;
const SLOW_WORK_MS = 2_000;

test('Plasma rejects adapter work that outlives the boundary deadline', async () => {
  const registry = new AdapterRegistry();
  let observedAbort = false;
  registry.register('slow', {
    capabilities: () => ({ language:'test' }),
    async invoke(_call, { signal } = {}) {
      signal?.addEventListener('abort', () => { observedAbort = true; }, { once:true });
      return delay(SLOW_WORK_MS, 'late');
    }
  });
  const call = createBoundaryCall({ module:'slow', member:'run', deadline:Date.now() + DEADLINE_WINDOW_MS });
  const result = await registry.invoke('slow', call);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PLASMA_BOUNDARY_DEADLINE');
  assert.equal(observedAbort, true);
});

test('Plasma applies the same deadline to policy evaluation', async () => {
  const registry = new AdapterRegistry({ policy: async () => delay(SLOW_WORK_MS) });
  let invoked = false;
  registry.register('target', {
    capabilities: () => ({ language:'test' }),
    async invoke() { invoked = true; return true; }
  });
  const call = createBoundaryCall({ module:'target', member:'run', deadline:Date.now() + DEADLINE_WINDOW_MS });
  const result = await registry.invoke('target', call);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PLASMA_BOUNDARY_DEADLINE');
  assert.equal(invoked, false);
});

test('Plasma completes calls normally when they finish inside the deadline', async () => {
  const registry = new AdapterRegistry();
  registry.register('fast', {
    capabilities: () => ({ language:'test' }),
    async invoke() { return 'done'; }
  });
  const call = createBoundaryCall({ module:'fast', member:'run', deadline:Date.now() + 5_000 });
  const result = await registry.invoke('fast', call);
  assert.deepEqual({ ok:result.ok, value:result.value }, { ok:true, value:'done' });
});
