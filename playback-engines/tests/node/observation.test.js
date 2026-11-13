'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {observe}=require('../../lib/observation');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcm-observe-'));t.after(()=>fs.rmSync(root,{recursive:true}));const dir=path.join(root,'asound/card5/pcm0p/sub0');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(root,'asound/card5/id'),'PRO\n');const device={key:'usb:fiio',pcm:'hw:CARD=PRO,DEV=0',index:5,device:0,label:'FiiO'};return{root,dir,device};}
test('selected engine does not count as confirmed when the PCM is closed',t=>{
 const e=fixture(t);fs.writeFileSync(path.join(e.dir,'hw_params'),'closed\n');
 const result=observe(e.device,'album_player',{procRoot:e.root});assert.equal(result.state,'idle');assert.equal(result.actualEngine,null);assert.equal(result.routeMatches,null);
});
test('running PCM owner and format confirm the actual engine independently of selection',t=>{
 const e=fixture(t);fs.mkdirSync(path.join(e.root,'123'));fs.writeFileSync(path.join(e.root,'123/comm'),'ap2renderer\n');
 fs.writeFileSync(path.join(e.dir,'status'),'state: RUNNING\nowner_pid: 123\n');fs.writeFileSync(path.join(e.dir,'hw_params'),'access: MMAP_INTERLEAVED\nformat: S32_LE\nchannels: 2\nrate: 44100 (44100/1)\n');
 const result=observe(e.device,'album_player',{procRoot:e.root});assert.equal(result.state,'running');assert.equal(result.actualEngine,'album_player');assert.equal(result.routeMatches,true);assert.deepEqual(result.pcm,{state:'RUNNING',format:'S32_LE',rate:44100,channels:2,ownerPid:123,ownerProcess:'ap2renderer'});
 const mismatch=observe(e.device,'mpd',{procRoot:e.root});assert.equal(mismatch.state,'mismatch');assert.equal(mismatch.actualEngine,'album_player');assert.equal(mismatch.routeMatches,false);
});
test('unknown PCM owner is unconfirmed and reused card index is unavailable',t=>{
 const e=fixture(t);fs.writeFileSync(path.join(e.dir,'status'),'state: RUNNING\n');fs.writeFileSync(path.join(e.dir,'hw_params'),'format: S16_LE\nchannels: 2\nrate: 48000 (48000/1)\n');
 assert.equal(observe(e.device,'mpd',{procRoot:e.root}).state,'unconfirmed');
 fs.writeFileSync(path.join(e.root,'asound/card5/id'),'OTHER\n');assert.equal(observe(e.device,'mpd',{procRoot:e.root}).state,'unavailable');
});

test('one readable stream cannot confirm a device whose other substream could not be inspected',t=>{
 const e=fixture(t);fs.mkdirSync(path.join(e.root,'123'));fs.writeFileSync(path.join(e.root,'123/comm'),'ap2renderer\n');
 fs.writeFileSync(path.join(e.dir,'status'),'state: RUNNING\nowner_pid: 123\n');fs.writeFileSync(path.join(e.dir,'hw_params'),'format: S32_LE\nchannels: 2\nrate: 44100 (44100/1)\n');
 const other=path.join(path.dirname(e.dir),'sub1');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'hw_params'),'format: S32_LE\n');
 const result=observe(e.device,'album_player',{procRoot:e.root});assert.equal(result.state,'unconfirmed');assert.equal(result.routeMatches,null);
});

test('source comparison accepts lossless integer packing but flags rate, channel and precision changes',()=>{
 const{compareFormat}=require('../../lib/observation');const source={rate:44100,bits:24,channels:2};
 assert.equal(compareFormat({rate:44100,format:'S32_LE',channels:2},source),true);
 assert.equal(compareFormat({rate:48000,format:'S32_LE',channels:2},source),false);
 assert.equal(compareFormat({rate:44100,format:'S16_LE',channels:2},source),false);
 assert.equal(compareFormat({rate:44100,format:'S32_LE',channels:1},source),false);
 assert.equal(compareFormat(null,source),null);
});

test('MPD output thread is attributed to its owning process instead of treated as an unknown engine',t=>{
 const e=fixture(t);for(const pid of [26,123])fs.mkdirSync(path.join(e.root,String(pid)));
 fs.writeFileSync(path.join(e.root,'26/comm'),'output:alsa\n');fs.writeFileSync(path.join(e.root,'26/status'),'Name:\toutput:alsa\nTgid:\t123\nPid:\t26\n');fs.writeFileSync(path.join(e.root,'123/comm'),'mpd\n');
 fs.writeFileSync(path.join(e.dir,'status'),'state: RUNNING\nowner_pid: 26\n');fs.writeFileSync(path.join(e.dir,'hw_params'),'format: S16_LE\nchannels: 2\nrate: 44100 (44100/1)\n');
 const result=observe(e.device,'mpd',{procRoot:e.root});assert.equal(result.actualEngine,'mpd');assert.equal(result.routeMatches,true);assert.equal(result.pcm.ownerPid,123);assert.equal(result.pcm.ownerProcess,'mpd');
});
