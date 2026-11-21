import type { DocumentsResponse, Documento, LoginResponse, Rol, TipoDocumento } from '../domain/tipos';

const baseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const tokenKey = 'reciclaje.jwt';
const roleKey = 'reciclaje.role';
const commerceKey = 'reciclaje.comercio';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

export const sesion = {
  get token() { return localStorage.getItem(tokenKey); },
  get role() { return localStorage.getItem(roleKey) as Rol | null; },
  get comercioId() { return localStorage.getItem(commerceKey); },
  save(result: LoginResponse) { localStorage.setItem(tokenKey, result.token); localStorage.setItem(roleKey, result.role); if (result.comercio_id) localStorage.setItem(commerceKey, result.comercio_id); else localStorage.removeItem(commerceKey); },
  clear() { localStorage.removeItem(tokenKey); localStorage.removeItem(roleKey); localStorage.removeItem(commerceKey); }
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (sesion.token) headers.set('Authorization', `Bearer ${sesion.token}`);
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...init, headers }); }
  catch { throw new ApiError('No se pudo conectar con el servidor. Revisa que la API esté disponible.', 0); }
  if (!response.ok) {
    const messages: Record<number, string> = { 400: 'Revisa los datos enviados.', 401: 'Inicia sesión para continuar.', 403: 'Tu rol no tiene permiso para esta acción.', 404: 'No se encontró el registro.', 409: 'El registro cambió; actualiza la lista y vuelve a intentar.', 503: 'El servidor de datos no está disponible.' };
    throw new ApiError(messages[response.status] ?? 'La solicitud no pudo completarse.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  login(username: string, password: string) {
    return request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  },
  list<T extends Documento>(type: TipoDocumento) {
    return request<DocumentsResponse<T>>(`/api/docs?type=${encodeURIComponent(type)}`);
  },
  save<T extends Documento>(doc: T) {
    return request<{ ok: boolean }>(`/api/docs/${encodeURIComponent(doc._id)}`, { method: 'PUT', body: JSON.stringify(doc) });
  }
};
