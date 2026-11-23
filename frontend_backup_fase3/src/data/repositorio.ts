import { local } from './pouch';
import type { Pesaje, LineaPesaje } from '../domain/tipos';

export async function registrarPesajeLocal(
  comercioId: string,
  recolectorId: string,
  lineas: LineaPesaje[]
): Promise<void> {
  const opId = crypto.randomUUID();
  const fecha = new Date().toISOString().slice(0, 10);
  
  const doc: Pesaje = {
    _id: `pesaje:${fecha}:${opId}`,
    type: 'pesaje',
    solicitud_id: `solicitud:${fecha}:demo`,
    comercio_id: comercioId,
    recolector_id: recolectorId,
    lineas,
    estado: 'pendiente_verificacion',
    capturado_en: new Date().toISOString(),
    dispositivo: 'web-client'
  };

  await local.put(doc);
  console.log('Pesaje registrado localmente con éxito (Offline-First).');
}

export async function consultarSaldoLocal(comercioId: string): Promise<number> {
  try {
    const r = await local.find({
      selector: { type: 'movimiento_puntos', comercio_id: comercioId }
    });
    return r.docs.reduce((acc: number, d: any) => acc + (d.puntos || 0), 0);
  } catch (e) {
    console.error('Error consultando saldo local:', e);
    return 0;
  }
}