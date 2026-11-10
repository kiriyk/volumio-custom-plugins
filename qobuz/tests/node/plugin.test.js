'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Playback = require('../../lib/playback');
const Browse = require('../../lib/browse');

test('late resolve after stop does not play', async () => {
  let resolve; const calls=[];
  const api={request:()=>new Promise(r=>{resolve=r;}),streamUrl:p=>p};
  const sm={getTrack:()=>({service:'qobuz_custom',uri:'qobuz_custom/track/42'}),setConsumeUpdateService:async()=>{}};
  const mpd={sendMpdCommand:async c=>calls.push(c),stop:async()=>{}};
  const playback=new Playback(api,mpd,sm,()=>{});
  const pending=playback.clearAddPlayTrack({uri:'qobuz_custom/track/42'});
  await playback.stop(); resolve({path:'/stream/ticket',codec:'flac'}); await pending;
  assert.deepEqual(calls,[]);
});

test('actual quality belongs to played URI', async () => {
  const errors=[];
  const api={request:async()=>({path:'/stream/ticket',codec:'flac',sampleRate:44100,bitDepth:24}),streamUrl:p=>p};
  const sm={getTrack:()=>({service:'qobuz_custom',uri:'qobuz_custom/track/42'}),setConsumeUpdateService:async()=>{}};
  const playback=new Playback(api,{sendMpdCommand:async()=>{}},sm,e=>errors.push(e));
  await playback.clearAddPlayTrack({uri:'qobuz_custom/track/42',duration:247});
  assert.deepEqual(errors,[]);
  assert.equal(playback.lastQuality.sampleRate,44100);assert.equal(playback.lastQuality.bitDepth,24);
  assert.equal(playback.lastQuality.uri,'qobuz_custom/track/42');
});

test('album queue preserves repeats and paginates opaque IDs', async () => {
  let n=0; const paths=[];
  const b=new Browse({request:async(method,p)=>{paths.push(p);return ++n===1?
    {items:[{type:'track',id:'42',title:'A'},{type:'track',id:'1',available:false}],next_cursor:'2'}:
    {items:[{type:'track',id:'42',title:'A'}],next_cursor:null};}});
  const result=await b.explode('qobuz_custom/album/aBc9');
  assert.deepEqual(result.map(x=>x.uri),['qobuz_custom/track/42','qobuz_custom/track/42']);
  assert.equal(paths[1],'/v1/albums/aBc9?cursor=2');
});

test('repeated cursor cannot loop forever', async () => {
  const b=new Browse({request:async()=>({items:[{type:'track',id:'42'}],next_cursor:'1'})});
  await assert.rejects(()=>b.explode('qobuz_custom/album/aBc9'));
});
