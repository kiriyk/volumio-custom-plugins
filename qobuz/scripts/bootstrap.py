"""Initialize private plugin state; research import happens only on first install."""
import json
import os
import secrets
import sys
from pathlib import Path


def write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(data)


def bootstrap(state, research):
    state, research = Path(state), Path(research)
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    state.chmod(0o700)
    key = state / 'api-key'
    if not key.exists():
        write(key, secrets.token_urlsafe(32))
    key.chmod(0o600)
    marker, credentials = state / '.initialized', state / 'credentials.json'
    if not marker.exists() and not credentials.exists():
        try:
            parameters = json.loads((research / 'parameters.json').read_text())
            session = json.loads((research / 'session.json').read_text())
            token = session.get('token')
            if token and all(parameters.get(k) for k in ('app_id', 'oauth_parameter', 'stream_candidates')):
                value = {k: parameters[k] for k in ('app_id', 'oauth_parameter', 'stream_candidates')}
                value.update(access_token=token, user_id=session.get('user_id'))
                write(credentials, json.dumps(value))
        except (OSError, ValueError, TypeError):
            pass
    if credentials.exists():
        credentials.chmod(0o600)
    write(marker, 'initialized\n')


if __name__ == '__main__':
    bootstrap(sys.argv[1], sys.argv[2])
