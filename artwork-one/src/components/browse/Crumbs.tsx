import { sourceLabel } from '../navigationLabels';
/** The breadcrumb trail in every page head: Library / …the pages walked through… / here. */
import type { BrowseItem } from '../../core/store/browse';

export default function Crumbs({ trail, current, root, onHome, onCrumb }: { trail?: BrowseItem[]; current?: string; root?: string; onHome?: () => void; onCrumb?: (c: BrowseItem) => void }) {
  return (
    <nav className="aw-crumbs" aria-label="Навигация">
      <a onClick={onHome}>{root || 'Медиатека'}</a>
      {(trail || []).map((c, i) => [<span key={'s' + i} className="aw-crumbs__sep">/</span>, <a key={'c' + i} onClick={() => onCrumb && onCrumb(c)}>{sourceLabel(c)}</a>])}
      {current ? <span className="aw-crumbs__sep">/</span> : null}
      <span className="aw-crumbs__cur">{current}</span>
    </nav>
  );
}
