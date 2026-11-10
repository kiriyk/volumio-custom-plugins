#!/usr/bin/env python3
"""One-track API/transport probe. Prints no session or signed URL."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
BASE = 'https://www.qobuz.com/api.json/0.2'


def save(name, value):
    path = ROOT / name
    with open(path, 'w') as file:
        os.chmod(path, 0o600)
        json.dump(value, file)


def main():
    os.umask(0o077)
    requested_format = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    if requested_format not in (6, 7, 27):
        raise ValueError('supported_formats_6_7_27')
    if not (ROOT / 'session.json').exists():
        print('Waiting for browser authorization')
        return
    settings = json.loads((ROOT / 'parameters.json').read_text())
    session = json.loads((ROOT / 'session.json').read_text())
    summary = {'phase': 'catalog', 'authorized': True, 'requested_format': requested_format}

    def api(path, params):
        url = BASE + path + '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            'X-App-Id': settings['app_id'],
            'X-User-Auth-Token': session['token'],
            'User-Agent': 'Mozilla/5.0',
        })
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)

    try:
        catalog = api('/catalog/search', {'query': 'Daft Punk Get Lucky', 'limit': 5})
        items = (catalog.get('tracks') or {}).get('items') or []
        track = next((x for x in items if x.get('streamable')), None)
        if not track:
            summary.update(phase='no_streamable_search_result')
            return
        summary.update(track_id=track['id'], title=track.get('title'),
                       catalog_duration=track.get('duration'))
        summary['phase'] = 'resolve'
        stream = None
        attempts = []
        for secret in settings['stream_candidates']:
            ts = str(time.time())
            text = 'trackgetFileUrlformat_id' + str(requested_format) + 'intentstreamtrack_id' + str(track['id']) + ts + secret
            params = {'track_id': track['id'], 'format_id': requested_format, 'intent': 'stream',
                      'request_ts': ts, 'request_sig': hashlib.md5(text.encode('ascii')).hexdigest()}
            try:
                stream = api('/track/getFileUrl', params)
                if stream.get('url'):
                    break
                stream = None
                attempts.append('no_url')
            except urllib.error.HTTPError as exc:
                attempts.append(exc.code)
                if exc.code in (401, 410, 429):
                    break
        summary['resolve_attempts'] = attempts
        if not stream:
            summary.update(phase='resolve_failed')
            return
        save('stream.json', stream)
        if requested_format in (7, 27):
            save('stream-hires.json', stream)
        summary.update(phase='transport', returned_format=stream.get('format_id'),
                       mime_type=stream.get('mime_type'), stream_duration=stream.get('duration'),
                       bit_depth=stream.get('bit_depth'), sampling_rate=stream.get('sampling_rate'),
                       sample=stream.get('sample'))
        req = urllib.request.Request(stream['url'], headers={'Range': 'bytes=0-65535'})
        with urllib.request.urlopen(req, timeout=25) as response:
            summary.update(http_status=response.status,
                           content_type=response.headers.get('Content-Type'),
                           content_range=response.headers.get('Content-Range'))
            sample = response.read(65536)
        path = ROOT / 'sample.bin'
        path.write_bytes(sample)
        summary['flac_magic'] = sample.startswith(b'fLaC')
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
            'stream=codec_name,sample_rate,bits_per_raw_sample,channels', '-of', 'json', str(path)],
            capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            summary['measured_streams'] = json.loads(result.stdout).get('streams')
        else:
            summary['ffprobe_exit'] = result.returncode
        summary['phase'] = 'transport_checked'
    except Exception as exc:
        summary['error_type'] = type(exc).__name__
        if isinstance(exc, urllib.error.HTTPError):
            summary['http_status'] = exc.code
    finally:
        save('probe-result.json', summary)
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
