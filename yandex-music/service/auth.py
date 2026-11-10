import asyncio
import contextlib
import secrets
import time

from .errors import ServiceError, public_error


class AuthManager:
    def __init__(self, store, backend_factory):
        self.store, self.factory = store, backend_factory
        self.backend, self.user = None, None
        self.credentials = None
        self.device, self.task = None, None
        self.lock = asyncio.Lock()
        self.generation = 0
        self.account_epoch = 0
        self.reauth_required = False
        self.on_change = lambda: None

    async def initialize(self):
        saved = self.store.load()
        if saved:
            try:
                await self._commit(saved, allow_refresh=True)
            except Exception as error:
                # A temporary outage must not destroy the persisted session.
                self.credentials = saved
                self.reauth_required = public_error(error).code == 'AUTH_EXPIRED'

    async def _commit(self, credentials, *, allow_refresh=False, invalidate=True, expected_epoch=None):
        epoch = self.account_epoch if expected_epoch is None else expected_epoch
        if epoch != self.account_epoch:
            raise ServiceError('AUTH_REQUIRED', 'Account changed', 401)
        candidate = self.factory(credentials['access_token'])
        try:
            try:
                user = await candidate.initialize()
            except Exception as error:
                if (not allow_refresh or public_error(error).code != 'AUTH_EXPIRED'
                        or not credentials.get('refresh_token')):
                    raise
                renewed = await candidate.refresh(credentials['refresh_token'])
                credentials = {**credentials, **renewed}
                await candidate.close()
                candidate = self.factory(credentials['access_token'])
                user = await candidate.initialize()
            if epoch != self.account_epoch:
                raise ServiceError('AUTH_REQUIRED', 'Account changed', 401)
            self.store.save(credentials)
        except BaseException:
            await candidate.close()
            raise
        previous = self.backend
        changed_user = self.user is not None and self.user.get('id') != user.get('id')
        self.backend, self.user, self.credentials = candidate, user, credentials
        self.reauth_required = False
        if invalidate or changed_user:
            self.account_epoch += 1
            self.on_change()
        if previous:
            await previous.close()

    async def _cancel_device(self):
        self.generation += 1
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        if self.device and self.device['status'] == 'pending':
            self.device['status'] = 'cancelled'

    async def login_token(self, token):
        if not isinstance(token, str) or not token.strip() or len(token) > 8192:
            raise ServiceError('BAD_REQUEST', 'Enter an OAuth token', 400)
        async with self.lock:
            await self._cancel_device()
            await self._commit({'access_token': token.strip()})
        return self.account()

    def account(self):
        return {'authenticated': self.backend is not None and not self.reauth_required,
                'user': self.user if not self.reauth_required else None}

    def require_backend(self):
        if self.reauth_required:
            raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
        if not self.backend:
            raise ServiceError('AUTH_REQUIRED', 'Sign in to Yandex Music', 401)
        return self.backend

    async def call(self, method, *args, **kwargs):
        if self.backend is None and self.credentials:
            async with self.lock:
                if self.backend is None:
                    await self._commit(self.credentials, allow_refresh=True)
        backend = self.require_backend()
        epoch = self.account_epoch
        try:
            result = await getattr(backend, method)(*args, **kwargs)
        except Exception as error:
            translated = public_error(error)
            if translated.code != 'AUTH_EXPIRED':
                raise translated from None
            async with self.lock:
                if epoch != self.account_epoch:
                    raise ServiceError('AUTH_REQUIRED', 'Account changed', 401)
                if self.backend is backend:
                    refresh = (self.credentials or {}).get('refresh_token')
                    if not refresh:
                        self.reauth_required = True
                        raise translated from None
                    try:
                        credentials = await backend.refresh(refresh)
                        if epoch != self.account_epoch or self.backend is not backend:
                            raise ServiceError('AUTH_REQUIRED', 'Account changed', 401)
                        credentials.setdefault('refresh_token', refresh)
                        await self._commit(credentials, invalidate=False, expected_epoch=epoch)
                    except Exception as refresh_error:
                        if epoch == self.account_epoch and public_error(refresh_error).code == 'AUTH_EXPIRED':
                            self.reauth_required = True
                        raise public_error(refresh_error) from None
            try:
                result = await getattr(self.require_backend(), method)(*args, **kwargs)
            except Exception as retry_error:
                raise public_error(retry_error) from None
        if epoch != self.account_epoch:
            raise ServiceError('AUTH_REQUIRED', 'Account changed', 401)
        return result

    async def start(self):
        async with self.lock:
            await self._cancel_device()
            candidate = self.factory(None)
            try:
                code = await candidate.request_device_code()
            except BaseException:
                await candidate.close()
                raise
            self.device = {'id': secrets.token_urlsafe(18), 'status': 'pending',
                           'user_code': code['user_code'],
                           'verification_url': code['verification_url'],
                           'expires_in': code['expires_in']}
            self.task = asyncio.create_task(self._poll(candidate, code, self.generation))
            return dict(self.device)

    async def _poll(self, candidate, code, generation):
        deadline = time.monotonic() + code['expires_in']
        try:
            while time.monotonic() < deadline:
                credentials = await candidate.poll_device_token(code['device_code'])
                if credentials:
                    if generation != self.generation:
                        return
                    # No lock: logout holds it while cancelling/awaiting this task.
                    await self._commit(credentials)
                    self.device['status'] = 'success'
                    return
                await asyncio.sleep(max(0.01, code.get('interval', 5)))
            self.device['status'] = 'expired'
        except asyncio.CancelledError:
            raise
        except Exception as error:
            code = public_error(error).code
            status = {'AUTH_EXPIRED': 'expired', 'ACCESS_DENIED': 'denied'}.get(code, 'error')
            self.device.update(status=status, error=code)
        finally:
            await candidate.close()

    def status(self, session_id):
        if not self.device or self.device['id'] != session_id:
            raise ServiceError('NOT_FOUND', 'Login session was not found', 404)
        return dict(self.device)

    async def logout(self):
        async with self.lock:
            await self._cancel_device()
            if self.backend:
                await self.backend.close()
            self.backend, self.user, self.credentials = None, None, None
            self.reauth_required = False
            self.account_epoch += 1
            self.store.clear()
            self.on_change()
        return self.account()

    async def close(self):
        await self._cancel_device()
        if self.backend:
            await self.backend.close()
