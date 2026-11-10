import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bootstrap', pathlib.Path(__file__).parents[1] / 'scripts/bootstrap.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class BootstrapTests(unittest.TestCase):
    def test_update_preserves_session_and_does_not_undo_logout(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); state = root / 'state'; research = root / 'research'; research.mkdir()
            (research / 'parameters.json').write_text(json.dumps({'app_id': 'id', 'oauth_parameter': 'param', 'stream_candidates': ['secret']}))
            (research / 'session.json').write_text(json.dumps({'token': 'original', 'user_id': 1}))
            module.bootstrap(state, research)
            self.assertEqual(json.loads((state / 'credentials.json').read_text())['access_token'], 'original')
            (state / 'credentials.json').write_text(json.dumps({'access_token': 'replacement'}))
            module.bootstrap(state, research)
            self.assertEqual(json.loads((state / 'credentials.json').read_text())['access_token'], 'replacement')
            (state / 'credentials.json').unlink()
            module.bootstrap(state, research)
            self.assertFalse((state / 'credentials.json').exists())
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
