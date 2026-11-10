"""Run on Pi: throttle real account streams for 30 minutes, without audio output.

Reads credentials only through the authenticated local control API; prints only
resource measurements, never tokens, signed URLs, titles or account identity.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, default=1800)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600:
        parser.error('seconds must be between 1 and 3600')
    key = Path('/data/configuration/music_service/yandex_music/api-key').read_text().strip()
    base = 'http://127.0.0.1:17899'
    pid = int(subprocess.check_output(
        ['systemctl', 'show', '--value', '-p', 'MainPID', 'volumio-yandex.service']))
    ticks_per_second = os.sysconf('SC_CLK_TCK')

    def resources():
        status = Path(f'/proc/{pid}/status').read_text()
        rss = int(next(line for line in status.splitlines() if line.startswith('VmRSS:')).split()[1])
        stat = Path(f'/proc/{pid}/stat').read_text().split(')', 1)[1].split()
        cpu = (int(stat[11]) + int(stat[12])) / ticks_per_second
        return {'rss_kib': rss, 'cpu_seconds': cpu,
                'fds': len(list(Path(f'/proc/{pid}/fd').iterdir()))}

    def resolve(id_):
        request = urllib.request.Request(base + '/v1/playback/resolve',
            data=json.dumps({'track_id': id_}).encode(),
            headers={'X-API-Key': key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        return base + result['path']

    start = time.monotonic()
    baseline = resources()
    samples = []
    total = 0
    tracks = 0
    next_sample = start
    while time.monotonic() - start < args.seconds:
        url = resolve(('60426346', '330765')[tracks % 2])
        with urllib.request.urlopen(url, timeout=30) as response:
            tracks += 1
            while time.monotonic() - start < args.seconds:
                chunk = response.read(16384)
                if not chunk:
                    break
                total += len(chunk)
                now = time.monotonic()
                if now >= next_sample:
                    sample = {'elapsed': round(now - start), 'bytes': total, **resources()}
                    samples.append(sample)
                    print(json.dumps(sample), flush=True)
                    next_sample = now + 60
                # 320 kbps real-time consumption, bounded client buffer.
                time.sleep(min(len(chunk) / 40000, max(0, args.seconds - (time.monotonic() - start))))
    final = resources()
    print(json.dumps({'complete': True, 'duration_seconds': round(time.monotonic() - start),
        'tracks': tracks, 'bytes': total, 'rss_min_kib': min(s['rss_kib'] for s in samples),
        'rss_max_kib': max(s['rss_kib'] for s in samples), 'rss_final_kib': final['rss_kib'],
        'fds_initial': baseline['fds'], 'fds_final': final['fds'],
        'cpu_seconds': round(final['cpu_seconds'] - baseline['cpu_seconds'], 2)}), flush=True)


if __name__ == '__main__':
    main()
