'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const Manager=require('../../lib/manager');const {defaults}=require('../../lib/profiles');

function environment(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'engine-manager-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
  const conf=path.join(dir,'mpd.conf');const original='music_directory "/mnt"\naudio_output {\n type "alsa"\n name "Volumio"\n device "volumio"\n}\n';fs.writeFileSync(conf,original);
  const calls=[];const card={key:'usb:fiio:123',label:'FiiO',pcm:'hw:CARD=FiiO,DEV=0',index:2,device:0,usb:true};
  let failStart=false,deviceList=[card];
  const runtime={devices:async()=>deviceList,stopRenderer:async()=>calls.push('renderer-stop'),startRenderer:async()=>{calls.push('renderer-start');if(failStart)throw Object.assign(Error('offline'),{code:'RENDERER_UNAVAILABLE'});return{controlUrl:'http://127.0.0.1:1234/control'};},outputPolicy:async engine=>calls.push('outputs-'+engine)};
  const mpd={stop:async()=>calls.push('mpd-stop'),sendMpdCommand:async()=>({}),createMPDFile:cb=>{const before=fs.statSync(conf).mtimeMs;fs.writeFileSync(conf,original);/* Pi tmpfs can timestamp immediate rewrites identically. Make this fake native write observable. */fs.utimesSync(conf,new Date(),new Date(Math.max(Date.now(),before+10)));cb();},restartMpd:cb=>{calls.push('mpd-restart');cb();},clearAddPlayTrack:async()=>{},pause:async()=>{},resume:async()=>{},seek:async()=>{},next:async()=>{},previous:async()=>{}};
  const sm={currentPosition:4,currentStatus:'pause',stop:async()=>{calls.push('core-stop');sm.currentStatus='stop';}};
  const router={stateMachine:sm,pluginManager:{getPlugin:()=>mpd},broadcastMessage:()=>{},volumiosetvolume:async value=>{calls.push(['hardware-volume',value]);},volumioretrievevolume:async()=>({vol:86,mute:false}),volumioupdatevolume:()=>{}};
  const manager=new Manager({router,stateDir:dir,runtime,mpdConfig:conf});
  return{dir,conf,manager,calls,sm,card,setFail:value=>{failStart=value;},setDevices:value=>{deviceList=value;}};
}
test('opening manager and discovering a USB DAC does not activate output or select it',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  assert.equal(e.manager.settings.managed,false);assert.equal(e.manager.settings.device,null);assert.deepEqual(e.calls,[]);
  assert.equal(e.manager.status().devices[0].label,'FiiO');
});
test('apply stops playback, commits separate profiles and never sets hardware volume to 100',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const settings=defaults();settings.managed=true;settings.device={key:e.card.key,label:e.card.label};settings.modes.mpd='bypass';settings.custom.mpd.volume=37;
  await e.manager.apply(settings);
  assert.equal(e.sm.currentPosition,4);assert.equal(e.sm.currentStatus,'stop');
  assert.equal(e.calls[0],'core-stop');assert.ok(!e.calls.some(x=>Array.isArray(x)&&x[0]==='hardware-volume'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.dir,'settings.json'))).custom.mpd.volume,37);
  assert.match(fs.readFileSync(e.conf,'utf8'),/mixer_type "none"/);
  await e.manager.setVolume(100);assert.ok(!e.calls.some(x=>Array.isArray(x)&&x[0]==='hardware-volume'));
});
test('missing remembered DAC remains selected and unavailable, without automatic fallback',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const settings=defaults();settings.managed=true;settings.device={key:e.card.key,label:e.card.label};await e.manager.apply(settings);
  e.setDevices([]);await e.manager.refreshDevices();
  assert.equal(e.manager.settings.device.key,e.card.key);assert.equal(e.manager.status().available,false);
  assert.equal(e.manager.status().error,'DEVICE_UNAVAILABLE');
});
test('failed engine switch restores the previous persisted selection and MPD configuration',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const settings=defaults();settings.managed=true;settings.device={key:e.card.key,label:e.card.label};await e.manager.apply(settings);
  const old=fs.readFileSync(path.join(e.dir,'settings.json'),'utf8');const conf=fs.readFileSync(e.conf,'utf8');
  const changed=JSON.parse(old);changed.engine='album_player';e.setFail(true);
  await assert.rejects(e.manager.apply(changed));
  assert.equal(fs.readFileSync(path.join(e.dir,'settings.json'),'utf8'),old);assert.equal(fs.readFileSync(e.conf,'utf8'),conf);
  assert.equal(e.manager.settings.engine,'mpd');
});

test('local files in managed MPD bypass are capability-checked before starting playback',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const settings=defaults();settings.managed=true;settings.device={key:e.card.key,label:e.card.label};settings.modes.mpd='bypass';await e.manager.apply(settings);
  const track={service:'mpd',uri:'music-library/USB/album/song.flac',duration:180};e.sm.getTrack=()=>track;
  let checked=0;const commands=[];
  e.manager.runtime.probe=async()=>({rate:44100,bits:24,channels:2});e.manager.runtime.check=async()=>{checked++;};
  e.manager.localStream.urlFor=async()=> 'http://127.0.0.1:12345/opaque.flac';
  e.manager.mpd.sendMpdCommand=async command=>{commands.push(command);return{};};e.sm.setConsumeUpdateService=async()=>{};
  await e.manager.mpd.clearAddPlayTrack(track);
  assert.equal(checked,1);assert.ok(commands.includes('play'));assert.equal(e.sm.currentPosition,4);
});

test('saving an inactive custom profile preserves current playback and does not reconfigure output',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  e.sm.currentStatus='play';const next=defaults();next.custom.album_player.volume=37;
  await e.manager.apply(next);
  assert.deepEqual(e.calls,[]);assert.equal(e.sm.currentStatus,'play');
  assert.equal(e.manager.settings.custom.album_player.volume,37);
});

test('reapplying a remembered DAC after reconnect restores readiness without resuming playback',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.modes.mpd='bypass';await e.manager.apply(next);
  e.setDevices([]);await e.manager.refreshDevices();assert.equal(e.manager.ready,false);
  e.setDevices([e.card]);await e.manager.apply(next);
  assert.equal(e.manager.ready,true);assert.equal(e.manager.status().error,null);assert.equal(e.sm.currentStatus,'stop');
});

test('startup with missing saved DAC stops playback and disables MPD outputs',async t=>{
  const e=environment(t);const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};
  fs.writeFileSync(path.join(e.dir,'settings.json'),JSON.stringify(next));e.setDevices([]);
  await e.manager.start();t.after(()=>e.manager.close());
  assert.equal(e.sm.currentStatus,'stop');assert.ok(e.calls.includes('outputs-album_player'));
  assert.equal(e.manager.ready,false);assert.equal(e.manager.error,'DEVICE_UNAVAILABLE');
  const before=fs.readFileSync(e.conf,'utf8');
  await new Promise(resolve=>e.manager.mpd.createMPDFile(error=>{assert.equal(error.code,'DEVICE_UNAVAILABLE');resolve();}));
  assert.equal(fs.readFileSync(e.conf,'utf8'),before);
});

test('software mute toggles without losing saved level or touching hardware volume',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.custom.mpd.volumeEnabled=true;next.custom.mpd.volume=37;
  await e.manager.apply(next);const commands=[];e.manager.mpd.sendMpdCommand=async(...args)=>commands.push(args);
  const muted=await e.manager.setVolume('mute');assert.equal(muted.mute,true);assert.equal(e.manager.settings.custom.mpd.volume,37);
  const unmuted=await e.manager.setVolume('unmute');assert.equal(unmuted.mute,false);assert.equal(unmuted.vol,37);
  assert.deepEqual(commands,[['setvol',[0]],['setvol',[37]]]);
  assert.ok(!e.calls.some(x=>Array.isArray(x)&&x[0]==='hardware-volume'));
});

for(const action of ['stop','pause'])test(`local preparation is cancelled by ${action} before any delayed Play`,async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.modes.mpd='bypass';await e.manager.apply(next);
  const track={service:'mpd',uri:'USB/song.flac'};e.sm.getTrack=()=>track;e.sm.setConsumeUpdateService=async()=>{};
  e.manager.localStream.urlFor=async()=> 'http://127.0.0.1/song';
  let release,entered;const probing=new Promise(resolve=>{entered=resolve;});
  e.manager.runtime.probe=()=>{entered();return new Promise(resolve=>{release=resolve;});};e.manager.runtime.check=async()=>{};
  const commands=[];e.manager.mpd.sendMpdCommand=async command=>commands.push(command);
  const pending=e.manager.mpd.clearAddPlayTrack(track);await probing;await e.manager.mpd[action]();
  release({rate:44100,bits:16,channels:2});await pending;
  assert.ok(!commands.includes('play'));
});

test('MPD track changes preserve software mute',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.custom.mpd.volumeEnabled=true;next.custom.mpd.volume=37;
  await e.manager.apply(next);await e.manager.setVolume('mute');const commands=[];
  e.manager.mpd.sendMpdCommand=async(...args)=>{commands.push(args);return{};};e.sm.setConsumeUpdateService=async()=>{};
  await e.manager.createTransport('qobuz_custom').play('http://127.0.0.1/song',{},()=>true);
  assert.deepEqual(commands.find(c=>c[0]==='setvol'),['setvol',[0]]);assert.equal(e.manager.volumeState().mute,true);
});

test('shutdown drains an in-flight save and forbids subsequent operations',async t=>{
  const e=environment(t);await e.manager.start();
  let release,entered;const preparing=new Promise(resolve=>{entered=resolve;});
  const originalPrepare=e.manager.prepare.bind(e.manager);
  e.manager.prepare=async(...args)=>{entered();await new Promise(resolve=>{release=resolve;});return originalPrepare(...args);};
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};
  const applying=e.manager.apply(next);await preparing;
  let stopped=false;const shutdown=e.manager.shutdown().then(()=>{stopped=true;});
  await new Promise(setImmediate);const premature=stopped;release();await applying;await shutdown;
  assert.equal(premature,false);
  assert.equal(e.manager.closed,true);assert.equal(e.manager.settings.managed,false);
  assert.doesNotMatch(fs.readFileSync(e.conf,'utf8'),/Playback Engines/);
  await assert.rejects(e.manager.apply(next),{code:'ENGINE_UNAVAILABLE'});
  await assert.rejects(e.manager.createTransport('qobuz_custom').play('http://127.0.0.1/song',{},()=>true),{code:'ENGINE_UNAVAILABLE'});
});

test('Album Player reapplies its saved profile and muted gain after a renderer restart',async t=>{
  const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
  let native={};e.manager.runtime.startRenderer=async()=>{native={};};
  e.manager.runtime.requestConfig=async value=>{if(value)native={...value};return{...native};};
  const gains=[];e.manager.rendererVolume=async value=>gains.push(value);
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.engine='album_player';next.modes.album_player='custom';next.custom.album_player.volumeEnabled=true;next.custom.album_player.volume=42;
  await e.manager.apply(next);await e.manager.setVolume('mute');
  // The launch must stop at its delegate: these assertions concern configuration before Play.
  const facade=e.manager.createTransport('qobuz_custom');
  await assert.rejects(facade.play('http://127.0.0.1/song',{},()=>true));
  assert.equal(native.volume_enabled,true);assert.equal(gains.at(-1),0);
});

test('managed volume requests publish the software level through the core update path',async t=>{
  const e=environment(t);const updates=[];e.manager.router.volumioupdatevolume=value=>updates.push(value);
  await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.custom.mpd.volumeEnabled=true;await e.manager.apply(next);
  await e.manager.router.volumiosetvolume(41);assert.equal(updates.at(-1)?.vol,41);
  await e.manager.router.volumiosetvolume('mute');assert.equal(updates.at(-1).mute,true);
});

test('waits for native MPD async file write even when its callback fires early',async t=>{
  const e=environment(t);const native=fs.readFileSync(e.conf,'utf8');
  e.manager.mpd.createMPDFile=callback=>{callback();setTimeout(()=>fs.writeFileSync(e.conf,native),35);};
  await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.modes.mpd='bypass';
  await e.manager.apply(next);await new Promise(resolve=>setTimeout(resolve,80));
  assert.match(fs.readFileSync(e.conf,'utf8'),/name "Playback Engines"/);
});

test('Album Player bypass releases its retained PCM before checking the next track',async t=>{
  const http=require('node:http');const e=environment(t);let held=false,config={};
  const server=http.createServer(async(req,res)=>{
    for await(const chunk of req){}const action=req.headers.soapaction.split('#')[1].replace('"','');
    if(action==='Play')held=true; // Native Stop and natural end both retain the PCM handle.
    let fields='';if(action==='GetTransportInfo')fields='<CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>';
    if(action==='GetPositionInfo')fields='<RelTime>0:00:01.000</RelTime><TrackDuration>0:03:00.000</TrackDuration>';
    res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${fields}</u:${action}Response></s:Body></s:Envelope>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  e.manager.runtime.stopRenderer=async()=>{held=false;};
  e.manager.runtime.startRenderer=async()=>{e.manager.runtime.endpoints={controlUrl:`http://127.0.0.1:${server.address().port}/control`};};
  e.manager.runtime.requestConfig=async value=>{if(value)config={...value};return{...config};};
  e.manager.runtime.probe=async()=>({rate:44100,bits:16,channels:2});
  e.manager.runtime.check=async()=>{if(held)throw Object.assign(Error('busy'),{code:'PCM_BUSY'});};
  e.sm.consumeState={};e.sm.setConsumeUpdateService=async source=>{e.sm.consumeState.service=source;};e.sm.syncState=async()=>{};
  await e.manager.start();t.after(()=>e.manager.close());
  const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.engine='album_player';await e.manager.apply(next);
  const transport=e.manager.createTransport('qobuz_custom');
  assert.equal(await transport.play('http://127.0.0.1/first.wav',{uri:'qobuz_custom/track/1',duration:180},()=>true),true);
  await transport.stop();assert.equal(held,true);
  assert.equal(await transport.play('http://127.0.0.1/second.wav',{uri:'qobuz_custom/track/2',duration:180},()=>true),true);
});

test('preflight failures appear in engine status and a later successful track clears them',async t=>{
 const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
 const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};next.modes.mpd='bypass';await e.manager.apply(next);
 e.manager.runtime.probe=async()=>{throw Object.assign(Error('unsupported'),{code:'UNSUPPORTED_FORMAT'});};
 const transport=e.manager.createTransport('qobuz_custom');
 await assert.rejects(transport.play('http://127.0.0.1/file',{},()=>true),{code:'UNSUPPORTED_FORMAT'});
 assert.equal(e.manager.status().error,'UNSUPPORTED_FORMAT');
 e.manager.runtime.probe=async()=>({rate:44100,bits:16,channels:2});e.manager.runtime.check=async()=>{};e.sm.setConsumeUpdateService=async()=>{};
 assert.equal(await transport.play('http://127.0.0.1/file',{},()=>true),true);assert.equal(e.manager.status().error,null);
});

test('cancelling a launch after Album Player accepts Play still stops that renderer',async t=>{
 const http=require('node:http');const e=environment(t);let valid=true,config={};const actions=[];
 const server=http.createServer(async(req,res)=>{for await(const _ of req){}const action=req.headers.soapaction.split('#')[1].replace('"','');actions.push(action);if(action==='Play')valid=false;res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 e.manager.runtime.startRenderer=async()=>{e.manager.runtime.endpoints={controlUrl:`http://127.0.0.1:${server.address().port}/control`};};e.manager.runtime.requestConfig=async value=>{if(value)config={...value};return{...config};};
 e.sm.consumeState={};e.sm.setConsumeUpdateService=async source=>{e.sm.consumeState.service=source;};
 await e.manager.start();t.after(()=>e.manager.close());const next=defaults();next.managed=true;next.engine='album_player';next.modes.album_player='custom';next.device={key:e.card.key,label:e.card.label};await e.manager.apply(next);
 assert.equal(await e.manager.createTransport('qobuz_custom').play('http://127.0.0.1/file',{duration:1},()=>valid),false);
 assert.equal(actions.at(-1),'Stop');assert.equal(e.manager.active,null);
});
test('cancelled CUE preparation failure cannot stop a newer track',async t=>{
 const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
 const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};await e.manager.apply(next);
 const track={uri:'USB/album.cue/track0001',service:'mpd'};e.sm.getTrack=()=>track;let reject,entered;
 const preparing=new Promise(resolve=>entered=resolve);e.manager.localStream.urlFor=async()=>{entered();return new Promise((_,r)=>reject=r);};
 const playing=e.manager.mpd.clearAddPlayTrack(track);await preparing;await e.manager.mpd.stop();
 const stopped=e.calls.filter(x=>x==='core-stop').length;reject(Error('cancelled'));await playing;
 assert.equal(e.calls.filter(x=>x==='core-stop').length,stopped);assert.equal(e.manager.error,null);
});
test('changing to a CUE track stops the previous audio before segment preparation',async t=>{
 const e=environment(t);await e.manager.start();t.after(()=>e.manager.close());
 const next=defaults();next.managed=true;next.device={key:e.card.key,label:e.card.label};await e.manager.apply(next);
 const track={uri:'USB/album.cue/track0001',service:'mpd'};e.sm.getTrack=()=>track;let stopped=false;
 e.manager.active={stop:async()=>{stopped=true;e.manager.active=null;}};
 e.manager.localStream.urlFor=async()=>{assert.equal(stopped,true);throw Error('fixture ends before playback');};
 await e.manager.mpd.clearAddPlayTrack(track);assert.equal(stopped,true);
});
for(const engine of ['mpd','album_player'])test(`managed ${engine} hides native MPD prefetch and restores it when disabled`,async t=>{
 const e=environment(t);const native=function(){return this;};e.manager.mpd.prefetch=native;
 await e.manager.start();t.after(()=>e.manager.close());assert.equal(e.manager.mpd.prefetch,native);
 e.manager.settings.managed=true;e.manager.settings.engine=engine;
 assert.equal(typeof e.manager.mpd.prefetch,'undefined');
 e.manager.settings.managed=false;assert.equal(e.manager.mpd.prefetch(),e.manager.mpd);
 await e.manager.close();assert.equal(e.manager.mpd.prefetch,native);
});
