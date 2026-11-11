import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from urllib.parse import quote
from xml.sax.saxutils import escape

root=Path('/tmp/albumplayer-research')
from common import mpd_snapshot
os.umask(0o077)
os.chdir(root/'aprenderer')
summary={'before':mpd_snapshot(),'output':'ALSA null; hardware devices hidden'}
process=None
control=None
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:7779/'+path,timeout=5) as r:
        raw=r.read()
        try:return json.loads(raw)
        except ValueError:return {'http_status':r.status}

def soap(action, **args):
    service='urn:schemas-upnp-org:service:AVTransport:1'
    payload=('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
        +'<u:'+action+' xmlns:u="'+service+'">'
        +''.join('<'+k+'>'+escape(str(v))+'</'+k+'>' for k,v in args.items())
        +'</u:'+action+'></s:Body></s:Envelope>').encode()
    request=urllib.request.Request(control,data=payload,headers={'Content-Type':'text/xml; charset="utf-8"','SOAPACTION':'"'+service+'#'+action+'"'})
    try:
        with urllib.request.urlopen(request,timeout=15) as r:tree=ET.fromstring(r.read())
    except urllib.error.HTTPError as e:tree=ET.fromstring(e.read())
    return {e.tag.split('}')[-1]:e.text for e in tree.iter() if len(e)==0}

def clean(state):
    return {k:v for k,v in state.items() if k in ['RelTime','TrackDuration','CurrentTransportState','CurrentTransportStatus','errorCode','errorDescription','stat_source','stat_output']}

try:
    with open(root/'renderer.log','wb') as log:process=subprocess.Popen(['strace','-f','-o',str(root/'renderer-network.trace'),'-e','trace=network','-s','2048','./ap2renderer'],stdout=log,stderr=log)
    for _ in range(100):
        try:config=get('?GetConfig');break
        except Exception:time.sleep(.1)
    else:raise RuntimeError('renderer_api_not_ready')
    summary['config_keys']=sorted(config)
    def setconfig(value):
        allowed=list(dict.fromkeys(re.findall(r"arr\['([^']+)'\]",(root/'aprenderer/renderer.js').read_text())))
        payload={k:value.get(k,0) for k in allowed}
        request=urllib.request.Request('http://127.0.0.1:7779/SetConfig',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=5) as response:reply=response.read()
        for _ in range(40):
            got=get('?GetConfig')
            if all(got.get(k)==value.get(k) for k in ['res44','volume_enabled']):break
            time.sleep(.05)
        return {'status':response.status,'response':reply.decode(errors='replace')[:80]}
    bypass={k:False for k in ['volume_enabled','hw_volume','use_conv','mode_16bit','mode_24bit','phase_mode','swap_mode','multi_mode'] if k in config}
    bypass.update({k:0 for k in ['enable_dsd','res_bf44','res44','res48','res88','res96','res176','res192','res352','res384'] if k in config})
    custom=dict(config);custom.update(res44=2,volume_enabled=True,need_down=0);summary['custom_set_response']=setconfig(custom)
    summary['custom_readback']={k:get('?GetConfig').get(k) for k in ['res44','volume_enabled']}
    disabled=dict(custom);disabled.update(bypass);setconfig(disabled)
    got=get('?GetConfig');summary['bypass_readback_matches']=all(got.get(k)==v for k,v in bypass.items());summary['bypass_mismatches']={k:{'expected':v,'actual':got.get(k)} for k,v in bypass.items() if got.get(k)!=v}
    setconfig(custom);got=get('?GetConfig');summary['custom_restored']=all(got.get(k)==custom.get(k) for k in bypass)
    setconfig(disabled)
    ports=set()
    for p in Path('/proc').glob('[0-9]*'):
        try:
            if (p/'comm').read_text().strip()!='ap2renderer' or str((p/'cwd').resolve())!=str(root/'aprenderer'):continue
            inodes={os.readlink(f).split('[')[1].rstrip(']') for f in (p/'fd').iterdir() if os.readlink(f).startswith('socket:[')}
            for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
                f=line.split()
                if f[3]=='0A' and f[9] in inodes:ports.add(int(f[1].split(':')[1],16))
        except OSError:pass
    summary['renderer_ports']=sorted(ports)
    description=None
    for port in ports:
        if port==7779:continue
        for path in ['/description.xml','/','/DeviceDescription.xml','/rootDesc.xml']:
            try:
                with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=2) as r:tree=ET.fromstring(r.read())
                ns={'d':'urn:schemas-upnp-org:device-1-0'}
                for service in tree.findall('.//d:service',ns):
                    if service.findtext('d:serviceType',namespaces=ns)=='urn:schemas-upnp-org:service:AVTransport:1':
                        from urllib.parse import urljoin
                        control=urljoin('http://127.0.0.1:'+str(port)+path,service.findtext('d:controlURL',namespaces=ns));description=tree
                if control:break
            except (OSError,ET.ParseError):pass
        if control:break
    if not control:raise RuntimeError('avtransport_control_not_found')
    key=Path('/data/configuration/music_service/qobuz_custom/api-key').read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:17901/v1/playback/resolve',data=json.dumps({'track_id':'8767428','quality':'27'}).encode(),headers={'X-API-Key':key,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=65) as r:resolved=json.load(r)
    url='http://127.0.0.1:17901'+resolved['path']+'?format=.flac'
    metadata='<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="research" parentID="0" restricted="1"><dc:title>Research Stream</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:audio/flac:*" duration="00:04:07.632">'+escape(url)+'</res></item></DIDL-Lite>'
    summary['set_uri']=clean(soap('SetAVTransportURI',InstanceID=0,CurrentURI=url,CurrentURIMetaData=metadata))
    summary['play']=clean(soap('Play',InstanceID=0,Speed=1))
    for _ in range(150):
        config=get('?GetConfig')
        if '44.1' in config.get('stat_output',''):break
        time.sleep(.1)
    summary['formats']=clean(config)
    position=soap('GetPositionInfo',InstanceID=0);summary['position']=clean(position);summary['position_uri_present']=bool(position.get('TrackURI'))
    summary['pause_result']=clean(soap('Pause',InstanceID=0))
    summary['paused']=clean(soap('GetTransportInfo',InstanceID=0))
    summary['paused_position']=clean(soap('GetPositionInfo',InstanceID=0))
    summary['seek_result']=clean(soap('Seek',InstanceID=0,Unit='REL_TIME',Target='00:00:30'))
    summary['after_seek']=clean(soap('GetPositionInfo',InstanceID=0))
    summary['resume_result']=clean(soap('Play',InstanceID=0,Speed=1))
    time.sleep(.3)
    summary['resumed']=clean(soap('GetTransportInfo',InstanceID=0))
    summary['resumed_position']=clean(soap('GetPositionInfo',InstanceID=0))
    search_request=urllib.request.Request('http://127.0.0.1:17901/v1/search?q='+quote('Give Life Back to Music')+'&type=track',headers={'X-API-Key':key})
    with urllib.request.urlopen(search_request,timeout=30) as response:items=json.load(response)['items']
    track=next(t for t in items if t.get('available') and t['id']!='8767428')
    summary['next_track']={k:track.get(k) for k in ['id','title','duration_ms']}
    request=urllib.request.Request('http://127.0.0.1:17901/v1/playback/resolve',data=json.dumps({'track_id':track['id'],'quality':'27'}).encode(),headers={'X-API-Key':key,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=65) as response:next_resolved=json.load(response)
    next_url='http://127.0.0.1:17901'+next_resolved['path']+'?format=.flac'
    next_metadata=metadata.replace(escape(url),escape(next_url)).replace('Research Stream','Research Next').replace('00:04:07.632',time.strftime('%H:%M:%S',time.gmtime(track['duration_ms']/1000)))
    summary['set_next_result']=clean(soap('SetNextAVTransportURI',InstanceID=0,NextURI=next_url,NextURIMetaData=next_metadata))
    next_path=next_resolved['path']
    def next_request_count():
        return (root/'renderer-network.trace').read_text(errors='replace').count('GET '+next_path)
    before_next_requests=next_request_count()
    summary['next_result']=clean(soap('Next',InstanceID=0))
    for _ in range(60):
        position=soap('GetPositionInfo',InstanceID=0)
        media=soap('GetMediaInfo',InstanceID=0)
        if '88.2' in get('?GetConfig').get('stat_source',''):break
        time.sleep(.1)
    summary['manual_next_uri_matches']=media.get('CurrentURI')==next_url
    summary['manual_next_media_uri_present']=bool(media.get('CurrentURI'))
    summary['manual_next_metadata_matches']='Research Next' in media.get('CurrentURIMetaData','')
    summary['after_next']=clean(position)
    summary['manual_next_formats']=clean(get('?GetConfig'))
    summary['manual_next_requested_second_stream']=next_request_count()>before_next_requests
    summary['manual_next_transport']=clean(soap('GetTransportInfo',InstanceID=0))
    explicit_baseline=next_request_count()
    summary['explicit_stop']=clean(soap('Stop',InstanceID=0))
    summary['explicit_set_uri']=clean(soap('SetAVTransportURI',InstanceID=0,CurrentURI=next_url,CurrentURIMetaData=next_metadata))
    summary['explicit_play']=clean(soap('Play',InstanceID=0,Speed=1))
    for _ in range(100):
        config=get('?GetConfig')
        if '88.2' in config.get('stat_source','') and config.get('stat_playing'):break
        time.sleep(.1)
    summary['explicit_formats']=clean(config)
    summary['explicit_requested_second_stream']=next_request_count()>explicit_baseline
    summary['explicit_state']=clean(soap('GetTransportInfo',InstanceID=0))
    summary['explicit_position']=clean(soap('GetPositionInfo',InstanceID=0))
    soap('Stop',InstanceID=0)
    soap('SetAVTransportURI',InstanceID=0,CurrentURI=url,CurrentURIMetaData=metadata)
    soap('Play',InstanceID=0,Speed=1)
    for _ in range(100):
        if '44.1' in get('?GetConfig').get('stat_output',''):break
        time.sleep(.1)
    summary['automatic_set_next']=clean(soap('SetNextAVTransportURI',InstanceID=0,NextURI=next_url,NextURIMetaData=next_metadata))
    before_auto_requests=next_request_count()
    summary['seek_near_end']=clean(soap('Seek',InstanceID=0,Unit='REL_TIME',Target='00:04:05'))
    for _ in range(150):
        position=soap('GetPositionInfo',InstanceID=0)
        media=soap('GetMediaInfo',InstanceID=0)
        if '88.2' in get('?GetConfig').get('stat_source',''):break
        time.sleep(.1)
    summary['automatic_next_uri_matches']=media.get('CurrentURI')==next_url
    summary['automatic_next_metadata_matches']='Research Next' in media.get('CurrentURIMetaData','')
    summary['automatic_next_position']=clean(position)
    summary['automatic_next_formats']=clean(get('?GetConfig'))
    summary['automatic_next_requested_second_stream']=next_request_count()>before_auto_requests
    summary['automatic_next_state']=clean(soap('GetTransportInfo',InstanceID=0))
except Exception as e:
    summary['error_type']=type(e).__name__
    if isinstance(e,RuntimeError):summary['error']=str(e)
finally:
    if control:
        try:soap('Stop',InstanceID=0)
        except Exception:pass
    for p in Path('/proc').glob('[0-9]*'):
        try:
            if (p/'comm').read_text().strip()=='ap2renderer' and str((p/'cwd').resolve())==str(root/'aprenderer'):os.kill(int(p.name),15)
        except OSError:pass
    if process:
        try:process.wait(timeout=3)
        except subprocess.TimeoutExpired:process.kill();process.wait()
    if (root/'renderer-network.trace').exists():summary['http_range_offsets']=re.findall(r'Range: bytes=([0-9-]+)',(root/'renderer-network.trace').read_text(errors='replace'))
    summary['after']=mpd_snapshot();summary['queue_unchanged']=summary['before']==summary['after']
    (root/'renderer-summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False))
    print(json.dumps({k:v for k,v in summary.items() if k!='config_keys'},indent=2,ensure_ascii=False))
