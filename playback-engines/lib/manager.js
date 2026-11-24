'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Q = require('kew');
const Runtime = require('./runtime');
const AplayerRuntime = require('./aplayer-runtime');
const {AplayerTransport,aplayerSource,aplayerProfile}=require('./aplayer');
const {writeJson, fail} = Runtime;
const {defaults, validateSettings, effectiveProfile, albumPatch, albumPayload, rewriteMpdConfig} = require('./profiles');
const LocalStream = require('./local-stream');
const {localTrack} = require('./native-mpd');
const {observe,compareFormat}=require('./observation');
const engines = require('./transport');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function samePlaybackSettings(next,previous) {
  const sameOutput=next.managed===previous.managed && next.engine===previous.engine &&
    next.device?.key===previous.device?.key && next.modes[next.engine]===previous.modes[previous.engine] &&
    (next.engine!=='album_player'||next.localAlbumPlayer===previous.localAlbumPlayer);
  return sameOutput && (!next.managed || next.modes[next.engine]==='bypass' ||
    JSON.stringify(next.custom[next.engine])===JSON.stringify(previous.custom[previous.engine]));
}
function kew(value) { const d = Q.defer(); Promise.resolve(value).then(v => d.resolve(v),e => d.reject(e)); return d.promise; }

class ManagedTransport {
  constructor(manager,service,onError) { Object.assign(this,{manager,service,onError}); this.delegate=null; }
  get kind() { return this.manager.settings.managed ? this.manager.settings.engine : 'mpd'; }
  async play(url,track,valid,owns=valid) { return this.manager.play(this,url,track,valid,owns); }
  activate() { return this.delegate ? this.delegate.activate() : Promise.resolve(); }
  pause() { return this.manager.active===this ? this.delegate.pause() : Promise.resolve(); }
  resume() { return this.manager.active===this ? this.delegate.resume() : Promise.resolve(); }
  seek(ms) { return this.manager.active===this ? this.delegate.seek(ms) : Promise.resolve(); }
  async stop() {
    if(this.manager.active!==this)return;
    this.manager.active=null;
    if(this.delegate)await this.delegate.stop();
  }
  close() { this.delegate?.close(); if(this.manager.active===this)this.manager.active=null; }
}

class Manager {
  constructor({router,stateDir,runtime,aplayer,mpdConfig='/etc/mpd.conf',localStream}) {
    Object.assign(this,{router,stateDir,mpdConfig});
    this.mpd=router.pluginManager.getPlugin('music_service','mpd');
    this.runtime=runtime || new Runtime({stateDir}); this.aplayer=aplayer || new AplayerRuntime({stateDir}); this.localStream=localStream || new LocalStream({cacheDir:path.join(stateDir,'cue-cache')});
    this.settings=defaults();this.devices=[];this.active=null;this.ready=false;this.error=null;
    this.chain=Promise.resolve();this.hooks=[];this.facades=new Set();this.closed=false;this.closing=false;this.generation=0;this.localGeneration=0;
    this.inputFormat=null;this.expectedAplayerFormat=null;this.original={};this.volume=0;this.muted=false;this.mpdDirty=false;
  }
  async start() {
    try {this.settings=validateSettings(JSON.parse(fs.readFileSync(path.join(this.stateDir,'settings.json'),'utf8')));}
    catch(e){if(e.code!=='ENOENT')throw fail('BAD_SETTINGS');}
    try {const v=await this.router.volumioretrievevolume?.();if(Number.isFinite(v?.vol))this.volume=v.vol;} catch {}
    await this.aplayer.recover();
    await this.refreshDevices();this.installHooks();
    if(this.settings.managed){
      try {
        // Volumio may still reconnect its MPD client during boot. A stopped
        // state needs no MPD command before prepare() regenerates the output.
        if (['play', 'pause'].includes(this.router.stateMachine.currentStatus)) await this.router.stateMachine.stop();
        await this.runtime.stopRenderer();
        await this.prepare(this.settings, this.device());
        this.ready = true;
      }
      catch(e){this.error=e.code || 'ENGINE_ERROR';this.ready=false;await this.runtime.outputPolicy('album_player').catch(()=>{});}
    } else this.ready=true;
    this.publish();
  }
  device(settings=this.settings) {
    const found=this.devices.find(d=>d.key===settings.device?.key);
    if(!found)throw fail('DEVICE_UNAVAILABLE');return found;
  }
  status() {
    const available=!!this.devices.find(d=>d.key===this.settings.device?.key);
    return {managed:this.settings.managed,engine:this.settings.engine,localAlbumPlayer:this.settings.localAlbumPlayer,mode:this.settings.modes[this.settings.engine],device:this.settings.device,devices:this.devices,available,
      observation:this.observation(),ready:this.ready && (!this.settings.managed || available),error:this.error,volumeEnabled:this.settings.managed && effectiveProfile(this.settings).volumeEnabled,bitPerfectVerified:false};
  }
  observation(){
    if(!this.settings.managed)return{state:'unmanaged',actualEngine:null,routeMatches:null,pcm:null,checkedAt:Date.now()};
    const device=this.devices.find(d=>d.key===this.settings.device?.key);
    const native=this.active?.delegate?.kind==='aplayer';
    const result=observe(device,native?'aplayer':this.settings.engine,{aplayerPid:this.aplayer.pid});
    const expected=native?this.expectedAplayerFormat:null;
    if(this.inputFormat){
      result.inputFormat=this.inputFormat;
      if(result.pcm&&(expected||this.settings.modes[this.settings.engine]==='bypass')){
        result.formatMatches=compareFormat(result.pcm,expected||this.inputFormat);
        if(result.formatMatches===false)result.state='mismatch';
      }
    }
    return result;
  }
  publish(){this.router.broadcastMessage?.('pushPlaybackEnginesState',this.status());}
  async refreshDevices() {
    this.devices=await this.runtime.devices();
    if(this.settings.managed && !this.devices.some(d=>d.key===this.settings.device?.key)) {
      if(this.ready){this.generation++;this.localGeneration++;}
      this.error='DEVICE_UNAVAILABLE';this.ready=false;
      if(this.active){await this.stopPlayback();await this.runtime.stopRenderer().catch(()=>{});await this.aplayer.stop();}
    }
    this.publish();return this.devices;
  }
  async stopPlayback() {
    const sm=this.router.stateMachine;
    if(['play','pause'].includes(sm.currentStatus))await sm.stop();
    if(this.active)await this.active.stop();
    await (this.original.stop || this.mpd.stop.bind(this.mpd))();
  }
  async regenerate() {
    await new Promise((resolve,reject)=>this.mpd.createMPDFile(e=>e?reject(fail('MPD_CONFIG_ERROR')):resolve()));
    await new Promise((resolve,reject)=>this.mpd.restartMpd(e=>e?reject(fail('MPD_CONFIG_ERROR')):resolve()));
    const deadline=Date.now()+15000;
    do {
      try {if(this.settings.managed)await this.runtime.outputPolicy(this.settings.engine);return;}
      catch {await sleep(200);}
    }while(Date.now()<deadline);
    throw fail('MPD_UNAVAILABLE');
  }
  async prepare(settings,device) {
    await this.regenerate();
    if(settings.engine==='album_player' && settings.localAlbumPlayer!=='aplayer')await this.configureRenderer(settings,device);
  }
  async configureRenderer(settings,device) {
    await this.runtime.startRenderer(device);
    const patch=albumPatch(settings.modes.album_player,settings.custom.album_player);
    const current=await this.runtime.requestConfig();
    await this.runtime.requestConfig(albumPayload(current,patch));
    const got=await this.runtime.requestConfig();
    if(Object.entries(patch).some(([k,v])=>got[k]!==v))throw fail('PROFILE_SAVE_FAILED');
    if(effectiveProfile(settings).volumeEnabled)await this.rendererVolume(this.muted?0:settings.custom.album_player.volume);
  }

  apply(candidate) {
    if(this.closed||this.closing)return Promise.reject(fail('ENGINE_UNAVAILABLE'));
    let next;try{next=validateSettings(candidate);}catch(e){return Promise.reject(e);}
    const operation=this.chain.then(async()=>{
      await this.refreshDevices();const previous=this.settings;const wasReady=this.ready;
      if(samePlaybackSettings(next,previous) && (wasReady || !next.managed)){
        writeJson(path.join(this.stateDir,'settings.json'),next);this.settings=next;this.publish();return this.status();
      }
      const device=next.managed?this.device(next):null;
      if(next.managed&&next.engine==='album_player'&&next.localAlbumPlayer==='aplayer')await this.aplayer.available();
      this.generation++;this.localGeneration++;
      await this.stopPlayback();await this.runtime.stopRenderer();await this.aplayer.stop();
      this.settings=next;this.inputFormat=null;this.ready=false;this.error=null;this.publish();
      try {
        if(next.managed)await this.prepare(next,device);else await this.regenerate();
        writeJson(path.join(this.stateDir,'settings.json'),next);this.ready=true;this.publish();return this.status();
      } catch(e) {
        this.settings=previous;this.error=e.code||'ENGINE_ERROR';
        await this.runtime.stopRenderer().catch(()=>{});
        try {if(previous.managed)await this.prepare(previous,this.device(previous));else await this.regenerate();this.ready=wasReady;}
        catch {this.ready=false;this.error='ROLLBACK_FAILED';}
        this.publish();throw fail(this.error);
      }
    });
    this.chain=operation.catch(()=>{});return operation;
  }
  createTransport(service,onError=()=>{}) {const facade=new ManagedTransport(this,service,onError);this.facades.add(facade);return facade;}
  play(facade,url,track,valid,owns) {
    if(this.closed||this.closing)return Promise.reject(fail('ENGINE_UNAVAILABLE'));
    const operation=this.chain.then(()=>{
      const generation=this.generation;
      const live=()=>!this.closed&&!this.closing&&generation===this.generation;
      const current=()=>live()&&valid();
      return this.playNow(facade,url,track,current,this.usesAplayer(facade)?()=>live()&&owns():owns).catch(e=>{
        if(current()){this.error=e.code||'ENGINE_ERROR';this.publish();}
        throw e;
      });
    });
    this.chain=operation.catch(()=>{});return operation;
  }
  async playNow(facade,url,track,valid,owns) {
    if(!valid())return false;
    if(this.closed)throw fail('ENGINE_UNAVAILABLE');
    if(this.settings.managed && !this.status().ready)throw fail(this.error||'DEVICE_UNAVAILABLE');
    if(this.active)await this.active.stop();if(!valid())return false;
    this.inputFormat=null;
    this.expectedAplayerFormat=null;
    if(this.usesAplayer(facade))return this.playAplayer(facade,url,track,valid,owns);
    await this.aplayer.stop();
    if(!valid())return false;
    if(this.settings.managed){
      const device=this.device();
      await this.original.stop();if(!valid())return false;
      if(this.settings.modes[this.settings.engine]==='bypass') {
        // Native Album Player retains its exclusive PCM handle even after Stop.
        // Release that process before opening the device for exact-format preflight.
        if(this.settings.engine==='album_player')await this.runtime.stopRenderer();
        if(!valid())return false;
        const format=await this.runtime.probe(typeof url==='string'?url:url.source);if(!valid())return false;this.inputFormat=format;
        if(format.encoding==='dsd'&&this.settings.engine!=='mpd')throw fail('UNSUPPORTED_FORMAT');
        const deadline=Date.now()+3000;
        for(;;){try{await this.runtime.check(device,format);break;}catch(e){if(e.code!=='PCM_BUSY')throw e;if(Date.now()>=deadline)throw fail('DEVICE_BUSY');await sleep(150);}}
      }
      if(this.settings.engine==='mpd') {
        const profile=effectiveProfile(this.settings);
        await this.mpd.sendMpdCommand('crossfade',[profile.crossfade]);
        await this.mpd.sendMpdCommand('replay_gain_mode',[profile.replaygain]);
        if(profile.volumeEnabled)await this.mpd.sendMpdCommand('setvol',[this.muted?0:this.settings.custom.mpd.volume]);
      }else {
        if(facade===this.local && this.settings.modes.album_player==='custom' && /\.(dsf|dff)$/i.test(url)){
          const format=await this.runtime.probe(url);
          if(!valid())return false;
          if(format.encoding!=='dsd'||!format.duration)throw fail('UNSUPPORTED_FORMAT');
          this.inputFormat=format;
          track={...track,duration:format.duration};
        }
        await this.configureRenderer(this.settings,device);
      }
    }
    if(!valid())return false;
    const config=this.settings.managed && this.settings.engine==='album_player' ? {engine:'album_player',controlUrl:this.runtime.endpoints?.controlUrl} : {engine:'mpd'};
    facade.delegate?.close();
    facade.delegate=engines.createTransport({config,mpd:{...this.mpd,stop:this.original.stop},sm:this.router.stateMachine,service:facade.service,updateSource:'playback_engines',onError:e=>{
      if(this.active===facade){this.error=e.code||'ENGINE_ERROR';this.publish();facade.onError(e);}
    }});
    // MPD methods may be inherited from a prototype, so bind those explicitly.
    if(facade.delegate.kind==='mpd')facade.delegate.mpd=this.nativeMpd();
    this.active=facade;
    try {
      const played=await (typeof url==='string' ? facade.delegate.play(url,track,valid,owns) : facade.delegate.playLocal(url,track,valid));
      if(played&&this.active===facade){this.error=null;this.publish();}
      if(!played && this.active===facade)await facade.stop();
      return played;
    }
    catch(e){if(this.active===facade){facade.close();this.error=e.code||'ENGINE_ERROR';this.publish();}throw e;}
  }
  usesAplayer(facade) {
    return facade===this.local && this.settings.managed && this.settings.engine==='album_player' &&
      this.settings.localAlbumPlayer==='aplayer';
  }

  async checkOutput(device, format, valid) {
    const deadline=Date.now()+3000;
    while(valid()){
      try{await this.runtime.check(device,format);return;}
      catch(error){
        if(error.code!=='PCM_BUSY')throw error;
        if(Date.now()>=deadline)throw fail('DEVICE_BUSY');
        await sleep(150);
      }
    }
  }

  async playAplayer(facade,source,track,valid,owns) {
    const device=this.device();
    const bypass=this.settings.modes.album_player==='bypass';
    const profile=effectiveProfile(this.settings);
    await this.original.stop();
    if(!valid())return false;
    await this.runtime.stopRenderer();
    if(!valid())return false;
    const format=await this.runtime.probe(source.ticket.file);
    if(!valid())return false;
    const dsd=format.encoding==='dsd';
    if(dsd!==['.dsf','.dff'].includes(source.suffix))throw fail('UNSUPPORTED_FORMAT');
    const {patch,dsdMode}=aplayerProfile(profile,bypass,format);
    const expected=dsdMode===1?{encoding:'dop',rate:format.rate/2,channels:format.channels}:
      dsdMode===2?{...format,encoding:'dsd32'}:bypass?format:null;
    this.inputFormat=format;
    this.expectedAplayerFormat=expected;
    if(expected)await this.checkOutput(device,expected,valid);
    if(!valid())return false;
    let played=false;
    try{
      if(!await this.aplayer.start(device,valid)||!valid())return false;
      if(!await this.aplayer.configure(patch,valid)||!valid())return false;
      if(profile.volumeEnabled)await this.aplayer.setVolume(this.muted?0:profile.volume);
      if(!valid())return false;
      facade.delegate?.close();
      facade.delegate=new AplayerTransport({
        runtime:this.aplayer,sm:this.router.stateMachine,service:facade.service,
        verifyOutput:()=>{
          const actual=observe(device,'aplayer',{aplayerPid:this.aplayer.pid});
          if(actual.state==='mismatch')throw fail('APLAYER_OUTPUT_MISMATCH');
          if(actual.state!=='running')return false;
          if(expected&&compareFormat(actual.pcm,expected)!==true)throw fail('APLAYER_OUTPUT_MISMATCH');
          return true;
        },
        onError:error=>{
          if(this.active===facade&&owns()){
            this.error=error.code||'APLAYER_PLAYBACK_ERROR';
            this.publish();
            facade.onError(error);
          }
        }
      });
      this.active=facade;
      played=await facade.delegate.playLocal(source,track,valid,owns);
      if(played&&owns()&&this.active===facade){this.error=null;this.publish();}
      return played;
    } finally {
      if(!played){
        if(this.active===facade)await facade.stop();
        else await this.aplayer.stop();
      }
    }
  }

  nativeMpd(){return{stop:this.original.stop,pause:this.original.pause,resume:this.original.resume,seek:this.original.seek,sendMpdCommand:this.mpd.sendMpdCommand.bind(this.mpd)};}
  async rendererVolume(value){
    const endpoint=this.runtime.endpoints?.renderingControlUrl;if(!endpoint)throw fail('VOLUME_UNAVAILABLE');
    const client=new engines.SoapClient(endpoint,{service:'urn:schemas-upnp-org:service:RenderingControl:1'});
    await client.call('SetVolume',{InstanceID:0,Channel:'Master',DesiredVolume:value});
  }
  async setVolume(value) {
    if(!this.settings.managed)return this.original.setVolume?.(value);
    const profile=effectiveProfile(this.settings);
    if(!profile.volumeEnabled)return this.volumeState();
    let muted=this.muted;
    if(value==='mute')muted=true;
    else if(value==='unmute')muted=false;
    else if(value==='toggle')muted=!muted;
    let volume=profile.volume;
    if(!['mute','unmute','toggle'].includes(value)){
      volume=value==='+'?volume+1:value==='-'?volume-1:Number(value);
      if(!Number.isFinite(volume))return this.volumeState();
      volume=Math.max(0,Math.min(100,Math.round(volume)));muted=false;
    }
    const gain=muted?0:volume;
    if(this.settings.engine==='mpd')await this.mpd.sendMpdCommand('setvol',[gain]);
    else if(this.active?.delegate?.kind==='aplayer'){
      if(this.aplayer.pid)await this.active.delegate.serialize(()=>this.aplayer.setVolume(gain));
    }else if(this.runtime.endpoints || this.settings.localAlbumPlayer!=='aplayer')await this.rendererVolume(gain);
    this.muted=muted;this.settings.custom[this.settings.engine].volume=volume;this.volume=volume;writeJson(path.join(this.stateDir,'settings.json'),this.settings);
    return this.volumeState();
  }
  volumeState(){const profile=effectiveProfile(this.settings);return{vol:profile.volumeEnabled?profile.volume:this.volume,mute:profile.volumeEnabled&&this.muted,disableVolumeControl:!profile.volumeEnabled};}
  patch(object,key,value){const old=object[key];this.hooks.push(()=>{object[key]=old;});object[key]=value;}
  installHooks() {
    const mpd=this.mpd;
    // Volumio advances its queue early whenever a source exposes prefetch().
    // Managed playback starts each track itself, so native MPD cannot prefetch it.
    if(typeof mpd.prefetch==='function'){
      const descriptor=Object.getOwnPropertyDescriptor(mpd,'prefetch'),native=mpd.prefetch;
      Object.defineProperty(mpd,'prefetch',{configurable:true,get:()=>this.settings.managed?undefined:native});
      this.hooks.push(()=>{if(descriptor)Object.defineProperty(mpd,'prefetch',descriptor);else delete mpd.prefetch;});
    }
    for(const key of ['stop','pause','resume','seek','clearAddPlayTrack','next','previous'])if(typeof mpd[key]==='function')this.original[key]=mpd[key].bind(mpd);
    const create=mpd.createMPDFile.bind(mpd);
    this.patch(mpd,'createMPDFile',callback=>{
      try{if(this.settings.managed)this.device();}catch(e){callback(e);return;}
      const before=fs.statSync(this.mpdConfig,{bigint:true}).mtimeNs;
      create(error=>{
        if(error){callback(error);return;}
        (async()=>{
          // Volumio invokes its callback before fs.readFile/fs.writeFile completes.
          // Observe a real write (mtime, not chmod's ctime), then a stable file.
          const deadline=Date.now()+5000;
          let last=before,stableSince=Date.now();
          for(;;){
            const stat=fs.statSync(this.mpdConfig,{bigint:true});
            if(stat.mtimeNs!==last){last=stat.mtimeNs;stableSince=Date.now();}
            if(last!==before&&stat.size>0n&&Date.now()-stableSince>=100)break;
            if(Date.now()>=deadline)throw fail('MPD_CONFIG_ERROR');
            await sleep(20);
          }
          if(this.settings.managed){
            const text=fs.readFileSync(this.mpdConfig,'utf8');
            if(!fs.existsSync(path.join(this.stateDir,'mpd.conf.before-plugin'))){fs.mkdirSync(this.stateDir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(this.stateDir,'mpd.conf.before-plugin'),text,{mode:0o600});}
            fs.writeFileSync(this.mpdConfig,rewriteMpdConfig(text,this.device().pcm,this.settings.modes.mpd,this.settings.custom.mpd));this.mpdDirty=true;
          }
        })().then(()=>callback(),e=>callback(e));
      });
    });
    this.local=this.createTransport('mpd',e=>{
      this.error=e.code||'ENGINE_ERROR';this.publish();
      if(this.usesAplayer(this.local))this.onLocalError?.(this.error);
      Promise.resolve(this.router.stateMachine.stop()).catch(()=>{});
    });
    this.patch(mpd,'clearAddPlayTrack',track=>{
      if(!this.settings.managed)return this.original.clearAddPlayTrack(track);
      const generation=++this.localGeneration;
      const index=this.router.stateMachine.currentPosition;
      const native=this.usesAplayer(this.local);
      const current=()=>this.router.stateMachine.getTrack(this.router.stateMachine.currentPosition);
      const owns=()=>generation===this.localGeneration&&!this.closed&&!this.closing&&!this.router.stateMachine.isVolatile &&
        (native||this.router.stateMachine.currentPosition===index) && current()===track;
      return kew((async()=>{
        if(this.active)await this.active.stop();
        if(!owns())return;
        const source=this.settings.engine==='mpd' ?
          await localTrack(track.uri,this.runtime,this.localStream,this.settings.modes.mpd==='bypass') :
          native?await aplayerSource(this.localStream,track.uri,owns):await this.localStream.urlFor(track.uri,{valid:owns});
        if(owns())await this.local.play(source,track,owns,owns);
      })().catch(e=>{
        if(!owns())return;
        this.error=e.code||'LOCAL_FILE_UNAVAILABLE';this.publish();
        if(native)this.onLocalError?.(this.error);
        return this.router.stateMachine.stop();
      }));
    });
    for(const key of ['stop','pause','resume','seek'])this.patch(mpd,key,(...args)=>{
      if(key==='stop'||(key==='pause'&&!(this.active===this.local&&this.local.delegate?.kind==='aplayer'&&
        this.local.delegate.session?.started!==undefined)))this.localGeneration++;
      return this.active===this.local?kew(this.local[key](...args)):this.original[key](...args);
    });
    for(const key of ['next','previous'])this.patch(mpd,key,(...args)=>{
      if(this.active!==this.local)return this.original[key](...args);
      if(this.local.delegate?.kind==='aplayer')this.localGeneration++;
      return kew((async()=>{await this.router.stateMachine.setConsumeUpdateService(undefined);return this.router.stateMachine[key]();})());
    });
    for(const [key,method] of [['volumiosetvolume','setVolume'],['volumioretrievevolume','retrieveVolume'],['volumioupdatevolume','updateVolume']]){
      if(typeof this.router[key]!=='function')continue;this.original[method]=this.router[key].bind(this.router);
      if(method==='setVolume')this.patch(this.router,key,value=>this.settings.managed?kew(this.setVolume(value).then(state=>{this.router.volumioupdatevolume?.(state);return state;})):this.original[method](value));
      else if(method==='retrieveVolume')this.patch(this.router,key,(...args)=>this.settings.managed?Q.resolve(this.volumeState()):this.original[method](...args));
      else this.patch(this.router,key,value=>this.original[method](this.settings.managed?{...value,...this.volumeState()}:value));
    }
  }
  async shutdown(){
    this.closing=true;this.generation++;this.localGeneration++;
    await this.chain;
    await this.stopPlayback();await this.runtime.stopRenderer();await this.aplayer.stop();this.settings={...this.settings,managed:false};
    if(this.mpdDirty)await this.regenerate();this.publish();await this.close();
  }
  async close(){this.closed=true;this.generation++;this.localGeneration++;for(const facade of this.facades)facade.close();while(this.hooks.length)this.hooks.pop()();await this.localStream.close();}
}
module.exports=Manager;
