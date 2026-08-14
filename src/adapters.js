import { createProcessAdapter, AdapterRegistry, encodeValue, decodeValue } from './index.js';

export function pythonAdapter({ command = 'python3', bridge = null } = {}) {
  return createProcessAdapter({ language: 'python', command, args: bridge ? [bridge] : ['-c', pythonBridgeSource()] });
}

export function rubyAdapter({ command = 'ruby', bridge = null } = {}) {
  return createProcessAdapter({ language: 'ruby', command, args: bridge ? [bridge] : ['-e', rubyBridgeSource()] });
}

export function phpAdapter({ command = 'php', bridge = null } = {}) {
  return createProcessAdapter({ language: 'php', command, args: bridge ? [bridge] : ['-r', phpBridgeSource()] });
}

export function perlAdapter({ command = 'perl', bridge = null } = {}) {
  return createProcessAdapter({ language: 'perl', command, args: bridge ? [bridge] : ['-MJSON::PP', '-e', perlBridgeSource()] });
}

export function jvmAdapter({ java = 'java', classPath, mainClass = 'PlasmaBridge' } = {}) {
  if (!classPath) throw new Error('JVM Plasma adapter requires classPath');
  return createProcessAdapter({ language: 'java', command: java, args: ['-cp', classPath, mainClass] });
}

export function wasmAdapter(instance) {
  if (!instance?.exports) throw new TypeError('WASM adapter requires a WebAssembly instance');
  return {
    capabilities: () => ({ language: 'wasm', async: false, bidirectional: true, exports: Object.keys(instance.exports) }),
    async invoke({ member, args = [] }) {
      const fn = instance.exports[member];
      if (typeof fn !== 'function') throw new Error(`unknown WASM export: ${member}`);
      const decoded = args.map((value) => decodeValue(encodeValue(value)));
      return fn(...decoded);
    }
  };
}

export function nativeOsAdapter(api = {}) {
  return {
    capabilities: () => ({ language: 'native-os', async: true, bidirectional: false, functions: Object.keys(api) }),
    async invoke({ member, args = [] }) { const fn = api[member]; if (typeof fn !== 'function') throw new Error(`native OS capability not registered: ${member}`); return fn(...args); }
  };
}

export function createStandardRegistry(options = {}) {
  const registry = new AdapterRegistry();
  if (options.javascript) registry.register('javascript', options.javascript);
  if (options.python !== false) registry.register('python', pythonAdapter(options.python ?? {}));
  if (options.ruby) registry.register('ruby', rubyAdapter(options.ruby));
  if (options.php) registry.register('php', phpAdapter(options.php));
  if (options.perl) registry.register('perl', perlAdapter(options.perl));
  if (options.jvm) registry.register('java', jvmAdapter(options.jvm));
  if (options.wasm) registry.register('wasm', wasmAdapter(options.wasm));
  if (options.os) registry.register('native-os', nativeOsAdapter(options.os));
  return registry;
}

export async function certifyAdapter(name, adapter, cases = defaultConformanceCases) {
  const results = [];
  for (const testCase of cases) {
    const started = Date.now();
    try {
      const result = await adapter.invoke(structuredClone(testCase.call));
      const passed = testCase.assert(result);
      results.push({ name: testCase.name, passed, durationMs: Date.now() - started, result });
    } catch (error) {
      results.push({ name: testCase.name, passed: false, durationMs: Date.now() - started, error: { name: error.name, message: error.message } });
    }
  }
  return { adapter: name, certified: results.every((r) => r.passed), capabilities: adapter.capabilities(), results };
}

export const defaultConformanceCases = Object.freeze([
  { name: 'identity-string', call: { module: 'builtin', member: 'identity', args: ['plasma'] }, assert: (value) => value === 'plasma' },
  { name: 'identity-number', call: { module: 'builtin', member: 'identity', args: [42] }, assert: (value) => value === 42 },
  { name: 'identity-map', call: { module: 'builtin', member: 'identity', args: [{ ok: true }] }, assert: (value) => value?.ok === true }
]);

export function bridgeProtocolHandler(functions = {}) {
  return async (message) => {
    if (message?.protocol !== 'plasma/1') throw new Error('unsupported Plasma bridge protocol');
    const call = message.call ?? message;
    const fn = functions[call.member] ?? (call.module === 'builtin' && call.member === 'identity' ? (value) => value : null);
    if (!fn) throw new Error(`unknown bridge member: ${call.member}`);
    return await fn(...(call.args ?? []));
  };
}

function pythonBridgeSource() { return `import sys,json\nfor line in sys.stdin:\n m=json.loads(line); c=m.get('call',m); a=c.get('args',[]); member=c.get('member');\n if c.get('module')=='builtin' and member=='identity': print(json.dumps(a[0] if a else None),flush=True)\n else: raise RuntimeError('unknown Plasma member: '+str(member))\n`; }
function rubyBridgeSource() { return `require 'json'; STDIN.each_line do |line|; m=JSON.parse(line); c=m['call']||m; a=c['args']||[]; if c['module']=='builtin' && c['member']=='identity'; puts JSON.generate(a[0]); STDOUT.flush; else; raise 'unknown Plasma member'; end; end`; }
function phpBridgeSource() { return `while (($line = fgets(STDIN)) !== false) { $m=json_decode($line,true); $c=$m['call']??$m; $a=$c['args']??[]; if (($c['module']??'')==='builtin' && ($c['member']??'')==='identity') { echo json_encode($a[0]??null)."\\n"; } else { fwrite(STDERR,'unknown Plasma member'); exit(2); } }`; }
function perlBridgeSource() { return `while(<STDIN>){my $m=decode_json($_);my $c=$m->{call}//$m;my $a=$c->{args}//[];if(($c->{module}//'') eq 'builtin' && ($c->{member}//'') eq 'identity'){print encode_json($a->[0])."\\n";}else{die 'unknown Plasma member';}}`; }
