import PouchDB from 'pouchdb-browser';

const db = new PouchDB('sistema_reciclaje_local');

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>Sistema de Gestión de Residuos y Reciclaje</h1>
  <p>Prueba de conexión con PouchDB</p>

  <button id="guardar">Guardar comercio</button>
  <button id="consultar">Consultar comercios</button>

  <pre id="resultado"></pre>
`;

const resultado = document.querySelector<HTMLPreElement>('#resultado')!;

document.querySelector('#guardar')!.addEventListener('click', async () => {
  try {
    const respuesta = await db.post({
      type: 'comercio',
      nombre: 'Comercio de prueba',
      estado: 'activo'
    });

    resultado.textContent = 'Guardado correctamente. ID: ' + respuesta.id;
  } catch (error) {
    resultado.textContent = 'Error: ' + String(error);
  }
});

document.querySelector('#consultar')!.addEventListener('click', async () => {
  try {
    const documentos = await db.allDocs({ include_docs: true });
    resultado.textContent = JSON.stringify(documentos.rows, null, 2);
  } catch (error) {
    resultado.textContent = 'Error: ' + String(error);
  }
});