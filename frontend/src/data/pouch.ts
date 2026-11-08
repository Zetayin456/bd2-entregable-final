import PouchDB from 'pouchdb-browser';
import PouchFind from 'pouchdb-find';
import type { Documento } from '../domain/tipos';

// @ts-ignore
const dbFactory = PouchDB.default || PouchDB;
dbFactory.plugin(PouchFind);

export const local = new dbFactory<Documento>('reciclaje_local');

export function iniciarSync(token: string, comercioId: string) {
  const remota = new dbFactory<Documento>(`http://localhost:8080/sync/comercio_${comercioId}`, {
    fetch: (url: any, opts: any) => {
      (opts!.headers as Headers).set('Authorization', `Bearer ${token}`);
      return dbFactory.fetch(url, opts);
    },
  });

  return local
    .sync(remota, { live: true, retry: true, batch_size: 100 })
    .on('paused', () => console.log('Sincronización al día.'))
    .on('active', () => console.log('Sincronizando con el servidor...'))
    .on('error', (err: any) => console.error('Error de sincronización:', err));
}