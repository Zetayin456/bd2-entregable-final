
import PouchDB from 'pouchdb-browser';

// Base de datos local del navegador
export const db = new PouchDB('sistema_reciclaje_local');

// Guardar documentos
export async function guardarDocumento(
  documento: Record<string, unknown>
) {
  return await db.post(documento);
}

// Consultar documentos
export async function listarDocumentos() {
  const resultado = await db.allDocs({
    include_docs: true
  });

  return resultado.rows.map(fila => fila.doc);
}
