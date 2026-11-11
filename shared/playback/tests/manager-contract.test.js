'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const {once}=require('node:events');
const {SoapClient,AlbumPlayerTransport}=require('..');

test('RenderingControl uses its service namespace instead of AVTransport',async t=>{
  let action;
  const server=http.createServer(async(req,res)=>{for await(const _ of req){}action=req.headers.soapaction;res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"/></s:Body></s:Envelope>');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  await new SoapClient(`http://127.0.0.1:${server.address().port}/control`,{service:'urn:schemas-upnp-org:service:RenderingControl:1'}).call('SetVolume',{InstanceID:0,Channel:'Master',DesiredVolume:37});
  assert.equal(action,'"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"');
});

test('manager-owned local playback ignores core MPD updates but retains queue service for controls',async()=>{
  const consume=[],events=[];const sm={consumeState:{},setConsumeUpdateService:async s=>{consume.push(s);sm.consumeState.service=s;},syncState:async(s,source)=>events.push({s,source})};
  const client={call:async action=>action==='GetTransportInfo'?{CurrentTransportState:'PLAYING',CurrentTransportStatus:'OK'}:action==='GetPositionInfo'?{RelTime:'0:00:01.000',TrackDuration:'0:03:00.000'}:{}};
  const engine=new AlbumPlayerTransport({client,mpd:{stop:async()=>{}},sm,service:'mpd',updateSource:'playback_engines',pollMs:60000});
  try{await engine.play('http://127.0.0.1/file.flac',{uri:'music-library/USB/file.flac',duration:180},()=>true);await engine.poll();
    assert.deepEqual(consume,['playback_engines']);assert.equal(sm.consumeState.service,'mpd');assert.equal(events[0].source,'playback_engines');assert.equal(events[0].s.service,'mpd');
  }finally{engine.close();}
});
