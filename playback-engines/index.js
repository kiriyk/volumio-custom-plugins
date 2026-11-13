'use strict';
const fs=require('node:fs');const path=require('node:path');const Q=require('kew');
const Manager=require('./lib/manager');const {defaults,validateSettings}=require('./lib/profiles');
const ENDPOINT='audio_interface/playback_engines';
const names={mpd:'MPD',album_player:'Album Player'};
const errors={DEVICE_BUSY:'Аудиовыход занят другим процессом. Закройте другое воспроизведение и попробуйте снова.',AUDIO_PREFLIGHT_FAILED:'Не удалось проверить параметры аудиовыхода. Проверьте подключение устройства.',PLUGIN_DISABLED:'Сначала включите плагин Playback Engines.',DEVICE_UNAVAILABLE:'Выбранное аудиоустройство недоступно. Подключите его или выберите другой выход.',UNSUPPORTED_FORMAT:'Устройство не поддерживает исходный формат без преобразования. Выберите пользовательский режим или другой выход.',BAD_SETTINGS:'Проверьте значения настроек.',PROFILE_SAVE_FAILED:'Движок не подтвердил сохранение профиля.',MPD_CONFIG_ERROR:'Не удалось настроить MPD.',MPD_UNAVAILABLE:'MPD не отвечает.',RENDERER_UNAVAILABLE:'Album Player не готов.',RENDERER_SERVICE_ERROR:'Не удалось запустить или остановить Album Player.',ROLLBACK_FAILED:'Не удалось восстановить прежнюю конфигурацию. Воспроизведение остановлено.',OUTDATED_SOURCES:'Обновите плагины Яндекса и Qobuz для управления движком.',VOLUME_UNAVAILABLE:'Программная громкость движка недоступна.'};
function kew(p){const d=Q.defer();Promise.resolve(p).then(v=>d.resolve(v),e=>d.reject(e));return d.promise;}
const unwrap=v=>v&&typeof v==='object'?v.value:v;
function select(id,label,value,options){return{id,element:'select',label,options,value:options.find(o=>o.value===value)||{value:value??'',label:'Выберите…'}};}
function input(id,label,value,min,max,step=1){return{id,element:'input',type:'number',label,value,attributes:[{min,max,step}]};}
function toggle(id,label,value){return{id,element:'switch',label,value};}
function section(id,label,method,content,description){return{id,element:'section',label,description,content,onSave:{type:'controller',endpoint:ENDPOINT,method},saveButton:{label:'Применить',data:content.map(x=>x.id)}};}
const modes=[{value:'bypass',label:'Всё отключено'},{value:'custom',label:'Пользовательские настройки'}];
const rates=[{value:0,label:'Исходная частота'},...[44100,48000,88200,96000,176400,192000,352800,384000].map(value=>({value,label:(value/1000)+' кГц'}))];

function actualOutput(status){
  const o=status.observation;
  if(!status.managed)return 'Управление выводом остаётся у Volumio. Фактический поток плагином не подтверждён.';
  if(!o)return 'Фактический вывод ещё не проверен.';
  const messages={idle:'Выбранное ALSA-устройство закрыто. Активный движок не подтверждён.',unavailable:'Выбранный выход недоступен. Если ЦАП переставлен в другой USB-порт, выберите его заново.',unconfirmed:'Процесс аудиовывода не подтверждён.',mismatch:'Несовпадение выбранного движка или исходного формата с фактическим потоком.',running:'Процесс аудиовывода подтверждён по ALSA.',open:'Устройство открыто, но поток сейчас не RUNNING.'};
  const pcm=o.pcm;
  const details=pcm?` ${pcm.ownerProcess||'неизвестный процесс'} · PID ${pcm.ownerPid||'?'} · ${pcm.state} · ${pcm.rate||'?'} Гц · ${pcm.format||'?'} · ${pcm.channels||'?'} канала.`:'';
  const source=o.inputFormat?` Источник: ${o.inputFormat.rate} Гц · ${o.inputFormat.bits} бит · ${o.inputFormat.channels} канала.`:'';
  return(messages[o.state]||'Фактический вывод не подтверждён.')+details+source+' Это проверка маршрута и формата; bit-perfect не проверен.';
}

class ControllerPlaybackEngines{
  constructor(context,dependencies={}){this.context=context;this.router=context.coreCommand;this.manager=dependencies.manager;this.startPromise=null;this.started=false;this.enabled=false;this.polling=false;this.timer=null;this.lastUi=0;}
  ensure(){
    if(!this.manager){
      const file=this.router.pluginManager.getConfigurationFile(this.context,'settings.json');
      this.manager=new Manager({router:this.router,stateDir:path.dirname(file)});
      try{this.manager.settings=validateSettings(JSON.parse(fs.readFileSync(file,'utf8')));}catch(e){if(e.code!=='ENOENT')this.manager.error='BAD_SETTINGS';}
    }
    return this.manager;
  }
  onVolumioStart(){return Q.resolve();}
  getConfigurationFiles(){return['config.json'];}
  onStart(){this.enabled=true;return kew(this.start());}
  async start(){
    if(this.started)return;if(this.startPromise)return this.startPromise;
    this.startPromise=(async()=>{const manager=this.ensure();await manager.start();this.started=true;
      this.timer=setInterval(()=>this.pollDevices(),2000);this.timer.unref?.();})();
    try{return await this.startPromise;}finally{this.startPromise=null;}
  }
  async pollDevices(){
    if(this.polling||!this.started)return;this.polling=true;
    try{
      const manager=this.ensure();const before=JSON.stringify(manager.devices);await manager.refreshDevices();
      if(before!==JSON.stringify(manager.devices)&&Date.now()-this.lastUi<120000)await this.refresh();
    }catch(e){this.ensure().error='DEVICE_ERROR';this.ensure().publish?.();}finally{this.polling=false;}
  }
  onStop(){this.enabled=false;return kew((async()=>{await this.startPromise?.catch(()=>{});clearInterval(this.timer);await this.manager?.shutdown();this.started=false;this.manager=null;})());}
  getTransport(service,onError){
    // Providers can start before this plugin. Resolve readiness on the first play,
    // rather than permanently falling back to MPD in their startup ordering.
    let transport,owner,native;
    const fallback=()=>native??=require('./lib/transport').createTransport({mpd:this.router.pluginManager.getPlugin('music_service','mpd'),sm:this.router.stateMachine});
    const current=()=>this.enabled?transport:fallback();
    return{get kind(){return transport?.kind||'mpd';},play:async(...args)=>{
      if(!this.enabled)return fallback().play(...args);
      await this.start();const manager=this.ensure();if(owner!==manager){transport?.close();transport=manager.createTransport(service,onError);owner=manager;}
      return transport.play(...args);
    },activate:()=>current()?.activate()||Promise.resolve(),pause:()=>current()?.pause()||Promise.resolve(),resume:()=>current()?.resume()||Promise.resolve(),seek:ms=>current()?.seek(ms)||Promise.resolve(),stop:()=>current()?.stop()||Promise.resolve(),close:()=>{transport?.close();native?.close();}};
  }
  getState(){const state={...this.ensure().status()};if(!this.enabled){state.managed=false;state.ready=false;}this.router.broadcastMessage('pushPlaybackEnginesState',state);return Q.resolve(state);}
  getUIConfig(){return kew(this.ui());}
  async ui(){
    const manager=this.ensure();await manager.refreshDevices();this.lastUi=Date.now();const s=manager.settings,status=manager.status();
    const options=manager.devices.map(d=>({value:d.key,label:d.label}));
    if(s.device&&!options.some(d=>d.value===s.device.key))options.push({value:s.device.key,label:s.device.label+' — недоступно'});
    const selected=section('selection','Движок и аудиовыход','saveSelection',[
      select('engine','Движок воспроизведения',s.engine,Object.entries(names).map(([value,label])=>({value,label}))),
      select('device','Аудиоустройство',s.device?.key,options),
      select('mpdMode','Обработка MPD',s.modes.mpd,modes),select('albumMode','Обработка Album Player',s.modes.album_player,modes)
    ],status.error?errors[status.error]||'Движок недоступен.':!s.managed?'Текущий вывод Volumio сохранён. Выберите устройство и нажмите «Применить».':`${names[s.engine]} · ${s.modes[s.engine]==='bypass'?'обработка отключена':'пользовательская обработка'} · ${status.ready?'профиль применён':'вывод не готов'}`);
    const mp=s.custom.mpd,ap=s.custom.album_player;
    const mpd=section('mpdCustom','Пользовательские настройки MPD','saveMpd',[
      toggle('volumeEnabled','Программная регулировка громкости',mp.volumeEnabled),input('volume','Программная громкость, %',mp.volume,0,100),
      select('resampleRate','Частота вывода',mp.resampleRate,rates),select('resampleBits','Разрядность при ресемплинге',mp.resampleBits,[16,24,32].map(value=>({value,label:value+' бит'}))),
      toggle('normalization','Нормализация громкости',mp.normalization),select('replaygain','ReplayGain',mp.replaygain,[['off','Отключён'],['track','По треку'],['album','По альбому'],['auto','Автоматически']].map(([value,label])=>({value,label}))),input('crossfade','Перекрытие треков, с',mp.crossfade,0,60)
    ],'Профиль хранится отдельно и используется только в пользовательском режиме MPD.');
    const album=section('albumCustom','Пользовательские настройки Album Player','saveAlbum',[
      toggle('volumeEnabled','Программная регулировка громкости',ap.volumeEnabled),input('volume','Программная громкость, %',ap.volume,0,100),select('resampleRate','Частота вывода',ap.resampleRate,rates),
      select('forceBits','Ограничение разрядности',ap.forceBits,[{value:0,label:'Без ограничения'},{value:16,label:'16 бит'},{value:24,label:'24 бита'}]),
      toggle('phaseInvert','Инверсия фазы',ap.phaseInvert),toggle('swapChannels','Поменять каналы местами',ap.swapChannels),toggle('downmix','Сведение многоканального звука',ap.downmix),
      toggle('convolverEnabled','Конвольвер',ap.convolverEnabled),input('convolverFilter','Номер фильтра конвольвера',ap.convolverFilter,0,99),input('convolverGain','Усиление конвольвера, дБ',ap.convolverGain,-60,60,0.5),
      select('dsdMode','Вывод DSD в пользовательском режиме',ap.dsdMode,[{value:0,label:'PCM'},{value:1,label:'DoP'},{value:2,label:'Native DSD'}])
    ],'Профиль хранится отдельно. Форматы DSD требуют поддержки аудиоустройства.');
    selected.content.push({id:'refreshDevices',element:'button',label:'Обновить устройства',onClick:{type:'emit',message:'callMethod',data:{endpoint:ENDPOINT,method:'refreshDevices',data:{}}}});
    const actual={id:'actualOutput',element:'section',label:'Фактический аудиовывод',description:actualOutput(status),content:[{id:'inspectOutput',element:'button',label:'Проверить тракт',onClick:{type:'emit',message:'callMethod',data:{endpoint:ENDPOINT,method:'refreshDevices',data:{}}}}]};
    return{page:{label:'Движки воспроизведения'},sections:[selected,actual,{id:'notice',element:'section',label:'Без обработки',description:'Переключение останавливает воспроизведение. Аппаратная громкость не меняется. Отключение программного ослабления может увеличить уровень сигнала. Совпадение настроек не является проверкой bit-perfect.',content:[]},mpd,album]};
  }
  async refresh(){const ui=await this.ui();this.router.broadcastMessage('pushUiConfig',ui);return ui;}
  refreshDevices(){return kew(this.refresh());}
  async save(operation){try{if(!this.enabled)throw Object.assign(Error(),{code:'PLUGIN_DISABLED'});const bypassWarning=await operation();if(bypassWarning)this.router.pushToastMessage('warning','Всё отключено — проверьте громкость','Перед запуском музыки убавьте громкость на ЦАПе или усилителе. Программное ослабление отключено: звук может стать значительно громче. Аппаратная громкость не менялась.');else this.router.pushToastMessage('success','Движки воспроизведения','Настройки применены.');}catch(e){this.router.pushToastMessage('error','Движки воспроизведения',errors[e.code]||'Не удалось применить настройки.');}return this.refresh();}
  saveSelection(data){return kew(this.save(async()=>{
    const manager=this.ensure(),next=JSON.parse(JSON.stringify(manager.settings));next.engine=unwrap(data.engine);next.managed=true;
    const device=manager.devices.find(d=>d.key===unwrap(data.device));if(!device)throw Object.assign(Error(),{code:'DEVICE_UNAVAILABLE'});next.device={key:device.key,label:device.label};
    if(data.mpdMode!==undefined)next.modes.mpd=unwrap(data.mpdMode);if(data.albumMode!==undefined)next.modes.album_player=unwrap(data.albumMode);if(data.mode!==undefined)next.modes[next.engine]=unwrap(data.mode);
    const previous=manager.settings;
    const enteringBypass=next.modes[next.engine]==='bypass'&&(!previous.managed||previous.engine!==next.engine||previous.modes[previous.engine]!=='bypass'||previous.device?.key!==next.device.key);
    await manager.apply(next);
    return enteringBypass;
  }));}
  saveCustom(engine,data){return kew(this.save(async()=>{
    const manager=this.ensure(),next=JSON.parse(JSON.stringify(manager.settings));const profile=next.custom[engine];
    for(const key of Object.keys(profile))if(data[key]!==undefined){const value=unwrap(data[key]);profile[key]=typeof profile[key]==='number'?Number(value):value;}
    await manager.apply(next);
  }));}
  saveMpd(data){return this.saveCustom('mpd',data);}
  saveAlbum(data){return this.saveCustom('album_player',data);}
}
module.exports=ControllerPlaybackEngines;
