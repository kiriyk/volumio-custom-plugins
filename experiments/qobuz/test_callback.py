import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('callback', pathlib.Path(__file__).with_name('callback.py'))
callback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(callback)


class CallbackTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='qobuz-callback-test-')
        callback.ROOT = pathlib.Path(self.directory.name)
        callback.SETTINGS = {'callback_path': '/qobuz/oauth/test/', 'app_id': 'test', 'oauth_parameter': 'test'}
        callback.STATUS = {'state': 'waiting'}
        self.exchanged = []

        def request(path, params=None, token=None, post=False):
            if path == '/oauth/callback':
                self.exchanged.append(params['code'])
                return {'token': 'test-token'}
            return {'user': {'id': 123, 'credential': {'parameters': {'valid': True}}}}

        callback.request = request
        self.server = callback.http.server.ThreadingHTTPServer(('127.0.0.1', 0), callback.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/qobuz/oauth/test/'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def check_code(self, key):
        with urllib.request.urlopen(self.url + '?' + key + '=test-code', timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertNotIn(b'test-token', response.read())
        self.assertEqual(self.exchanged, ['test-code'])
        self.assertEqual(json.loads((callback.ROOT / 'session.json').read_text())['token'], 'test-token')
        self.assertEqual((callback.ROOT / 'session.json').stat().st_mode & 0o777, 0o600)

    def test_qobuz_french_parameter(self):
        self.check_code('code_autorisation')

    def test_standard_parameter(self):
        self.check_code('code')

    def test_missing_code(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.url, timeout=3)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.exchanged, [])


if __name__ == '__main__':
    unittest.main()
