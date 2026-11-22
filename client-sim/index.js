import PouchDB from 'pouchdb';
import { randomUUID } from 'node:crypto';

const mode = process.env.SIM_MODE || 'idle';
const apiUrl = (process.env.API_URL || 'http://api:8080').replace(/\/$/, '');

if (mode !== 'offline-sync') {
  const clients = Number.parseInt(process.env.SIM_CLIENTS || '100', 10);
  console.log(`[Simulador] ${clients} clientes listos. Usa SIM_MODE=offline-sync para probar cola y sincronización real.`);
  const db = new PouchDB('sim_local_db');
  setInterval(() => void db.info(), 30_000);
} else {
  const username = process.env.SIM_ADMIN_USER;
  const password = process.env.SIM_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('Define SIM_ADMIN_USER y SIM_ADMIN_PASSWORD para la prueba offline.');

  const db = new PouchDB(`offline_sync_${randomUUID()}`);
  const suffix = randomUUID();
  const commerceId = `comercio:offline-${suffix}`;
  const requestId = `solicitud:offline-${suffix}`;
  const pending = [
    { _id: commerceId, type: 'comercio', nombre: 'Comercio de prueba offline', zona: 'Simulación', activo: true, creado_en: new Date().toISOString() },
    { _id: requestId, type: 'solicitud_recoleccion', comercio_id: commerceId, estado: 'pendiente', observaciones: 'Creada sin conexión; sincronización de prueba.', creada_en: new Date().toISOString() },
  ].map(doc => ({ ...doc, sync_status: 'pending', offline_created_at: new Date().toISOString() }));

  // During this phase the PouchDB queue is populated and no HTTP request is made.
  await db.bulkDocs(pending);
  const queued = await db.allDocs({ include_docs: true });
  if (queued.rows.length !== pending.length || queued.rows.some(row => row.doc.sync_status !== 'pending')) {
    throw new Error('La cola local offline no conservó todos los documentos pendientes.');
  }
  console.log(`OFFLINE: ${queued.rows.length} documentos guardados localmente sin conexión.`);

  const login = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`No se pudo autenticar contra la API (${login.status}).`);
  const { token } = await login.json();

  // Reconnection: replay the queued documents through the same API contract as the web client.
  for (const row of queued.rows) {
    const local = row.doc;
    const { _rev, sync_status, offline_created_at, ...document } = local;
    const response = await fetch(`${apiUrl}/api/docs/${encodeURIComponent(document._id)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(document),
    });
    if (!response.ok) throw new Error(`Falló sincronización de ${document._id} (${response.status}): ${await response.text()}`);
    const saved = await response.json();
    await db.put({ ...local, remote_rev: saved.rev, sync_status: 'synced' });
  }

  for (const document of pending) {
    const response = await fetch(`${apiUrl}/api/docs/${encodeURIComponent(document._id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`El documento sincronizado ${document._id} no se pudo recuperar (${response.status}).`);
  }
  const final = await db.allDocs({ include_docs: true });
  if (final.rows.some(row => row.doc.sync_status !== 'synced')) throw new Error('Quedaron documentos pendientes después de reconectar.');
  console.log(`PASS: ${final.rows.length} documentos offline sincronizados y verificados en CouchDB a través de la API.`);
  await db.destroy();
}
