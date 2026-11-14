'use strict';
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const {spawn}=require('node:child_process');
const {parseCue,sampleRange}=require('./cue');
const MAX_BYTES=256*1024*1024;
function run(binary,args,fds,valid){return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{stdio:['ignore','pipe','ignore',...fds]});const chunks=[];let bytes=0,failed=false;
 const abort=()=>{failed=true;child.kill('SIGKILL');};
 const timer=setTimeout(abort,120000);const poll=setInterval(()=>{if(!valid())abort();},50);
 child.stdout.on('data',b=>{bytes+=b.length;if(bytes>65536)abort();else chunks.push(b);});
 child.on('error',()=>{clearTimeout(timer);clearInterval(poll);reject(Error('CUE decoder unavailable'));});
 child.on('close',code=>{clearTimeout(timer);clearInterval(poll);if(code||failed||!valid())reject(Error('CUE preparation failed or cancelled'));else resolve(Buffer.concat(chunks).toString());});
});}
class CueStream{
 constructor(cacheDir){this.cacheDir=cacheDir;this.closed=false;this.files=[];this.tail=Promise.resolve();this.directory=null;}
 async ensureDirectory(){
  if(this.directory)return this.directory;
  await fsp.mkdir(this.cacheDir,{recursive:true,mode:0o700});
  for(const entry of await fsp.readdir(this.cacheDir,{withFileTypes:true})){
   const match=/^session-([0-9]+)-[A-Za-z0-9]+$/.exec(entry.name);
   if(!entry.isDirectory()||!match)continue;
   const pid=Number(match[1]);if(!Number.isSafeInteger(pid)||pid<2||pid>2147483647)continue;
   try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')await fsp.rm(path.join(this.cacheDir,entry.name),{recursive:true,force:true});}
  }
  this.directory=await fsp.mkdtemp(path.join(this.cacheDir,'session-'+process.pid+'-'));
  return this.directory;
 }
 prepare(bridge,cuePath,track,valid){const work=this.tail.then(()=>this.convert(bridge,cuePath,track,()=>!this.closed&&!bridge.closed&&valid()));this.tail=work.catch(()=>{});return work;}
 async convert(bridge,cuePath,track,valid){
  if(!valid())throw Error('CUE preparation cancelled');
  const cue=await bridge.resolveFile(encodeURIComponent(cuePath));const opened=await bridge.openFile(cue);let segment;
  try{if(opened.stat.size>1024*1024)throw Error('CUE too large');segment=parseCue(await opened.handle.readFile('utf8'),track);}finally{await opened.handle.close();}
  const source={file:await fsp.realpath(path.resolve(path.dirname(cue.file),segment.file)),roots:cue.roots};
  const input=await bridge.openFile(source);let output,filename,success=false;
  try{
   const raw=await run('/usr/bin/ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels,duration_ts,time_base','-of','json','/proc/self/fd/3'],[input.handle.fd],valid);
   const s=JSON.parse(raw).streams?.[0];const bits=Number(s?.bits_per_raw_sample||s?.bits_per_sample),rate=Number(s?.sample_rate),channels=Number(s?.channels);
   if(![16,24,32].includes(bits)||!Number.isInteger(rate)||rate<8000||rate>768000||!Number.isInteger(channels)||channels<1||channels>32||/dsd|pcm_f/i.test(s.codec_name))throw Error('Unsupported CUE source format');
   const tb=/^(\d+)\/(\d+)$/.exec(s.time_base||'');if(!tb||!Number.isSafeInteger(Number(s.duration_ts))||Number(s.duration_ts)<=0)throw Error('Unknown CUE source duration');
   const numerator=BigInt(s.duration_ts)*BigInt(tb[1])*BigInt(rate),denominator=BigInt(tb[2]);if(!denominator||numerator%denominator)throw Error('Inexact CUE source duration');
   const total=Number(numerator/denominator);const range=sampleRange(segment,rate,total);const size=(range.endSample-range.startSample)*channels*bits/8;
   if(size>MAX_BYTES)throw Error('CUE segment exceeds cache limit');
   await this.ensureDirectory();
   filename=path.join(this.directory,require('node:crypto').randomBytes(16).toString('hex')+'.wav');output=await fsp.open(filename,'wx+',0o600);
   // Seek to a whole second, then trim exact samples relative to that point.
   const anchor=Math.floor(range.startSample/rate),offset=anchor*rate;
   await run('/usr/bin/ffmpeg',['-nostdin','-v','error','-threads','1','-ss',String(anchor),'-i','/proc/self/fd/3','-map','0:a:0','-af',`atrim=start_sample=${range.startSample-offset}:end_sample=${range.endSample-offset},asetpts=PTS-STARTPTS`,'-c:a',`pcm_s${bits}le`,'-map_metadata','-1','-f','wav','-y','/proc/self/fd/4'],[input.handle.fd,output.fd],valid);
   const stat=await output.stat();if(stat.size<size||stat.size>size+65536)throw Error('Invalid CUE segment size');
   if(!valid())throw Error('CUE preparation cancelled');
   this.files.push(filename);while(this.files.length>2)await fsp.unlink(this.files.shift()).catch(()=>{});
   success=true;return {file:filename,roots:[this.directory]};
  }finally{await input.handle.close();if(output)await output.close();if(filename&&!success)await fsp.unlink(filename).catch(()=>{});}
 }
 async close(){this.closed=true;await this.tail;if(this.directory)await fsp.rm(this.directory,{recursive:true,force:true});this.files=[];}
}
module.exports=CueStream;
