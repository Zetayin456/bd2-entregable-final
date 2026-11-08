import PouchDB from 'pouchdb-browser';
import PouchFind from 'pouchdb-find';

PouchDB.plugin(PouchFind);

// Instancia local de la base de datos IndexedDB
export const localDB = new PouchDB('reciclaje_local');

// Función de sincronización con CouchDB a través del Backend en Rust (Fase 3)
export function conectarReplicacion(tokenJWT: string, comercioId: string) {
  const remota = new PouchDB(\http://localhost:8080/sync/comercio_\\, {
    fetch: (url, opts) => {
      (opts!.headers as Headers).set('Authorization', \Bearer \\);
      return PouchDB.fetch(url, opts);
    },
  });

  return localDB.sync(remota, { live: true, retry: true, batch_size: 100 })
    .on('paused', () => console.log('Sincronización al día con CouchDB'))
    .on('active', () => console.log('Sincronizando cambios con CouchDB...'))
    .on('denied', (err) => console.error('Escritura rechazada por política de seguridad:', err))
    .on('error', (err) => console.error('Error de conexión/red en sincronización:', err));
}
