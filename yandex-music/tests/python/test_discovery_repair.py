import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/repair-volumio-discovery.py'


def run(target, backup):
    return subprocess.run([sys.executable, str(SCRIPT), '--file', str(target), '--backup', str(backup)],
                          capture_output=True, text=True)


def test_repairs_only_restart_method_and_is_idempotent(tmp_path):
    target = tmp_path / 'index.js'
    backup = tmp_path / 'backup.js'
    original = ("ControllerVolumioDiscovery.prototype.restartBrowse = function () {\n"
                "  if (self.browse) { self.browse.stop(); self.browse = null; }\n};\n"
                "ControllerVolumioDiscovery.prototype.onVolumioStart = function () {\n"
                "  self.browse = 'unrelated';\n};\n")
    target.write_text(original)
    assert run(target, backup).returncode == 0
    fixed = target.read_text()
    assert backup.read_text() == original
    assert 'if (self.browser) { self.browser.stop(); self.browser = null; }' in fixed
    assert "self.browse = 'unrelated'" in fixed
    assert run(target, backup).returncode == 0
    assert target.read_text() == fixed and backup.read_text() == original


def test_refuses_unknown_source_without_modifying_it(tmp_path):
    target = tmp_path / 'index.js'
    backup = tmp_path / 'backup.js'
    target.write_text('unexpected upstream code')
    assert run(target, backup).returncode != 0
    assert target.read_text() == 'unexpected upstream code'
    assert not backup.exists()
