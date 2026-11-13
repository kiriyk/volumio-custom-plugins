import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioPresentation} from '../src/core/audioPresentation.ts';
const item=(id,value)=>({id,value});
const options=[{value:'hdmi',label:'HDMI выход 1'},{value:'old',label:'HDMI выход 1 (совместимый)'},{value:'usb',label:'FiiO'},{value:'gone',label:'FiiO (device 0) — недоступно'}];
const cfg=(engine='mpd',mpd='bypass',album='custom',device='gone')=>({sections:[{id:'selection',content:[item('engine',{value:engine}),item('mpdMode',{value:mpd}),item('albumMode',{value:album}),{id:'device',value:{value:device,label:options.find(x=>x.value===device)?.label},options}]}]});
test('only the draft selected engine mode and its custom profile are shown',()=>{
 assert.deepEqual([audioPresentation(cfg()).modeField,audioPresentation(cfg()).customSection],['mpdMode',null]);
 assert.equal(audioPresentation(cfg('album_player')).customSection,'albumCustom');
 assert.equal(audioPresentation(cfg('mpd','custom')).customSection,'mpdCustom');
 assert.equal(audioPresentation(cfg('album_player','custom','bypass')).customSection,null);
});
test('main outputs exclude old drivers and unavailable entries without mutating saved selection',()=>{
 const source=cfg(); const before=JSON.stringify(source); const view=audioPresentation(source);
 assert.deepEqual(view.options.map(x=>x.value),['hdmi','usb']);
 assert.equal(view.unavailable,'FiiO (device 0) — недоступно');
 assert.equal(view.hasAdvanced,true);
 assert.equal(JSON.stringify(source),before);
 assert.deepEqual(audioPresentation(source,true).options.map(x=>x.value),['hdmi','old','usb']);
 assert.match(audioPresentation(source,true).options[1].label,/старый драйвер/);
});
test('selected old driver remains visible when advanced outputs are collapsed',()=>{
 const view=audioPresentation(cfg('mpd','bypass','custom','old'));
 assert.deepEqual(view.options.map(x=>x.value),['hdmi','old','usb']);
 assert.equal(view.unavailable,null);
});
test('search visibility follows unsaved engine and mode edits without exposing hidden targets', async()=>{
 const {audioSectionVisible,audioFieldVisible}=await import('../src/core/audioPresentation.ts');
 const source=cfg('mpd','bypass');
 assert.equal(audioSectionVisible(audioPresentation(source),'albumCustom'),false);
 assert.equal(audioFieldVisible(audioPresentation(source),'selection','albumMode'),false);
 source.sections[0].content[0].value={value:'album_player'};
 assert.equal(audioSectionVisible(audioPresentation(source),'albumCustom'),true);
 assert.equal(audioSectionVisible(audioPresentation(source),'mpdCustom'),false);
 assert.equal(audioFieldVisible(audioPresentation(source),'selection','albumMode'),true);
});
