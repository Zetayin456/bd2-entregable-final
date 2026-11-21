import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const apiBase = (process.env.API_BASE_URL || 'http://localhost:8091').replace(/\/$/, '');
const envText = await readFile(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
const adminName = env.BOOTSTRAP_ADMIN_USER;
const adminPassword = env.BOOTSTRAP_ADMIN_PASSWORD;
assert.ok(adminName && adminPassword, 'Faltan BOOTSTRAP_ADMIN_USER o BOOTSTRAP_ADMIN_PASSWORD en .env');

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function expectStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: esperado HTTP ${expected}, recibido ${result.status} (${JSON.stringify(result.data)})`);
}

async function login(username, password, expected = 200) {
  const result = await call('/auth/login', { method: 'POST', body: { username, password } });
  expectStatus(result, expected, `login ${username}`);
  return result.data.token;
}

async function save(token, doc, expected = 201) {
  const result = await call(`/api/docs/${encodeURIComponent(doc._id)}`, { method: 'PUT', token, body: doc });
  expectStatus(result, expected, `guardar ${doc._id}`);
  return result.data;
}

async function createUser(token, username, role, comercio_id, password) {
  const result = await call('/api/users', {
    method: 'POST', token,
    body: { username, password, role, ...(comercio_id ? { comercio_id } : {}) },
  });
  expectStatus(result, 201, `crear usuario ${role}`);
}

const adminLogin = await call('/auth/login', { method: 'POST', body: { username: adminName, password: 'contraseña-incorrecta' } });
expectStatus(adminLogin, 401, 'rechazo de contraseña incorrecta');
const noToken = await call('/api/docs?type=comercio');
expectStatus(noToken, 401, 'protección de ruta sin sesión');
const admin = await login(adminName, adminPassword);
const suffix = randomUUID();
const commerceId = `comercio:e2e-${suffix}`;
const otherCommerceId = `comercio:e2e-otro-${suffix}`;
const operatorName = `e2e_operador_${suffix.slice(0, 8)}`;
const collectorName = `e2e_recolector_${suffix.slice(0, 8)}`;
const commerceName = `e2e_comercio_${suffix.slice(0, 8)}`;
const otherCommerceName = `e2e_otro_${suffix.slice(0, 8)}`;
const password = `E2e-${suffix}-Aa9!`;

await save(admin, { _id: commerceId, type: 'comercio', nombre: 'Comercio de integración', activo: true });
await save(admin, { _id: otherCommerceId, type: 'comercio', nombre: 'Otro comercio de integración', activo: true });
await createUser(admin, operatorName, 'operador_acopio', undefined, password);
await createUser(admin, collectorName, 'recolector', undefined, password);
await createUser(admin, commerceName, 'comercio', commerceId, password);
await createUser(admin, otherCommerceName, 'comercio', otherCommerceId, password);
const operator = await login(operatorName, password);
const collector = await login(collectorName, password);
const commerce = await login(commerceName, password);
const otherCommerce = await login(otherCommerceName, password);

const operatorCannotCreateUser = await call('/api/users', { method: 'POST', token: operator, body: { username: `denegado_${suffix}`, password, role: 'recolector' } });
expectStatus(operatorCannotCreateUser, 403, 'RBAC de creación de usuario');
expectStatus(await call(`/api/docs/${encodeURIComponent(commerceId)}`, { token: commerce }), 200, 'lectura del comercio propio');
expectStatus(await call(`/api/docs/${encodeURIComponent(commerceId)}`, { token: otherCommerce }), 403, 'aislamiento entre comercios');
const commerceList = await call('/api/docs?type=comercio', { token: commerce });
expectStatus(commerceList, 200, 'listado API para integración frontend-backend');
assert.ok(commerceList.data.docs.some((doc) => doc._id === commerceId));
assert.ok(!commerceList.data.docs.some((doc) => doc._id === otherCommerceId), 'el listado no debe exponer otros comercios');
expectStatus(await call('/api/changes?since=0', { token: commerce }), 200, 'endpoint incremental de sincronización');

const requestId = `solicitud:e2e-${suffix}`;
let request = { _id: requestId, type: 'solicitud_recoleccion', comercio_id: commerceId, estado: 'pendiente', creada_en: new Date().toISOString() };
let result = await save(commerce, request);
request._rev = result.rev;

const pendingWeighing = {
  _id: `pesaje:e2e-espera-${suffix}`, type: 'pesaje', comercio_id: commerceId,
  solicitud_id: requestId, lineas: [{ material: 'carton', peso_kg: 10 }],
  estado: 'pendiente_verificacion', capturado_en: new Date().toISOString(),
};
result = await save(collector, pendingWeighing, 409);
assert.equal(result.data.error, 'solicitud_no_aprobada');

result = await save(operator, { ...request, estado: 'aprobada' });
request = { ...request, _rev: result.rev, estado: 'aprobada' };
result = await save(operator, { ...request, estado: 'asignada', recolector_id: collectorName });
request = { ...request, _rev: result.rev, estado: 'asignada', recolector_id: collectorName };

const badTransition = await save(commerce, { ...request, estado: 'completada' }, 409);
assert.equal(badTransition.data.error, 'transicion_estado_invalida');

const weighing = {
  _id: `pesaje:e2e-${suffix}`, type: 'pesaje', comercio_id: commerceId,
  solicitud_id: requestId, lineas: [{ material: 'carton', peso_kg: 10 }],
  estado: 'pendiente_verificacion', capturado_en: new Date().toISOString(),
};
result = await save(collector, weighing);
const weighingRev = result.rev;

let duplicate = { ...weighing, _id: `pesaje:e2e-duplicado-${suffix}` };
result = await save(collector, duplicate, 409);
assert.equal(result.data.error, 'pesaje_duplicado');

let invalid = { ...weighing, _id: `pesaje:e2e-material-${suffix}`, solicitud_id: undefined, lineas: [{ material: 'organico', peso_kg: 1 }] };
result = await save(collector, invalid, 400);
assert.equal(result.data.error, 'material_no_permitido');
invalid = { ...weighing, _id: `pesaje:e2e-peso-${suffix}`, solicitud_id: undefined, lineas: [{ material: 'carton', peso_kg: 1000.01 }] };
result = await save(collector, invalid, 400);
assert.equal(result.data.error, 'peso_fuera_rango');

const commerceCannotVerify = await save(commerce, { ...weighing, _rev: weighingRev, estado: 'verificado' }, 403);
assert.equal(commerceCannotVerify.data.error, 'permiso_insuficiente');

const alteredVerification = { ...weighing, _rev: weighingRev, estado: 'verificado', lineas: [{ material: 'carton', peso_kg: 99 }] };
result = await save(operator, alteredVerification, 409);
assert.equal(result.data.error, 'datos_pesaje_alterados');

const verification = { ...weighing, _rev: weighingRev, estado: 'verificado', verificado_en: new Date().toISOString() };
result = await save(operator, verification);
const verifiedRev = result.rev;
result = await save(operator, { ...verification, _rev: verifiedRev }, 200);
assert.equal(result.data.points_awarded, true);

const balance = await call(`/api/points/balance?comercio_id=${encodeURIComponent(commerceId)}`, { token: commerce });
expectStatus(balance, 200, 'saldo de puntos propio');
assert.equal(balance.data.saldo, 50, '10 kg de cartón deben acreditar 50 puntos');
assert.equal(balance.data.movimientos.filter((movement) => movement.pesaje_id === weighing._id).length, 1, 'la acreditación debe ser idempotente');

const burstTime = new Date().toISOString();
for (let index = 1; index <= 8; index += 1) {
  await save(collector, {
    _id: `pesaje:e2e-rafaga-${index}-${suffix}`, type: 'pesaje', comercio_id: commerceId,
    lineas: [{ material: 'papel', peso_kg: 1 }], estado: 'pendiente_verificacion', capturado_en: burstTime,
  });
}
result = await save(collector, {
  _id: `pesaje:e2e-rafaga-9-${suffix}`, type: 'pesaje', comercio_id: commerceId,
  lineas: [{ material: 'papel', peso_kg: 1 }], estado: 'pendiente_verificacion', capturado_en: burstTime,
}, 429);
assert.equal(result.data.error, 'frecuencia_sospechosa');

console.log('PASS: autenticación, RBAC/alcance, API y cambios incrementales, transiciones, validaciones, antifraude, verificación e idempotencia de puntos.');

