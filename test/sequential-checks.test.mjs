import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
for(const mode of ['pass','fail','timeout'])test(`sequential cloud diagnostic checks: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'metis-check-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const pnpm=join(root,'pnpm'),calls=join(root,'calls');
 await writeFile(pnpm,`#!/usr/bin/env python3\nimport sys,time\nwith open(${JSON.stringify(calls)},'a') as f:f.write(sys.argv[1]+'\\n')\nif sys.argv[1]=='test':\n print('test case progress',flush=True)\n ${mode==='timeout'?'time.sleep(5)':mode==='fail'?'sys.exit(1)':'pass'}\n`,{mode:0o700});
 let out;try{out=await exec('python3',['runtime/container/sequential-checks.py','--pnpm',pnpm,'--timeout-seconds',mode==='timeout'?'0.3':'5'],{timeout:15000});}catch(e){assert.notEqual(mode,'pass');out=e;}
 const header=JSON.parse(out.stdout.trim().split('\n').at(-1)),result=JSON.parse(await readFile(join(header.log_directory,'progress.json'),'utf8'));t.after(()=>rm(result.log_directory,{recursive:true,force:true}));
 assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n'),mode==='pass'?['lint','typecheck','test','build','build:worker']:['lint','typecheck','test']);assert.equal(result.state,mode==='pass'?'completed':'blocked');assert.equal(result.checks.find(c=>c.name==='test').state,mode==='pass'?'completed':mode==='fail'?'failed':'timeout');assert.match(result.checks.find(c=>c.name==='test').output_tail,/test case progress/);
});
