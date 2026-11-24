import { useId } from 'react';
import type { AlbumInfo, ArtistInfo } from '../core/store/localMusic';
import { KIOSK } from '../core/kiosk';

export function albumFacts(album?: AlbumInfo): string[] {
  const year = album?.year;
  return [
    ...(album?.localYear && (!year || (album.yearType === 'firstRelease' && album.localYear !== year)) ? [album.localYear] : []),
    ...(year ? [album.yearType === 'firstRelease' ? 'Первый выпуск ' + year : year] : []),
    ...(album?.label ? [album.label] : [])
  ];
}

export function MusicSummary({ text, url }: { text?: string; url?: string }) {
  if (!text) return null;
  return (
    <>
      <p className="aw-music-info__summary">{text}</p>
      {url && (KIOSK
        ? <span className="aw-music-info__source">Wikipedia</span>
        : <a className="aw-music-info__source" href={url} target="_blank" rel="noopener">Wikipedia</a>)}
    </>
  );
}

export default function MusicInformation({ info }: { info?: AlbumInfo | ArtistInfo }) {
  const heading = useId();
  const facts = albumFacts(info);
  if (!info?.text && !facts.length) return null;
  return (
    <section className="aw-music-info" aria-labelledby={heading}>
      <h2 id={heading}>Информация</h2>
      {facts.length ? <p className="aw-music-info__facts">{facts.join(' · ')}</p> : null}
      <MusicSummary text={info?.text} url={info?.url} />
    </section>
  );
}
