'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const LocalStream=require('../../lib/local-stream');
const available=spawnSync('/usr/bin/ffmpeg',['-version']).status===0;
function wave(samples,bits=16){const bytes=bits/8,b=Buffer.alloc(44+samples.length*bytes);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(44100*bytes,28);b.writeUInt16LE(bytes,32);b.writeUInt16LE(bits,34);b.write('data',36);b.writeUInt32LE(samples.length*bytes,40);samples.forEach((n,i)=>b.writeIntLE(n,44+i*bytes,bytes));return b;}
function pcm(b){let p=12;while(p+8<=b.length){const len=b.readUInt32LE(p+4);if(b.toString('ascii',p,p+4)==='data')return b.subarray(p+8,p+8+len);p+=8+len+(len%2);}throw Error('missing PCM');}
for(const bits of [16,24,32])test('CUE exact WAVE segments preserve '+bits+'-bit samples, ranges and cleanup',{skip:!available},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cue-stream-'));const root=path.join(dir,'USB');await fs.mkdir(root);
 const samples=Array.from({length:4410},(_,i)=>i-2205);await fs.writeFile(path.join(root,'音 100%.wav'),wave(samples,bits));
 await fs.writeFile(path.join(root,'album.cue'),'FILE "音 100%.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:00:03\n');
 const bridge=new LocalStream({roots:[root],cacheDir:path.join(dir,'cache')});t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 const first=await bridge.urlFor('music-library/USB/album.cue/track0001');const second=await bridge.urlFor('USB/album.cue/track0002');
 const a=Buffer.from(await (await fetch(first)).arrayBuffer()),b=Buffer.from(await (await fetch(second)).arrayBuffer());
 assert.deepEqual(Buffer.concat([pcm(a),pcm(b)]),wave(samples,bits).subarray(44));assert.equal(pcm(a).length,1764*bits/8);
 const head=await fetch(first,{method:'HEAD'});assert.equal(Number(head.headers.get('content-length')),a.length);
 const range=await fetch(first,{headers:{Range:'bytes=7-19'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),a.subarray(7,20));
 await bridge.close();assert.deepEqual(await fs.readdir(path.join(dir,'cache')),[]);
});
test('CUE source path escape is refused before decoding',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cue-escape-'));const root=path.join(dir,'USB');await fs.mkdir(root);await fs.writeFile(path.join(dir,'private.wav'),'private');await fs.symlink(path.join(dir,'private.wav'),path.join(root,'evil.wav'));await fs.writeFile(path.join(root,'album.cue'),'FILE "evil.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n');const bridge=new LocalStream({roots:[root],cacheDir:path.join(dir,'cache')});t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});await assert.rejects(bridge.urlFor('USB/album.cue/track0001'));
});
test('cache startup removes only stale process sessions and preserves live or unrelated directories',async t=>{
 const CueStream=require('../../lib/cue-stream');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cue-prune-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const stale=path.join(dir,'session-1073741824-dead'),live=path.join(dir,'session-'+process.pid+'-live'),other=path.join(dir,'other-data');
 for(const p of [stale,live,other]){await fs.mkdir(p);await fs.writeFile(path.join(p,'keep'),'data');}
 const cache=new CueStream(dir);await cache.ensureDirectory();await assert.rejects(fs.stat(stale),{code:'ENOENT'});assert.ok((await fs.stat(live)).isDirectory());assert.ok((await fs.stat(other)).isDirectory());await cache.close();
});
