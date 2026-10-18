import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {validatePath,changeSetDigest} from '../../src/repository-adapters/contract.mjs';
import {check,AdapterError} from './store.mjs';
const exec=promisify(execFile);
// Trusted Chrome-style RGB/RGBA, non-interlaced, single-frame PNG screenshots.
// Other image encodings need a separately configured verified media transport.
export function pngDimensions(bytes){
  check(bytes.length>32&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'invalid_capture_png');
  let offset=8,width,height,channels;const compressed=[];let ended=false;
  while(offset+12<=bytes.length){const size=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);check(offset+12+size<=bytes.length,'invalid_capture_png');const data=bytes.subarray(offset+8,offset+8+size);
    let crc=0xffffffff;for(const byte of bytes.subarray(offset+4,offset+8+size)){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}check(((crc^0xffffffff)>>>0)===bytes.readUInt32BE(offset+8+size),'invalid_capture_png');
    if(kind==='IHDR'){check(offset===8&&size===13,'invalid_capture_png');width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=data[9]===6?4:data[9]===2?3:0;check(width>0&&height>0&&width<=16384&&height<=16384&&width*height<=40000000&&data[8]===8&&channels&&data[10]===0&&data[11]===0&&data[12]===0,'unsupported_capture_png');}
    if(kind==='acTL')throw new AdapterError('animated_capture_not_supported');if(kind==='IDAT')compressed.push(data);
    offset+=12+size;if(kind==='IEND'){check(size===0&&offset===bytes.length,'invalid_capture_png');ended=true;break;}
  }
  check(ended&&channels&&compressed.length,'invalid_capture_png');const stride=width*channels+1;const decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:stride*height});check(decoded.length===stride*height,'invalid_capture_png');for(let y=0;y<height;y++)check(decoded[y*stride]<=4,'invalid_capture_png');return {width,height};
}
export async function captureImage(config,workspace,store) {
  check(Array.isArray(config.command)&&config.command.length>0&&config.command.every(s=>typeof s==='string'&&s.length<=1000),'invalid_capture_command');validatePath(config.output);
  try{await exec(config.command[0],config.command.slice(1),{cwd:workspace,env:{PATH:process.env.PATH,HOME:workspace,LANG:'C.UTF-8',...(process.env.PLAYWRIGHT_BROWSERS_PATH?{PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH}:{})},timeout:60000,maxBuffer:1024*1024});}catch{throw new AdapterError('ui_capture_failed');}
  let parent=workspace;for(const part of config.output.split('/').slice(0,-1)){parent=join(parent,part);const stat=await lstat(parent);check(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe_capture_path');}
  let file;try{file=await open(join(workspace,config.output),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat();check(stat.isFile()&&stat.size<=5*1024*1024,'capture_image_too_large');const bytes=await file.readFile(),dimensions=pngDimensions(bytes);return {content:await store.put(bytes),mimeType:'image/png',byteLength:bytes.length,...dimensions,alt:config.alt??'Application interface',caption:'',capture:{scenario:config.scenario,route:config.route,viewport:config.viewport,fullPage:config.fullPage??false}};}finally{await file?.close();}
}
export async function comparisonsFor({config,before,workspace,store,snapshot,changeSet}){if(!config)return [];const after=await captureImage(config,workspace,store);return [{id:'ui-comparison',label:config.label??'UI changes',before:{...before,alt:before.alt+' before the change',caption:config.beforeCaption??'',subject:{kind:'source_revision',revision:snapshot.revision}},after:{...after,alt:after.alt+' after the change',caption:config.afterCaption??'',subject:{kind:'change_set',sha256:await changeSetDigest(changeSet,snapshot)}}}];}
export function httpMediaPublisher(config){
  const origin=new URL(config.origin);check(origin.protocol==='https:'&&!origin.username&&!origin.password&&!origin.search&&!origin.hash,'invalid_media_gateway');
  return async({intent,store})=>{const images=new Map();for(const pair of intent.review.comparisons)for(const side of ['before','after'])images.set(pair[side].content.ref,pair[side]);const published=[];
    for(const image of images.values()){const bytes=await store.get(image.content);const dims=pngDimensions(bytes);check(image.mimeType==='image/png'&&dims.width===image.width&&dims.height===image.height&&bytes.length===image.byteLength,'media_metadata_mismatch');let response;try{response=await (config.fetchImpl??fetch)(origin.href,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({key:image.content.sha256+'.png',bytes:bytes.toString('base64'),mimeType:image.mimeType,publicationKey:intent.idempotencyKey}),signal:AbortSignal.timeout(60000)});}catch{throw new AdapterError('media_upload_unknown');}check(response.ok,'media_upload_rejected');const data=await response.json();published.push({...image.content,url:data.url});}
    return published;
  };
}
// Cabinitron's existing review-media protocol. This writes to an explicitly
// configured existing bucket; it never creates a bucket or changes permissions.
export function artifactsMediaPublisher(config,{run=exec}={}){
  check(/^[a-f0-9]{32}$/.test(config.accountId)&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket),'invalid_artifacts_media_config');
  const origin=new URL(config.origin);check(origin.protocol==='https:'&&!origin.username&&!origin.password&&!origin.search&&!origin.hash,'invalid_artifacts_media_config');
  return async({intent,store})=>{
    const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os');const root=await mkdtemp(join(tmpdir(),'metis-media-'));
    try{const images=new Map();for(const pair of intent.review.comparisons)for(const side of ['before','after'])images.set(pair[side].content.ref,pair[side]);const published=[];
      for(const image of images.values()){const bytes=await store.get(image.content),dims=pngDimensions(bytes);check(image.mimeType==='image/png'&&dims.width===image.width&&dims.height===image.height&&bytes.length===image.byteLength,'media_metadata_mismatch');const name=image.content.sha256+'.png',path=join(root,name);await writeFile(path,bytes,{mode:0o600});
        try{await run('wrangler',['r2','object','put',config.bucket+'/media/'+name,'--file',path,'--content-type','image/png','--remote'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CI:'true',CLOUDFLARE_API_TOKEN:config.apiToken,CLOUDFLARE_ACCOUNT_ID:config.accountId,CLOUDFLARE_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(root,'wrangler.log')},timeout:60000,maxBuffer:1000000});}catch{throw new AdapterError('artifacts_media_upload_failed');}
        published.push({...image.content,url:origin.origin+'/api/operator/reviews/media/'+name});
      }return published;
    }finally{await rm(root,{recursive:true,force:true});}
  };
}
