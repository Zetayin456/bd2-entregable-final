import type { ChangesResponse, Documento, LoginResponse, Rol, SaldoPuntos, SaveResponse, SyncPage, TipoDocumento } from '../domain/tipos';

const baseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const tokenKey = 'reciclaje.jwt';
const roleKey = 'reciclaje.role';
const commerceKey = 'reciclaje.comercio';
const userKey = 'reciclaje.user';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'ApiError'; }
}

export const sesion = {
  get token() { return localStorage.getItem(tokenKey); },
  get role() { return localStorage.getItem(roleKey) as Rol | null; },
  get comercioId() { return localStorage.getItem(commerceKey); },
  get username() { return localStorage.getItem(userKey); },
  save(result: LoginResponse) { localStorage.setItem(tokenKey, result.token); localStorage.setItem(roleKey, result.role); localStorage.setItem(userKey, result.username); if (result.comercio_id) localStorage.setItem(commerceKey, result.comercio_id); else localStorage.removeItem(commerceKey); },
  clear() { localStorage.removeItem(tokenKey); localStorage.removeItem(roleKey); localStorage.removeItem(commerceKey); localStorage.removeItem(userKey); }
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (sesion.token) headers.set('Authorization', `Bearer ${sesion.token}`);
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) }); }
  catch { throw new ApiError('No se pudo conectar con el servidor. Revisa que la API esté disponible.', 0); }
  if (!response.ok) {
    const messages: Record<number, string> = { 400: 'Revisa los datos enviados.', 401: 'Inicia sesión para continuar.', 403: 'Tu rol no tiene permiso para esta acción.', 404: 'No se encontró el registro.', 409: 'El registro cambió; actualiza la lista y vuelve a intentar.', 503: 'El servidor de datos no está disponible.' };
    const payload = await response.json().catch(() => ({})) as { message?: unknown; error?: unknown };
    const message = typeof payload.message === 'string' ? payload.message : messages[response.status] ?? 'La solicitud no pudo completarse.';
    throw new ApiError(message, response.status, typeof payload.error === 'string' ? payload.error : undefined);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  login(username: string, password: string) {
    return request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  },
  list<T extends Documento>(type: TipoDocumento, bookmark?: string) {
    const cursor = bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : '';
    return request<SyncPage<T>>(`/api/docs?type=${encodeURIComponent(type)}${cursor}`);
  },
  get<T extends Documento>(id: string) {
    return request<T>(`/api/docs/${encodeURIComponent(id)}`);
  },
  changes(since: string) {
    return request<ChangesResponse>(`/api/changes?since=${encodeURIComponent(since)}`);
  },
  saldoPuntos(comercioId?: string) {
    const query = comercioId ? `?comercio_id=${encodeURIComponent(comercioId)}` : '';
    return request<SaldoPuntos>(`/api/points/balance${query}`);
  },
  save<T extends Documento>(doc: T) {
    return request<SaveResponse>(`/api/docs/${encodeURIComponent(doc._id)}`, { method: 'PUT', body: JSON.stringify(doc) });
  }
};
