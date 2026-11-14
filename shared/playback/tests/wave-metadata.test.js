'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {metadata}=require('../soap');
test('CUE segment URLs advertise WAVE while retaining the original queue URI',()=>{
 const uri='music-library/USB/album.cue/track0001';const xml=metadata('http://127.0.0.1:1234/opaque.wav',{uri,trackType:'cue/track0001'});
 assert.match(xml,/http-get:\*:audio\/wav:\*/);assert.ok(xml.includes(uri));
});
