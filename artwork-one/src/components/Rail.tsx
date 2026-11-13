import { sourceLabel } from './navigationLabels';
/** The rail (spec §5.1): Home, Music, the library's own sources, Now Playing; MyVolumio, zones and
 *  settings below. Icons only, or icons with labels — the toggle at the foot switches, per browser. */
import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { goToMyVolumio } from '../core/store/auth';
import Icon from './Icon';
import Spinner from './Spinner';
import { usePlayer } from '../core/store/player';
import { useBrowse } from '../core/store/browse';
import { useMenu } from '../core/store/menu';
import { useUi } from '../core/store/ui';
import { useMenuSources, menuSources } from '../core/store/menuSources';
import SourceGlyph from './SourceGlyph';
import type { BrowseItem } from '../core/store/browse';

function Item({ icon, mark, label, active, open, onClick }: { icon?: string; mark?: React.ReactNode; label: string; active: boolean; open: boolean; onClick: () => void }) {
  return (
    <li>
      <a onClick={onClick} aria-label={label} title={open ? undefined : label} className={active ? 'active' : ''}>
        {mark || <Icon name={icon || 'circle'} />}<span className="rail__label">{label}</span>
      </a>
    </li>
  );
}

export default function Rail() {
  const nav = useNavigate();
  const loc = useLocation();
  const sources = useBrowse(s => s.sources);
  const current = useBrowse(s => s.currentUri);
  const myVolumio = useMenu(s => s.hasMyVolumio());
  useMenuSources(s => s.choices); useMenuSources(s => s.order);   // a switch in Appearance redraws the rail
  const inMenu = menuSources(sources, useMenuSources.getState().shown, useMenuSources.getState().order);
  const open = useUi(s => s.railOpen);
  // Volumio's own message while it indexes points here: "the icon on bottom left will keep spinning"
  const scanning = usePlayer(s => !!s.state.updatedb);
  // the whole layout (head, page, mini player) follows the rail's width through --rail-w
  useEffect(() => { document.documentElement.classList.toggle('aw-rail-open', open); }, [open]);
  const at = (p: string) => loc.pathname === p;
  const sourceActive = (uri: string) => at('/browse') && current === uri;
  const goSource = (s: BrowseItem) => { useBrowse.getState().open(s, true); nav('/browse'); };
  const goMusic = () => { useBrowse.getState().home(); nav('/browse'); };
  return (
    <div id="main-menu">
      <div className="brand-row">
        <div className="brand" onClick={() => nav('/home')} role="link" tabIndex={0} aria-label="Volumio">V</div>
        <span className="rail__label rail__label--brand">Volumio</span>
      </div>
      <ul className="main-menu-list">
        <Item icon="home" label="Главная" open={open} active={at('/home')} onClick={() => nav('/home')} />
        <Item icon="search" label="Поиск" open={open} active={at('/search')} onClick={() => { useBrowse.getState().setDedicated(true); nav('/search'); const q = useBrowse.getState().searchField; if (q.length >= 2) useBrowse.getState().search(q); }} />
        <Item icon="album" label="Музыка" open={open} active={at('/browse') && !inMenu.some(s => sourceActive(s.uri))} onClick={goMusic} />
        {/* the library's sources switched on in Appearance → Menu (Playlists and Favourites unless switched off) */}
        {inMenu.map(s => <Item key={s.uri} mark={<SourceGlyph source={s} />} label={sourceLabel(s)} open={open} active={sourceActive(s.uri)} onClick={() => goSource(s)} />)}
        <Item icon="graphic_eq" label="Сейчас играет" open={open} active={at('/playback')} onClick={() => nav('/playback')} />
      </ul>
      <ul className="main-menu-bottom">
        {scanning ? (
          <li className="rail__scan">
            <a onClick={() => nav('/plugin/miscellanea-my_music')} aria-label="Обновление медиатеки" title={open ? undefined : 'Обновление медиатеки'}>
              <span className="rail__scan-icon"><Spinner size={20} /></span><span className="rail__label">Обновление медиатеки</span>
            </a>
          </li>
        ) : null}
        {myVolumio && <Item icon="person" label="MyVolumio" open={open} active={loc.pathname.startsWith('/myvolumio')} onClick={() => goToMyVolumio(nav)} />}
        <Item icon="speaker" label="Зоны" open={open} active={at('/multi-room')} onClick={() => nav('/multi-room')} />
        <Item icon="tune" label="Настройки" open={open} active={loc.pathname.startsWith('/settings') || loc.pathname.startsWith('/plugin')} onClick={() => nav('/settings')} />
        <li className="rail__toggle">
          <a onClick={() => useUi.getState().toggleRail()} aria-label={open ? 'Свернуть меню' : 'Развернуть меню'} title={open ? undefined : 'Развернуть меню'} aria-expanded={open}>
            <Icon name={open ? 'left_panel_close' : 'left_panel_open'} /><span className="rail__label">Свернуть</span>
          </a>
        </li>
      </ul>
    </div>
  );
}
