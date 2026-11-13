'use strict';
const fs=require('node:fs'),path=require('node:path');
function fields(text){const result={};for(const line of text.split('\n')){const index=line.indexOf(':');if(index>=0)result[line.slice(0,index).trim()]=line.slice(index+1).trim();}return result;}
function observe(device,requestedEngine,{procRoot='/proc'}={}){
 const result={checkedAt:Date.now(),state:'unavailable',actualEngine:null,routeMatches:null,pcm:null};
 if(!device||!Number.isInteger(device.index)||device.index<0||!Number.isInteger(device.device)||device.device<0)return result;
 const identity=/^hw:CARD=([A-Za-z0-9_-]+),DEV=(\d+)$/.exec(device.pcm||'');
 if(!identity||Number(identity[2])!==device.device)return result;
 const card=path.join(procRoot,'asound','card'+device.index);
 try{
  if(fs.readFileSync(path.join(card,'id'),'utf8').trim()!==identity[1])return result;
  const directory=path.join(card,'pcm'+device.device+'p');
  const streams=[];let unreadable=false;
  for(const entry of fs.readdirSync(directory).filter(v=>/^sub\d+$/.test(v))){
   try{
    const parameters=fs.readFileSync(path.join(directory,entry,'hw_params'),'utf8').trim();if(parameters==='closed')continue;
    const hw=fields(parameters),status=fields(fs.readFileSync(path.join(directory,entry,'status'),'utf8'));
    let ownerPid=/^\d+$/.test(status.owner_pid||'')?Number(status.owner_pid):null;
    let ownerProcess=null;
    try{
      if(ownerPid){
        // ALSA may report an output thread TID, e.g. MPD's output:alsa.
        try{const process=fields(fs.readFileSync(path.join(procRoot,String(ownerPid),'status'),'utf8'));if(/^[1-9]\d*$/.test(process.Tgid||''))ownerPid=Number(process.Tgid);}catch{}
        ownerProcess=fs.readFileSync(path.join(procRoot,String(ownerPid),'comm'),'utf8').trim();
      }
    }catch{}
    streams.push({state:status.state||'UNKNOWN',format:hw.format||null,rate:Number.parseInt(hw.rate,10)||null,channels:Number.parseInt(hw.channels,10)||null,ownerPid,ownerProcess});
   }catch{unreadable=true;result.state='unconfirmed';}
  }
  if(!streams.length){if(result.state!=='unconfirmed')result.state='idle';return result;}
  const pcm=streams.find(s=>s.state==='RUNNING')||streams[0];result.pcm=pcm;
  const engineOf=stream=>stream.ownerProcess==='mpd'?'mpd':stream.ownerProcess==='ap2renderer'?'album_player':null;
  result.actualEngine=engineOf(pcm);
  if(unreadable||!result.actualEngine||streams.some(s=>!engineOf(s))){result.state='unconfirmed';return result;}
  result.routeMatches=streams.every(s=>engineOf(s)===requestedEngine);
  result.state=!result.routeMatches?'mismatch':pcm.state==='RUNNING'?'running':'open';
  return result;
 }catch{return result;}
}
function compareFormat(pcm,source){
 if(!pcm||!source)return null;
 const bits={S16_LE:16,S24_LE:24,S24_3LE:24,S32_LE:32}[pcm.format];
 if(!bits||!pcm.rate||!pcm.channels)return null;
 return pcm.rate===source.rate&&pcm.channels===source.channels&&bits>=source.bits;
}
module.exports={observe,compareFormat};
