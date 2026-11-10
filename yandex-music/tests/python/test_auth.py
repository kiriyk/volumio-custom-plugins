import asyncio
import json
import stat
from yandex_music.exceptions import DeviceAuthError

import pytest

from service.auth import AuthManager
from service.errors import ServiceError
from service.storage import CredentialStore


def test_credentials_are_private_and_atomically_replaced(tmp_path):
    store = CredentialStore(tmp_path / 'credentials.json')
    assert store.load() is None
    store.save({'access_token': 'secret-one'})
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    store.save({'access_token': 'secret-two'})
    assert json.loads(store.path.read_text()) == {'access_token': 'secret-two'}
    assert len(list(tmp_path.iterdir())) == 1
    store.clear()
    assert store.load() is None


class Backend:
    def __init__(self, token=None):
        self.token = token
        self.polls = 0
        self.closed = False

    async def initialize(self):
        if self.token == 'bad-token':
            raise ServiceError('AUTH_EXPIRED', 'Please sign in', 401)
        return {'id': '123', 'name': 'Listener'}

    async def request_device_code(self):
        return {'device_code': 'private-code', 'user_code': 'ABCD',
                'verification_url': 'https://oauth.yandex.ru/device',
                'expires_in': 60, 'interval': 0.01}

    async def poll_device_token(self, code):
        assert code == 'private-code'
        self.polls += 1
        return None if self.polls == 1 else {'access_token': 'device-token'}

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_failed_login_preserves_existing_session_and_hides_tokens(tmp_path):
    auth = AuthManager(CredentialStore(tmp_path / 'credentials.json'), Backend)
    await auth.login_token('working-token')
    with pytest.raises(ServiceError):
        await auth.login_token('bad-token')
    assert auth.account() == {'authenticated': True, 'user': {'id': '123', 'name': 'Listener'}}
    assert auth.store.load()['access_token'] == 'working-token'
    assert 'working-token' not in json.dumps(auth.account())
    await auth.close()


@pytest.mark.asyncio
async def test_device_login_is_background_and_never_exposes_device_secret(tmp_path):
    auth = AuthManager(CredentialStore(tmp_path / 'credentials.json'), Backend)
    state = await auth.start()
    assert state['status'] == 'pending'
    assert state['user_code'] == 'ABCD'
    assert 'private-code' not in json.dumps(state)
    for _ in range(40):
        if auth.status(state['id'])['status'] == 'success':
            break
        await asyncio.sleep(0.01)
    assert auth.status(state['id'])['status'] == 'success'
    assert auth.store.load()['access_token'] == 'device-token'
    await auth.logout()
    assert auth.account()['authenticated'] is False
    with pytest.raises(ServiceError, match='Sign in'):
        auth.require_backend()
    await auth.close()


@pytest.mark.asyncio
async def test_logout_cancels_device_poll_and_cannot_restore_account(tmp_path):
    class SlowBackend(Backend):
        async def poll_device_token(self, code):
            await asyncio.sleep(1)
            return {'access_token': 'too-late'}
    auth = AuthManager(CredentialStore(tmp_path / 'credentials.json'), SlowBackend)
    await auth.start()
    await auth.logout()
    assert auth.store.load() is None
    assert not auth.account()['authenticated']
    await auth.close()


@pytest.mark.asyncio
async def test_persisted_expired_access_token_is_refreshed_after_service_restart(tmp_path):
    class RefreshBackend(Backend):
        async def refresh(self, token):
            assert token == 'refresh-fixture'
            return {'access_token': 'renewed-token'}
    store = CredentialStore(tmp_path / 'credentials.json')
    store.save({'access_token': 'bad-token', 'refresh_token': 'refresh-fixture'})
    auth = AuthManager(store, RefreshBackend)
    await auth.initialize()
    assert auth.account()['authenticated'] is True
    assert store.load() == {'access_token': 'renewed-token', 'refresh_token': 'refresh-fixture'}
    await auth.close()


@pytest.mark.asyncio
async def test_catalog_result_after_logout_does_not_return_old_account_data(tmp_path):
    ready, finish = asyncio.Event(), asyncio.Event()
    class SlowBackend(Backend):
        async def library(self):
            ready.set()
            await finish.wait()
            return {'private_old_account': 'tracks'}
    auth = AuthManager(CredentialStore(tmp_path / 'credentials.json'), SlowBackend)
    await auth.login_token('working-token')
    pending = asyncio.create_task(auth.call('library'))
    await ready.wait()
    await auth.logout()
    finish.set()
    with pytest.raises(ServiceError):
        await pending
    await auth.close()


@pytest.mark.asyncio
async def test_old_refresh_cannot_replace_account_selected_by_device_login(tmp_path):
    refreshing, release_refresh, allow_device = asyncio.Event(), asyncio.Event(), asyncio.Event()
    class RacingBackend(Backend):
        async def initialize(self):
            return {'id': 'new-user' if self.token == 'new-token' else 'old-user', 'name': 'Listener'}
        async def refresh(self, token):
            refreshing.set()
            await release_refresh.wait()
            return {'access_token': 'old-refreshed'}
        async def library(self):
            raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
        async def poll_device_token(self, code):
            await allow_device.wait()
            return {'access_token': 'new-token'}
    store = CredentialStore(tmp_path / 'credentials.json')
    store.save({'access_token': 'old-token', 'refresh_token': 'refresh-fixture'})
    auth = AuthManager(store, RacingBackend)
    await auth.initialize()
    login = await auth.start()
    pending = asyncio.create_task(auth.call('library'))
    await refreshing.wait()
    allow_device.set()
    for _ in range(100):
        if auth.status(login['id'])['status'] == 'success':
            break
        await asyncio.sleep(0.001)
    assert auth.account()['user']['id'] == 'new-user'
    release_refresh.set()
    with pytest.raises(ServiceError):
        await pending
    assert store.load()['access_token'] == 'new-token'
    await auth.close()


@pytest.mark.asyncio
async def test_expired_token_without_refresh_is_reported_as_signed_out(tmp_path):
    class ExpiredBackend(Backend):
        async def library(self):
            raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
    auth = AuthManager(CredentialStore(tmp_path / 'credentials.json'), ExpiredBackend)
    await auth.login_token('working-token')
    with pytest.raises(ServiceError):
        await auth.call('library')
    assert auth.account()['authenticated'] is False
    assert auth.store.load()['access_token'] == 'working-token'
    await auth.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(('oauth_error', 'expected'), [('access_denied', 'denied'), ('expired_token', 'expired')])
async def test_device_oauth_denial_and_expiration_have_distinct_states(tmp_path, oauth_error, expected):
    class DeniedBackend(Backend):
        async def poll_device_token(self, code):
            raise DeviceAuthError(oauth_error)
    auth = AuthManager(CredentialStore(tmp_path / 'credentials.json'), DeniedBackend)
    login = await auth.start()
    for _ in range(100):
        if auth.status(login['id'])['status'] != 'pending':
            break
        await asyncio.sleep(0.001)
    assert auth.status(login['id'])['status'] == expected
    await auth.close()
