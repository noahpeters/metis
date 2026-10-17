import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('real container HTTP server exits on SIGTERM and releases its listener',async()=>{
  const child=fork(fileURLToPath(new URL('../runtime/container/server.mjs',import.meta.url)),[],{env:{PATH:process.env.PATH,PORT:'0'},stdio:['ignore','ignore','ignore','ipc']});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
  try{
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    const {port}=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Server exited before listening')));});
    const response=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
    child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  }finally{clearTimeout(timeout);child.kill('SIGKILL');}
});
