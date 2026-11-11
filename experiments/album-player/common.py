"""Read-only MPD observations; importing this module starts no players."""
import hashlib
import socket

def mpd_snapshot():
    with socket.create_connection(('127.0.0.1', 6600), timeout=5) as s:
        f = s.makefile('rwb'); f.readline()
        def command(text):
            f.write((text+'\n').encode()); f.flush(); lines=[]
            while True:
                line=f.readline()
                if line == b'OK\n': return lines
                if not line or line.startswith(b'ACK'): raise RuntimeError('mpd_snapshot_failed')
                lines.append(line)
        queue = hashlib.sha256(b''.join(command('playlistinfo'))).hexdigest()
        status = {}
        for line in command('status'):
            k, _, v = line.decode().strip().partition(': ')
            if k in ['state','song','songid','elapsed','volume','playlist','playlistlength']:
                status[k]=v
        return {'queue_sha256':queue,'status':status}
