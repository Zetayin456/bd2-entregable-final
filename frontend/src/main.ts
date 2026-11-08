// Usamos la instancia global inyectada por el CDN
const PouchDB = (window as any).PouchDB;


const localDB = new PouchDB('reciclaje_local');

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; background: #f9f9f9; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
    <header style="border-bottom: 2px solid #007bff; padding-bottom: 10px; margin-bottom: 20px;">
      <h1 style="color: #007bff; margin: 0;">Gestión de Residuos y Reciclaje Incentivado</h1>
      <p style="color: #666; margin: 5px 0 0 0;">Universidad de El Salvador - Fase 3 (Sincronización Distribuida)</p>
      <div id="estadoSync" style="margin-top: 8px; font-size: 13px; font-weight: bold; color: #d9534f;">Estado Sync: Desconectado del Backend</div>
    </header>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <section style="background: white; padding: 20px; border-radius: 6px; border: 1px solid #ddd;">
        <h3 style="margin-top: 0; color: #333;">📦 Registrar Pesaje (Local-First)</h3>
        <div style="margin-bottom: 10px;">
          <label style="display: block; font-size: 14px; margin-bottom: 5px;">ID Comercio:</label>
          <input type="text" id="comercioId" value="comercio:7b1e2c10" style="width: 100%; padding: 8px; box-sizing: border-box;" />
        </div>
        <div style="margin-bottom: 10px;">
          <label style="display: block; font-size: 14px; margin-bottom: 5px;">Peso Material (kg):</label>
          <input type="number" id="pesoKg" value="25" style="width: 100%; padding: 8px; box-sizing: border-box;" />
        </div>
        <button id="btnRegistrar" style="background: #28a745; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; width: 100%;">Registrar en IndexedDB</button>
        <p id="mensajeRegistro" style="margin-top: 10px; font-size: 13px; font-weight: bold;"></p>
      </section>

      <section style="background: white; padding: 20px; border-radius: 6px; border: 1px solid #ddd;">
        <h3 style="margin-top: 0; color: #333;">🔄 Sincronización y Puntos</h3>
        <button id="btnConectarSync" style="background: #ffc107; color: #333; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; width: 100%; font-weight: bold; margin-bottom: 10px;">Iniciar Sync con CouchDB</button>
        <button id="btnConsultar" style="background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; width: 100%;">Calcular Puntos Locales</button>
        <div id="resultadoSaldo" style="margin-top: 15px; font-size: 15px; font-weight: bold; color: #333;">Registros locales: 0</div>
      </section>
    </div>
  </div>
`;

document.getElementById('btnRegistrar')?.addEventListener('click', async () => {
  const comercioId = (document.getElementById('comercioId') as HTMLInputElement).value;
  const pesoKg = parseFloat((document.getElementById('pesoKg') as HTMLInputElement).value);
  const msg = document.getElementById('mensajeRegistro');

  const doc = {
    _id: `pesaje:${new Date().toISOString().slice(0, 10)}:${crypto.randomUUID()}`,
    type: 'pesaje',
    comercio_id: comercioId,
    recolector_id: 'recolector:brandon',
    lineas: [{ material: 'carton', peso_kg: pesoKg }],
    estado: 'pendiente_verificacion',
    capturado_en: new Date().toISOString()
  };

  try {
    await localDB.put(doc);
    if (msg) {
      msg.style.color = 'green';
      msg.textContent = `¡Guardado localmente! ID: ${doc._id.slice(0, 20)}...`;
    }
  } catch (err) {
    if (msg) {
      msg.style.color = 'red';
      msg.textContent = `Error: ${err}`;
    }
  }
});

document.getElementById('btnConectarSync')?.addEventListener('click', () => {
  const comercioId = (document.getElementById('comercioId') as HTMLInputElement).value;
  const statusEl = document.getElementById('estadoSync');
  const tokenJWT = 'token_simulado_fase3';

  if (statusEl) {
    statusEl.style.color = '#f0ad4e';
    statusEl.textContent = 'Estado Sync: Conectando con Axum/CouchDB...';
  }

  try {
  const remota = new PouchDB(`http://localhost:8091/sync/comercio_${comercioId}`, {
      fetch: (url: any, opts: any) => {
        (opts!.headers as Headers).set('Authorization', `Bearer ${tokenJWT}`);
        return PouchDB.fetch(url, opts);
      },
    });

    localDB.sync(remota, { live: true, retry: true, batch_size: 100 })
      .on('paused', () => {
        if (statusEl) {
          statusEl.style.color = '#28a745';
          statusEl.textContent = 'Estado Sync: Al día (Sincronizado)';
        }
      })
      .on('active', () => {
        if (statusEl) {
          statusEl.style.color = '#0275d8';
          statusEl.textContent = 'Estado Sync: Sincronizando cambios...';
        }
      })
      .on('error', (err: any) => {
        if (statusEl) {
          statusEl.style.color = '#d9534f';
          statusEl.textContent = `Estado Sync: Error de red / sin conexión (${err.message || 'offline'})`;
        }
      });
  } catch (e) {
    console.error(e);
  }
});

document.getElementById('btnConsultar')?.addEventListener('click', async () => {
  const res = document.getElementById('resultadoSaldo');
  try {
    const allDocs = await localDB.allDocs({ include_docs: true });
    const pesajes = allDocs.rows.filter((r: any) => (r.doc as any)?.type === 'pesaje');
    if (res) {
      res.textContent = `Pesajes persistidos localmente: ${pesajes.length} registro(s)`;
    }
  } catch (err) {
    if (res) {
      res.textContent = `Error al consultar: ${err}`;
    }
  }
});