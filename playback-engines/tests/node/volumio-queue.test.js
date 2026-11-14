'use strict';
// Exercise the installed Volumio state machine without instantiating its live player.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const Q=require('kew');const Manager=require('../../lib/manager');
const AlbumPlayer=require('../../../shared/playback/album-player');
const source=process.env.VOLUMIO_STATEMACHINE_PATH||'/volumio/app/statemachine.js';
function core(){const module={exports:{}};vm.runInNewContext(fs.readFileSync(source,'utf8'),{module,exports:module.exports,require:id=>{if(id==='kew')return Q;if(id==='./randomqueue')return function(){};throw Error(id);},setTimeout:()=>0,clearTimeout(){},Date,process:{env:{}}});return module.exports;}
for(const service of ['mpd','qobuz_custom','yandex_music'])test(`Volumio queue advances exactly once after Album Player EOF for ${service}`,{skip:!fs.existsSync(source)},async t=>{
 const Core=core(),sm=Object.create(Core.prototype),tracks=[0,1,2].map(i=>({uri:service+'/track/'+i,service,name:'Track '+i,duration:2})),played=[];
 const log={verbose(){},info(){}};const router={logger:log,pushDebugConsoleMessage(){},pushConsoleMessage(){},pushErrorConsoleMessage(){},broadcastMessage(){}};
 Object.assign(sm,{commandRouter:router,logger:log,currentPosition:0,currentStatus:'play',currentSeek:0,currentSongDuration:2000,currentRepeat:false,currentRepeatSingleSong:false,currentRandom:false,currentConsume:false,prefetchDone:false,askedForPrefetch:false,simulateStopStartDone:false,isVolatile:false,volatileState:null,isUpnp:false,isConsume:false,consumeState:{},runPlaybackTimer:true,playbackStart:Date.now(),playQueue:{arrayQueue:tracks,getTrack:i=>tracks[i]},pushState:()=>Q.resolve(),pushEmptyState:()=>Q.resolve(),stopPlaybackTimer:()=>Q.resolve(),getNextIndex:()=>sm.currentPosition+1,play:()=>{played.push(sm.currentPosition);sm.currentStatus='play';return Q.resolve();}});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'core-queue-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const mpd={prefetch:()=>Q.resolve(),createMPDFile:cb=>cb(),stop:async()=>{},pause:async()=>{},resume:async()=>{},seek:async()=>{},clearAddPlayTrack:async()=>{},sendMpdCommand:async()=>({}),next:async()=>{},previous:async()=>{}};
 router.stateMachine=sm;router.pluginManager={getPlugin:(_cat,name)=>name==='mpd'?mpd:{}};
 const manager=new Manager({router,stateDir:dir,runtime:{devices:async()=>[]},mpdConfig:path.join(dir,'mpd.conf')});await manager.start();manager.settings.managed=true;manager.settings.engine='album_player';t.after(()=>manager.close());
 let status='PLAYING';const client={call:async action=>action==='GetTransportInfo'?{CurrentTransportState:status,CurrentTransportStatus:'OK'}:action==='GetPositionInfo'?{RelTime:status==='PLAYING'?'00:00:01.800':'00:00:00.000',TrackDuration:'00:00:02.000'}:{}};
 const transport=new AlbumPlayer({client,mpd:{stop:async()=>{}},sm,service,updateSource:'playback_engines',pollMs:60000,onError:e=>assert.fail(e.code)});t.after(()=>transport.close());
 await transport.play('http://127.0.0.1/silence.wav',tracks[0],()=>sm.currentPosition===0);await transport.poll();
 sm.currentSeek=1800;sm.playbackStart=Date.now();sm.increasePlaybackTimer();
 assert.equal(sm.currentPosition,0,'native prefetch must not advance the queue before renderer EOF');
 status='STOPPED';await transport.poll();await new Promise(setImmediate);
 assert.deepEqual(played,[1]);assert.equal(sm.currentPosition,1);await transport.poll();assert.deepEqual(played,[1]);
});
