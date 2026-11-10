import json
import os
import tempfile
from pathlib import Path


class CredentialStore:
    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        try:
            value = json.loads(self.path.read_text())
            return value if isinstance(value, dict) and value.get('access_token') else None
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def save(self, value):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, name = tempfile.mkstemp(prefix='.credentials-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
            os.chmod(self.path, 0o600)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def clear(self):
        self.path.unlink(missing_ok=True)
