'use strict';
const{test}=require('node:test');const assert=require('node:assert/strict');
const Controller=require('../../index');const{defaults}=require('../../lib/profiles');
function setup(){
  const manager={settings:defaults(),devices:[{key:'usb:one',label:'FiiO BTA30 Pro',pcm:'hw:CARD=FiiO,DEV=0'}],status(){return{engine:this.settings.engine,mode:this.settings.modes[this.settings.engine],managed:false,ready:true,available:false,devices:this.devices};},refreshDevices:async()=>{},start:async()=>{},apply:async settings=>{manager.applied=settings;manager.settings=settings;},close:async()=>{},shutdown:async()=>{}};
  const router={sharedVars:{get:()=> 'ru'},broadcastMessage:()=>{},pushToastMessage:()=>{}};
  const controller=new Controller({coreCommand:router},{manager});controller.started=true;controller.enabled=true;
  return{manager,controller};
}
test('settings describe both engines and show hot-plugged devices without saving',async()=>{
  const{controller,manager}=setup();const ui=await controller.ui();
  const fields=ui.sections[0].content;
  assert.deepEqual(fields.find(f=>f.id==='engine').options.map(o=>o.value),['mpd','album_player']);
  assert.equal(fields.find(f=>f.id==='device').options[0].label,'FiiO BTA30 Pro');
  assert.equal(manager.applied,undefined);
  manager.devices.push({key:'usb:two',label:'Second DAC'});const refreshed=await controller.ui();
  assert.equal(refreshed.sections[0].content.find(f=>f.id==='device').options.length,2);assert.equal(manager.applied,undefined);
});

test('source playback cannot implicitly enable a disabled manager',async()=>{
  const{controller,manager}=setup();controller.enabled=false;controller.started=false;
  let managerStarts=0;manager.start=async()=>{managerStarts++;};
  const calls=[];controller.router.pluginManager={getPlugin:()=>({sendMpdCommand:async command=>calls.push(command)})};
  controller.router.stateMachine={setConsumeUpdateService:async()=>{}};
  const transport=controller.getTransport('qobuz_custom',()=>{});
  await transport.play('http://127.0.0.1/stream.flac',{duration:1},()=>true);
  assert.equal(managerStarts,0);assert.equal(calls.at(-1),'play');
});
test('selection saves only chosen engine mode and preserves both custom profiles',async()=>{
  const{controller,manager}=setup();manager.settings.custom.mpd.volume=37;manager.settings.custom.album_player.volume=52;
  await controller.saveSelection({engine:{value:'album_player'},mode:{value:'bypass'},device:{value:'usb:one'}});
  assert.equal(manager.applied.engine,'album_player');assert.equal(manager.applied.managed,true);
  assert.equal(manager.applied.custom.mpd.volume,37);assert.equal(manager.applied.custom.album_player.volume,52);
});

// A missing transition notification must fail even after an earlier bypass visit.
test('warns on every entry into bypass for either engine, including engine changes',async()=>{
  const{controller,manager}=setup();const notices=[];
  controller.router.pushToastMessage=(...args)=>notices.push(args);
  const choose=async(engine,mode)=>controller.saveSelection({engine,mode,device:'usb:one'});
  await choose('mpd','bypass');
  await choose('mpd','custom');
  await choose('mpd','bypass');
  await choose('album_player','bypass');
  await choose('album_player','custom');
  await choose('album_player','bypass');
  const warnings=notices.filter(n=>n[0]==='warning');
  assert.equal(warnings.length,4);
  for(const warning of warnings){
    assert.match(warning[2],/убавьте громкость/i);
    assert.match(warning[2],/ЦАПе или усилителе/);
  }
  assert.equal(manager.settings.engine,'album_player');
});

test('does not warn for opening settings, saving unchanged bypass, or a failed switch',async()=>{
  const{controller,manager}=setup();const notices=[];
  controller.router.pushToastMessage=(...args)=>notices.push(args);
  manager.settings.managed=true;manager.settings.modes.mpd='bypass';
  manager.settings.device={key:'usb:one',label:'FiiO BTA30 Pro'};
  await controller.ui();
  await controller.saveSelection({engine:'mpd',mode:'bypass',device:'usb:one'});
  manager.apply=async()=>{throw Object.assign(new Error(),{code:'RENDERER_UNAVAILABLE'});};
  await controller.saveSelection({engine:'album_player',mode:'bypass',device:'usb:one'});
  assert.equal(notices.filter(n=>n[0]==='warning').length,0);
  assert.equal(notices.at(-1)[0],'error');
});

test('disabled plugin reports unmanaged state and refuses applying an output',async()=>{
  const{controller,manager}=setup();manager.settings.managed=true;controller.enabled=false;const states=[],notices=[];
  manager.status=()=>({managed:true,ready:true,engine:'mpd'});
  controller.router.broadcastMessage=(event,data)=>states.push([event,data]);controller.router.pushToastMessage=(...args)=>notices.push(args);
  const state=await controller.getState();assert.equal(state.managed,false);assert.equal(states.at(-1)[1].managed,false);
  await controller.saveSelection({engine:'mpd',mode:'bypass',device:'usb:one'});
  assert.equal(manager.applied,undefined);assert.equal(notices.at(-1)[0],'error');
});

test('disable waits for startup before shutting down the manager',async()=>{
  const{controller,manager}=setup();controller.started=false;
  let release;manager.start=()=>new Promise(resolve=>{release=resolve;});
  const lifecycle=[];manager.shutdown=async()=>{lifecycle.push('shutdown');};
  const starting=controller.onStart();const stopping=controller.onStop();
  await new Promise(setImmediate);assert.deepEqual(lifecycle,[]);
  release();await starting;await stopping;assert.deepEqual(lifecycle,['shutdown']);assert.equal(controller.enabled,false);assert.equal(controller.started,false);
});

test('audio diagnostic section distinguishes a selected profile from an actually open PCM',async()=>{
 const{controller,manager}=setup();manager.settings.managed=true;manager.settings.engine='album_player';
 manager.status=()=>({managed:true,ready:true,devices:manager.devices,observation:{state:'idle',actualEngine:null,routeMatches:null,pcm:null}});
 const idle=(await controller.ui()).sections.find(s=>s.id==='actualOutput');assert.ok(idle);assert.match(idle.description,/закрыто/);assert.match(idle.description,/не подтвержд/);
 manager.status=()=>({managed:true,ready:true,devices:manager.devices,observation:{state:'running',actualEngine:'album_player',routeMatches:true,pcm:{state:'RUNNING',ownerProcess:'ap2renderer',ownerPid:123,format:'S32_LE',rate:44100,channels:2}}});
 const running=(await controller.ui()).sections.find(s=>s.id==='actualOutput');assert.match(running.description,/ap2renderer/);assert.match(running.description,/44100/);assert.match(running.description,/S32_LE/);assert.match(running.description,/bit-perfect не проверен/);
});
