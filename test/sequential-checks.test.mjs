import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
for(const mode of ['pass','fail','timeout'])test(`sequential cloud diagnostic checks: ${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'metis-check-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const pnpm=join(root,'pnpm'),calls=join(root,'calls');
 await writeFile(pnpm,`#!/usr/bin/env python3\nimport sys,time\nwith open(${JSON.stringify(calls)},'a') as f:f.write(sys.argv[1]+'\\n')\nif sys.argv[1]=='test':\n print('test case progress',flush=True)\n ${mode==='timeout'?'time.sleep(5)':mode==='fail'?'sys.exit(1)':'pass'}\n`,{mode:0o700});
 let out;try{out=await exec('python3',['runtime/container/sequential-checks.py','--pnpm',pnpm,'--timeout-seconds',mode==='timeout'?'1.5':'5'],{timeout:15000});}catch(e){assert.notEqual(mode,'pass');out=e;}
 const header=JSON.parse(out.stdout.trim().split('\n').at(-1)),result=JSON.parse(await readFile(join(header.log_directory,'progress.json'),'utf8'));t.after(()=>rm(result.log_directory,{recursive:true,force:true}));
 assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n'),mode==='pass'?['lint','typecheck','test','build','build:worker']:['lint','typecheck','test']);assert.equal(result.state,mode==='pass'?'completed':'blocked');assert.equal(result.checks.find(c=>c.name==='test').state,mode==='pass'?'completed':mode==='fail'?'failed':'timeout');assert.match(result.checks.find(c=>c.name==='test').output_tail,/test case progress/);
});

for (const inheritedCI of [undefined, 'false']) test(`verification isolates CI environment when inherited CI is ${inheritedCI ?? 'unset'}`, async t => {
 const root = await mkdtemp(join(tmpdir(), 'metis-check-env-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const pnpm = join(root, 'pnpm'), calls = join(root, 'calls');
 await writeFile(pnpm, `#!/usr/bin/env python3
import json,os,sys
with open(${JSON.stringify(calls)},'a') as f:
 f.write(json.dumps({'check':sys.argv[1],'ci':os.environ.get('CI'),'codex_home':os.environ.get('CODEX_HOME'),'home':os.environ.get('HOME')})+'\\n')
`, { mode: 0o700 });
 const env = { ...process.env, CODEX_HOME: join(root, 'private-codex-home'), HOME: root };
 delete env.CI;
 if (inheritedCI !== undefined) env.CI = inheritedCI;
 const parentEnv = { ...env }, processCI = process.env.CI;
 const { stdout } = await exec('python3', ['runtime/container/sequential-checks.py', '--pnpm', pnpm, '--timeout-seconds', '5'], { env, timeout: 15000 });
 const result = JSON.parse(stdout.trim().split('\n').at(-1));
 t.after(() => rm(result.log_directory, { recursive: true, force: true }));
 assert.equal(result.state, 'completed');
 const children = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
 assert.deepEqual(children.map(child => child.check), ['lint', 'typecheck', 'test', 'build', 'build:worker']);
 for (const child of children) {
  assert.equal(child.ci, 'true');
  assert.equal(child.codex_home, null);
  assert.equal(child.home, result.log_directory);
  assert.notEqual(child.home, root);
 }
 assert.deepEqual(env, parentEnv);
 assert.equal(process.env.CI, processCI);
});

for (const timeout of [undefined, '480', '1800']) test(`verification accepts ${timeout ?? 'default'} bounded check window`, async t => {
 const root = await mkdtemp(join(tmpdir(), 'metis-check-window-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const pnpm = join(root, 'pnpm');
 await writeFile(pnpm, '#!/usr/bin/env python3\n', { mode: 0o700 });
 const args = ['runtime/container/sequential-checks.py', '--pnpm', pnpm];
 if (timeout !== undefined) args.push('--timeout-seconds', timeout);
 const { stdout } = await exec('python3', args, { timeout: 15000 });
 const result = JSON.parse(stdout.trim().split('\n').at(-1));
 t.after(() => rm(result.log_directory, { recursive: true, force: true }));
 assert.equal(result.state, 'completed');
 assert.deepEqual(result.checks.map(check => [check.name, check.state, check.exit_code]),
  ['lint', 'typecheck', 'test', 'build', 'build:worker'].map(name => [name, 'completed', 0]));
});

for (const timeout of ['0', '-1', '1800.01', 'nan', 'inf']) test(`verification rejects invalid check window ${timeout} before launching checks`, async t => {
 const root = await mkdtemp(join(tmpdir(), 'metis-check-invalid-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const pnpm = join(root, 'pnpm'), marker = join(root, 'launched');
 await writeFile(pnpm, `#!/usr/bin/env python3\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`, { mode: 0o700 });
 await assert.rejects(exec('python3', ['runtime/container/sequential-checks.py', '--pnpm', pnpm, '--timeout-seconds', timeout]), error => {
  assert.equal(error.code, 2);
  assert.match(error.stderr, /timeout in \(0, 1800\] required/);
  return true;
 });
 await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
