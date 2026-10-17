// Repository data only. Implementations receive credential access through
// trusted closures, never through these persisted/model-visible envelopes.
export const CONTRACT_VERSION = 1;
const modes = new Set(['100644', '100755']);
const digestPattern = /^[a-f0-9]{64}$/;
function requireValue(condition, message) { if (!condition) throw new TypeError(`Repository adapter: ${message}`); }
function record(value, keys, name) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  requireValue(Object.keys(value).every(key => keys.includes(key)), `${name} has unsupported fields`);
}
function text(value, max=256) { return typeof value === 'string' && value.length>0 && value.length<=max && !/[\u0000-\u001f\u007f]/.test(value); }
function identifier(value) { return text(value) && /^[a-zA-Z0-9._:/-]+$/.test(value) && !value.includes('://'); }
function digest(value) { return typeof value==='string' && digestPattern.test(value); }
function version(value) { requireValue(value.version===CONTRACT_VERSION, 'unsupported contract version'); }
function sameSource(a,b) { return a.adapter===b.adapter && a.repository===b.repository; }
export function validateSource(source) {
  record(source,['adapter','repository','ref'],'source');
  requireValue(typeof source.adapter==='string' && /^[a-z][a-z0-9-]{0,39}$/.test(source.adapter),'invalid adapter ID');
  requireValue(identifier(source.repository),'invalid repository identity');
  requireValue(text(source.ref),'a requested source ref is required');
  return source;
}
export function validatePath(path) {
  requireValue(text(path,1024) && !/[\\:]/.test(path) && !path.startsWith('/') && path===path.normalize('NFC'),'invalid relative workspace path');
  requireValue(path.split('/').every(part=>part && part!=='.' && part!=='..' && part.toLowerCase()!=='.git'),'unsafe workspace path');
  return path;
}
export function validateContent(content) {
  record(content,['ref','sha256'],'content');
  requireValue(identifier(content.ref) && digest(content.sha256),'content requires an opaque reference and SHA-256');
  return content;
}
export function validateSnapshot(snapshot) {
  record(snapshot,['version','source','adapterVersion','revision','content','instructions'],'snapshot');version(snapshot);validateSource(snapshot.source);
  requireValue(text(snapshot.adapterVersion),'a pinned adapter implementation version is required');
  requireValue(text(snapshot.revision),'an immutable provider revision is required');validateContent(snapshot.content);
  requireValue(Array.isArray(snapshot.instructions) && snapshot.instructions.length<=100,'instructions must be a bounded file manifest');
  const paths=new Set();
  for(const file of snapshot.instructions) {
    record(file,['path','sha256'],'instruction file');validatePath(file.path);
    requireValue(digest(file.sha256) && !paths.has(file.path),'invalid or duplicate instruction file');paths.add(file.path);
  }
  return snapshot;
}
function validateFile(file,withContent) {
  record(file,withContent?['sha256','mode','contentRef']:['sha256','mode'],'file');
  requireValue(digest(file.sha256) && modes.has(file.mode),'only hashed regular files and executable files are supported');
  if(withContent)requireValue(identifier(file.contentRef),'changed files require an opaque content reference');
}
export function validateChangeSet(changeSet,snapshot) {
  validateSnapshot(snapshot);
  record(changeSet,['version','source','baseRevision','changes'],'change set');version(changeSet);validateSource(changeSet.source);
  requireValue(sameSource(changeSet.source,snapshot.source) && changeSet.source.ref===snapshot.source.ref && changeSet.baseRevision===snapshot.revision,'change set does not match the pinned source');
  requireValue(Array.isArray(changeSet.changes) && changeSet.changes.length>0 && changeSet.changes.length<=1000,'change set must contain 1–1000 file changes');
  const paths=new Set();
  for(const change of changeSet.changes) {
    record(change,['path','before','after'],'file change');validatePath(change.path);
    requireValue(!paths.has(change.path.toLowerCase()),'duplicate or case-colliding file path');paths.add(change.path.toLowerCase());
    requireValue(change.before===null || (change.before && typeof change.before==='object'),'before must be a file or null');
    requireValue(change.after===null || (change.after && typeof change.after==='object'),'after must be a file or null');
    requireValue(change.before!==null || change.after!==null,'empty file change');
    if(change.before!==null)validateFile(change.before,false);
    if(change.after!==null)validateFile(change.after,true);
    requireValue(!change.before || !change.after || change.before.sha256!==change.after.sha256 || change.before.mode!==change.after.mode,'unchanged file');
  }
  return changeSet;
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
async function hash(value) {
  const data=new TextEncoder().encode(JSON.stringify(canonical(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function changeSetDigest(changeSet,snapshot) {
  validateChangeSet(changeSet,snapshot);
  return hash({...changeSet,changes:[...changeSet.changes].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
}
export async function publicationIntent({taskId,attemptId,snapshot,changeSet,title,description,evidence=[]}) {
  // Detach before the first await; callers cannot race a validated manifest
  // against hashing or mutate an intent while it is being constructed.
  snapshot=structuredClone(snapshot);changeSet=structuredClone(changeSet);evidence=structuredClone(evidence);
  requireValue(text(taskId) && text(attemptId),'task and attempt identities are required');
  requireValue(text(title,200) && typeof description==='string' && description.length<=60000,'bounded review title and description are required');
  requireValue(Array.isArray(evidence) && evidence.length<=50,'evidence must be a bounded content manifest');
  evidence.forEach(validateContent);
  const changesDigest=await changeSetDigest(changeSet,snapshot);
  // Copy/freeze the whole intent so an implementation cannot alter the identity
  // between preflight, durable intent recording, and publication.
  const intent=JSON.parse(JSON.stringify({version:CONTRACT_VERSION,taskId,attemptId,snapshot,changeSet:{...changeSet,changes:[...changeSet.changes].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)},changeSetDigest:changesDigest,review:{title,description,evidence}}));
  intent.idempotencyKey='metis-review-'+await hash(intent);
  const freeze=value=>{if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  return freeze(intent);
}
export function validatePublication(receipt,intent,allowedReviewOrigins) {
  record(receipt,['version','adapter','repository','baseRevision','changeSetDigest','idempotencyKey','review'],'publication');version(receipt);
  requireValue(sameSource(receipt,intent.snapshot.source) && receipt.baseRevision===intent.snapshot.revision && receipt.changeSetDigest===intent.changeSetDigest && receipt.idempotencyKey===intent.idempotencyKey,'publication does not match its recorded intent');
  record(receipt.review,['id','url','revision'],'review');
  requireValue(text(receipt.review.id) && text(receipt.review.revision),'provider review ID and exact submitted revision are required');
  let url;try{url=new URL(receipt.review.url);}catch{throw new TypeError('Repository adapter: invalid review URL');}
  requireValue(Array.isArray(allowedReviewOrigins) && allowedReviewOrigins.includes(url.origin),'review URL origin is not configured for this adapter');
  requireValue(url.protocol==='https:' && !url.username && !url.password && !Array.from(url.searchParams.keys()).some(key=>/^(token|access_token|auth|authorization|key|api_key|signature|sig|jwt)$/i.test(key)),'review URL must use HTTPS without credentials or signed access parameters');
  return receipt;
}
export function validateObservation(observation,publication) {
  record(observation,['version','review','checks','integration','deployment'],'observation');version(observation);
  record(observation.review,['id','revision','state','approval'],'review status');
  requireValue(observation.review.id===publication.review.id && observation.review.revision===publication.review.revision,'review status refers to a different review or revision');
  requireValue(['open','closed','integrated','unknown'].includes(observation.review.state) && ['pending','approved','changes_requested','unknown'].includes(observation.review.approval),'invalid review status');
  for(const [name,states] of [['checks',['pending','passed','failed','unknown']],['integration',['not_integrated','integrated','unknown']],['deployment',['not_started','pending','succeeded','failed','unknown']]]) {
    const status=observation[name];record(status,['state','revision'],name);
    requireValue(states.includes(status.state) && (status.revision===null || text(status.revision)),`invalid ${name} status`);
  }
  requireValue(observation.checks.revision===null || observation.checks.revision===publication.review.revision,'checks must cover the published revision');
  requireValue(!['passed','failed'].includes(observation.checks.state) || observation.checks.revision===publication.review.revision,'completed checks must cover the published revision');
  requireValue(observation.integration.state!=='integrated' || text(observation.integration.revision),'integration must identify its resulting revision');
  requireValue((observation.review.state==='integrated') === (observation.integration.state==='integrated'),'review and integration evidence disagree');
  requireValue(observation.deployment.state!=='succeeded' || (observation.integration.state==='integrated' && observation.deployment.revision===observation.integration.revision),'successful deployment must cover the exact integrated revision');
  return observation;
}
export function defineRepositoryAdapter(definition) {
  record(definition,['id','version','resolve','prepare','collect','publish','observe'],'adapter definition');
  requireValue(typeof definition.id==='string' && /^[a-z][a-z0-9-]{0,39}$/.test(definition.id) && text(definition.version),'adapter ID and implementation version are required');
  for(const method of ['resolve','prepare','collect','publish','observe'])requireValue(typeof definition[method]==='function',`missing ${method} implementation`);
  // This deliberately supplies no network, auth, scheduler, or model launcher.
  return Object.freeze({...definition});
}
