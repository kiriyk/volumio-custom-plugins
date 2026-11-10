import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

import pytest

ROOT = Path(__file__).resolve().parents[2]


def command(path, text):
    path.write_text('#!/bin/bash\nset -eu\n' + text)
    path.chmod(0o755)


@pytest.fixture
def installation(tmp_path):
    root = tmp_path / 'root'
    plugin = root / 'data/plugins/music_service/yandex_music'
    plugin.mkdir(parents=True)
    for filename in ('install.sh', 'uninstall.sh'):
        shutil.copy(ROOT / filename, plugin / filename)
    shutil.copytree(ROOT / 'systemd', plugin / 'systemd')
    (plugin / 'service').mkdir()
    (plugin / 'service/requirements.txt').write_text('')
    (root / 'etc').mkdir()
    (root / 'etc/os-release').write_text('VERSION_CODENAME=bookworm\nVOLUMIO_VERSION=4.239\n')
    bin_ = tmp_path / 'bin'
    bin_.mkdir()
    log = tmp_path / 'commands'
    for name in ('systemctl', 'apt-get', 'chown', 'visudo'):
        command(bin_ / name, f'printf "%s %s\\n" "{name}" "$*" >> "$COMMAND_LOG"\n')
    command(bin_ / 'id', 'echo 0\n')
    command(bin_ / 'dpkg', 'echo armhf\n')
    command(bin_ / 'dpkg-query', 'if [ "${MISSING_FFMPEG:-0}" = 1 ] && [ "${@: -1}" = ffmpeg ]; then exit 1; fi\necho "install ok installed"\n')
    command(bin_ / 'node', 'if [ "${FAKE_NODE_OLD:-0}" = 1 ]; then exit 1; fi\n')
    python = f'''if [ "${{1:-}}" = -m ] && [ "${{2:-}}" = venv ]; then
  mkdir -p "$3/bin"
  printf '#!/bin/bash\\nexit 0\\n' > "$3/bin/python"
  chmod +x "$3/bin/python"
else
  exec {sys.executable} "$@"
fi
'''
    command(bin_ / 'python3', python)
    env = {**os.environ, 'PATH': str(bin_) + ':' + os.environ['PATH'],
           'DESTDIR': str(root), 'COMMAND_LOG': str(log)}
    return root, plugin, log, env


def test_install_preflight_rejects_old_node_before_mutation(installation):
    root, plugin, log, env = installation
    result = subprocess.run(['bash', str(plugin / 'install.sh')],
                            env={**env, 'FAKE_NODE_OLD': '1'}, capture_output=True)
    assert result.returncode != 0
    assert not log.exists()
    assert not (root / 'data/configuration').exists()


def test_install_adds_ffmpeg_when_missing(installation):
    root, plugin, log, env = installation
    result = subprocess.run(['bash', str(plugin / 'install.sh')],
                            env={**env, 'MISSING_FFMPEG': '1'}, capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    assert any('apt-get install ' in line and 'ffmpeg' in line for line in log.read_text().splitlines())


def test_install_preserves_credentials_and_does_not_enable_service(installation):
    root, plugin, log, env = installation
    state = root / 'data/configuration/music_service/yandex_music'
    state.mkdir(parents=True)
    credentials = state / 'credentials.json'
    credentials.write_text(json.dumps({'access_token': 'fixture-only'}))
    result = subprocess.run(['bash', str(plugin / 'install.sh')], env=env, capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads(credentials.read_text())['access_token'] == 'fixture-only'
    assert (state / 'api-key').stat().st_mode & 0o777 == 0o600
    key = (state / 'api-key').read_text()
    subprocess.run(['bash', str(plugin / 'install.sh')], env=env, check=True, capture_output=True)
    assert (state / 'api-key').read_text() == key
    assert 'systemctl start' not in log.read_text()
    assert 'systemctl enable' not in log.read_text()
    assert (root / 'etc/systemd/system/volumio-yandex.service').exists()
    sudoers = root / 'etc/sudoers.d/volumio-yandex'
    assert sudoers.stat().st_mode & 0o777 == 0o440


def test_volumio_can_invoke_installer_via_sh(installation):
    root, plugin, log, env = installation
    result = subprocess.run(['sh', str(plugin / 'install.sh')], env=env, capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    result = subprocess.run(['sh', str(plugin / 'uninstall.sh')], env=env, capture_output=True)
    assert result.returncode == 0, result.stderr.decode()


def test_uninstall_removes_own_credentials_unit_and_runtime(installation):
    root, plugin, log, env = installation
    subprocess.run(['bash', str(plugin / 'install.sh')], env=env, check=True, capture_output=True)
    unrelated = root / 'data/configuration/music_service/another'
    unrelated.mkdir()
    (unrelated / 'config.json').write_text('{}')
    subprocess.run(['bash', str(plugin / 'uninstall.sh')], env=env, check=True, capture_output=True)
    assert not (root / 'data/configuration/music_service/yandex_music').exists()
    assert not (plugin / '.venv').exists()
    assert (unrelated / 'config.json').exists()
    assert 'systemctl stop volumio-yandex.service' in log.read_text()


def test_release_excludes_local_secrets_tests_and_build_environments():
    result = subprocess.run(['bash', 'scripts/package.sh'], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    archive = Path(result.stdout.strip().splitlines()[-1])
    with tarfile.open(archive) as release:
        names = release.getnames()
    assert any(name.endswith('/package-lock.json') for name in names)
    assert any(name.endswith('/scripts/repair-volumio-discovery.py') for name in names)
    assert not any(any(part in name.split('/') for part in
                       ('.git', '.venv', 'node_modules', 'tests', '__pycache__', '.state')) for name in names)
    assert not any(name.endswith(('credentials.json', 'api-key', '.pyc')) for name in names)
