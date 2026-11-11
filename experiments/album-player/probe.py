import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

os.umask(0o077)
root = Path('/tmp/albumplayer-research')
os.chdir(root / 'aplayer')

from common import mpd_snapshot

def req(query, data=None):
    r=urllib.request.Request('http://127.0.0.1:7778/'+query,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(r, timeout=15) as response:
        raw=response.read()
        try: return json.loads(raw)
        except ValueError: return {'http_status':response.status,'body_bytes':len(raw)}

summary={'before':mpd_snapshot(),'output':'ALSA null; /dev/snd hidden in private mount namespace'}
process=None
music=root/'music';music.mkdir(exist_ok=True)
local=next(Path('/media/External_HD/qobuz').rglob('*.flac'),None)
if local and not (music/'local.flac').exists(): (music/'local.flac').symlink_to(local)
try:
    key=Path('/data/configuration/music_service/qobuz_custom/api-key').read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:17901/v1/playback/resolve',data=json.dumps({'track_id':'8767428','quality':'27'}).encode(),headers={'X-API-Key':key,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=65) as response: resolved=json.load(response)
    url='http://127.0.0.1:17901'+resolved['path']+'?format=.flac'
    (music/'stream.m3u').write_text('#EXTM3U\n#EXTINF:247,Test Stream\n'+url+'\n')
    summary['resolved_format']={k:resolved.get(k) for k in ['codec','sampleRate','bitDepth']}
except Exception as error: summary['resolve_error_type']=type(error).__name__;url=None
try:
    with open(root/'player.log','wb') as log:
        process=subprocess.Popen(['./aplayer'],stdout=log,stderr=log)
    for _ in range(60):
        try: config=req('?GetConfig'); break
        except Exception:
            if process.poll() not in (None,0): raise RuntimeError('player_exited')
            time.sleep(.1)
    else: raise RuntimeError('api_not_ready')
    summary['version_date']=(root/'aplayer/date.html').read_text().strip()
    summary['initial_config']={k:config.get(k) for k in ['di_mode','gapless_mode','volume_enabled','hw_volume','use_conv','enable_dsd','res44','res48','stat_source','stat_output']}
    config['root_folder']='tmp/albumplayer-research'
    config.update(volume_enabled=False,hw_volume=False,use_conv=False,enable_dsd=0,mode_16bit=False,mode_24bit=False,phase_mode=False,swap_mode=False,multi_mode=False)
    for k in ['res44','res48','res88','res96','res176','res192','res352','res384']: config[k]=0
    summary['set_config_response']=req('SetConfig',config)
    summary['root_folder_after']=req('?GetConfig').get('root_folder')
    bypass={k:False for k in ['volume_enabled','hw_volume','use_conv','mode_16bit','mode_24bit','phase_mode','swap_mode','multi_mode']}
    bypass.update({k:0 for k in ['enable_dsd','res_bf44','res44','res48','res88','res96','res176','res192','res352','res384']})
    custom=dict(config);custom.update(res44=2,volume_enabled=True)
    req('SetConfig',custom)
    summary['custom_readback']={k:req('?GetConfig').get(k) for k in ['res44','volume_enabled']}
    disabled=dict(custom);disabled.update(bypass)
    req('SetConfig',disabled)
    got=req('?GetConfig')
    summary['bypass_readback_matches']=all(got.get(k)==v for k,v in bypass.items())
    req('SetConfig',custom)
    got=req('?GetConfig')
    summary['custom_restored']=all(got.get(k)==custom.get(k) for k in bypass)
    req('SetConfig',disabled)
    if req('?State').get('RadioMode'):req('?RadioMode')
    folders=req('?GetPlaylists&ind=-1')
    for target in ['/tmp','/tmp/albumplayer-research']:
        entries=folders.get('Drives',[])
        idx=next((i for i,e in enumerate(entries) if e.get('path')==target and not e.get('expanded')),None)
        if idx is not None: folders=req('?GetPlaylists&ind='+str(idx))
    entries=folders.get('Drives',[])
    summary['folder_paths']=[e.get('path') for e in entries if '/tmp/albumplayer' in e.get('path','')]
    idx=next((i for i,e in enumerate(entries) if e.get('path')==str(music)),None)
    if idx is not None:
        req('?GetPlaylist&playlist='+str(idx))
        for _ in range(60):
            if not req('?State').get('Scanning'):break
            time.sleep(.1)
        albums=req('?GetAlbums')
        summary['loaded_albums']={k:albums.get(k) for k in ['Albums','Songs']}
    if url:
        req('?AddStation',{'url':url,'name':'Research Stream','folder':'Research'})
        if not req('?State').get('RadioMode'):req('?RadioMode')
        albums=req('?GetAlbums')
        summary['radio_album_count']=len(albums.get('Albums',[]))
        index=next((i for i,a in enumerate(albums.get('Albums',[])) if 'Research' in a),None)
        if index is not None:
            req('?Play&album='+str(index)+'&song=0')
            for _ in range(200):
                state=req('?State')
                if state.get('Freq',0)>0 or state.get('LastError'):break
                time.sleep(.1)
            summary['stream_state']={k:state.get(k) for k in ['Playing','Paused','Freq','Bps','Ch','Position','PlayingLen','ProgressVisible','LastError']}
            summary['stream_output']={k:req('?GetConfig').get(k) for k in ['stat_source','stat_output']}
            req('?Pause');time.sleep(.2)
            summary['pause_state']={k:req('?State').get(k) for k in ['Playing','Paused','Position','LastError']}
            req('?Pause');req('?Position&pos=20');time.sleep(.2)
            summary['seek_state']={k:req('?State').get(k) for k in ['Playing','Paused','Position','PlayingLen','LastError']}
            req('?Stop')
    summary['state']={k:req('?State').get(k) for k in ['Playing','Paused','LastError']}
except Exception as error:
    summary['exit_code']=process.poll() if process else None
    summary['error_type']=type(error).__name__
    if isinstance(error,RuntimeError):summary['error']=str(error)
finally:
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if (proc/'comm').read_text().strip()=='aplayer' and str((proc/'cwd').resolve())==str(root/'aplayer'):
                os.kill(int(proc.name),15)
        except OSError:pass
    if process and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=4)
        except subprocess.TimeoutExpired: process.kill();process.wait()
    summary['after']=mpd_snapshot()
    summary['queue_unchanged']=summary['before']==summary['after']
    (root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print(json.dumps(summary,ensure_ascii=False,indent=2))
