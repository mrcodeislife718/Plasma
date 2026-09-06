import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProcessAdapter, HandleRegistry, PlasmaBoundaryError, createBoundaryCall } from '../src/index.js';

const bridge = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const m=JSON.parse(input.trim());const c=m.call;if(c.member==='sleep'){setTimeout(()=>console.log(JSON.stringify('late')),1000);return;}if(c.member==='large'){process.stdout.write(JSON.stringify('x'.repeat(8192))+'\\n');return;}if(c.member==='env'){console.log(JSON.stringify(process.env.PLASMA_ALLOWED??null));return;}console.log(JSON.stringify(c.args?.[0]??null));});`;

function nodeAdapter(options = {}) {
  return createProcessAdapter({ language: 'node-test', command: process.execPath, args: ['-e', bridge], ...options });
}

async function readPid(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return Number(await fs.readFile(file, 'utf8')); }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error('foreign process did not publish pid');
}

function observe(promise) {
  return promise.then((value) => ({ ok:true, value }), (error) => ({ ok:false, error }));
}

test('process adapter performs a real isolated JSONL round trip', async () => {
  const adapter = nodeAdapter({ env: { PLASMA_ALLOWED: 'yes' }, inheritEnvironment: [] });
  const result = await adapter.invoke({ module: 'test', member: 'identity', args: [{ ok: true }] });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(adapter.capabilities().environment, ['PLASMA_ALLOWED']);
});

test('process adapter enforces hard execution deadlines', async () => {
  const adapter = nodeAdapter({ timeoutMs: 100 });
  await assert.rejects(() => adapter.invoke({ module: 'test', member: 'sleep', args: [] }), (error) => {
    assert.ok(error instanceof PlasmaBoundaryError);
    assert.equal(error.code, 'PLASMA_ADAPTER_TIMEOUT');
    return true;
  });
});

test('process adapter enforces output ceilings', async () => {
  const adapter = nodeAdapter({ maxOutputBytes: 256 });
  await assert.rejects(() => adapter.invoke({ module: 'test', member: 'large', args: [] }), (error) => {
    assert.ok(error instanceof PlasmaBoundaryError);
    assert.equal(error.code, 'PLASMA_ADAPTER_OUTPUT_LIMIT');
    return true;
  });
});

test('process adapter aborts and cleans up foreign execution', async () => {
  const adapter = nodeAdapter({ timeoutMs: 5000 });
  const controller = new AbortController();
  const pending = adapter.invoke({ module: 'test', member: 'sleep', args: [] }, { signal: controller.signal });
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(() => pending, /cancelled by caller/);
});

test('process adapter timeout resolves only after the foreign pid is reaped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plasma-reap-'));
  const pidFile = path.join(root, 'pid');
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`;
  const adapter = createProcessAdapter({ language:'node-reap', command:process.execPath, args:['-e',script], timeoutMs:500 });
  try {
    const outcomePromise = observe(adapter.invoke({ module:'test', member:'hang', args:[] }));
    const pid = await readPid(pidFile);
    const outcome = await outcomePromise;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'PLASMA_ADAPTER_TIMEOUT');
    assert.throws(() => process.kill(pid, 0), (error) => error?.code === 'ESRCH');
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('process adapter abort resolves only after the foreign pid is reaped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plasma-abort-reap-'));
  const pidFile = path.join(root, 'pid');
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`;
  const adapter = createProcessAdapter({ language:'node-reap', command:process.execPath, args:['-e',script], timeoutMs:5000 });
  const controller = new AbortController();
  try {
    const outcomePromise = observe(adapter.invoke({ module:'test', member:'hang', args:[] }, { signal:controller.signal }));
    const pid = await readPid(pidFile);
    controller.abort(new Error('stop foreign work'));
    const outcome = await outcomePromise;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /stop foreign work/);
    assert.throws(() => process.kill(pid, 0), (error) => error?.code === 'ESRCH');
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('handle registry detects double release and live-handle leaks', () => {
  const handles = new HandleRegistry();
  const handle = handles.retain({ resource: true }, { owner: 'test' });
  assert.equal(handles.release(handle.id), 0);
  assert.throws(() => handles.release(handle.id), /unknown Plasma handle/);
  const leaked = handles.retain('live');
  assert.throws(() => handles.close(), (error) => error.code === 'PLASMA_HANDLE_LEAK');
  assert.equal(handles.dereference(leaked.id), 'live');
  handles.release(leaked.id);
  handles.close();
});

test('boundary calls carry explicit lifecycle, capability, deadline and trace metadata', () => {
  const deadline = Date.now() + 10_000;
  const call = createBoundaryCall({ module: 'native', member: 'read', args: [1], ownership: 'transferred', capabilities: ['filesystem.read','filesystem.read'], deadline, traceId: 'trace-1' });
  assert.deepEqual(call.capabilities, ['filesystem.read']);
  assert.equal(call.ownership, 'transferred');
  assert.equal(call.deadline, deadline);
  assert.equal(call.traceId, 'trace-1');
});
