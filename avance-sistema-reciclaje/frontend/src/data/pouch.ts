import PouchDB from 'pouchdb-browser';

// Base de datos local existente
export const db = new PouchDB('sistema_reciclaje_local');

// Base de datos independiente para la cola offline
export const colaDB = new PouchDB('sistema_reciclaje_cola');

export type TipoRegistro = 'comercio' | 'solicitud' | 'pesaje' | 'movimiento_puntos';

export type EstadoSincronizacion =
  | 'pendiente'
  | 'sincronizado'
  | 'rechazado';

export interface DocumentoCola {
  _id: string;
  _rev?: string;
  tipo_registro: TipoRegistro;
  datos: Record<string, unknown>;
  estado_sync: EstadoSincronizacion;
  intentos: number;
  creado_local: string;
  ultimo_error?: string;
}

// Guardar documentos en la base local existente
export async function guardarDocumento(
  documento: Record<string, unknown>
) {
  return await db.post(documento);
}

// Consultar documentos de la base local existente
export async function listarDocumentos() {
  const resultado = await db.allDocs({
    include_docs: true
  });

  return resultado.rows
    .map(fila => fila.doc)
    .filter(Boolean);
}

// Agregar un registro a la cola offline
export async function guardarEnCola(
  tipo: TipoRegistro,
  documento: Record<string, unknown>
) {
  const registro: DocumentoCola = {
    _id: `cola_${crypto.randomUUID()}`,
    tipo_registro: tipo,
    datos: documento,
    estado_sync: 'pendiente',
    intentos: 0,
    creado_local: new Date().toISOString()
  };

  return await colaDB.put(registro);
}

// Listar todos los registros de la cola
export async function listarCola(): Promise<DocumentoCola[]> {
  const resultado = await colaDB.allDocs({
    include_docs: true
  });

  return resultado.rows
    .map(fila => fila.doc)
    .filter(Boolean) as DocumentoCola[];
}

// Consultar solamente los registros pendientes
export async function listarPendientes(): Promise<DocumentoCola[]> {
  const registros = await listarCola();

  return registros.filter(
    registro => registro.estado_sync === 'pendiente'
  );
}

// Cambiar el estado de un registro de la cola
export async function actualizarEstadoCola(
  id: string,
  estado: EstadoSincronizacion,
  error?: string
) {
  const registro = await colaDB.get(id) as DocumentoCola;

  registro.estado_sync = estado;
  registro.intentos += 1;

  if (error) {
    registro.ultimo_error = error;
  } else {
    delete registro.ultimo_error;
  }

  return await colaDB.put(registro);
}

// Eliminar un registro de la cola cuando corresponda
export async function eliminarDeCola(id: string) {
  const registro = await colaDB.get(id);
  return await colaDB.remove(registro);
}

