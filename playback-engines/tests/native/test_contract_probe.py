"""Host-side checks for the opt-in probe, without starting audio processes."""
import argparse
import io
import json
import subprocess
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('native-ap-cue-contract.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class CleanupTest(unittest.TestCase):
    def test_player_exit_still_cleans_own_recorder_and_files(self):
        with tempfile.TemporaryDirectory() as root:
            capture, playlist = [Path(root) / name for name in ('capture.raw', 'probe.ap2')]
            capture.touch()
            playlist.touch()
            recorder = Mock()
            recorder.poll.return_value = None
            command = Mock(side_effect=ValueError('Player exited'))
            with self.assertRaisesRegex(ValueError, 'Player exited'):
                probe.cleanup(command, recorder, str(capture), [playlist])
            recorder.terminate.assert_called_once()
            recorder.communicate.assert_called_once()
            self.assertFalse(capture.exists())
            self.assertFalse(playlist.exists())

    def test_stale_playlist_is_rejected_before_audio_starts(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as root:
            cwd = Path(root) / 'player'
            cwd.mkdir()
            folder = Path(root) / 'music'
            folder.mkdir()
            songs = iter([
                {'Songs': ['One', 'Two', 'Three'], 'SongsLen': [10000]*3},
                {'Songs': ['One'], 'SongsLen': [10000]},
            ])
            def response(url, timeout):
                query = url.split('?', 1)[1]
                data = ({'State': {'Playing': False, 'Scanning': False},
                         'GetAlbums': {'Albums': ['Fixture']},
                         'GetConfig': {'cue_mode': True, 'auto_mode': False, 'volume_enabled': False},
                         'GetPath': {'Path': 'original.flac'},
                         'GetPlaylists': {'Drives': [{'path': str(folder)}]}}
                        .get(query.split('&')[0], {'Result': 'OK'}))
                if query.startswith('GetSongs'):
                    data = next(songs)
                return io.BytesIO(json.dumps(data).encode())
            opener = Mock()
            opener.open.side_effect = response
            args = argparse.Namespace(pid=123, executable=str(cwd/'aplayer'),
                url='http://127.0.0.1:7778', folder=str(folder), case='direct', report=str(Path(root)/'report.json'))
            with patch.object(probe, 'owned_endpoint', return_value=('stamp', cwd)), \
                 patch.object(probe.urllib.request, 'build_opener', return_value=opener), \
                 patch.object(probe.subprocess, 'Popen', side_effect=AssertionError('Audio must not start')):
                with self.assertRaisesRegex(ValueError, 'requested native selection'):
                    probe.main(args)

    def test_unresponsive_recorder_is_killed(self):
        recorder = Mock()
        recorder.poll.return_value = None
        recorder.communicate.side_effect = [subprocess.TimeoutExpired('arecord', 3), (b'', b'')]
        probe.cleanup(Mock(), recorder, None, [])
        recorder.kill.assert_called_once()


if __name__ == '__main__':
    unittest.main()
