import asyncio
import aiohttp


class ServiceError(Exception):
    def __init__(self, code='SERVICE_UNAVAILABLE', message='Qobuz request failed', status=503):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def public_error(error):
    if isinstance(error, ServiceError):
        return error
    if isinstance(error, (asyncio.TimeoutError, aiohttp.ClientError)):
        return ServiceError('UPSTREAM_TIMEOUT', 'Qobuz connection failed', 504)
    return ServiceError()
