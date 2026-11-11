#!/usr/bin/env python3
"""Install a pinned ARMHF renderer without executing vendor installation scripts."""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
import urllib.request

URL = 'https://albumplayer.ru/linux/aprenderer-arm32.tar.gz'
SHA256 = '66fc02a0b4ad9305f782f4fcf3ff27cedbaed2c15afd9e2c5dafb77335b5bb1d'
MAX_DOWNLOAD = 64 * 1024 * 1024
MAX_EXTRACTED = 256 * 1024 * 1024


class InstallError(Exception):
    pass


def _no_links(path):
    path = Path(path).absolute()
    for component in (path, *path.parents):
        if component.is_symlink():
            raise InstallError('Installation paths must not contain symbolic links')


def install_archive(archive, state_dir, expected_sha256=SHA256, max_bytes=MAX_EXTRACTED):
    archive, state = Path(archive), Path(state_dir)
    if archive.stat().st_size > MAX_DOWNLOAD:
        raise InstallError('Renderer download exceeds size limit')
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        for chunk in iter(lambda: source.read(65536), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha256:
        raise InstallError('Renderer archive SHA256 mismatch')
    _no_links(state)
    destination = state / 'renderer'
    _no_links(destination)
    # No extraction API is trusted with archive-selected paths or metadata.
    with tarfile.open(archive, 'r:gz') as bundle, tempfile.TemporaryDirectory(prefix='playback-renderer-') as temporary:
        stage = Path(temporary)
        members, seen, total = [], set(), 0
        for member in bundle:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or not path.parts or path.parts[0] != 'aprenderer':
                raise InstallError('Unsafe renderer archive path')
            if not member.isfile() and not member.isdir():
                raise InstallError('Renderer archive contains a link or special file')
            relative = Path(*path.parts[1:])
            if relative in seen:
                raise InstallError('Duplicate renderer archive path')
            seen.add(relative)
            total += member.size
            if len(seen) > 2048 or member.size < 0 or total > max_bytes:
                raise InstallError('Renderer archive exceeds extraction limits')
            if relative == Path('.'):
                if not member.isdir():
                    raise InstallError('Invalid renderer archive root')
                continue
            _no_links(destination / relative)
            members.append((member, relative))
        if not any(relative == Path('ap2renderer') and member.isfile() for member, relative in members):
            raise InstallError('Renderer archive has no executable')
        for member, relative in members:
            target = stage / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if relative == Path('ap2renderer') else 0o600 if relative == Path('config.dat') else 0o644)
        header = (stage / 'ap2renderer').read_bytes()[:52]
        if len(header) < 52 or header[:6] != b'\x7fELF\x01\x01' or header[18:20] != b'\x28\x00':
            raise InstallError('Renderer executable is not ARM 32-bit little-endian ELF')
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        state.chmod(0o700)
        destination.mkdir(exist_ok=True, mode=0o700)
        for member, relative in members:
            if member.isdir():
                (destination / relative).mkdir(parents=True, exist_ok=True)
                continue
            if relative == Path('config.dat') and (destination / relative).exists():
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            # Replace files atomically; an already running executable is never truncated.
            descriptor, temporary_path = tempfile.mkstemp(prefix='.renderer-', dir=target.parent)
            try:
                with os.fdopen(descriptor, 'wb') as output, (stage / relative).open('rb') as source:
                    shutil.copyfileobj(source, output)
                os.chmod(temporary_path, (stage / relative).stat().st_mode & 0o777)
                os.replace(temporary_path, target)
            finally:
                if os.path.exists(temporary_path):
                    os.unlink(temporary_path)
        if (destination / 'config.dat').exists():
            (destination / 'config.dat').chmod(0o600)


def download_archive(target):
    request = urllib.request.Request(URL, headers={'User-Agent': 'Volumio-Playback-Engines/0.1'})
    with urllib.request.urlopen(request, timeout=30) as response, Path(target).open('xb') as output:
        if not response.geturl().startswith('https://'):
            raise InstallError('Renderer download must remain HTTPS')
        total = 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD:
                raise InstallError('Renderer download exceeds size limit')
            output.write(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state_dir')
    parser.add_argument('--archive', help='Use an already downloaded archive; the pinned checksum is still mandatory')
    args = parser.parse_args()
    try:
        if args.archive:
            install_archive(args.archive, args.state_dir)
        else:
            with tempfile.TemporaryDirectory(prefix='playback-download-') as temporary:
                archive = Path(temporary) / 'renderer.tar.gz'
                download_archive(archive)
                install_archive(archive, args.state_dir)
    except (InstallError, OSError, tarfile.TarError) as error:
        print('Renderer installation failed: ' + str(error)[:320], file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
