'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
for(const [folder,service] of [['qobuz','qobuz_custom'],['yandex-music','yandex_music']]){
  test(`${service} uses the shared engine manager when installed`,async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-manager-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
    let plays=0;const transport={kind:'album_player',play:async()=>{plays++;return true;},close(){}};const requested=[];
    const manager={getTransport:(...args)=>{requested.push(args);return transport;}};
    const router={pluginManager:{getConfigurationFile:(_ctx,name)=>path.join(dir,name),getPlugin:(category)=>category==='audio_interface'?manager:{}},stateMachine:{},sharedVars:{get:()=> 'ru'},broadcastMessage(){},pushToastMessage(){},volumioAddToBrowseSources(){}};
    const Controller=require(`../../../${folder}/index`);
    const controller=new Controller({coreCommand:router},{api:{request:async()=>({ready:true,api_version:1})},service:{start:async()=>{},stop:async()=>{}}});
    await controller.onStart();await controller.playback.transport.play('http://127.0.0.1/a',{},()=>true);assert.equal(plays,1);
    assert.equal(requested[0][0],service);assert.equal(typeof requested[0][1],'function');
    assert.equal(controller.getPlaybackEngineVersion(),1);
  });
}

test('source resolves a newly enabled manager on the next play without restarting the source',async()=>{
  const {createTransportWithManager}=require('../index');let manager;const calls=[];
  const transport=createTransportWithManager(null,{mpd:{sendMpdCommand:async command=>calls.push(command)},sm:{setConsumeUpdateService:async()=>{}},service:'qobuz_custom',getManager:()=>manager});
  await transport.play('http://127.0.0.1/a',{},()=>true);assert.equal(calls.at(-1),'play');
  manager={getTransport:()=>({kind:'album_player',play:async()=>{calls.push('album');return true;},close(){}})};
  await transport.play('http://127.0.0.1/b',{},()=>true);assert.equal(calls.at(-1),'album');assert.equal(transport.kind,'album_player');
});
