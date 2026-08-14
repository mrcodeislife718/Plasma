import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const PlasmaType = Object.freeze({
  null: 'null', boolean: 'boolean', integer: 'integer', float: 'float', string: 'string', bytes: 'bytes', list: 'list', map: 'map', handle: 'handle'
});

export function encodeValue(value) {
  if (value == null) return { type: PlasmaType.null, value: null };
  if (typeof value === 'boolean') return { type: PlasmaType.boolean, value };
  if (typeof value === 'bigint' || Number.isInteger(value)) return { type: PlasmaType.integer, value: String(value) };
  if (typeof value === 'number') return { type: PlasmaType.float, value };
  if (typeof value === 'string') return { type: PlasmaType.string, value };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { type: PlasmaType.bytes, value: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return { type: PlasmaType.list, value: value.map(encodeValue) };
  if (typeof value === 'object') return { type: PlasmaType.map, value: Object.fromEntries(Object.entries(value).map(([k,v]) => [k, encodeValue(v)])) };
  throw new TypeError(`unsupported Plasma value: ${typeof value}`);
}

export function decodeValue(encoded) {
  switch (encoded?.type) {
    case PlasmaType.null: return null;
    case PlasmaType.boolean: case PlasmaType.float: case PlasmaType.string: return encoded.value;
    case PlasmaType.integer: { const n = BigInt(encoded.value); return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n; }
    case PlasmaType.bytes: return Buffer.from(encoded.value, 'base64');
    case PlasmaType.list: return encoded.value.map(decodeValue);
    case PlasmaType.map: return Object.fromEntries(Object.entries(encoded.value).map(([k,v]) => [k, decodeValue(v)]));
    default: throw new TypeError(`unknown Plasma type: ${encoded?.type}`);
  }
}

export class HandleRegistry {
  constructor() { this.handles = new Map(); }
  retain(value, metadata = {}) { const id = randomUUID(); this.handles.set(id, { value, refs: 1, metadata }); return { type: PlasmaType.handle, id, metadata }; }
  clone(id) { const entry = this.#get(id); entry.refs++; return { type: PlasmaType.handle, id, metadata: entry.metadata }; }
  dereference(id) { return this.#get(id).value; }
  release(id) { const entry = this.#get(id); entry.refs--; if (entry.refs <= 0) this.handles.delete(id); return entry.refs; }
  #get(id) { const entry = this.handles.get(id); if (!entry) throw new Error(`unknown Plasma handle: ${id}`); return entry; }
}

export class AdapterRegistry {
  constructor() { this.adapters = new Map(); }
  register(name, adapter) {
    if (this.adapters.has(name)) throw new Error(`adapter already registered: ${name}`);
    for (const method of ['invoke','capabilities']) if (typeof adapter?.[method] !== 'function') throw new TypeError(`adapter ${name} missing ${method}()`);
    this.adapters.set(name, adapter); return this;
  }
  get(name) { const adapter = this.adapters.get(name); if (!adapter) throw new Error(`unknown adapter: ${name}`); return adapter; }
  list() { return [...this.adapters].map(([name, adapter]) => ({ name, ...adapter.capabilities() })); }
  async invoke(name, call) {
    const started = Date.now();
    try { return { ok: true, value: await this.get(name).invoke(call), adapter: name, durationMs: Date.now() - started }; }
    catch (error) { return { ok: false, error: translateError(error, name, call), adapter: name, durationMs: Date.now() - started }; }
  }
}

export function createJavaScriptAdapter(modules = {}) {
  return {
    capabilities: () => ({ language: 'javascript', async: true, bidirectional: true }),
    async invoke({ module, member, args = [] }) {
      const target = modules[module] ?? await import(module);
      const fn = member ? target[member] : target.default ?? target;
      if (typeof fn !== 'function') throw new Error(`JavaScript target is not callable: ${module}:${member ?? 'default'}`);
      return await fn(...args.map((arg) => decodeValue(encodeValue(arg))));
    }
  };
}

export function createProcessAdapter({ language, command, args = [], protocol = 'jsonl' }) {
  return {
    capabilities: () => ({ language, async: true, bidirectional: true, protocol }),
    invoke(call) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe','pipe','pipe'] });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error(`${language} adapter exited ${code}: ${stderr.trim()}`));
          try { resolve(protocol === 'jsonl' ? JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'null') : stdout); }
          catch (error) { reject(new Error(`${language} adapter returned invalid JSON: ${error.message}`)); }
        });
        child.stdin.end(JSON.stringify({ protocol: 'plasma/1', call }) + '\n');
      });
    }
  };
}

export function generateBinding(spec, target) {
  validateSpec(spec);
  const generators = {
    c: generateC, cpp: generateCpp, python: generatePython, java: generateJava,
    ruby: (s) => generateScriptBinding(s, 'ruby'), php: (s) => generateScriptBinding(s, 'php'), perl: (s) => generateScriptBinding(s, 'perl'),
    wasm: generateWasmManifest
  };
  const generator = generators[target];
  if (!generator) throw new Error(`unsupported binding target: ${target}`);
  return generator(spec);
}

export function createBoundaryCall({ module, member, args = [], source = null, ownership = 'borrowed' }) {
  return { id: randomUUID(), protocol: 'plasma/1', module, member, args: args.map(encodeValue), source, ownership, createdAt: new Date().toISOString() };
}

export function translateError(error, adapter, call) {
  return { name: error?.name ?? 'Error', message: error?.message ?? String(error), adapter, module: call?.module ?? null, member: call?.member ?? null, source: call?.source ?? null, stack: error?.stack ?? null };
}

function validateSpec(spec) {
  if (!spec?.name || !Array.isArray(spec.functions)) throw new TypeError('binding spec requires name and functions[]');
}
function generateC(spec) {
  const lines = [`/* Generated by Plasma */`, `#pragma once`, `#include <stdint.h>`, `typedef struct plasma_context plasma_context;`];
  for (const fn of spec.functions) lines.push(`int plasma_${spec.name}_${fn.name}(plasma_context* ctx);`);
  return lines.join('\n') + '\n';
}
function generateCpp(spec) {
  return `// Generated by Plasma\n#pragma once\nnamespace plasma::${spec.name} {\n${spec.functions.map((fn) => `  void ${fn.name}();`).join('\n')}\n}\n`;
}
function generatePython(spec) {
  return `# Generated by Plasma\nclass ${pascal(spec.name)}:\n${spec.functions.map((fn) => `    def ${fn.name}(self, *args):\n        return self._plasma.invoke("${fn.name}", args)`).join('\n') || '    pass'}\n`;
}
function generateJava(spec) {
  return `// Generated by Plasma\npublic interface ${pascal(spec.name)}Plasma {\n${spec.functions.map((fn) => `  Object ${fn.name}(Object... args);`).join('\n')}\n}\n`;
}
function generateScriptBinding(spec, language) { return `${language}:${spec.name}:${spec.functions.map((f)=>f.name).join(',')}\n`; }
function generateWasmManifest(spec) { return JSON.stringify({ plasma: 1, module: spec.name, imports: spec.functions.map((fn) => ({ name: fn.name, parameters: fn.parameters ?? [], returns: fn.returns ?? 'any' })) }, null, 2); }
function pascal(value) { return value.replace(/(^|[-_\s]+)(\w)/g, (_, __, c) => c.toUpperCase()); }
