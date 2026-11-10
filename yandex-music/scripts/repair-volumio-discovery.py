#!/usr/bin/env python3
"""Repair a known Volumio 4.239 mDNS browser leak; restart is left to the owner."""
import argparse
from pathlib import Path
import shutil
import sys

START = 'ControllerVolumioDiscovery.prototype.restartBrowse ='
END = 'ControllerVolumioDiscovery.prototype.onVolumioStart ='
OLD = ('self.browse)', 'self.browse.stop()', 'self.browse = null')
NEW = ('self.browser)', 'self.browser.stop()', 'self.browser = null')


def repair(target: Path, backup: Path) -> str:
    original = target.read_text()
    if original.count(START) != 1 or original.count(END) != 1:
        raise ValueError('unrecognised Volumio discovery implementation')
    start, end = original.index(START), original.index(END)
    if start >= end:
        raise ValueError('unexpected method order')
    method = original[start:end]
    if all(method.count(item) == 1 for item in NEW) and not any(item in method for item in OLD):
        return 'already fixed'
    if not all(method.count(item) == 1 for item in OLD) or any(item in method for item in NEW):
        raise ValueError('unrecognised restartBrowse method; no change made')
    if backup.exists():
        raise ValueError('backup exists; refusing to overwrite it')
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    for old, new in zip(OLD, NEW):
        method = method.replace(old, new)
    target.write_text(original[:start] + method + original[end:])
    return 'fixed; restart Volumio when convenient'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, default=Path('/volumio/app/plugins/system_controller/volumiodiscovery/index.js'))
    parser.add_argument('--backup', type=Path, default=Path('/data/volumiodiscovery-index-before-dbus-fix.js'))
    args = parser.parse_args()
    try:
        print(repair(args.file, args.backup))
    except (OSError, ValueError) as error:
        print(f'Not applied: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
