import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeValue, decodeValue, HandleRegistry, AdapterRegistry, createJavaScriptAdapter, generateBinding, createBoundaryCall } from '../src/index.js';
import { certifyAdapter, wasmAdapter, nativeOsAdapter } from '../src/adapters.js';

test('Plasma value ABI round-trips representative data', () => {
  const value = { name:'plasma', count:42, bytes:Buffer.from('x'), list:[true,null] };
  const decoded = decodeValue(encodeValue(value));
  assert.equal(decoded.name, 'plasma');
  assert.equal(decoded.count, 42);
  assert.equal(decoded.bytes.toString(), 'x');
});

test('handle registry enforces retain/release lifecycle', () => {
  const handles = new HandleRegistry();
  const handle = handles.retain({ ok:true });
  assert.equal(handles.clone(handle.id).id, handle.id);
  assert.equal(handles.release(handle.id), 1);
  assert.equal(handles.release(handle.id), 0);
  assert.throws(() => handles.dereference(handle.id), /unknown Plasma handle/);
});

test('JavaScript adapter executes bidirectionally and certification passes', async () => {
  const adapter = createJavaScriptAdapter({ builtin: { identity: (value) => value } });
  const registry = new AdapterRegistry().register('js', adapter);
  const result = await registry.invoke('js', { module:'builtin', member:'identity', args:[{ok:true}] });
  assert.equal(result.ok, true);
  assert.equal(result.value.ok, true);
  const certification = await certifyAdapter('js', adapter);
  assert.equal(certification.certified, true);
});

test('binding generators cover C, C++, Python, Java, scripting, and WASM contracts', () => {
  const spec = { name:'math', functions:[{name:'add',parameters:['i32','i32'],returns:'i32'}] };
  assert.match(generateBinding(spec,'c'), /plasma_math_add/);
  assert.match(generateBinding(spec,'cpp'), /namespace plasma::math/);
  assert.match(generateBinding(spec,'python'), /def add/);
  assert.match(generateBinding(spec,'java'), /Object add/);
  assert.match(generateBinding(spec,'ruby'), /ruby:math:add/);
  assert.equal(JSON.parse(generateBinding(spec,'wasm')).module, 'math');
});

test('WASM and native OS adapters execute registered functions', async () => {
  const binary = Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,8,1,4,109,97,105,110,0,0,10,6,1,4,0,65,7,11]);
  const instance = (await WebAssembly.instantiate(binary)).instance;
  assert.equal(await wasmAdapter(instance).invoke({member:'main'}), 7);
  assert.equal(await nativeOsAdapter({ cwd:()=>'/tmp' }).invoke({member:'cwd'}), '/tmp');
  assert.equal(createBoundaryCall({module:'x',member:'y'}).protocol, 'plasma/1');
});
