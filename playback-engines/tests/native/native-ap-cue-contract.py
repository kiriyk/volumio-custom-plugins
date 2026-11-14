#!/usr/bin/env python3
"""Opt-in hardware contract probe. Never use a production aplayer PID.

Requires a separately launched, isolated ARM32 aplayer and the generated 30s
FLAC/CUE fixture described in docs/testing/native-ap-cue-contract.md.
Exit 0 = PCM selection matches, 1 = contract mismatch, 2 = invalid environment.
"""
import argparse
import array
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request


def owned_endpoint(pid, executable, url, start_time=None):
    """Check identity and socket ownership before every HTTP command."""
    process = Path('/proc') / str(pid)
    executable = Path(executable).resolve(strict=True)
    cwd = (process / 'cwd').resolve(strict=True)
    if not cwd.is_relative_to('/tmp') or executable != cwd / 'aplayer':
        raise ValueError('Only a private /tmp/.../aplayer is allowed')
    if process.stat().st_uid != os.getuid() or (process / 'exe').resolve() != executable:
        raise ValueError('Foreign or unknown PID')
    stamp = (process / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    if start_time is not None and stamp != start_time:
        raise ValueError('PID was reused')
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment) != (
            'http', '127.0.0.1:7778', '', '', ''):
        raise ValueError('Only the explicit local API http://127.0.0.1:7778 is allowed')
    inodes = set()
    for fd in (process / 'fd').iterdir():
        try:
            match = re.fullmatch(r'socket:\[([0-9]+)\]', str(fd.readlink()))
            if match:
                inodes.add(match[1])
        except OSError:
            pass
    owned = False
    for table in ('tcp', 'tcp6'):
        for line in (process / 'net' / table).read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) > 9 and fields[3] == '0A' and fields[9] in inodes:
                owned |= fields[1] in ('00000000:1E62', '0100007F:1E62')
    if not owned:
        raise ValueError('PID does not own the API listener')
    env = dict(item.split(b'=', 1) for item in (process / 'environ').read_bytes().split(b'\0') if b'=' in item)
    config = Path(os.fsdecode(env.get(b'ALSA_CONFIG_PATH', b''))).resolve(strict=True)
    if not config.is_relative_to(cwd.parent):
        raise ValueError('ALSA config is not private')
    expected = 'pcm.!default { type hw card "NativeCueTest" device 0 } ctl.!default { type hw card "NativeCueTest" }'
    if ' '.join(config.read_text().split()) != expected:
        raise ValueError('ALSA default is not the isolated NativeCueTest loopback')
    if Path('/proc/asound/NativeCueTest').resolve().name != 'card7':
        raise ValueError('Expected NativeCueTest at card7; refusing other output')
    return stamp, cwd


def read_ap3(data):
    """Research-only decoder of one native export, not a supported queue API."""
    if data[:4] != b'AP3\0':
        raise ValueError('Unknown saved playlist format')
    pos = 4

    def number():
        nonlocal pos
        value = struct.unpack_from('<I', data, pos)[0]
        pos += 4
        if value > 1000000:
            raise ValueError('Unexpected AP3 count/length')
        return value

    def strings():
        nonlocal pos
        result = []
        for _ in range(number()):
            size = number()
            result.append(data[pos:pos + size].decode('utf-8'))
            pos += size
        return result

    headers = [strings() for _ in range(6)]
    names = [strings() for _ in range(number())]
    paths = [strings() for _ in range(number())]
    indices = [number(), number()]
    totals = [number() for _ in range(number())]
    lengths = [[number() for _ in range(number())] for _ in range(number())]
    if pos != len(data) or len(names) != 1 or lengths != [[10000, 10000, 10000]]:
        raise ValueError('Expected the generated one-album, 3x10s fixture')
    return headers, names, paths, indices, totals, lengths


def subset_ap3(decoded, selection):
    headers, names, paths, _, _, lengths = decoded
    number = lambda value: struct.pack('<I', value)
    strings = lambda values: number(len(values)) + b''.join(number(len(s.encode())) + s.encode() for s in values)
    matrix = lambda values: number(len(values)) + b''.join(strings(row) for row in values)
    selected_names = [[names[0][i] for i in selection]]
    selected_paths = [[paths[0][i] for i in selection]]
    selected_lengths = [lengths[0][i] for i in selection]
    return (b'AP3\0' + b''.join(strings(h) for h in headers) + matrix(selected_names)
            + matrix(selected_paths) + number(0) + number(0) + number(1)
            + number(sum(selected_lengths) // 1000) + number(1)
            + number(len(selection)) + b''.join(number(n) for n in selected_lengths))


def cleanup(command, recorder, capture, created):
    try:
        if recorder is not None:
            try:
                command('Stop')
            finally:
                if recorder.poll() is None:
                    recorder.terminate()
                    try:
                        recorder.communicate(timeout=3)
                    except subprocess.TimeoutExpired:
                        recorder.kill()
                        recorder.communicate(timeout=3)
    finally:
        if capture:
            Path(capture).unlink(missing_ok=True)
        for path in created:
            path.unlink(missing_ok=True)


def main(args):
    stamp, cwd = owned_endpoint(args.pid, args.executable, args.url)
    folder = Path(args.folder).resolve(strict=True)
    if not folder.is_relative_to(cwd.parent):
        raise ValueError('Fixture folder must be inside the private sandbox')
    private_name = 'native_contract_' + str(os.getpid())
    created = [cwd / (private_name + suffix + '.ap2') for suffix in ('', '_subset')]
    if any(p.exists() for p in created):
        raise ValueError('Probe playlist already exists')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def command(query):
        owned_endpoint(args.pid, args.executable, args.url, stamp)
        with opener.open(args.url + '/?' + query, timeout=4) as response:
            return json.load(response)

    def ready():
        for _ in range(100):
            if not command('State')['Scanning'] and command('GetAlbums').get('Albums'):
                return
            time.sleep(.05)
        raise ValueError('Native scan did not finish')

    def load(name=None):
        entries = command('GetPlaylists&ind=-1')['Drives']
        if name:
            index = next(i for i, x in enumerate(entries) if x['name'] == name + '.ap2')
        else:
            for _ in range(16):
                found = next((i for i, x in enumerate(entries) if x.get('path') == str(folder)), None)
                if found is not None:
                    index = found
                    break
                parents = [(i, x) for i, x in enumerate(entries) if x.get('path')
                           and str(folder).startswith(x['path'].rstrip('/') + '/') and not x.get('expanded')]
                if not parents:
                    raise ValueError('Fixture not in native folder tree')
                index = max(parents, key=lambda item: len(item[1]['path']))[0]
                entries = command('GetPlaylists&ind=' + str(index))['Drives']
            else:
                raise ValueError('Native folder tree too deep')
        command('GetPlaylist&playlist=' + str(index))
        ready()

    recorder = None
    capture = None
    try:
        if command('State')['Playing']:
            raise ValueError('Player must be idle before probe')
        load()
        songs = command('GetSongs&album=0')
        if songs != {'Songs': ['One', 'Two', 'Three'], 'SongsLen': [10000, 10000, 10000]}:
            raise ValueError('Wrong fixture; expected One/Two/Three, 10s each')
        config = command('GetConfig')
        if config.get('auto_mode') or not config.get('cue_mode') or config.get('volume_enabled'):
            raise ValueError('Expected cue_mode=true, auto_mode=false, volume_enabled=false')
        paths = [command('GetPath&album=0&song=' + str(i)) for i in range(3)]
        if args.case in ('exported', 'one', 'third', 'reordered'):
            command('SavePlaylist&name=' + private_name)
            decoded = read_ap3(created[0].read_bytes())
            if args.case == 'exported':
                load(private_name)
            else:
                selection = {'one': [0], 'third': [2], 'reordered': [2, 0, 2]}[args.case]
                created[1].write_bytes(subset_ap3(decoded, selection))
                load(private_name + '_subset')
        selected_songs = command('GetSongs&album=0')
        expected_names = {'one': ['One'], 'third': ['Three'],
                          'reordered': ['Three', 'One', 'Three']}.get(args.case, ['One', 'Two', 'Three'])
        if selected_songs != {'Songs': expected_names, 'SongsLen': [10000] * len(expected_names)}:
            raise ValueError('Loaded playlist does not match requested native selection; retry with fresh process')
        fd, capture = tempfile.mkstemp(prefix='native-cue-', suffix='.raw', dir=cwd.parent)
        os.close(fd)
        recorder = subprocess.Popen(['arecord', '-q', '-D', 'hw:CARD=NativeCueTest,DEV=1',
                                     '-f', 'S32_LE', '-r', '44100', '-c', '2', '-t', 'raw', capture],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        time.sleep(.2)
        command('Play&album=0&song=' + ('2' if args.case == 'direct-last' else '0'))
        started = time.monotonic()
        states, seen, eof = [], False, False
        while time.monotonic() - started < 50:
            state = command('State')
            item = {k: state.get(k) for k in ('Playing', 'Paused', 'Album', 'Song', 'Position', 'PlayingLen', 'LastError')}
            if not states or (states[-1]['Playing'], states[-1]['Song']) != (item['Playing'], item['Song']):
                states.append(item)
            seen |= state['Playing']
            if seen and not state['Playing']:
                eof = True
                break
            if state.get('LastError') or recorder.poll() is not None:
                break
            time.sleep(.06)
        elapsed = time.monotonic() - started
        command('Stop')  # EOF/cleanup only: never used to enforce a CUE boundary.
        for _ in range(50):
            if Path('/proc/asound/card7/pcm0p/sub0/hw_params').read_text().strip() == 'closed':
                break
            time.sleep(.1)
        else:
            raise ValueError('Native output did not close after Stop')
        time.sleep(.2)
        recorder.terminate()
        stderr = recorder.communicate(timeout=3)[1].decode()
        samples = array.array('i')
        samples.frombytes(Path(capture).read_bytes())
        runs, stereo = [], True
        for left, right in zip(samples[::2], samples[1::2]):
            stereo &= left == right
            value = left // 65536
            if runs and runs[-1]['value'] == value:
                runs[-1]['frames'] += 1
            else:
                runs.append({'value': value, 'frames': 1})
        observed = []
        for run in runs:
            if run['value'] and (not observed or observed[-1] != run['value']):
                observed.append(run['value'])
        expected = {'direct': [1, 2, 3], 'direct-last': [3], 'exported': [1, 2, 3],
                    'one': [1], 'third': [3], 'reordered': [3, 1, 3]}[args.case]
        passed = eof and stereo and observed == expected and not any(s['LastError'] for s in states)
        report = {'case': args.case, 'passed': passed, 'pid': args.pid, 'url': args.url,
                  'expectedMarkers': expected, 'observedMarkers': observed, 'elapsedSeconds': elapsed,
                  'eof': eof, 'songs': selected_songs, 'paths': paths, 'states': states, 'runs': runs,
                  'recorderStderr': stderr, 'config': {k: config.get(k) for k in (
                      'auto_mode', 'cue_mode', 'di_mode', 'gapless_mode', 'preload_mode', 'volume_enabled')}}
        Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({k: report[k] for k in ('case', 'passed', 'expectedMarkers', 'observedMarkers', 'elapsedSeconds')}))
        return 0 if passed else 1
    finally:
        cleanup(command, recorder, capture, created)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--executable', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--folder', required=True)
    parser.add_argument('--case', required=True, choices=['direct', 'direct-last', 'exported', 'one', 'third', 'reordered'])
    parser.add_argument('--report', required=True)
    try:
        sys.exit(main(parser.parse_args()))
    except (OSError, ValueError, KeyError, StopIteration, struct.error) as error:
        print('Invalid probe environment: ' + str(error), file=sys.stderr)
        sys.exit(2)
