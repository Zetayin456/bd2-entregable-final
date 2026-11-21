export type Rol = 'admin_plataforma' | 'operador_acopio' | 'recolector' | 'comercio';
export type TipoDocumento = 'comercio' | 'solicitud_recoleccion' | 'pesaje' | 'movimiento_puntos';
export type EstadoPesaje = 'pendiente_verificacion' | 'verificado';

export interface DocumentoBase {
  _id: string;
  _rev?: string;
  type: TipoDocumento;
}

export interface Comercio extends DocumentoBase {
  type: 'comercio'; nombre: string; giro?: string; zona?: string;
  activo?: boolean; creado_en?: string; estado?: string;
}

export interface SolicitudRecoleccion extends DocumentoBase {
  type: 'solicitud_recoleccion'; comercio_id: string; estado: string;
  creada_en?: string; fecha_solicitada?: string; observaciones?: string;
}

export interface LineaPesaje { material: string; peso_kg: number }
export interface Pesaje extends DocumentoBase {
  type: 'pesaje'; solicitud_id?: string; comercio_id: string;
  recolector_id: string; lineas: LineaPesaje[]; estado: EstadoPesaje;
  capturado_en: string; verificado_en?: string;
}

export interface MovimientoPuntos extends DocumentoBase {
  type: 'movimiento_puntos'; comercio_id: string; origen?: string;
  puntos: number; concepto: 'acreditacion' | 'canje'; creado_en?: string;
}

export type Documento = Comercio | SolicitudRecoleccion | Pesaje | MovimientoPuntos;
export interface LoginResponse { token: string; role: Rol; comercio_id?: string | null; expires_in: number }
export interface DocumentsResponse<T extends Documento = Documento> { docs: T[] }
