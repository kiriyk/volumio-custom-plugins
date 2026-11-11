"""Disposable Album Player probe: private mounts, null output, no real audio devices."""
import os
from pathlib import Path
import subprocess
import sys

root = Path('/tmp/albumplayer-research')
probe = sys.argv[-1] if len(sys.argv) > 1 else 'probe.py'
if probe not in {'probe.py', 'renderer-probe.py'}:
    raise SystemExit('Choose probe.py or renderer-probe.py')
if '--inside' not in sys.argv:
    os.execvp('unshare', ['unshare', '--mount', '--propagation', 'private', '--fork',
                         '/usr/bin/python3', str(Path(__file__).resolve()), '--inside', probe])
if os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt'):
    raise SystemExit('Refusing to mount inside the host mount namespace')
conf = root / 'asound-test.conf'
conf.write_text('pcm.!default { type null }\nctl.!default { type hw card 99 }\n')
subprocess.run(['mount', '--bind', str(conf), '/etc/asound.conf'], check=True)
subprocess.run(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', '/dev/snd'], check=True)
os.setgroups([])
os.setgid(1000)
os.setuid(1000)
os.execv('/usr/bin/python3', ['python3', str(root / probe)])
