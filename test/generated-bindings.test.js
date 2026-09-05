import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateBinding } from '../src/index.js';

const spec = {
  name: 'math',
  functions: [
    { name: 'add', parameters: [{ name: 'left', type: 'integer' }, { name: 'right', type: 'integer' }], returns: 'integer' },
    { name: 'label', parameters: [{ name: 'prefix', type: 'string' }, { name: 'suffix', type: 'string', optional: true }], returns: 'string' }
  ]
};

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plasma-bindings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function available(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

test('generated C binding compiles and invokes a concrete transport ABI', async (t) => {
  if (!available(process.env.CC || 'cc')) t.skip('C compiler unavailable');
  const root = await tempDir(t);
  const header = generateBinding(spec, 'c');
  await fs.writeFile(path.join(root, 'math.h'), header);
  await fs.writeFile(path.join(root, 'probe.c'), `#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\n#include "math.h"\nstatic int invoke(void *ctx,const char *module,const char *member,const char *args,char **result,char **error){(void)ctx;(void)error;if(strcmp(module,"math")!=0||strcmp(member,"add")!=0||strcmp(args,"[20,22]")!=0)return 9;*result=(char*)"42";return 0;}\nint main(void){plasma_transport transport={0,invoke};char *result=NULL,*error=NULL;int code=plasma_math_add(&transport,"[20,22]",&result,&error);if(code!=0||result==NULL)return 1;printf("%s\\n",result);return 0;}\n`);
  const cc = process.env.CC || 'cc';
  const compile = spawnSync(cc, ['-std=c11', '-Wall', '-Wextra', '-Werror', path.join(root, 'probe.c'), '-o', path.join(root, 'probe')], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(path.join(root, 'probe'), [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '42');
});

test('generated Python binding is syntactically valid and invokes its transport', async (t) => {
  if (!available('python3')) t.skip('python3 unavailable');
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'math_binding.py'), generateBinding(spec, 'python'));
  await fs.writeFile(path.join(root, 'run.py'), `from math_binding import Math\nclass Transport:\n    def invoke(self,module,member,args):\n        if module != 'math' or member != 'add' or args != [20,22]: raise RuntimeError('bad invocation')\n        return 42\nprint(Math(Transport()).add(20,22))\n`);
  const compile = spawnSync('python3', ['-m', 'py_compile', path.join(root, 'math_binding.py')], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync('python3', [path.join(root, 'run.py')], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '42');
});

test('generated JavaScript binding invokes an asynchronous Plasma transport', async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, 'math.mjs');
  await fs.writeFile(file, generateBinding(spec, 'javascript'));
  const module = await import(`${new URL(`file://${file}`).href}?v=${Date.now()}`);
  const calls = [];
  const client = new module.MathPlasma({ async invoke(moduleName, memberName, args) { calls.push({ moduleName, memberName, args }); return args[0] + args[1]; } });
  assert.equal(await client.add(20, 22), 42);
  assert.deepEqual(calls, [{ moduleName: 'math', memberName: 'add', args: [20,22] }]);
});

test('binding spec validation rejects injection-shaped identifiers and invalid types', () => {
  assert.throws(() => generateBinding({ name: 'bad;rm', functions: [] }, 'python'), /valid name/);
  assert.throws(() => generateBinding({ name: 'ok', functions: [{ name: 'x', parameters: [{ name: 'a);', type: 'integer' }] }] }, 'c'), /invalid or duplicate parameter/);
  assert.throws(() => generateBinding({ name: 'ok', functions: [{ name: 'x', parameters: [{ name: 'a', type: 'shell' }] }] }, 'c'), /unsupported Plasma binding type/);
});

test('WASM binding manifest carries typed async boundary information', () => {
  const manifest = JSON.parse(generateBinding(spec, 'wasm'));
  assert.equal(manifest.protocol, 'plasma-wasm/1');
  assert.equal(manifest.module, 'math');
  assert.equal(manifest.imports[0].parameters[0].type, 'integer');
  assert.equal(manifest.imports[0].async, true);
});
