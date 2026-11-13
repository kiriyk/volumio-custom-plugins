'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Runtime=require('../../lib/runtime');

test('renderer gets its own ALSA hardware configuration without touching global ALSA or volume',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'engine-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
  const commands=[];
  const runtime=new Runtime({stateDir:dir,run:async(file,args)=>{
    commands.push([file,args]);
    if(args.includes('show'))return {stdout:'123\n'};
    if(args.includes('discover'))return {stdout:JSON.stringify({controlUrl:'http://127.0.0.1:1234/control',apiUrl:'http://127.0.0.1:7779/'})};
    return {stdout:'[]'};
  }});
  const info=await runtime.startRenderer({pcm:'hw:CARD=FiiO-BTA30,DEV=0'});
  assert.equal(info.controlUrl,'http://127.0.0.1:1234/control');
  const conf=fs.readFileSync(path.join(dir,'asound.conf'),'utf8');
  assert.match(conf,/pcm\.!default/);assert.match(conf,/card "FiiO-BTA30"/);assert.doesNotMatch(conf,/type (?:plug|dmix|softvol)/);
  assert.ok(commands.some(([,args])=>args.includes('start')));
  assert.ok(commands.every(([file])=>!file.includes('amixer')));
});

test('ALSA configuration rejects injected PCM definitions before starting a service',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'engine-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
  let calls=0;const runtime=new Runtime({stateDir:dir,run:async()=>{calls++;return{stdout:''};}});
  await assert.rejects(runtime.startRenderer({pcm:'hw:CARD=X"\n pcm.!default {type plug},DEV=0'}));
  assert.equal(calls,0);assert.equal(fs.existsSync(path.join(dir,'asound.conf')),false);
});

test('MPD output policy disables every extra output for either engine',async t=>{
  const net=require('node:net');const commands=[];const enabled=new Map([[0,true],[7,true],[9,false]]);
  const server=net.createServer(socket=>{socket.write('OK MPD 0.23.0\n');socket.on('data',raw=>{
    const command=raw.toString().trim();commands.push(command);
    if(command==='outputs')socket.write([...enabled].map(([id,value])=>`outputid: ${id}\noutputname: ${id===9?'Playback Engines':'Other'}\noutputenabled: ${value?1:0}\n`).join('')+'OK\n');
    else{const [verb,id]=command.split(' ');enabled.set(Number(id),verb==='enableoutput');socket.write('OK\n');}
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const runtime=new Runtime({stateDir:'/unused',mpdPort:server.address().port});
  await runtime.outputPolicy('mpd');assert.deepEqual([...enabled],[[0,false],[7,false],[9,true]]);
  await runtime.outputPolicy('album_player');assert.ok([...enabled.values()].every(v=>!v));
  assert.ok(commands.includes('enableoutput 9'));assert.ok(commands.includes('disableoutput 9'));
});

test('renderer rejects HTTP success when native configuration was not saved',async t=>{
  const http=require('node:http');const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>res.end('Settings not saved!'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const runtime=new Runtime({stateDir:'/unused'});runtime.endpoints={apiUrl:`http://127.0.0.1:${server.address().port}/`};
  await assert.rejects(runtime.requestConfig({volume_enabled:false}),{code:'PROFILE_SAVE_FAILED'});
});

test('preflight reports exclusive PCM busy separately from an unsupported format',async()=>{
 const runtime=new Runtime({stateDir:'/unused',run:async()=>{throw{stdout:JSON.stringify({error:'PCM busy'})};}});
 await assert.rejects(runtime.check({pcm:'hw:CARD=PRO,DEV=0'},{rate:44100,bits:16,channels:2}),{code:'PCM_BUSY'});
});
