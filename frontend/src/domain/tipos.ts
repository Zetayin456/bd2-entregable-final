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
  creada_en?: string; fecha_solicitada?: string; observaciones?: string; recolector_id?: string;
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
  pesaje_id?: string; regla_version?: number;
}

export interface Recompensa { _id: string; type: 'recompensa'; nombre: string; descripcion?: string; costo_puntos: number; activo: boolean }

export type Documento = Comercio | SolicitudRecoleccion | Pesaje | MovimientoPuntos;
export interface LoginResponse { token: string; username: string; role: Rol; comercio_id?: string | null; expires_in: number }
export interface DocumentsResponse<T extends Documento = Documento> { docs: T[] }
export interface SyncPage<T extends Documento = Documento> { docs: T[]; bookmark?: string | null; has_more?: boolean }
export interface SaveResponse { ok: boolean; rev: string }
export interface ChangesResponse { results: Array<{ seq: unknown; id: string; doc?: Documento & { _deleted?: boolean } }>; last_seq: unknown; has_more: boolean }
export interface SaldoPuntos { comercio_id: string; saldo: number; movimientos: MovimientoPuntos[] }
