import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbackEngineView } from '../src/core/playbackEngine.ts';
test('managed engine replaces native output claims without asserting verified bit-perfect',()=>{
  const view=playbackEngineView({managed:true,engine:'album_player',mode:'bypass',ready:true,device:{label:'FiiO'}});
  assert.equal(view.engine,'Album Player');assert.equal(view.output,'FiiO');assert.equal(view.processing,'NO PROCESSING');assert.equal(view.bitPerfect,false);
  assert.equal(playbackEngineView({managed:true,engine:'mpd',mode:'custom',ready:true,device:{label:'Headphones'}}).processing,'CUSTOM PROCESSING');
});
test('unavailable output is explicit and unmanaged state restores native display',()=>{
  assert.equal(playbackEngineView({managed:true,engine:'mpd',mode:'bypass',ready:false,device:{label:'FiiO'}}).output,'FiiO · недоступно');
  assert.equal(playbackEngineView({managed:false}),null);assert.equal(playbackEngineView(null),null);
});
