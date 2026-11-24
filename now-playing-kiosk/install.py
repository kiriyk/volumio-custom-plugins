#!/usr/bin/env python3
"""Install, restore or roll back the Now Playing overlay on Volumio."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PLUGIN = Path("/data/plugins/user_interface/now_playing")
ROTARY = Path("/data/configuration/system_hardware/rotaryencoder2/config.json")
STATE = Path("/data/now-playing-kiosk")
CLIENT = "dist/app/client/build"
MODULES = ("dist/app/index", "dist/lib/NowPlayingContext", "dist/app/Encoder", "dist/app/TrackQuality")
SUFFIXES = (".js", ".js.map", ".d.ts", ".d.ts.map")
FILES = tuple(module + suffix for module in MODULES for suffix in SUFFIXES)
ACTIONS = ("dialAction0", "pushAction0", "longPushAction0", "doublePushAction0")
DISABLED = dict.fromkeys(ACTIONS, 0)


def read_json(path):
    return json.loads(path.read_text())


def write_atomic(path, content, owner=None):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".kiosk-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(content)
            if owner is not None:
                os.fchown(handle.fileno(), owner.st_uid, owner.st_gid)
                os.fchmod(handle.fileno(), owner.st_mode & 0o777)
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def write_json(path, data, owner=None):
    write_atomic(path, (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode(), owner)


def inventory(root):
    base = root / CLIENT
    if base.is_symlink():
        raise RuntimeError(f"Unexpected symbolic link: {base}")
    entries = [root / name for name in FILES] + list(base.rglob("*"))
    result = {}
    for path in entries:
        if path.is_symlink():
            raise RuntimeError(f"Unexpected symbolic link: {path}")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def compare(actual, expected, label):
    changed = sorted(path for path in actual.keys() | expected.keys() if actual.get(path) != expected.get(path))
    if changed:
        raise RuntimeError(f"{label}: checksum mismatch in {', '.join(changed[:6])}")


def copy_files(source, target, names):
    for name in sorted(names):
        output = target / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, output)


def actions():
    config = read_json(ROTARY)
    if config["enabled0"]["value"] is not True:
        raise RuntimeError("Rotary Encoder II slot 0 must be enabled")
    return {name: config[name]["value"] for name in ACTIONS}


def turn_actions(values):
    config = read_json(ROTARY)
    owner = ROTARY.stat()
    for name, value in values.items():
        config[name]["value"] = value
    write_json(ROTARY, config, owner)


def systemctl(action, service):
    subprocess.run(["systemctl", action, service], check=True, timeout=45)


def health(record):
    until = time.monotonic() + 55
    failure = None
    main_assets = [name.removeprefix(CLIENT) for name in record["files"]
                   if re.fullmatch(rf"{re.escape(CLIENT)}/static/js/main\.[0-9a-f]+\.js", name)]
    if len(main_assets) != 1:
        raise RuntimeError("Expected exactly one main browser bundle")
    asset = main_assets[0]
    headers = {"Host": "localhost:4004"}
    while time.monotonic() < until:
        try:
            with closing(http.client.HTTPConnection("127.0.0.1", 4004, timeout=3)) as connection:
                connection.request("GET", "/", headers=headers)
                response = connection.getresponse()
                if response.status != 200 or asset.encode() not in response.read():
                    raise RuntimeError("Now Playing HTML does not reference the expected bundle")
                connection.request("GET", asset, headers=headers)
                response = connection.getresponse()
                digest = hashlib.sha256(response.read()).hexdigest()
                if response.status != 200 or digest != record["files"][CLIENT + asset]:
                    raise RuntimeError("Now Playing returned a different browser bundle")
                if record["version"]:
                    connection.request("GET", "/kiosk/encoder", headers=headers)
                    response = connection.getresponse()
                    if response.status != 200 or response.readline() != b"event: ready\n":
                        raise RuntimeError("Encoder SSE is unavailable")
                    ready = json.loads(response.readline().removeprefix(b"data: "))
                    if ready != {"dial": True, "button": True}:
                        raise RuntimeError(f"Encoder devices are unavailable: {ready}")
                if actions() != record["actions"]:
                    raise RuntimeError("Rotary Encoder II actions changed during activation")
                return
        except (OSError, RuntimeError, ValueError, http.client.HTTPException) as error:
            failure = error
            time.sleep(1)
    raise RuntimeError(f"Health check on localhost:4004 failed: {failure}")


def apply_files(record):
    source = STATE / record["snapshot"] / "files"
    compare(inventory(source), record["files"], "Saved snapshot")
    owner = PLUGIN.stat()
    asset_dir = PLUGIN / CLIENT
    if asset_dir.exists():
        shutil.rmtree(asset_dir)
    for name in FILES:
        (PLUGIN / name).unlink(missing_ok=True)
    copy_files(source, PLUGIN, record["files"])
    for name in record["files"]:
        path = PLUGIN / name
        os.chown(path, owner.st_uid, owner.st_gid)
    for path in [asset_dir, *asset_dir.rglob("*")]:
        if path.is_dir():
            os.chown(path, owner.st_uid, owner.st_gid)
    turn_actions(record["actions"])
    compare(inventory(PLUGIN), record["files"], "Activated files")


def snapshot(source, hashes, version, base, rotary, official=None, previous=None):
    directory = Path(tempfile.mkdtemp(prefix="snapshot-", dir=STATE))
    record = {"snapshot": directory.name, "files": hashes, "version": version,
              "base": base, "actions": rotary, "official": official, "previous": previous}
    copy_files(source, directory / "files", hashes)
    compare(inventory(directory / "files"), hashes, "Staged files")
    write_json(directory / "record.json", record)
    return record


def saved(name):
    return read_json(STATE / name / "record.json")


def activate(target, current):
    marker = STATE / "active.json"
    try:
        systemctl("stop", "volumio")
        apply_files(target)
        systemctl("start", "volumio")
        health(target)
        systemctl("restart", "volumio-kiosk")
        write_json(marker, target["snapshot"] if target["version"] else None)
    except BaseException as error:
        print(f"Activation failed, restoring previous snapshot: {error}", file=sys.stderr)
        try:
            systemctl("stop", "volumio")
            apply_files(current)
            systemctl("start", "volumio")
            health(current)
            systemctl("restart", "volumio-kiosk")
        except Exception as rollback_error:
            raise RuntimeError(f"Restoration failed: {rollback_error}; snapshot: {current['snapshot']}") from error
        raise


def run(command, release):
    base = read_json(PLUGIN / "package.json")["version"]
    files = inventory(PLUGIN)
    rotary = actions()
    marker = STATE / "active.json"
    name = read_json(marker) if marker.exists() else None
    current = saved(name) if name else None
    if current:
        if current["base"] != base:
            raise RuntimeError(f"Official base is {base}; recorded overlay is for {current['base']}")
        compare(files, current["files"], "Installed overlay")
        if rotary != DISABLED:
            raise RuntimeError("Rotary Encoder II actions were edited. Resolve the four action values before retrying.")

    if command in ("restore", "rollback"):
        if not current:
            print("Official Now Playing is already active")
            return
        name = current["official"] if command == "restore" else current["previous"]
        if not name:
            raise RuntimeError("No previous kiosk release. Use restore to return to the official plugin.")
        activate(saved(name), current)
        print(f"{command} complete")
        return

    manifest = read_json(release / "manifest.json")
    if manifest["schema"] != 1 or base != manifest["base_version"]:
        raise RuntimeError(f"Installed Now Playing {base}; this release supports {manifest['base_version']}")
    payload = release / "payload"
    compare(inventory(payload), manifest["payload"], "Release payload")
    if not current:
        compare(files, manifest["official"], f"Official Now Playing {base}")
    else:
        compare(saved(current["official"])["files"], manifest["official"], "Saved official base")
        if current["files"] == manifest["payload"] and current["version"] == manifest["version"]:
            health(current)
            print(f"Now Playing kiosk {current['version']} already installed")
            return
    if command == "check":
        print(f"Now Playing {base} matches the release manifest")
        return
    if not current:
        current = snapshot(PLUGIN, files, None, base, rotary)
    official = current["official"] or current["snapshot"]
    target = snapshot(payload, manifest["payload"], manifest["version"], base, DISABLED,
                      official, current["snapshot"] if current["version"] else None)
    activate(target, current)
    print(f"Now Playing kiosk {target['version']} installed on official base {base}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "install", "restore", "rollback"])
    parser.add_argument("--release", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run on the player with sudo")
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "install.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run(args.command, args.release)


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
