import pytest
from service.wave import Wave
from service.errors import ServiceError


class Auth:
    def __init__(self):
        self.calls = []
        self.result = {'session_id': 'upstream', 'batch_id': 'batch',
                       'items': [{'id': '1', 'available': True}]}
        self.options = {field: {'label': field, 'values': [{'value': field + ':a', 'label': 'A'}]}
                        for field in ('activity', 'diversity', 'mood_energy', 'language')}

    async def call(self, method, *args):
        self.calls.append((method, args))
        if method == 'wave_options':
            return self.options
        return self.result


@pytest.fixture
def wave(tmp_path):
    return Wave(Auth(), tmp_path / 'wave-settings.json')


async def test_start_validates_selection_and_persists_only_settings(wave):
    result = await wave.start({'activity': 'activity:a', 'language': 'language:a'})
    assert result['items'][0]['id'] == '1'
    assert wave.auth.calls[-1] == ('wave_new', (['activity:a', 'language:a'],))
    assert 'upstream' not in wave.store.path.read_text()
    restored = Wave(wave.auth, wave.store.path)
    assert restored.session is None
    assert restored.selection == result['selection']
    with pytest.raises(ValueError):
        await wave.start({'language': 'arbitrary'})
    assert wave.session is None


async def test_default_seed_dedupe_and_expiration(wave):
    result = await wave.start({})
    assert wave.auth.calls[-1][1] == (['user:onyourwave'],)
    with pytest.raises(ServiceError):
        await wave.action('next', {'id': result['id']})
    assert wave.session is None


async def test_feedback_uses_original_batch_and_deduplicates_terminal(wave):
    result = await wave.start({})
    for event in ('trackStarted', 'trackStarted', 'trackFinished', 'skip'):
        await wave.action('event', {'id': result['id'], 'event': event, 'track_id': '1',
                                    'occurrence': 'one', 'seconds': 1.25})
    feedback = [args for method, args in wave.auth.calls if method == 'wave_event']
    assert len(feedback) == 2
    assert feedback[-1] == ('upstream', '1', 'batch', 'trackFinished', 1.25)


async def test_account_invalidation_discards_pending_response(wave):
    result = await wave.start({})
    original = wave.auth.call
    async def call(method, *args):
        if method == 'wave_next':
            wave.invalidate()
            return {'batch_id': 'second', 'items': [{'id': '2', 'available': True}]}
        return await original(method, *args)
    wave.auth.call = call
    with pytest.raises(ServiceError):
        await wave.action('next', {'id': result['id']})
    assert wave.session is None


@pytest.mark.parametrize('seconds', [-1, float('nan'), float('inf'), '1', True])
async def test_invalid_feedback_closes_context(wave, seconds):
    result = await wave.start({})
    with pytest.raises(ValueError):
        await wave.action('event', {'id': result['id'], 'event': 'skip', 'track_id': '1',
                                    'occurrence': 'x', 'seconds': seconds})
    assert wave.session is None


@pytest.mark.parametrize('selected', [None, False, 0, ['activity:a']])
async def test_selection_values_must_be_strings(wave, selected):
    with pytest.raises(ValueError):
        await wave.start({'activity': selected})
    assert wave.session is None


async def test_ending_context_is_idempotent_after_account_change(wave):
    result = await wave.start({})
    wave.invalidate()
    assert await wave.action('end', {'id': result['id']}) == {'ended': True}
    new = await wave.start({})
    with pytest.raises(ServiceError):
        await wave.action('end', {'id': result['id']})
    assert wave.session['id'] == new['id']
