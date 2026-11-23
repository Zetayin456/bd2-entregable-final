import {
  listarPendientes,
  actualizarEstadoCola,
  guardarEnCola
} from './pouch';
const API_URL = 'http://127.0.0.1:3000';

let tokenSesion: string | null = sessionStorage.getItem('token_sesion');
let rolSesion: string | null = sessionStorage.getItem('rol_sesion');
let usuarioSesion: string | null = sessionStorage.getItem('usuario_sesion');

export type ComercioAPI = {
  _id?: string;
  _rev?: string;
  type?: string;
  nombre: string;
  estado: string;
  createdAt?: string;
};

export type SolicitudAPI = {
  _id?: string;
  _rev?: string;
  type?: string;
  comercio_id: string;
  tipo_residuo: string;
  direccion: string;
  cantidad_aproximada: number;
  estado?: string;
  createdAt?: string;
};

export type PesajeAPI = {
  _id?: string;
  _rev?: string;
  type?: string;
  solicitud_id: string;
  comercio_id: string;
  recolector_id: string;
  tipo_residuo: string;
  peso_kg: number;
  estado?: string;
};

export type MovimientoPuntosAPI = {
  _id?: string;
  _rev?: string;
  type?: string;
  comercio_id?: string;
  pesaje_id?: string;
  puntos: number;
  operacion?: string;
};

export type SaldoPuntosAPI = {
  saldo_puntos: number;
  cantidad_movimientos: number;
};

type RespuestaLogin = {
  access_token: string;
  token_type: string;
  expires_in: number;
  rol: string;
};

async function solicitarAPI<T>(
  ruta: string,
  opciones: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(tokenSesion ? { Authorization: `Bearer ${tokenSesion}` } : {}),
    ...(opciones.headers as Record<string, string> | undefined)
  };

  const respuesta = await fetch(`${API_URL}${ruta}`, {
    ...opciones,
    headers
  });

  const texto = await respuesta.text();

  if (!respuesta.ok) {
    throw new Error(texto || `Error del servidor: ${respuesta.status}`);
  }

  return texto ? JSON.parse(texto) as T : {} as T;
}

// ========================
// AUTENTICACIÓN
// ========================

export async function iniciarSesionAPI(usuario: string, contrasena: string) {
  const resultado = await solicitarAPI<RespuestaLogin>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ usuario, contrasena })
  });

  tokenSesion = resultado.access_token;
  rolSesion = resultado.rol;
  usuarioSesion = usuario;

  sessionStorage.setItem('token_sesion', resultado.access_token);
  sessionStorage.setItem('rol_sesion', resultado.rol);
  sessionStorage.setItem('usuario_sesion', usuario);

  return resultado;
}

export function cerrarSesionAPI() {
  tokenSesion = null;
  rolSesion = null;
  usuarioSesion = null;

  sessionStorage.removeItem('token_sesion');
  sessionStorage.removeItem('rol_sesion');
  sessionStorage.removeItem('usuario_sesion');
}

export function haySesionAdmin(): boolean {
  return Boolean(tokenSesion && rolSesion === 'admin_plataforma');
}

export function haySesionRecolector(): boolean {
  return Boolean(tokenSesion && rolSesion === 'recolector');
}

export function obtenerUsuarioSesion(): string | null {
  return usuarioSesion;
}

// ========================
// COMERCIOS
// ========================

type RespuestaComercios = {
  rows?: Array<{ doc?: ComercioAPI }>;
};

export async function listarComerciosAPI(): Promise<ComercioAPI[]> {
  const resultado = await solicitarAPI<RespuestaComercios>('/comercios');

  return (resultado.rows ?? []).reduce<ComercioAPI[]>((lista, fila) => {
    if (fila.doc && fila.doc.type === 'comercio') {
      lista.push(fila.doc);
    }
    return lista;
  }, []);
}

export async function crearComercioAPI(comercio: ComercioAPI) {
  const resultado = await guardarEnCola('comercio', { ...comercio });

  void sincronizarPendientesAPI().catch(console.error);

  return {
    ok: true,
    id: resultado.id,
    rev: resultado.rev,
    pendiente: true
  };
}

// ========================
// SOLICITUDES
// ========================

type RespuestaSolicitudes = {
  docs?: SolicitudAPI[];
};

export async function listarSolicitudesAPI(): Promise<SolicitudAPI[]> {
  const resultado = await solicitarAPI<RespuestaSolicitudes>('/solicitudes');
  return resultado.docs ?? [];
}

export async function crearSolicitudAPI(solicitud: SolicitudAPI) {
  const resultado = await guardarEnCola('solicitud', { ...solicitud });

  void sincronizarPendientesAPI().catch(console.error);

  return {
    ok: true,
    id: resultado.id,
    rev: resultado.rev,
    pendiente: true
  };
}

// ========================
// PESAJES
// ========================

type RespuestaPesajes = {
  docs?: PesajeAPI[];
};

export async function listarPesajesAPI(): Promise<PesajeAPI[]> {
  const resultado = await solicitarAPI<RespuestaPesajes>('/pesajes');
  return resultado.docs ?? [];
}

export async function crearPesajeAPI(pesaje: PesajeAPI) {
  const resultado = await guardarEnCola('pesaje', { ...pesaje });

  void sincronizarPendientesAPI().catch(console.error);

  return {
    ok: true,
    id: resultado.id,
    rev: resultado.rev,
    pendiente: true
  };
}

export async function verificarPesajeAPI(id: string) {
  return solicitarAPI<{ ok: boolean; mensaje?: string; pesaje?: PesajeAPI }>(
    `/pesajes/${encodeURIComponent(id)}/verificar`,
    { method: 'POST' }
  );
}

// ========================
// PUNTOS
// ========================

export async function crearMovimientoPuntosAPI(
  pesaje_id: string,
  puntos: number
) {
  return solicitarAPI<{ ok: boolean; id?: string; rev?: string }>(
    '/puntos',
    {
      method: 'POST',
      body: JSON.stringify({ pesaje_id, puntos })
    }
  );
}

type RespuestaMovimientos = {
  docs?: MovimientoPuntosAPI[];
};

export async function listarMovimientosPuntosAPI(
  comercioId: string
): Promise<MovimientoPuntosAPI[]> {
  const resultado = await solicitarAPI<RespuestaMovimientos>(
    `/comercios/${encodeURIComponent(comercioId)}/puntos/movimientos`
  );

  return resultado.docs ?? [];
}

export async function consultarSaldoAPI(
  comercioId: string
): Promise<SaldoPuntosAPI> {
  return solicitarAPI<SaldoPuntosAPI>(
    `/comercios/${encodeURIComponent(comercioId)}/saldo`
  );
}

// ========================
// SINCRONIZACION OFFLINE
// ========================


export async function sincronizarPendientesAPI() {
  if (!navigator.onLine) {
    return {
      sincronizados: 0,
      pendientes: 0
    };
  }

  const pendientes = await listarPendientes();
  let sincronizados = 0;

  for (const registro of pendientes) {
    try {
      if (registro.tipo_registro === 'movimiento_puntos') {
        await solicitarAPI(
          '/puntos',
          {
            method: 'POST',
            body: JSON.stringify({
              pesaje_id: registro.datos.pesaje_id,
              puntos: registro.datos.puntos
            })
          }
        );
      } else {
        await solicitarAPI(
          `/sincronizar/${encodeURIComponent(registro._id)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              ...registro.datos,
              type_registro: registro.tipo_registro
            })
          }
        );
      }

      await actualizarEstadoCola(
        registro._id,
        'sincronizado'
      );

      sincronizados++;
    } catch (error) {
      const mensaje = error instanceof Error
        ? error.message
        : 'Error desconocido al sincronizar';

      await actualizarEstadoCola(
        registro._id,
        'pendiente',
        mensaje
      );
    }
  }

  const restantes = await listarPendientes();

  return {
    sincronizados,
    pendientes: restantes.length
  };
}

  
