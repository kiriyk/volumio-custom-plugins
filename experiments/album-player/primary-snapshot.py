import hashlib
import json
from pathlib import Path
import socket
import sys

with socket.create_connection(('127.0.0.1', 6600), timeout=5) as c:
    f=c.makefile('rwb');f.readline()
    def read(command):
        f.write((command+'\n').encode());f.flush();lines=[]
        while True:
            line=f.readline()
            if line==b'OK\n':return lines
            if not line or line.startswith(b'ACK'):raise RuntimeError('mpd_read_failed')
            lines.append(line)
    digest=hashlib.sha256(b''.join(read('playlistinfo'))).hexdigest()
    status={}
    for line in read('status'):
        k, _, v=line.decode().strip().partition(': ')
        if k in ['state','elapsed','volume','song','songid','playlist','playlistlength']:status[k]=v
result={'mpd_queue':digest,'mpd_status':status,
        'volumio_queue':hashlib.sha256(Path('/data/queue').read_bytes()).hexdigest(),
        'asound':hashlib.sha256(Path('/etc/asound.conf').read_bytes()).hexdigest()}
Path(sys.argv[1]).write_text(json.dumps(result,indent=2))
print(json.dumps(result))
