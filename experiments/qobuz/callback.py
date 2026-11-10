#!/usr/bin/env python3
"""Temporary Qobuz OAuth experiment; not an installed Volumio plugin."""
import http.server
import json
import os
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
SETTINGS = {}
BASE = 'https://www.qobuz.com/api.json/0.2'
STATUS = {'state': 'waiting', 'started_at': int(time.time())}
LOCK = threading.Lock()


def store(name, value):
    path = ROOT / name
    fd = os.open(str(path) + '.new', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f)
    os.replace(str(path) + '.new', path)


def request(path, params=None, token=None, post=False):
    url = BASE + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    headers = {'X-App-Id': SETTINGS['app_id'], 'User-Agent': 'Mozilla/5.0'}
    if token:
        headers['X-User-Auth-Token'] = token
    data = b'extra=partner' if post else None
    if post:
        headers['Content-Type'] = 'text/plain;charset=UTF-8'
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, text):
        data = text.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/health':
            self.reply(200, 'Qobuz research callback ready')
            return
        if parsed.path != SETTINGS['callback_path']:
            self.reply(404, 'Not found')
            return
        params = urllib.parse.parse_qs(parsed.query)
        code = params.get('code_autorisation', [''])[0] or params.get('code', [''])[0]
        if not code or len(code) > 8192:
            self.reply(400, 'Не получен код авторизации. Повтори вход по исходной ссылке.')
            return
        if not LOCK.acquire(blocking=False):
            self.reply(409, 'Авторизация уже обрабатывается.')
            return
        try:
            if STATUS['state'] == 'authorized':
                self.reply(200, 'Вход уже выполнен. Можно закрыть эту вкладку.')
                return
            STATUS['state'] = 'exchanging'
            store('status.json', STATUS)
            result = request('/oauth/callback', {
                'code': code, 'private_key': SETTINGS['oauth_parameter'],
                'app_id': SETTINGS['app_id'],
            })
            token = result.get('token')
            if not isinstance(token, str) or not token:
                raise ValueError('missing_token')
            profile = request('/user/login', token=token, post=True)
            user = profile.get('user') or {}
            if not user.get('id'):
                raise ValueError('missing_user')
            store('session.json', {
                'token': profile.get('user_auth_token') or token,
                'user_id': user['id'],
                'has_subscription_parameters': bool((user.get('credential') or {}).get('parameters')),
                'created_at': int(time.time()),
            })
            STATUS.update(state='authorized', authorized_at=int(time.time()))
            store('status.json', STATUS)
            self.reply(200, 'Qobuz: вход выполнен. Можно закрыть вкладку и вернуться в чат. Пароль не сохранялся.')
        except Exception as exc:
            STATUS.update(state='failed', error_type=type(exc).__name__)
            if isinstance(exc, urllib.error.HTTPError):
                STATUS['http_status'] = exc.code
            store('status.json', STATUS)
            self.reply(502, 'Не удалось завершить вход. Вернись в чат: причина сохранена без токенов и пароля.')
        finally:
            LOCK.release()


if __name__ == '__main__':
    os.umask(0o077)
    SETTINGS = json.loads((ROOT / 'parameters.json').read_text())
    store('status.json', STATUS)
    server = http.server.ThreadingHTTPServer(('0.0.0.0', 17900), Handler)
    server.timeout = 1
    deadline = time.monotonic() + 3600
    while time.monotonic() < deadline:
        server.handle_request()
    server.server_close()
