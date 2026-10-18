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
// A provider read is bound to the last recorded publication before it can
// become rework input. Unrecorded head movement requires reconciliation.
export function validateSubmittedChange(change,publication,allowedReviewOrigins) {
  record(change,['version','changeId','taskId','source','baseRevision','changeSetDigest','review','submittedSnapshot','feedback'],'submitted change');version(change);validateSource(change.source);
  requireValue(change.changeId===publication.changeId && change.taskId===publication.taskId && sameSource(change.source,publication) && change.source.ref===publication.targetRef && change.baseRevision===publication.baseRevision && change.changeSetDigest===publication.changeSetDigest,'submitted change does not match the recorded publication');
  record(change.review,['id','url','revision','state','canUpdate','updateToken'],'submitted review');
  requireValue(change.review.id===publication.review.id && change.review.revision===publication.review.revision,'review head moved; reconcile before rework');
  validateReviewLink(change.review.url,allowedReviewOrigins);
  requireValue(['open','closed','integrated','unknown'].includes(change.review.state) && typeof change.review.canUpdate==='boolean','invalid submitted review state');
  requireValue(change.review.updateToken===null || text(change.review.updateToken),'invalid provider concurrency token');
  requireValue(!change.review.canUpdate || (change.review.state==='open' && text(change.review.updateToken)),'updateable reviews require an open state and concurrency token');
  validateSnapshot(change.submittedSnapshot);
  requireValue(sameSource(change.submittedSnapshot.source,change.source) && change.submittedSnapshot.revision===change.review.revision,'submitted snapshot must contain the exact review head');
  requireValue(Array.isArray(change.feedback) && change.feedback.length<=100,'feedback must be a bounded manifest');
  const ids=new Set();
  for(const item of change.feedback) {
    record(item,['id','kind','revision','content'],'feedback');
    requireValue(text(item.id) && !ids.has(item.id) && ['review_comment','check_failure','merge_conflict'].includes(item.kind) && text(item.revision),'invalid or duplicate revision-bound feedback');
    ids.add(item.id);validateContent(item.content);
  }
  return change;
}
function validateRework(rework,{taskId,attemptId,changeId,snapshot},allowedReviewOrigins) {
  record(rework,['reason','previousPublication','submittedChange'],'rework');
  requireValue(['fix_issues','resolve_conflicts','refresh_base'].includes(rework.reason),'invalid rework reason');
  const previous=rework.previousPublication;
  validatePublicationShape(previous,allowedReviewOrigins);
  requireValue(previous.attemptId!==attemptId,'rework requires a new execution attempt');
  requireValue(previous.taskId===taskId && previous.changeId===changeId && sameSource(previous,snapshot.source) && previous.targetRef===snapshot.source.ref,'rework must preserve task, change, repository and target identity');
  validateSubmittedChange(rework.submittedChange,previous,allowedReviewOrigins);
  requireValue(rework.submittedChange.review.canUpdate && rework.submittedChange.review.state==='open','review no longer accepts updates');
}
// Images are revision-bound content manifests, never inline bytes or upload
// credentials. Actual decoding/hashing and storage remain adapter work.
export function validateComparisons(comparisons,{snapshot,changeSetDigest,rework}) {
  requireValue(Array.isArray(comparisons) && comparisons.length<=10,'at most 10 before/after comparisons are supported');
  validateSnapshot(snapshot);requireValue(digest(changeSetDigest),'comparison output digest is required');
  const ids=new Set(),contents=new Map();let totalBytes=0;
  const beforeRevisions=new Set([snapshot.revision,...(rework?[rework.submittedChange.submittedSnapshot.revision]:[])]);
  for(const pair of comparisons) {
    record(pair,['id','label','before','after'],'image comparison');
    requireValue(identifier(pair.id) && !ids.has(pair.id) && text(pair.label,200),'comparison IDs must be unique and labelled');ids.add(pair.id);
    for(const side of ['before','after']) {
      const image=pair[side];record(image,['content','mimeType','byteLength','width','height','alt','caption','subject','capture'],'review image');validateContent(image.content);
      const identity=JSON.stringify([image.content.sha256,image.mimeType,image.byteLength,image.width,image.height]);
      requireValue(!contents.has(image.content.ref) || contents.get(image.content.ref)===identity,'image content reference has conflicting metadata');contents.set(image.content.ref,identity);
      requireValue(['image/png','image/jpeg','image/webp'].includes(image.mimeType),'unsupported review image type');
      requireValue(Number.isInteger(image.byteLength) && image.byteLength>0 && image.byteLength<=5*1024*1024,'review image exceeds 5 MiB');totalBytes+=image.byteLength;
      requireValue(Number.isInteger(image.width) && Number.isInteger(image.height) && image.width>0 && image.height>0 && image.width<=16384 && image.height<=16384 && image.width*image.height<=40000000,'invalid review image dimensions');
      requireValue(text(image.alt,500) && typeof image.caption==='string' && image.caption.length<=1000,'image alt text and a bounded caption are required');
      record(image.subject,['kind','revision','sha256'],'image subject');
      requireValue(side==='before' ? (image.subject.kind==='source_revision' && beforeRevisions.has(image.subject.revision) && image.subject.sha256===undefined) : (image.subject.kind==='change_set' && image.subject.sha256===changeSetDigest && image.subject.revision===undefined),'image refers to a different source or output revision');
      record(image.capture,['scenario','route','viewport','fullPage'],'image capture');
      requireValue(text(image.capture.scenario,200) && text(image.capture.route,1000) && image.capture.route.startsWith('/') && !image.capture.route.startsWith('//') && !/[?#\\]/.test(image.capture.route) && typeof image.capture.fullPage==='boolean','image capture requires a scenario and path without query parameters');
      record(image.capture.viewport,['width','height','deviceScaleFactor'],'capture viewport');
      const viewport=image.capture.viewport;
      requireValue(['width','height'].every(key=>Number.isInteger(viewport[key]) && viewport[key]>0 && viewport[key]<=8192) && Number.isFinite(viewport.deviceScaleFactor) && viewport.deviceScaleFactor>=0.5 && viewport.deviceScaleFactor<=4,'invalid capture viewport');
    }
    requireValue(pair.before.capture.scenario===pair.after.capture.scenario && JSON.stringify(canonical(pair.before.capture.viewport))===JSON.stringify(canonical(pair.after.capture.viewport)) && pair.before.capture.fullPage===pair.after.capture.fullPage,'before and after must use the same scenario, viewport and capture mode');
  }
  requireValue(totalBytes<=20*1024*1024,'comparison images exceed the 20 MiB submission budget');
  return comparisons;
}
export async function publicationIntent({taskId,attemptId,changeId,snapshot,changeSet,title,description,descriptionFormat='markdown',descriptionDialect='gfm',comparisons=[],evidence=[],rework=null},allowedReviewOrigins=[]) {
  // Detach before the first await; callers cannot race a validated manifest
  // against hashing or mutate an intent while it is being constructed.
  snapshot=structuredClone(snapshot);changeSet=structuredClone(changeSet);evidence=structuredClone(evidence);rework=structuredClone(rework);comparisons=structuredClone(comparisons);
  requireValue(text(taskId) && text(attemptId) && text(changeId),'task, attempt and stable change identities are required');
  validateSnapshot(snapshot);
  if(rework!==null)validateRework(rework,{taskId,attemptId,changeId,snapshot},allowedReviewOrigins);
  requireValue(text(title,200) && typeof description==='string' && description.length<=60000,'bounded review title and description are required');
  requireValue(descriptionFormat==='markdown' && descriptionDialect==='gfm','review bodies must use GitHub Flavored Markdown');
  requireValue(Array.isArray(evidence) && evidence.length<=50,'evidence must be a bounded content manifest');
  evidence.forEach(validateContent);
  const changesDigest=await changeSetDigest(changeSet,snapshot);
  validateComparisons(comparisons,{snapshot,changeSetDigest:changesDigest,rework});
  // Copy/freeze the whole intent so an implementation cannot alter the identity
  // between preflight, durable intent recording, and publication.
  const intent=JSON.parse(JSON.stringify({version:CONTRACT_VERSION,taskId,attemptId,changeId,operation:rework===null?'create':'update',rework,snapshot,changeSet:{...changeSet,changes:[...changeSet.changes].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)},changeSetDigest:changesDigest,review:{title,description,descriptionFormat,descriptionDialect,comparisons,evidence}}));
  intent.idempotencyKey='metis-review-'+await hash(intent);
  const freeze=value=>{if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  return freeze(intent);
}
function validateReviewLink(value,allowedReviewOrigins) {
  let url;try{url=new URL(value);}catch{throw new TypeError('Repository adapter: invalid review URL');}
  requireValue(Array.isArray(allowedReviewOrigins) && allowedReviewOrigins.includes(url.origin),'review URL origin is not configured for this adapter');
  requireValue(url.protocol==='https:' && !url.username && !url.password && !Array.from(url.searchParams.keys()).some(key=>/^(token|access_token|auth|authorization|key|api_key|signature|sig|jwt)$/i.test(key)),'review URL must use HTTPS without credentials or signed access parameters');
}
function validatePublicationShape(receipt,allowedReviewOrigins) {
  record(receipt,['version','taskId','attemptId','changeId','operation','parentIdempotencyKey','adapter','repository','targetRef','baseRevision','changeSetDigest','idempotencyKey','review'],'publication');version(receipt);
  validateSource({adapter:receipt.adapter,repository:receipt.repository,ref:receipt.targetRef});
  requireValue(text(receipt.taskId) && text(receipt.attemptId) && text(receipt.changeId) && text(receipt.baseRevision) && digest(receipt.changeSetDigest) && /^metis-review-[a-f0-9]{64}$/.test(receipt.idempotencyKey),'invalid publication identity');
  requireValue((receipt.operation==='create' && receipt.parentIdempotencyKey===null) || (receipt.operation==='update' && /^metis-review-[a-f0-9]{64}$/.test(receipt.parentIdempotencyKey) && receipt.parentIdempotencyKey!==receipt.idempotencyKey),'invalid publication revision lineage');
  record(receipt.review,['id','url','revision'],'review');
  requireValue(text(receipt.review.id) && text(receipt.review.revision),'provider review ID and exact submitted revision are required');
  validateReviewLink(receipt.review.url,allowedReviewOrigins);
}
export function validatePublication(receipt,intent,allowedReviewOrigins) {
  validatePublicationShape(receipt,allowedReviewOrigins);
  requireValue(receipt.taskId===intent.taskId && receipt.attemptId===intent.attemptId && receipt.changeId===intent.changeId && receipt.operation===intent.operation && receipt.parentIdempotencyKey===(intent.rework?.previousPublication.idempotencyKey??null) && sameSource(receipt,intent.snapshot.source) && receipt.targetRef===intent.snapshot.source.ref && receipt.baseRevision===intent.snapshot.revision && receipt.changeSetDigest===intent.changeSetDigest && receipt.idempotencyKey===intent.idempotencyKey,'publication does not match its recorded intent');
  if(intent.operation==='update')requireValue(receipt.review.id===intent.rework.previousPublication.review.id && receipt.review.revision!==intent.rework.previousPublication.review.revision,'update must preserve the review and produce a new submitted revision');
  return receipt;
}
// Preflight only: the provider must still enforce the expected head/token in
// its actual conditional write, and reconcile any partial/ambiguous update.
export function validateUpdatePrecondition(intent,{submittedChange,targetSnapshot},allowedReviewOrigins) {
  requireValue(intent.operation==='update' && intent.rework,'an update intent is required');
  validateRework(intent.rework,intent,allowedReviewOrigins);
  validateSubmittedChange(submittedChange,intent.rework.previousPublication,allowedReviewOrigins);
  requireValue(submittedChange.review.state==='open' && submittedChange.review.canUpdate,'review no longer accepts updates');
  requireValue(submittedChange.review.updateToken===intent.rework.submittedChange.review.updateToken,'review concurrency token changed; reconcile before updating');
  validateSnapshot(targetSnapshot);
  requireValue(sameSource(targetSnapshot.source,intent.snapshot.source) && targetSnapshot.source.ref===intent.snapshot.source.ref && targetSnapshot.revision===intent.snapshot.revision && targetSnapshot.content.sha256===intent.snapshot.content.sha256,'target base moved; prepare another rework attempt');
  return intent;
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
  record(definition,['id','version','resolve','prepare','collect','publish','readChange','prepareRework','update','observe'],'adapter definition');
  requireValue(typeof definition.id==='string' && /^[a-z][a-z0-9-]{0,39}$/.test(definition.id) && text(definition.version),'adapter ID and implementation version are required');
  for(const method of ['resolve','prepare','collect','publish','readChange','prepareRework','update','observe'])requireValue(typeof definition[method]==='function',`missing ${method} implementation`);
  // This deliberately supplies no network, auth, scheduler, or model launcher.
  return Object.freeze({...definition});
}

// Produces provider-ready Markdown after an adapter has uploaded/reconciled all
// images. It does not upload bytes or render HTML in the Metis UI.
export function renderReviewMarkdown(intent,publishedImages,allowedMediaOrigins) {
  requireValue(intent.review.descriptionFormat==='markdown' && intent.review.descriptionDialect==='gfm','unsupported review body format');
  validateComparisons(intent.review.comparisons,intent);
  requireValue(Array.isArray(publishedImages),'published images must be a manifest');
  const expected=new Map();
  for(const pair of intent.review.comparisons)for(const side of ['before','after']) {
    const content=pair[side].content;
    requireValue(!expected.has(content.ref) || expected.get(content.ref)===content.sha256,'image content reference has conflicting hashes');expected.set(content.ref,content.sha256);
  }
  const urls=new Map();
  for(const image of publishedImages) {
    record(image,['ref','sha256','url'],'published image');
    requireValue(expected.has(image.ref) && expected.get(image.ref)===image.sha256 && !urls.has(image.ref),'unexpected, duplicate or mismatched published image');
    requireValue(text(image.url,4096),'published image URL exceeds its limit');
    validateReviewLink(image.url,allowedMediaOrigins);urls.set(image.ref,new URL(image.url).href.replace(/[<>()[\\\]]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase()));
  }
  requireValue(urls.size===expected.size,'review images have not all been published');
  const escape=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_[\]{}()#+.!|~-])/g,'\\$1');
  const lines=[intent.review.description];
  for(const pair of intent.review.comparisons) {
    lines.push('',`## ${escape(pair.label)}`);
    for(const side of ['before','after']) {
      const image=pair[side];lines.push('',`### ${side==='before'?'Before':'After'}`,'',`![${escape(image.alt)}](<${urls.get(image.content.ref)}>)`);
      if(image.caption)lines.push('',escape(image.caption));
    }
  }
  const markdown=lines.join('\n');
  requireValue(markdown.length<=60000,'assembled review Markdown exceeds 60000 characters');
  return markdown;
}
