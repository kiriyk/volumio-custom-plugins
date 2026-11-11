'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const Browse=require('../../lib/browse');
test('catalog quality survives album and search mapping without altering playback quality fields',async()=>{
 const quality={codec:'flac',bitDepth:24,sampleRate:96000,basis:'catalog'};
 const b=new Browse({request:async()=>({items:[{type:'track',id:'42',title:'Song',recording_quality:quality}],next_cursor:null})});
 const page=await b.browse('qobuz_custom/album/abc');
 const item=page.navigation.lists[0].items[0];
 assert.deepEqual(item.recordingQuality,quality);
 assert.equal(item.samplerate,undefined);
 const found=await b.search('Song');
 assert.deepEqual(found[0].items[0].recordingQuality,quality);
});
test('artist pages expose artist info and separate pagination from albums',async()=>{
 const b=new Browse({request:async()=>({items:[{type:'album',id:'abc',title:'Album',artist_links:[{id:'12',name:'Artist'}]}],title:'Artist',artist:{id:'12',name:'Artist',cover_url:''},next_cursor:'50'})});
 const page=await b.browse('qobuz_custom/artist/12');
 assert.equal(page.navigation.info.type,'artist');assert.equal(page.navigation.info.uri,'qobuz_custom/artist/12');
 assert.equal(page.navigation.lists[0].items[0].icon,'fa-music');
 assert.equal(page.navigation.lists[1].awNavigation,true);
});
test('track links lead to artist and album with stable IDs',async()=>{
 const b=new Browse({request:async()=>({items:[{type:'track',id:'42',title:'Song',album_id:'abc',artist_links:[{id:'12',name:'Artist'}]}],next_cursor:null})});
 const page=await b.browse('qobuz_custom/track/42');
 assert.equal(page.navigation.lists[0].items[0].uri,'qobuz_custom/artist/12');
 assert.equal(page.navigation.lists[0].items[1].uri,'qobuz_custom/album/abc');
});
test('native quality fallback only accepts Qobuz stream transport', async()=>{
 const nativeQuality=require('../../lib/native-quality');
 let file='http://127.0.0.1:17901/stream/ticket';
 const mpd={sendMpdCommand:async cmd=>cmd==='status'?{audio:'96000:24:2',song:'0'}:{file}};
 assert.deepEqual(await nativeQuality(mpd,'qobuz_custom/track/42'),{uri:'qobuz_custom/track/42',codec:'flac',sampleRate:96000,bitDepth:24});
 file='http://127.0.0.1:17899/stream/other';assert.equal(await nativeQuality(mpd,'qobuz_custom/track/42'),null);
});
test('failed library refresh does not permanently mark downloads indexed',async()=>{
 const Controller=require('../../index');let calls=0;
 const controller=new Controller({coreCommand:{broadcastMessage:()=>{},pluginManager:{getPlugin:()=>({sendMpdCommand:async()=>{if(++calls===1)throw Error('temporarily busy');}})}}},
   {api:{request:async()=>({items:[{id:'job',state:'completed'}]})}});
 await controller.refreshDownloads();assert.equal(controller.completedDownloads.has('job'),false);
 await controller.refreshDownloads();assert.equal(controller.completedDownloads.has('job'),true);assert.equal(calls,2);
});
