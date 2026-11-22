import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const apiBase = (process.env.API_BASE_URL || 'http://localhost:8091').replace(/\/$/, '');
const envText = await readFile(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  return match ? [[match[1], match[2].replace(/^("')(.*)\1$/, '$2')]] : [];
}));

async function call(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

const suffix = randomUUID();
const password = `Redeem-${suffix}-Aa9!`;
const login = await call('/auth/login', { method: 'POST', body: { username: env.BOOTSTRAP_ADMIN_USER, password: env.BOOTSTRAP_ADMIN_PASSWORD } });
assert.equal(login.status, 200, 'login de administrador');
const admin = login.data.token;
const commerceId = `comercio:rewards-${suffix}`;
const commerceUser = `rewards_${suffix.slice(0, 10)}`;
let result = await call(`/api/docs/${encodeURIComponent(commerceId)}`, { method: 'PUT', token: admin, body: { _id: commerceId, type: 'comercio', nombre: 'Comercio de prueba de canje', activo: true } });
assert.equal(result.status, 201, 'crear comercio para probar canje');
result = await call('/api/users', { method: 'POST', token: admin, body: { username: commerceUser, password, role: 'comercio', comercio_id: commerceId } });
assert.equal(result.status, 201, 'crear usuario de comercio');
const commerceLogin = await call('/auth/login', { method: 'POST', body: { username: commerceUser, password } });
assert.equal(commerceLogin.status, 200, 'login de comercio');
const commerce = commerceLogin.data.token;

const weighingId = `pesaje:rewards-${suffix}`;
const weighing = { _id: weighingId, type: 'pesaje', comercio_id: commerceId, recolector_id: env.BOOTSTRAP_ADMIN_USER, lineas: [{ material: 'carton', peso_kg: 20 }], estado: 'pendiente_verificacion', capturado_en: new Date().toISOString() };
result = await call(`/api/docs/${encodeURIComponent(weighingId)}`, { method: 'PUT', token: admin, body: weighing });
assert.equal(result.status, 201, 'registrar pesaje para acumular puntos');
weighing._rev = result.data.rev;
result = await call(`/api/docs/${encodeURIComponent(weighingId)}`, { method: 'PUT', token: admin, body: { ...weighing, estado: 'verificado', verificado_en: new Date().toISOString() } });
assert.equal(result.status, 201, 'verificar pesaje y acreditar 100 puntos');

const catalog = await call('/api/rewards', { token: commerce });
assert.equal(catalog.status, 200, 'catálogo de recompensas');
const rewardId = 'recompensa:kit-reciclaje';
assert.ok(catalog.data.rewards.some(reward => reward._id === rewardId), 'el catálogo contiene el kit de reciclaje');
const requestId = `redeem-${suffix}`;
const first = await call(`/api/rewards/${encodeURIComponent(rewardId)}/redeem`, { method: 'POST', token: commerce, body: { request_id: requestId } });
assert.equal(first.status, 201, 'canjear recompensa con saldo suficiente');
const retry = await call(`/api/rewards/${encodeURIComponent(rewardId)}/redeem`, { method: 'POST', token: commerce, body: { request_id: requestId } });
assert.equal(retry.status, 200, 'reintento idempotente del canje');
assert.equal(retry.data.movement_id, first.data.movement_id);
const insufficient = await call(`/api/rewards/${encodeURIComponent(rewardId)}/redeem`, { method: 'POST', token: commerce, body: { request_id: `redeem-${randomUUID()}` } });
assert.equal(insufficient.status, 409, 'rechazar canje sin saldo');
assert.equal(insufficient.data.error, 'saldo_insuficiente');
const balance = await call(`/api/points/balance?comercio_id=${encodeURIComponent(commerceId)}`, { token: commerce });
assert.equal(balance.status, 200);
assert.equal(balance.data.saldo, 0, 'el ledger refleja acreditación y un único canje');
assert.equal(balance.data.movimientos.filter(movement => movement._id === first.data.movement_id).length, 1, 'un solo movimiento de canje');
console.log('PASS: catálogo/canje, saldo suficiente, descuento, idempotencia y rechazo por saldo insuficiente.');
