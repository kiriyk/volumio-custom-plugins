"""Pi-only incognito API probe. No playback, credentials or audio URLs printed."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from service.backend import YandexBackend


async def main():
    credentials = json.loads(Path('/data/configuration/music_service/yandex_music/credentials.json').read_text())
    backend = YandexBackend(credentials['access_token'])
    try:
        await backend.initialize()
        options = await backend.wave_options()
        filters = [options[key]['values'] for key in ('diversity', 'mood_energy', 'language')]
        activities = ['user:onyourwave'] + [item['value'] for item in options['activity']['values']]
        selections = [[activity] + [choices[0]['value'] for choices in filters] for activity in activities]
        selections += [['user:onyourwave'] + [choices[index % len(choices)]['value'] for choices in filters]
                       for index in range(1, max(map(len, filters)))]
        client = await backend._client()
        for index, seeds in enumerate(selections):
            session = await client.rotor_session_new(seeds, incognito=True, include_tracks_in_response=True)
            assert session.radio_session_id and session.sequence and not session.terminated
            accepted = {f'{seed.type}:{seed.tag}' for seed in session.accepted_seeds or []}
            # The API omits neutral/default filters from accepted_seeds.
            neutral = {'settingDiversity:default', 'settingMoodEnergy:all', 'settingLanguage:any'}
            assert set(seeds) - neutral <= accepted, 'Requested filters were not accepted'
            print(json.dumps({'requested': seeds, 'accepted': sorted(accepted), 'tracks': len(session.sequence)}, ensure_ascii=False), flush=True)
            if index == 0:
                received = [str(item.track.id) for item in session.sequence]
                for batch in range(2):
                    result = await client.rotor_session_tracks(session.radio_session_id, queue=received)
                    assert result.sequence and not result.unknown_session and not result.terminated
                    received.extend(str(item.track.id) for item in result.sequence)
                    print(json.dumps({'batch': batch + 2, 'tracks': len(result.sequence)}), flush=True)
    finally:
        await backend.close()


if __name__ == '__main__':
    asyncio.run(main())
