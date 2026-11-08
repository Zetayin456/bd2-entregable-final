export type TipoDocumento = 'comercio' | 'solicitud_recoleccion' | 'pesaje' | 'movimiento_puntos';

export interface Comercio {
  _id: string;
  type: 'comercio';
  nombre: string;
  giro: string;
  zona: string;
  activo: boolean;
  creado_en: string;
}

export interface LineaPesaje {
  material: string;
  peso_kg: number;
}

export interface Pesaje {
  _id: string;
  type: 'pesaje';
  solicitud_id: string;
  comercio_id: string;
  recolector_id: string;
  lineas: LineaPesaje[];
  estado: 'pendiente_verificacion' | 'verificado';
  capturado_en: string;
  dispositivo?: string;
}

export interface MovimientoPuntos {
  _id: string;
  type: 'movimiento_puntos';
  comercio_id: string;
  origen: string;
  puntos: number;
  concepto: 'acreditacion' | 'canje';
  creado_en: string;
}

export type Documento = Comercio | Pesaje | MovimientoPuntos;