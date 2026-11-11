import { useEffect } from 'react';
import { useQobuzDownloads, refreshQobuzDownloads, cancelQobuzDownload } from '../../core/store/qobuzDownloads';
import Icon from '../Icon';
const labels:Record<string,string>={queued:'В очереди',downloading:'Скачивается',completed:'Сохранено',cancelled:'Отменено',error:'Ошибка'};
const errors:Record<string,string>={DISK_UNAVAILABLE:'Подключи внешний диск',DISK_FULL:'Недостаточно места на диске',DOWNLOAD_FAILED:'Не удалось сохранить файл',INVALID_PATH:'Недопустимый путь',UNAVAILABLE:'FLAC недоступен'};
const size=(n:number)=>`${(n/1024/1024).toFixed(1)} МБ`;
export default function QobuzDownloads() {
  const items=useQobuzDownloads(s=>s.items);
  useEffect(()=>{refreshQobuzDownloads();},[]);
  return <section className="aw-downloads" aria-label="Загрузки Qobuz"><h2>Загрузки Qobuz</h2>
    {!items.length ? <p>В меню трека выбери «Скачать на внешний диск». Файлы сохраняются в qobuz/исполнитель/альбом.</p> : null}
    {[...items].reverse().map(job=><div className="aw-download" key={job.id}>
      <Icon name={job.state==='completed'?'check':'download'}/>
      <div className="aw-download__info"><strong>{job.title || 'Трек '+job.track_id}</strong>
        <span>{job.artist}{job.album ? ` · ${job.album}` : ''}</span>
        <span>{labels[job.state] || job.state} · {size(job.downloaded || 0)}{job.total ? ` / ${size(job.total)}` : ''}
          {job.bitDepth && job.sampleRate ? ` · FLAC ${job.bitDepth} бит / ${job.sampleRate/1000} кГц` : ''}</span>
        {job.state==='downloading' ? <progress max={job.total || undefined} value={job.total ? job.downloaded : undefined}/> : null}
        {job.error_code ? <span role="alert">{errors[job.error_code] || 'Не удалось завершить загрузку'}</span> : null}
      </div>
      {['queued','downloading'].includes(job.state) ? <button className="aw-iconbtn" type="button" aria-label="Отменить загрузку" onClick={()=>cancelQobuzDownload(job.id)}><Icon name="close"/></button> : null}
    </div>)}
  </section>;
}
