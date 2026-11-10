#!/usr/bin/env python3
"""Isolated MPD decode/control test; no ALSA output or Volumio queue."""
import json
import os
import pathlib
import socket
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent


def main():
    os.umask(0o077)
    root = ROOT / 'test-mpd'
    root.mkdir(exist_ok=True, mode=0o700)
    (root / 'music').mkdir(exist_ok=True)
    (root / 'playlists').mkdir(exist_ok=True)
    config = '\n'.join([
        f'music_directory "{root}/music"', f'playlist_directory "{root}/playlists"',
        f'db_file "{root}/database"', f'log_file "{root}/mpd.log"',
        f'pid_file "{root}/mpd.pid"', 'bind_to_address "127.0.0.1"',
        'port "16601"', 'log_level "error"',
        'audio_output {', ' type "null"', ' name "Research controls"', ' sync "yes"', '}',
        'audio_output {', ' type "null"', ' name "Research full decode"', ' sync "no"', '}',
    ])
    (root / 'mpd.conf').write_text(config + '\n')
    stream = json.loads((ROOT / 'stream-hires.json').read_text())
    url = stream['url']
    if any(c in url for c in '\r\n'):
        raise ValueError('invalid_url')
    quoted = url.replace('\\', '\\\\').replace('"', '\\"')
    summary = {'isolated_port': 16601, 'output': 'null', 'duration': stream.get('duration')}
    process = None
    connection = None
    with open(root / 'process.log', 'ab') as log:
        try:
            process = subprocess.Popen(['mpd', '--no-daemon', str(root / 'mpd.conf')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            for attempt in range(30):
                try:
                    connection = socket.create_connection(('127.0.0.1', 16601), timeout=5)
                    break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError('test_mpd_start_failed')
                    time.sleep(.1)
            if connection is None:
                raise RuntimeError('test_mpd_unreachable')
            file = connection.makefile('rwb')
            if not file.readline().startswith(b'OK MPD'):
                raise RuntimeError('invalid_mpd_greeting')

            def command(text):
                file.write((text + '\n').encode()); file.flush()
                result = {}
                while True:
                    line = file.readline()
                    if line == b'OK\n':
                        break
                    if not line or line.startswith(b'ACK'):
                        raise RuntimeError('test_mpd_command_failed')
                    key, sep, value = line.decode().strip().partition(': ')
                    if sep:
                        result[key] = value
                if 'error' in result:
                    raise RuntimeError('test_mpd_playback_failed')
                return result

            command('disableoutput 1')
            command('add "' + quoted + '"')
            command('play 0')
            for _ in range(50):
                status = command('status')
                if status.get('audio'):
                    break
                time.sleep(.2)
            if status.get('state') != 'play' or not status.get('audio'):
                raise RuntimeError('test_mpd_no_audio')
            summary['audio'] = status['audio']
            command('pause 1')
            if command('status').get('state') != 'pause':
                raise RuntimeError('pause_failed')
            command('pause 0')
            if command('status').get('state') != 'play':
                raise RuntimeError('resume_failed')
            command('seekcur 30')
            time.sleep(.3)
            status = command('status')
            if float(status.get('elapsed', 0)) < 29:
                raise RuntimeError('seek_failed')
            summary.update(pause=True, resume=True, seek_elapsed=status['elapsed'])
            command('stop'); command('clear')
            command('disableoutput 0'); command('enableoutput 1')
            command('add "' + quoted + '"'); command('play 0')
            start = time.monotonic()
            seen_playing = False
            while time.monotonic() - start < 90:
                status = command('status')
                seen_playing = seen_playing or status.get('state') == 'play'
                if status.get('state') == 'stop' and seen_playing:
                    summary.update(full_decode=True, decode_wall_seconds=round(time.monotonic()-start, 2))
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('full_decode_timeout')
            summary['mpd_playtime'] = command('stats').get('playtime')
        except Exception as error:
            summary['error_type'] = type(error).__name__
            if isinstance(error, RuntimeError):
                summary['stage'] = str(error)
        finally:
            if connection:
                connection.close()
            if process:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
    (ROOT / 'mpd-result.json').write_text(json.dumps(summary))
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
