/**
 * The Info face (12B–12D): the artist and the record as two rows under a hairline, and the way to their pages.
 * Under the artist: who people listen to alongside them (a tap searches the library). Under the record and
 * in a third row, the track: the credits MusicBrainz has (producer, engineers, who wrote it, who plays on it).
 */
import { useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import { rest } from '../../core/api';
import { usePlayingMusicUri, useLocalAlbumCover, useLocalAlbumInfo, useLocalArtistInfo } from '../../core/store/localMusic';
import { albumFacts, MusicSummary } from '../MusicInformation';
import { canOpenTrackInfo, trackInfoFolder } from '../../core/nowPlayingNavigation';
import { usePlayer } from '../../core/store/player';
import { useAbout, type Credit } from '../../core/store/about';
import { useTrackInfo } from '../../core/store/trackInfo';
import { useBrowse } from '../../core/store/browse';
import { KIOSK } from '../../core/kiosk';

export default function InfoFace() {
  const st: any = usePlayer(s => s.state);
  const artist = useAbout(s => s.artist);
  const album = useAbout(s => s.album);
  const track = useAbout(s => s.track);
  const localUri = usePlayingMusicUri(st);
  const localAlbum = useLocalAlbumInfo(localUri);
  const localArtist = useLocalArtistInfo(localUri, 'album');
  const cover = useLocalAlbumCover(localUri, st.albumart);
  const info = useTrackInfo();
  const nav = useNavigate();
  const artistName = localArtist?.artist || st.artist;
  if (!artistName && !(localUri && (localAlbum?.text || albumFacts(localAlbum).length))) { return null; }
  const linkState = artistName === st.artist ? st : { ...st, artist: artistName };
  const canGo = canOpenTrackInfo(linkState);
  const img = (artist && artist.thumb) || cover;
  const artistSub = artist ? [artist.description, artist.begin].filter(Boolean).join(' · ') : '';
  const n = info.tracks;
  // the genre lives here, not on the Cover face (handoff 16B)
  const localFacts = albumFacts(localAlbum);
  const albumSub = [
    ...(localUri ? (localFacts.length ? localFacts : [info.year]) : [album && album.label, (album && album.year) || info.year]),
    info.genre, n ? n + (n === 1 ? ' track' : ' tracks') : ''
  ].filter(Boolean).join(' · ');
  const goInfo = async (kind: 'artist' | 'album') => {
    const folder = await trackInfoFolder(linkState, kind, rest);
    if (!folder) return;
    useBrowse.getState().open(folder, true);
    nav('/browse');
  };
  const goArtist = () => { void goInfo('artist'); };
  // a related artist: the search page, with the name typed in
  const findArtist = (e: React.MouseEvent, name: string) => { e.stopPropagation(); nav('/search'); window.setTimeout(() => useBrowse.getState().search(name), 50); };
  const creditRows = (list: Credit[]) => (
    <dl className="np-about__credits">
      {list.map(c => <div className="np-about__credit" key={c.role}><dt className="np-about__role mono">{c.role.toUpperCase()}</dt><dd className="np-about__names">{c.names.join(', ')}</dd></div>)}
    </dl>
  );
  const goAlbum = () => { void goInfo('album'); };
  return (
    <div className={'np-about' + (localUri ? ' np-about--local' : '')}>
      <div className="np-about__rule" />
      {artistName ? <div className={'np-about__row np-about__row--artist' + (canGo ? ' is-link' : '')} onClick={goArtist}>
        {img ? <img className="np-about__img np-about__img--round" src={img} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} /> : <div className="np-about__img np-about__img--round" />}
        <div className="np-about__body">
          <div className="np-about__head">
            <span className="np-about__name">{artistName}</span>
            {artistSub ? <span className="np-about__sub">{artistSub}</span> : null}
          </div>
          {localArtist ? <div className="np-about__local-summary" onClick={(e) => e.stopPropagation()}><MusicSummary text={localArtist.text} url={localArtist.url} /></div> : null}
          {artist && artist.extract ? <p className="np-about__text">{artist.extract}</p> : null}
          {artist && artist.extract && artist.url && !KIOSK ? <a className="np-about__src mono" href={artist.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>БИОГРАФИЯ · WIKIPEDIA</a> : null}
          {artist && artist.extract && (!artist.url || KIOSK) ? <span className="np-about__src mono">БИОГРАФИЯ · WIKIPEDIA</span> : null}
          {artist && artist.related && artist.related.length ? (
            <div className="np-about__related">
              <span className="np-about__role mono">ПОХОЖИЕ</span>
              <div className="np-about__chips">{artist.related.map(r => <button type="button" className="np-about__chip" key={r.mbid} onClick={(e) => findArtist(e, r.name)} title={'Найти: ' + r.name}>{r.name}</button>)}</div>
            </div>
          ) : null}
        </div>
        {canGo ? <button type="button" className="np-about__go" aria-label="Открыть исполнителя"><span>Исполнитель</span><Icon name="chevron_right" /></button> : null}
      </div> : null}
      {st.album ? (
        <div className={'np-about__row np-about__row--album' + (canGo ? ' is-link' : '')} onClick={goAlbum}>
          {cover ? <img className="np-about__img" src={cover} alt="" /> : <div className="np-about__img" />}
          <div className="np-about__body">
            <div className="np-about__name">{st.album}</div>
            {albumSub ? <div className="np-about__sub">{albumSub}</div> : null}
            {localAlbum?.text ? <div className="np-about__local-summary" onClick={(e) => e.stopPropagation()}><MusicSummary text={localAlbum.text} url={localAlbum.url} /></div> : null}
            {album && album.extract ? <p className="np-about__text np-about__text--album">{album.extract}</p> : null}
            {album && album.credits && album.credits.length ? creditRows(album.credits) : null}
          </div>
          {canGo ? <button type="button" className="np-about__go" aria-label="Открыть альбом"><span>Альбом</span><Icon name="chevron_right" /></button> : null}
        </div>
      ) : null}
      {track && track.credits.length ? (
        <div className="np-about__row np-about__row--track">
          <div className="np-about__img np-about__img--track"><Icon name="music_note" /></div>
          <div className="np-about__body">
            <div className="np-about__name">{st.title}</div>
            <div className="np-about__sub">Этот трек</div>
            {creditRows(track.credits)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
