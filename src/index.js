import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { generateBindingArtifact, normalizeBindingSpec } from './bindings.js';

export const PlasmaType = Object.freeze({
  null: 'null', boolean: 'boolean', integer: 'integer', float: 'float', string: 'string', bytes: 'bytes', list: 'list', map: 'map', handle: 'handle'
});

export class PlasmaBoundaryError extends Error {
  constructor(message, { code = 'PLASMA_BOUNDARY_ERROR', adapter = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PlasmaBoundaryError';
    this.code = code;
    this.adapter = adapter;
  }
}

export function encodeValue(value) {
  if (value == null) return { type: PlasmaType.null, value: null };
  if (typeof value === 'boolean') return { type: PlasmaType.boolean, value };
  if (typeof value === 'bigint' || Number.isInteger(value)) return { type: PlasmaType.integer, value: String(value) };
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Plasma cannot encode non-finite numbers'); return { type: PlasmaType.float, value }; }
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
  constructor() { this.handles = new Map(); this.closed = false; }
  retain(value, metadata = {}) {
    this.#assertOpen();
    const id = randomUUID();
    this.handles.set(id, { value, refs: 1, metadata: structuredClone(metadata), createdAt: Date.now() });
    return { type: PlasmaType.handle, id, metadata: structuredClone(metadata) };
  }
  clone(id) { this.#assertOpen(); const entry = this.#get(id); entry.refs++; return { type: PlasmaType.handle, id, metadata: structuredClone(entry.metadata) }; }
  dereference(id) { this.#assertOpen(); return this.#get(id).value; }
  release(id) {
    this.#assertOpen();
    const entry = this.#get(id);
    if (entry.refs <= 0) throw new PlasmaBoundaryError(`invalid reference count for Plasma handle: ${id}`, { code: 'PLASMA_HANDLE_REFCOUNT' });
    entry.refs--;
    if (entry.refs === 0) this.handles.delete(id);
    return entry.refs;
  }
  snapshot() { return [...this.handles.entries()].map(([id, entry]) => ({ id, refs: entry.refs, metadata: structuredClone(entry.metadata), createdAt: entry.createdAt })); }
  leakReport() { return this.snapshot().filter((entry) => entry.refs > 0); }
  close({ allowLeaks = false } = {}) {
    if (this.closed) return;
    const leaks = this.leakReport();
    if (leaks.length && !allowLeaks) throw new PlasmaBoundaryError(`cannot close Plasma handle registry with ${leaks.length} live handle(s)`, { code: 'PLASMA_HANDLE_LEAK' });
    this.handles.clear(); this.closed = true;
  }
  #assertOpen() { if (this.closed) throw new PlasmaBoundaryError('Plasma handle registry is closed', { code: 'PLASMA_HANDLE_REGISTRY_CLOSED' }); }
  #get(id) { const entry = this.handles.get(id); if (!entry) throw new PlasmaBoundaryError(`unknown Plasma handle: ${id}`, { code: 'PLASMA_UNKNOWN_HANDLE' }); return entry; }
}

export class AdapterRegistry {
  constructor({ policy = null } = {}) { this.adapters = new Map(); this.policy = policy; }
  register(name, adapter) {
    if (this.adapters.has(name)) throw new Error(`adapter already registered: ${name}`);
    for (const method of ['invoke','capabilities']) if (typeof adapter?.[method] !== 'function') throw new TypeError(`adapter ${name} missing ${method}()`);
    this.adapters.set(name, adapter); return this;
  }
  get(name) { const adapter = this.adapters.get(name); if (!adapter) throw new Error(`unknown adapter: ${name}`); return adapter; }
  list() { return [...this.adapters].map(([name, adapter]) => ({ name, ...adapter.capabilities() })); }
  async invoke(name, call) {
    const started = Date.now();
    const deadline = call?.deadline ?? null;
    let controller = null;
    let timer = null;
    try {
      if (deadline != null) {
        if (!Number.isFinite(deadline)) throw new PlasmaBoundaryError('Plasma boundary deadline must be a finite epoch-millisecond timestamp', { code: 'PLASMA_BOUNDARY_DEADLINE', adapter: name });
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PlasmaBoundaryError('Plasma boundary deadline has expired', { code: 'PLASMA_BOUNDARY_DEADLINE', adapter: name });
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(new PlasmaBoundaryError('Plasma boundary deadline exceeded', { code: 'PLASMA_BOUNDARY_DEADLINE', adapter: name })), remaining);
        timer.unref?.();
      }
      if (this.policy) await raceWithBoundaryAbort(Promise.resolve(this.policy({ adapter: name, call: structuredClone(call) })), controller?.signal);
      const adapter = this.get(name);
      const invocation = Promise.resolve(adapter.invoke(call, controller ? { signal: controller.signal } : undefined));
      const value = await raceWithBoundaryAbort(invocation, controller?.signal);
      return { ok: true, value, adapter: name, durationMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: translateError(error, name, call), adapter: name, durationMs: Date.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
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

export function createProcessAdapter({
  language,
  command,
  args = [],
  protocol = 'jsonl',
  timeoutMs = 30_000,
  maxOutputBytes = 4 * 1024 * 1024,
  cwd = undefined,
  env = {},
  inheritEnvironment = ['PATH'],
  killSignal = 'SIGKILL'
}) {
  if (!language || !command) throw new TypeError('process adapter requires language and command');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError('maxOutputBytes must be a positive integer');
  const baseEnv = Object.fromEntries(inheritEnvironment.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const childEnv = Object.freeze({ ...baseEnv, ...env });
  return {
    capabilities: () => ({ language, async: true, bidirectional: true, protocol, timeoutMs, maxOutputBytes, environment: Object.keys(childEnv).sort() }),
    invoke(call, { signal } = {}) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
        const child = spawn(command, args, { stdio: ['pipe','pipe','pipe'], cwd, env: childEnv, windowsHide: true, shell: false });
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          if (error) reject(error); else resolve(value);
        };
        const terminate = (error) => { if (!child.killed) child.kill(killSignal); finish(error); };
        const timer = setTimeout(() => terminate(new PlasmaBoundaryError(`${language} adapter timed out after ${timeoutMs}ms`, { code: 'PLASMA_ADAPTER_TIMEOUT', adapter: language })), timeoutMs);
        timer.unref?.();
        const onAbort = () => terminate(signal.reason instanceof Error ? signal.reason : new PlasmaBoundaryError(`${language} adapter aborted`, { code: 'PLASMA_ADAPTER_ABORTED', adapter: language }));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener?.('abort', onAbort, { once: true });
        const append = (current, chunk, streamName) => {
          const nextSize = current.length + chunk.length;
          if (nextSize > maxOutputBytes) {
            terminate(new PlasmaBoundaryError(`${language} adapter ${streamName} exceeded ${maxOutputBytes} bytes`, { code: 'PLASMA_ADAPTER_OUTPUT_LIMIT', adapter: language }));
            return current;
          }
          return Buffer.concat([current, chunk], nextSize);
        };
        child.stdout.on('data', (chunk) => { stdout = append(stdout, Buffer.from(chunk), 'stdout'); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, Buffer.from(chunk), 'stderr'); });
        child.once('error', (error) => finish(new PlasmaBoundaryError(`${language} adapter failed to start: ${error.message}`, { code: 'PLASMA_ADAPTER_SPAWN', adapter: language, cause: error })));
        child.once('close', (code, exitSignal) => {
          if (settled) return;
          if (code !== 0) return finish(new PlasmaBoundaryError(`${language} adapter exited ${code ?? 'null'}${exitSignal ? ` (${exitSignal})` : ''}: ${stderr.toString('utf8').trim()}`, { code: 'PLASMA_ADAPTER_EXIT', adapter: language }));
          try {
            if (protocol !== 'jsonl') return finish(null, stdout.toString('utf8'));
            const lines = stdout.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
            if (lines.length !== 1) throw new Error(`expected exactly one JSON response line, received ${lines.length}`);
            const parsed = JSON.parse(lines[0]);
            finish(null, parsed);
          } catch (error) {
            finish(new PlasmaBoundaryError(`${language} adapter returned invalid ${protocol} response: ${error.message}`, { code: 'PLASMA_ADAPTER_PROTOCOL', adapter: language, cause: error }));
          }
        });
        const message = JSON.stringify({ protocol: 'plasma/1', call }) + '\n';
        child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') finish(new PlasmaBoundaryError(`${language} adapter stdin failed: ${error.message}`, { code: 'PLASMA_ADAPTER_STDIN', adapter: language, cause: error })); });
        child.stdin.end(message);
      });
    }
  };
}

export function generateBinding(spec, target) {
  return generateBindingArtifact(spec, target);
}

export { generateBindingArtifact, normalizeBindingSpec };

export function createBoundaryCall({ module, member, args = [], source = null, ownership = 'borrowed', capabilities = [], deadline = null, traceId = null }) {
  if (!module) throw new TypeError('boundary call requires module');
  if (!['borrowed','owned','transferred'].includes(ownership)) throw new TypeError(`unsupported Plasma ownership mode: ${ownership}`);
  if (deadline != null && (!Number.isFinite(deadline) || deadline <= Date.now())) throw new TypeError('deadline must be a future epoch-millisecond timestamp');
  return { id: randomUUID(), protocol: 'plasma/1', module, member, args: args.map(encodeValue), source, ownership, capabilities: [...new Set(capabilities)].sort(), deadline, traceId, createdAt: new Date().toISOString() };
}

export function translateError(error, adapter, call) {
  return { name: error?.name ?? 'Error', code: error?.code ?? null, message: error?.message ?? String(error), adapter, module: call?.module ?? null, member: call?.member ?? null, source: call?.source ?? null, traceId: call?.traceId ?? null, stack: error?.stack ?? null };
}

function raceWithBoundaryAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    promise,
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  ]);
}
