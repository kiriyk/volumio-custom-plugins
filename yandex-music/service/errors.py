import asyncio

import aiohttp
from yandex_music import exceptions as ym


class ServiceError(Exception):
    def __init__(self, code, message, status=503):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def public_error(error):
    """Never serialize SDK exception text: it can contain OAuth and signed URLs."""
    if isinstance(error, ServiceError):
        return error
    if isinstance(error, ym.UnauthorizedError):
        return ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
    if isinstance(error, ym.DeviceAuthError):
        if 'access_denied' in str(error):
            return ServiceError('ACCESS_DENIED', 'Sign-in was declined', 403)
        if 'expired_token' in str(error):
            return ServiceError('AUTH_EXPIRED', 'Login code expired', 401)
    if isinstance(error, (asyncio.TimeoutError, ym.TimedOutError)):
        return ServiceError('UPSTREAM_TIMEOUT', 'Music service timed out', 504)
    if isinstance(error, ym.NotFoundError):
        return ServiceError('NOT_FOUND', 'Item was not found', 404)
    if isinstance(error, ym.BadRequestError):
        return ServiceError('UNAVAILABLE', 'This item is unavailable', 422)
    if isinstance(error, (ym.NetworkError, aiohttp.ClientError)):
        return ServiceError('SERVICE_UNAVAILABLE', 'Music service is unreachable', 503)
    return ServiceError('SERVICE_UNAVAILABLE', 'Music service request failed', 503)
