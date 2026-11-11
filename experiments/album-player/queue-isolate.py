import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

root = Path('/tmp/albumplayer-transport-test')
if '--inside' not in sys.argv:
    os.execvp('unshare', ['unshare', '--mount', '--propagation', 'private', '--fork', 'python3', __file__, '--inside'])
if os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt'):
    raise SystemExit('A private mount namespace is required')
for port in (7778, 7779):
    if socket.socket().connect_ex(('127.0.0.1', port)) == 0:
        raise SystemExit('Test player port is already occupied')
asound = root/'asound.conf'; asound.write_text('pcm.!default { type null }\nctl.!default { type hw card 99 }\n')
queue = root/'queue'; queue.write_text('[]')
os.chown(queue, 1000, 1000)
subprocess.run(['mount', '--bind', str(asound), '/etc/asound.conf'], check=True)
subprocess.run(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', '/dev/snd'], check=True)
subprocess.run(['mount', '--bind', str(queue), '/data/queue'], check=True)
os.setgroups([]); os.setgid(1000); os.setuid(1000)
process = None
try:
    with (root/'renderer.log').open('wb') as log:
        process = subprocess.Popen(['./ap2renderer'], cwd=root/'aprenderer', stdout=log, stderr=log)
    for _ in range(100):
        try:
            with urllib.request.urlopen('http://127.0.0.1:7779/?GetConfig', timeout=1) as response:
                config = json.load(response)
            break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError('Renderer did not start')
    ports = set()
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if (proc/'comm').read_text().strip() != 'ap2renderer' or str((proc/'cwd').resolve()) != str(root/'aprenderer'):
                continue
            inodes = set()
            for fd in (proc/'fd').iterdir():
                try:
                    link = os.readlink(fd)
                    if link.startswith('socket:['): inodes.add(link[8:-1])
                except OSError: pass
            for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
                fields = line.split()
                if fields[3] == '0A' and fields[9] in inodes: ports.add(int(fields[1].split(':')[1], 16))
        except OSError: pass
    control = None
    ns = {'d': 'urn:schemas-upnp-org:device-1-0'}
    from urllib.parse import urljoin
    for port in ports - {7779}:
        for resource in ['/description.xml', '/', '/DeviceDescription.xml', '/rootDesc.xml']:
            try:
                url = 'http://127.0.0.1:' + str(port) + resource
                with urllib.request.urlopen(url, timeout=2) as response: tree = ET.fromstring(response.read())
                for service in tree.findall('.//d:service', ns):
                    if service.findtext('d:serviceType', namespaces=ns) == 'urn:schemas-upnp-org:service:AVTransport:1':
                        control = urljoin(url, service.findtext('d:controlURL', namespaces=ns))
            except (OSError, ET.ParseError): pass
            if control: break
        if control: break
    print('Renderer ports:', sorted(ports), flush=True)
    if not control: raise RuntimeError('Control endpoint not found')
    (root/'control.json').write_text(json.dumps({'controlUrl': control}))
    result = subprocess.run(['node', str(root/'acceptance.js')] + (['--smoke'] if (root/'smoke').exists() else []), cwd=root, timeout=600)
    raise SystemExit(result.returncode)
finally:
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if (proc/'comm').read_text().strip() == 'ap2renderer' and str((proc/'cwd').resolve()) == str(root/'aprenderer'):
                os.kill(int(proc.name), signal.SIGTERM)
        except OSError: pass
    if process:
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
