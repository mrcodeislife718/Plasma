import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProcessAdapter, createJavaScriptAdapter, AdapterRegistry, HandleRegistry } from '../src/index.js';
import { pythonAdapter, rubyAdapter, phpAdapter, perlAdapter, jvmAdapter, wasmAdapter, nativeOsAdapter, certifyAdapter, defaultConformanceCases } from '../src/adapters.js';

function commandExists(command) { return spawnSync(command, ['--version'], { stdio:'ignore' }).status === 0; }
function compile(command,args,message){const result=spawnSync(command,args,{encoding:'utf8'});assert.equal(result.status,0,`${message}: ${result.stderr||result.stdout}`);}

async function certify(name,adapter){
  const proof=await certifyAdapter(name,adapter,defaultConformanceCases);
  assert.equal(proof.certified,true,JSON.stringify(proof.results));
  const failure=await new AdapterRegistry().register(name,adapter).invoke(name,{module:'missing',member:'explode',args:[]});
  assert.equal(failure.ok,false);
  assert.equal(failure.error.adapter,name);
  return proof;
}

test('JavaScript and native OS adapters prove values errors and lifecycle handles', async () => {
  await certify('javascript',createJavaScriptAdapter({ builtin:{ identity:(value)=>value } }));
  const osAdapter=nativeOsAdapter({ identity:(value)=>value });
  for(const entry of defaultConformanceCases){const value=await osAdapter.invoke(entry.call);assert.equal(entry.assert(value),true);}
  await assert.rejects(osAdapter.invoke({member:'missing'}),/not registered/);
  const handles=new HandleRegistry(); const handle=handles.retain({alive:true}); const clone=handles.clone(handle.id); assert.deepEqual(handles.dereference(clone.id),{alive:true}); assert.equal(handles.release(handle.id),1); assert.equal(handles.release(handle.id),0); assert.throws(()=>handles.dereference(handle.id),/unknown Plasma handle/);
});

test('Python Ruby PHP and Perl execute real process bridges bidirectionally', async (t) => {
  const matrix=[['python',pythonAdapter(), 'python3'],['ruby',rubyAdapter(), 'ruby'],['php',phpAdapter(), 'php'],['perl',perlAdapter(), 'perl']];
  for(const [name,adapter,command] of matrix){if(!commandExists(command)){t.diagnostic(`${command} not installed; CI certification job requires it`);continue;}await certify(name,adapter);}
});

test('C and C++ bridges compile and execute through Plasma JSON process protocol', async (t) => {
  if(!commandExists('cc')||!commandExists('c++')) t.skip('C/C++ compilers unavailable');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plasma-native-'));
  const cSource=`#include <stdio.h>\n#include <string.h>\nint main(void){char line[8192];if(!fgets(line,sizeof(line),stdin))return 2;char *p=strstr(line,"\\\"args\\\":[");if(!p)return 3;p+=8;if(*p=='\\\"'){char *e=strchr(p+1,'\\\"');if(!e)return 4;*++e='\\0';printf("\\\"%s\\\"\\n",p+1);}else if(*p=='{'){char *e=strstr(p,"]}");if(!e)return 5;*e='\\0';printf("%s\\n",p);}else{char *e=strchr(p,']');if(!e)return 6;*e='\\0';printf("%s\\n",p);}return 0;}\n`;
  const cppSource=`#include <iostream>\n#include <string>\nint main(){std::string line;std::getline(std::cin,line);auto p=line.find("\\\"args\\\":[");if(p==std::string::npos)return 3;p+=8;if(line[p]=='\\\"'){auto e=line.find('\\\"',p+1);std::cout<<line.substr(p,e-p+1)<<"\\n";}else if(line[p]=='{'){auto e=line.find("]}",p);std::cout<<line.substr(p,e-p)<<"\\n";}else{auto e=line.find(']',p);std::cout<<line.substr(p,e-p)<<"\\n";}return 0;}\n`;
  await fs.writeFile(path.join(root,'bridge.c'),cSource); await fs.writeFile(path.join(root,'bridge.cpp'),cppSource);
  compile('cc',[path.join(root,'bridge.c'),'-O2','-o',path.join(root,'cbridge')],'C bridge compile failed');
  compile('c++',[path.join(root,'bridge.cpp'),'-std=c++17','-O2','-o',path.join(root,'cppbridge')],'C++ bridge compile failed');
  await certify('c',createProcessAdapter({language:'c',command:path.join(root,'cbridge')}));
  await certify('cpp',createProcessAdapter({language:'cpp',command:path.join(root,'cppbridge')}));
});

test('JVM bridge compiles and executes real Java process protocol', async (t) => {
  if(!commandExists('javac')||!commandExists('java')) t.skip('JDK unavailable');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plasma-java-'));
  const source=`import java.io.*; public class PlasmaBridge { public static void main(String[] a)throws Exception{String s=new BufferedReader(new InputStreamReader(System.in)).readLine();int p=s.indexOf("\\\"args\\\":[")+8;char c=s.charAt(p);int e;if(c=='\\\"'){e=s.indexOf('\\\"',p+1)+1;}else if(c=='{'){e=s.indexOf("]}",p);}else{e=s.indexOf(']',p);}System.out.println(s.substring(p,e));} }`;
  await fs.writeFile(path.join(root,'PlasmaBridge.java'),source);
  compile('javac',[path.join(root,'PlasmaBridge.java')],'Java bridge compile failed');
  await certify('java',jvmAdapter({classPath:root}));
});

test('TypeScript bridge compiles then executes through Node process protocol', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plasma-ts-'));
  const source=`import * as readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin}); rl.on('line',(line)=>{const m=JSON.parse(line); const c=m.call??m; if(c.module==='builtin'&&c.member==='identity') process.stdout.write(JSON.stringify(c.args?.[0]??null)+'\\n'); else {process.stderr.write('unknown member');process.exitCode=2;} rl.close();});`;
  await fs.writeFile(path.join(root,'bridge.ts'),source);
  const tsc=path.resolve('node_modules','.bin',process.platform==='win32'?'tsc.cmd':'tsc');
  compile(tsc,[path.join(root,'bridge.ts'),'--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--outDir',root,'--types','node','--skipLibCheck'],'TypeScript bridge compile failed');
  await certify('typescript',createProcessAdapter({language:'typescript',command:process.execPath,args:[path.join(root,'bridge.js')]}));
});

test('WASM adapter executes real WebAssembly exports and rejects missing members', async () => {
  const binary=Uint8Array.from([0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,3,2,1,0,7,12,1,8,105,100,101,110,116,105,116,121,0,0,10,6,1,4,0,32,0,11]);
  assert.equal(WebAssembly.validate(binary),true);
  const {instance}=await WebAssembly.instantiate(binary);
  const adapter=wasmAdapter(instance);
  assert.equal(await adapter.invoke({member:'identity',args:[42]}),42);
  await assert.rejects(adapter.invoke({member:'missing',args:[]}),/unknown WASM export/);
});
