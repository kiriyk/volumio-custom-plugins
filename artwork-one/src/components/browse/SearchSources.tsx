import { useBrowse } from '../../core/store/browse';
import { searchableSources } from '../../core/searchSources';

export default function SearchSources() {
  const sources = useBrowse(s => s.sources);
  const selected = useBrowse(s => s.searchScope);
  return <div className="aw-search-sources" role="group" aria-label="Источники поиска">
    <button type="button" aria-pressed={!selected} className={!selected ? 'active' : ''} onClick={() => useBrowse.getState().setSearchScope(null)}>Все источники</button>
    {searchableSources(sources).map(source => <button key={source.uri} type="button"
      aria-pressed={selected?.uri === source.uri} className={selected?.uri === source.uri ? 'active' : ''}
      onClick={() => useBrowse.getState().setSearchScope(source)}>{source.name || source.title}</button>)}
  </div>;
}
