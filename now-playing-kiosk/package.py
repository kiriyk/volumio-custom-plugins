"""Package the compiled server changes and complete browser bundle."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

CLIENT = "dist/app/client/build"
MODULES = (
    "dist/app/index", "dist/lib/NowPlayingContext", "dist/app/Encoder", "dist/app/TrackQuality",
)
SUFFIXES = (".js", ".js.map", ".d.ts", ".d.ts.map")


def checksums(root):
    return {
        file.relative_to(root).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted(root.rglob("*")) if file.is_file()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("official", "server", "release"):
        parser.add_argument(name, type=Path)
    for name in ("base_version", "server_revision", "client_revision", "version"):
        parser.add_argument(name)
    args = parser.parse_args()

    payload = args.release / "payload"
    shutil.copytree(args.server / CLIENT, payload / CLIENT)
    manifest = {
        "schema": 1, "base_version": args.base_version, "server_revision": args.server_revision,
        "client_revision": args.client_revision, "version": args.version,
        "official": {f"{CLIENT}/{name}": digest for name, digest in checksums(args.official / CLIENT).items()},
    }
    for module in MODULES:
        for suffix in SUFFIXES:
            name = module + suffix
            file = args.official / name
            if file.exists():
                manifest["official"][name] = hashlib.sha256(file.read_bytes()).hexdigest()
            target = payload / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(args.server / name, target)
    manifest["payload"] = checksums(payload)
    (args.release / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
