import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const target = (__ENV.TARGET || 'http://api:8080').replace(/\/$/, '');
const virtualUsers = Number(__ENV.VUS || 10);
const duration = __ENV.DURATION || '2m';
const runId = (__ENV.RUN_ID || 'manual').replace(/[^a-zA-Z0-9_-]/g, '-');
const networkProfile = __ENV.NETEM_PROFILE || 'ideal';

const businessStepDuration = new Trend('business_step_duration_ms', true);
const businessFlowDuration = new Trend('business_flow_duration_ms', true);
const businessFlowSuccess = new Rate('business_flow_success');
const businessStepSuccess = new Rate('business_step_success');
const businessSteps = new Counter('business_steps_total');
const businessStepResponses = new Counter('business_step_responses_total');
const businessStepFailures = new Counter('business_step_failures_total');
const completedFlows = new Counter('business_flows_completed_total');

export const options = {
  scenarios: {
    authenticated_business_flow: {
      executor: 'constant-vus',
      vus: virtualUsers,
      duration,
      gracefulStop: '10s',
    },
  },
  tags: { run_id: runId, network_profile: networkProfile },
  systemTags: ['status', 'method', 'name', 'group', 'check', 'error', 'scenario', 'expected_response'],
};

function routeName(method, path) {
  if (path.startsWith('/api/docs/')) return `${method} /api/docs/:id`;
  if (path.startsWith('/api/points/balance')) return 'GET /api/points/balance';
  return `${method} ${path}`;
}

function request(method, path, body, token, expectedStatus, label) {
  const route = routeName(method, path);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const params = {
    headers,
    tags: { name: route, endpoint: route },
    timeout: '30s',
  };
  const started = Date.now();
  const response = http.request(method, `${target}${path}`, body ? JSON.stringify(body) : null, params);
  businessStepDuration.add(Date.now() - started, { endpoint: route });
  const status = String(response.status);
  const responseTags = { step: label, endpoint: route, status };
  businessStepResponses.add(1, responseTags);
  const ok = check(response, { [`${label} HTTP ${status}`]: result => result.status === expectedStatus });
  businessStepSuccess.add(ok);
  if (ok) businessSteps.add(1, { step: label });
  else businessStepFailures.add(1, responseTags);
  return response;
}

function json(response) {
  try { return response.json(); } catch (error) { return {}; }
}

function login(username, password, label) {
  const response = request('POST', '/auth/login', { username, password }, null, 200, label);
  return response.status === 200 ? json(response).token : null;
}

function save(token, document, expectedStatus, label) {
  const path = `/api/docs/${encodeURIComponent(document._id)}`;
  const response = request('PUT', path, document, token, expectedStatus, label);
  return response.status === expectedStatus ? json(response) : null;
}

export function setup() {
  const adminName = __ENV.K6_ADMIN_USER;
  const adminPassword = __ENV.K6_ADMIN_PASSWORD;
  if (!adminName || !adminPassword) throw new Error('Define K6_ADMIN_USER y K6_ADMIN_PASSWORD en .env para correr el flujo de negocio.');

  const adminToken = login(adminName, adminPassword, 'login_administrador');
  if (!adminToken) throw new Error('No se pudo autenticar el administrador para preparar k6.');
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const password = `K6-${suffix}-Aa9!`;
  const operatorName = `k6_oper_${suffix}`;
  const collectorName = `k6_reco_${suffix}`;

  for (const [username, role] of [[operatorName, 'operador_acopio'], [collectorName, 'recolector']]) {
    const result = request('POST', '/api/users', { username, password, role }, adminToken, 201, `crear_${role}`);
    if (result.status !== 201) throw new Error(`No se pudo crear la cuenta temporal ${role} para k6.`);
  }

  const operatorToken = login(operatorName, password, 'login_operador');
  const collectorToken = login(collectorName, password, 'login_recolector');
  if (!operatorToken || !collectorToken) throw new Error('No se pudieron autenticar las cuentas temporales de k6.');
  return { adminToken, operatorToken, collectorToken, collectorName };
}

export default function (users) {
  const started = Date.now();
  const suffix = `${runId}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const commerceId = `comercio:k6-${suffix}`;
  const requestId = `solicitud:k6-${suffix}`;
  const weighingId = `pesaje:k6-${suffix}`;

  const commerce = save(users.adminToken, {
    _id: commerceId, type: 'comercio', nombre: `Comercio carga ${suffix}`, zona: networkProfile, activo: true,
  }, 201, 'registrar_comercio');
  if (!commerce) { businessFlowSuccess.add(false); return; }

  const requestDoc = {
    _id: requestId, type: 'solicitud_recoleccion', comercio_id: commerceId,
    estado: 'pendiente', fecha_solicitada: new Date().toISOString(),
    observaciones: `corrida=${runId}; red=${networkProfile}`,
  };
  const createdRequest = save(users.adminToken, requestDoc, 201, 'crear_solicitud');
  if (!createdRequest) { businessFlowSuccess.add(false); return; }

  const approved = save(users.operatorToken, {
    _id: requestDoc._id, type: requestDoc.type, comercio_id: requestDoc.comercio_id,
    estado: 'aprobada', fecha_solicitada: requestDoc.fecha_solicitada,
    observaciones: requestDoc.observaciones, _rev: createdRequest.rev,
  }, 201, 'aprobar_solicitud');
  if (!approved) { businessFlowSuccess.add(false); return; }
  const assigned = save(users.operatorToken, {
    _id: requestDoc._id, type: requestDoc.type, comercio_id: requestDoc.comercio_id,
    estado: 'asignada', fecha_solicitada: requestDoc.fecha_solicitada,
    observaciones: requestDoc.observaciones, _rev: approved.rev,
    recolector_id: users.collectorName,
  }, 201, 'asignar_recolector');
  if (!assigned) { businessFlowSuccess.add(false); return; }

  const capturedAt = new Date().toISOString();
  const weighing = {
    _id: weighingId, type: 'pesaje', solicitud_id: requestId, comercio_id: commerceId,
    recolector_id: users.collectorName,
    lineas: [{ material: 'carton', peso_kg: 10 }],
    estado: 'pendiente_verificacion', capturado_en: capturedAt,
  };
  const captured = save(users.collectorToken, weighing, 201, 'registrar_pesaje');
  if (!captured) { businessFlowSuccess.add(false); return; }

  const verified = save(users.operatorToken, {
    _id: weighing._id, type: weighing.type, solicitud_id: weighing.solicitud_id,
    comercio_id: weighing.comercio_id, recolector_id: weighing.recolector_id,
    lineas: weighing.lineas, estado: 'verificado', capturado_en: weighing.capturado_en,
    _rev: captured.rev, verificado_en: new Date().toISOString(),
  }, 201, 'verificar_pesaje');
  if (!verified || verified.points_awarded !== true) { businessFlowSuccess.add(false); return; }

  const closed = save(users.operatorToken, {
    _id: requestDoc._id, type: requestDoc.type, comercio_id: requestDoc.comercio_id,
    estado: 'completada', fecha_solicitada: requestDoc.fecha_solicitada,
    observaciones: requestDoc.observaciones, _rev: assigned.rev,
    recolector_id: users.collectorName,
  }, 201, 'cerrar_recoleccion');
  if (!closed) { businessFlowSuccess.add(false); return; }

  const balancePath = `/api/points/balance?comercio_id=${encodeURIComponent(commerceId)}`;
  const balanceResponse = request('GET', balancePath, null, users.operatorToken, 200, 'consultar_puntos');
  const balance = balanceResponse.status === 200 ? json(balanceResponse) : null;
  const balanceOk = Boolean(balance && balance.saldo === 50);
  check(balance || {}, { 'saldo acredita los puntos del pesaje': result => result.saldo === 50 });
  businessFlowSuccess.add(balanceOk);
  if (balanceOk) {
    completedFlows.add(1, { flow: 'solicitud_pesaje_cierre_verificacion_puntos' });
    businessFlowDuration.add(Date.now() - started, { flow: 'solicitud_pesaje_cierre_verificacion_puntos' });
  }
}
