import PouchDB from 'pouchdb-browser';
import { api, ApiError, sesion } from './api';
import type { Documento, TipoDocumento } from '../domain/tipos';

export type EstadoSync = 'connected' | 'offline' | 'pending' | 'syncing' | 'error';
export type DocumentoLocal<T extends Documento = Documento> = T & {
  remote_rev?: string;
  sync_status?: 'pending' | 'synced' | 'conflict' | 'rejected';
  local_modified_at?: string;
  sync_error?: string;
  conflict_remote?: DocumentoLocal;
};
type PersistedLocal = DocumentoLocal & { _rev: string };
export interface SyncSnapshot { state: EstadoSync; pending: number; conflicts: number; rejected: number; lastSync?: string; message: string }

const localDbName = () => {
  if(sesion.role==='admin_plataforma')return 'sistema_reciclaje_local';
  if(!sesion.role||!sesion.username)return 'sistema_reciclaje_guest';
  const suffix=[sesion.role,sesion.username,sesion.comercioId??''].map(value=>encodeURIComponent(value)).join('_');
  return `sistema_reciclaje_local_${suffix}`;
};
let activeDbName=localDbName();
export let db = new PouchDB<DocumentoLocal>(activeDbName);
const listeners = new Set<(snapshot: SyncSnapshot) => void>();
let running: Promise<void> | null = null;
let snapshot: SyncSnapshot = { state: !navigator.onLine ? 'offline' : sesion.token ? 'connected' : 'pending', pending: 0, conflicts: 0, rejected: 0, message: !navigator.onLine ? 'Sin conexión' : sesion.token ? 'Conectado' : 'Inicia sesión para sincronizar' };
let timer: number | undefined;
let onlineHandlersInstalled = false;

export async function cambiarAlmacenPorSesion() {
  if(running)await running;
  const nextName=localDbName();
  if(nextName===activeDbName)return;
  await db.close();
  activeDbName=nextName;
  db=new PouchDB<DocumentoLocal>(activeDbName);
  await refreshCounts();
}

async function allLocal() {
  const result = await db.allDocs({ include_docs: true });
  return result.rows.map(row => row.doc).filter((doc): doc is PersistedLocal => Boolean(doc && 'type' in doc));
}
async function refreshCounts() {
  const docs = await allLocal();
  snapshot = { ...snapshot, pending: docs.filter(d => d.sync_status === 'pending').length, conflicts: docs.filter(d => d.sync_status === 'conflict').length, rejected: docs.filter(d => d.sync_status === 'rejected').length };
  publish();
}
function publish() { for (const listener of listeners) listener({ ...snapshot }); }
function setState(state: EstadoSync, message: string) { snapshot = { ...snapshot, state, message }; publish(); }
function defined<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
export function observarSync(listener: (value: SyncSnapshot) => void) { listeners.add(listener); listener({ ...snapshot }); return () => listeners.delete(listener); }
export async function listarDocumentos<T extends Documento>(type?: TipoDocumento): Promise<DocumentoLocal<T>[]> {
  const docs = await allLocal();
  return docs.filter(doc => !type || doc.type === type) as DocumentoLocal<T>[];
}

export async function guardarLocal<T extends Documento>(document: T): Promise<void> {
  const previous = await db.get(document._id).catch(() => undefined);
  const next = { ...previous, ...document, ...(previous?._rev ? { _rev: previous._rev } : {}), remote_rev: previous?.remote_rev ?? ('remote_rev' in document ? document.remote_rev as string | undefined : undefined), sync_status: 'pending' as const, sync_error: undefined, local_modified_at: new Date().toISOString() } as DocumentoLocal;
  await (db.put as unknown as (value: DocumentoLocal) => Promise<unknown>)(next);
  await refreshCounts();
}

async function putRemote(local: DocumentoLocal): Promise<void> {
  const body = { ...local } as Record<string, unknown>;
  delete body.remote_rev; delete body.sync_status; delete body.local_modified_at; delete body.sync_error; delete body.conflict_remote;
  if (local.remote_rev) body._rev = local.remote_rev; else delete body._rev;
  try {
    const result = await api.save(body as unknown as Documento);
    const current = await db.get(local._id);
    const changedAgain=current.local_modified_at!==local.local_modified_at;
    await db.put(defined({ ...current, remote_rev: result.rev, sync_status: changedAgain?'pending' as const:'synced' as const, sync_error: undefined, conflict_remote: undefined }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const latest = await pullOne(local._id);
      const current = await db.get(local._id);
      if (latest && sameBusinessData(current, latest)) {
        await db.put(defined({ ...current, remote_rev: latest.remote_rev, sync_status: 'synced' as const, sync_error: undefined, conflict_remote: undefined }));
      } else {
        await db.put(defined({ ...current, sync_status: 'conflict' as const, sync_error: 'El servidor contiene una revisión distinta.', conflict_remote: latest }));
      }
      return;
    }
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      const current = await db.get(local._id).catch(() => undefined);
      if (current) await db.put(defined({ ...current, sync_status: 'rejected' as const, sync_error: error.message }));
    }
    throw error;
  }
}

function sameBusinessData(a: DocumentoLocal, b: DocumentoLocal): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
  const clean = (doc: DocumentoLocal) => { const value = { ...doc } as Record<string, unknown>; for (const key of ['_rev','remote_rev','sync_status','local_modified_at','sync_error','conflict_remote']) delete value[key]; return JSON.stringify(canonical(value)); };
  return clean(a) === clean(b);
}

async function pullOne(id: string): Promise<DocumentoLocal | undefined> {
  try { return toLocal(await api.get(id)); } catch (error) { if(error instanceof ApiError&&error.status===404)return undefined;throw error; }
}

function toLocal<T extends Documento>(remote: T): DocumentoLocal<T> {
  const { _rev, ...body } = remote;
  return { ...body, remote_rev: _rev, sync_status: 'synced' } as DocumentoLocal<T>;
}

const cursorId = () => `_local/sync-${encodeURIComponent(sesion.role ?? 'sin-rol')}-${encodeURIComponent(sesion.username ?? sesion.token?.slice(0, 24) ?? 'anonymous')}-${encodeURIComponent(sesion.comercioId ?? 'global')}`;
async function readCursor(): Promise<string> {
  try { const state=await (db as any).get(cursorId()) as { last_seq?: string }; return state.last_seq ?? '0'; } catch { return '0'; }
}
async function saveCursor(lastSeq: unknown): Promise<void> {
  const id=cursorId();
  const previous=await (db as any).get(id).catch(()=>({_id:id})) as { _id:string; _rev?:string };
  await (db as any).put({ ...previous, _id:id, last_seq:encodeSequence(lastSeq) });
}
function encodeSequence(value:unknown):string { return typeof value==='string'?value:JSON.stringify(value)??'0'; }
async function migrateOldRecords() {
  for(const doc of await allLocal()) if(!doc.sync_status) await db.put({ ...doc, sync_status:'pending', local_modified_at:new Date().toISOString() });
}
async function pullChanges() {
  let since=await readCursor();
  for(;;){
    const page=await api.changes(since);
    for(const change of page.results){
      const remote=change.doc;
      if(!remote)continue;
      const existing=await db.get(change.id).catch(()=>undefined);
      if(remote._deleted){if(existing&&existing.sync_status==='synced')await db.remove(existing);continue;}
      if(!('type' in remote))continue;
      const incoming=toLocal(remote as Documento);
      if(existing?.sync_status==='pending'||existing?.sync_status==='conflict'||existing?.sync_status==='rejected')continue;
      if(existing?.remote_rev===incoming.remote_rev)continue;
      await db.put({ ...existing, ...incoming, ...(existing?._rev?{_rev:existing._rev}:{}) });
    }
    await saveCursor(page.last_seq);
    since=encodeSequence(page.last_seq);
    if(!page.has_more)break;
  }
}

export async function sincronizar(): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      await migrateOldRecords();
      if (!navigator.onLine) { await refreshCounts(); setState('offline', 'Sin conexión. Los cambios quedan guardados localmente.'); return; }
      if (!sesion.token) { await refreshCounts(); setState('pending', 'Inicia sesión para sincronizar.'); return; }
      setState('syncing', 'Sincronizando cambios locales y remotos…');
      const pendingDocs = (await allLocal()).filter(doc => doc.sync_status === 'pending');
      pendingDocs.sort((left, right) => (left.type === 'pesaje' ? 0 : 1) - (right.type === 'pesaje' ? 0 : 1));
      for (const doc of pendingDocs) await putRemote(doc);
      await pullChanges();
      snapshot = { ...snapshot, state: 'connected', lastSync: new Date().toISOString(), message: 'Sincronización al día' };
      await refreshCounts();
    } catch (error) {
      await refreshCounts();
      if (error instanceof ApiError && error.status === 401) { setState('error', 'La sesión venció. Inicia sesión nuevamente.'); }
      else if (!navigator.onLine || (error instanceof ApiError && error.status === 0)) setState('error', 'No se pudo contactar la API; hay cambios locales pendientes.');
      else setState('error', error instanceof ApiError ? error.message : 'Error al sincronizar.');
    }
  })().finally(() => { running = null; if(snapshot.state==='connected'&&snapshot.pending>0&&navigator.onLine&&sesion.token)window.setTimeout(()=>void sincronizar(),100); });
  return running;
}

export async function resolverConflicto(id: string, choice: 'local' | 'remote') {
  const local = await db.get(id);
  if (local.sync_status !== 'conflict') return;
  if (choice === 'remote') {
    if(!local.conflict_remote)return;
    const remote = local.conflict_remote;
    await db.put(defined({ ...remote, _id: id, _rev: local._rev, sync_status: 'synced' as const, sync_error: undefined, conflict_remote: undefined }));
  } else {
    await db.put(defined({ ...local, remote_rev: local.conflict_remote?.remote_rev, sync_status: 'pending' as const, sync_error: undefined, conflict_remote: undefined }));
  }
  await refreshCounts();
  if (choice === 'local') await sincronizar();
}

export function iniciarSincronizacion() {
  if (timer) window.clearInterval(timer);
  void sincronizar();
  timer = window.setInterval(() => void sincronizar(), 30_000);
  if (!onlineHandlersInstalled) {
    onlineHandlersInstalled = true;
    window.addEventListener('online', () => { setState('pending', 'Conexión recuperada; sincronizando…'); void sincronizar(); });
    window.addEventListener('offline', () => { setState('offline', 'Sin conexión. Los cambios quedan guardados localmente.'); });
  }
}
