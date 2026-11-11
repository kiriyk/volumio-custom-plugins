import { create } from 'zustand';
import { emit, on } from '../socket';
interface Download { id:string;track_id:string;title:string;artist:string;album:string;state:string;downloaded:number;total:number|null;error_code:string|null;path:string|null;sampleRate?:number;bitDepth?:number }
export const useQobuzDownloads = create<{items:Download[]}>()(() => ({items:[]}));
on('pushQobuzDownloads', data => useQobuzDownloads.setState({items:Array.isArray(data?.items) ? data.items : []}));
export function downloadQobuz(uri:string) { emit('callMethod',{endpoint:'music_service/qobuz_custom',method:'downloadTrack',data:{uri}}); }
export function cancelQobuzDownload(id:string) { emit('callMethod',{endpoint:'music_service/qobuz_custom',method:'cancelDownload',data:{id}}); }
export function refreshQobuzDownloads() { emit('callMethod',{endpoint:'music_service/qobuz_custom',method:'getDownloads',data:{}}); }
