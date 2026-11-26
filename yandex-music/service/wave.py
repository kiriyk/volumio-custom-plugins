"""Player-local wave context. No credentials or upstream URLs in responses."""
import asyncio
import math
import logging
import secrets

from .errors import ServiceError
from .storage import CredentialStore


class Wave:
    def __init__(self, auth, path):
        self.auth = auth
        self.store = CredentialStore(path)
        self.selection = {}
        if path.exists():
            import json
            self.selection = json.loads(path.read_text())
        self.session = None
        self.lock = asyncio.Lock()

    def invalidate(self):
        self.session = None

    async def options(self):
        return {'options': await self.auth.call('wave_options'), 'selection': self.selection}

    def require(self, id_):
        if not self.session or self.session['id'] != id_:
            raise ServiceError('WAVE_EXPIRED', 'Wave session ended; start again', 409)
        return self.session

    def batch(self, session, result):
        if not result or result.get('terminated') or result.get('unknown_session'):
            raise ServiceError('WAVE_EXPIRED', 'Wave session expired', 409)
        items = []
        batch = result.get('batch_id')
        if not batch:
            raise ServiceError('UNAVAILABLE', 'Missing wave batch', 502)
        for track in result['items']:
            id_ = track['id']
            if track['available'] and id_ not in session['tracks']:
                session['tracks'][id_] = batch
                items.append(track)
        if not items:
            raise ServiceError('UNAVAILABLE', 'No new playable recommendations', 422)
        logging.getLogger(__name__).info('wave batch tracks=%d', len(items))
        return {'id': session['id'], 'items': items, 'selection': self.selection}

    async def start(self, selection):
        async with self.lock:
            self.invalidate()
            options = await self.auth.call('wave_options')
            if not isinstance(selection, dict) or set(selection) - set(options):
                raise ValueError('Invalid wave selection')
            seeds = []
            for field, choices in options.items():
                selected = selection.get(field, '')
                if not isinstance(selected, str) or (selected and selected not in [c['value'] for c in choices['values']]):
                    raise ValueError('Unknown wave option')
                if selected:
                    seeds.append(selected)
            if not selection.get('activity'):
                seeds.insert(0, 'user:onyourwave')
            result = await self.auth.call('wave_new', seeds)
            session = {'id': secrets.token_urlsafe(18), 'upstream': result.get('session_id'),
                       'tracks': {}, 'events': set()}
            if not session['upstream']:
                raise ServiceError('UNAVAILABLE', 'Missing wave session', 502)
            response = self.batch(session, result)
            self.store.save(selection)
            self.selection = dict(selection)
            response['selection'] = self.selection
            self.session = session
            return response

    async def action(self, action, data):
        async with self.lock:
            if action == 'end' and self.session is None:
                return {'ended': True}
            session = self.require(data.get('id'))
            try:
                if action == 'end':
                    self.invalidate()
                    return {'ended': True}
                if action == 'next':
                    result = await self.auth.call('wave_next', session['upstream'], list(session['tracks']))
                    self.require(session['id'])
                    return self.batch(session, result)
                if action != 'event':
                    raise ValueError('Unknown wave action')
                track, event, occurrence = data.get('track_id'), data.get('event'), data.get('occurrence')
                seconds = data.get('seconds', 0)
                if (track not in session['tracks'] or event not in ('trackStarted', 'trackFinished', 'skip')
                        or not isinstance(occurrence, str) or not 0 < len(occurrence) <= 100
                        or isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                        or not math.isfinite(seconds) or seconds < 0):
                    raise ValueError('Invalid wave feedback')
                key = (occurrence, event if event == 'trackStarted' else 'terminal')
                if key not in session['events']:
                    await self.auth.call('wave_event', session['upstream'], track,
                                         session['tracks'][track], event, seconds)
                    self.require(session['id'])
                    session['events'].add(key)
                    logging.getLogger(__name__).info('wave event=%s seconds=%.3f', event, seconds)
                return {'accepted': True}
            except BaseException:
                self.invalidate()
                raise
