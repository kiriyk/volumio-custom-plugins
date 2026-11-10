from .errors import ServiceError


def value(obj, name, default=None):
    result = obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)
    return default if result is None else result


def cover_url(obj):
    uri = value(obj, 'cover_uri') or value(value(obj, 'cover'), 'uri') or ''
    if not uri:
        uri = next((item for item in value(value(obj, 'cover'), 'items_uri', []) if item), '')
    if not uri:
        uri = value(value(obj, 'cover'), 'prefix', '')
    if not uri:
        return ''
    uri = str(uri).replace('%%', '300x300')
    return uri if uri.startswith('https://') else 'https://' + uri.removeprefix('http://')


def track_dto(track):
    albums = value(track, 'albums', [])
    album = albums[0] if albums else None
    return {'type': 'track', 'id': str(value(track, 'id', '')),
            'album_id': str(value(album, 'id', '')), 'title': value(track, 'title', 'Unavailable'),
            'artists': [value(a, 'name', '') for a in value(track, 'artists', [])],
            'artist_links': [{'id': str(value(a, 'id')), 'name': value(a, 'name', '')}
                             for a in value(track, 'artists', []) if value(a, 'id')],
            'album': value(album, 'title', ''), 'duration_ms': value(track, 'duration_ms', 0),
            'cover_url': cover_url(track), 'available': value(track, 'available', False)}


def entity_dto(kind, obj):
    if kind == 'track':
        return track_dto(obj)
    result = {'type': kind, 'id': str(value(obj, 'kind' if kind == 'playlist' else 'id', '')),
              'title': value(obj, 'title', value(obj, 'name', '')), 'cover_url': cover_url(obj)}
    if kind == 'playlist':
        owner = value(obj, 'owner')
        result['owner'] = str(value(owner, 'uid', value(owner, 'login', value(obj, 'uid', ''))))
    if kind == 'album':
        result['artists'] = [value(a, 'name', '') for a in value(obj, 'artists', [])]
    return result


def pagination(cursor, limit):
    try:
        offset, size = int(cursor or 0), int(limit)
        if offset < 0 or not 1 <= size <= 100:
            raise ValueError
        return offset, size
    except (ValueError, TypeError):
        raise ServiceError('BAD_REQUEST', 'Invalid page or page size', 400) from None


def paginate(items, cursor=None, limit=50):
    offset, size = pagination(cursor, limit)
    end = offset + size
    return {'items': items[offset:end], 'next_cursor': str(end) if end < len(items) else None}
