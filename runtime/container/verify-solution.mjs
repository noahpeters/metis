// Run only inside the task container, never on the operator's computer. This
// process is separate from the Codex process and receives no auth directory.
import {pathToFileURL} from 'node:url';
const module=await import(pathToFileURL(process.argv[2]).href);
const cases=JSON.parse(process.argv[3]);
if(typeof module.summarize!=='function')process.exit(1);
const results=await Promise.all(cases.map(({values,nonce})=>module.summarize(values,nonce)));
process.stdout.write(JSON.stringify(results));
