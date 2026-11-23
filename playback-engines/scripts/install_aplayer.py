#!/usr/bin/env python3
"""Install the verified full Album Player ARMHF build."""
import argparse
from pathlib import Path
import sys
import tarfile
import tempfile

from install_renderer import InstallError, download_archive, install_archive

URL = 'https://albumplayer.ru/linux/aplayer-arm32.tar.gz'
SHA256 = '030ff12da35d07be4842959ae6bce9b2e271777849afb59d14e1e80590c41397'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state_dir')
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    try:
        with tempfile.TemporaryDirectory(prefix='playback-aplayer-') as directory:
            archive = args.archive
            if archive is None:
                archive = Path(directory) / 'aplayer.tar.gz'
                download_archive(archive, URL)
            install_archive(archive, args.state_dir, SHA256,
                            component='aplayer', binary='aplayer', subdirectory='aplayer')
    except (InstallError, OSError, tarfile.TarError) as error:
        print('APlayer installation failed: ' + str(error)[:320], file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
