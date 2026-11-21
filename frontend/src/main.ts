import './style.css';
import { api, ApiError, sesion } from './data/api';
import { cambiarAlmacenPorSesion, guardarLocal, iniciarSincronizacion, listarDocumentos, observarSync, resolverConflicto, sincronizar, type SyncSnapshot } from './data/pouch';
import type { Comercio, Documento, EstadoPesaje, MovimientoPuntos, Pesaje, Rol, SolicitudRecoleccion, TipoDocumento } from './domain/tipos';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('No se encontró el contenedor #app');

const titles: Record<string, string> = { inicio: 'Panel principal', comercios: 'Comercios', solicitudes: 'Solicitudes', pesajes: 'Pesajes', puntos: 'Puntos y recompensas' };
const roleLabels: Record<Rol, string> = { admin_plataforma: 'Administrador', operador_acopio: 'Operador de acopio', recolector: 'Recolector', comercio: 'Comercio' };
let activeView = 'inicio';

app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><div class="brand-icon">♻</div><div><strong>EcoGestión</strong><small>RECICLAJE INCENTIVADO</small></div></div>
      <div class="menu-label">MENÚ PRINCIPAL</div>
      <nav class="navigation">${Object.entries({ inicio: '⌂|Inicio', comercios: '▦|Comercios', solicitudes: '▤|Solicitudes', pesajes: '⚖|Pesajes', puntos: '✧|Puntos y recompensas' }).map(([key, item]) => { const [icon, label] = item.split('|'); return `<button class="nav-link" data-view="${key}"><span>${icon}</span>${label}</button>`; }).join('')}</nav>
      <div class="sidebar-bottom"><div class="offline-status" id="sync-indicator"><i></i><div><b>Sincronización</b><small id="api-state">Sin comprobar</small></div></div><small class="version">Sistema de Gestión · Módulo 3</small></div>
    </aside>
    <main class="main">
      <header class="topbar"><div><span class="eyebrow">PLATAFORMA DE RECICLAJE</span><h1 id="page-title">Panel principal</h1></div><div class="profile"><button id="sync-button" class="secondary-button" type="button">Sincronizar</button><div class="avatar" id="profile-avatar">?</div><div><b id="profile-name">Sin sesión</b><small id="profile-role">Inicia sesión para consultar</small></div><button id="session-button" class="secondary-button">Iniciar sesión</button></div></header>
      <section id="content" class="content"></section>
      <footer>© 2026 Sistema de Gestión de Residuos y Reciclaje Incentivado</footer>
    </main>
  </div>`;

const content = document.querySelector<HTMLElement>('#content')!;
const title = document.querySelector<HTMLElement>('#page-title')!;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function notify(message: string, isError = false) { const target = content.querySelector<HTMLElement>('#feedback'); if (target) { target.textContent = message; target.className = `feedback ${isError ? 'error' : 'success'}`; } }
function report(error: unknown) { notify(error instanceof ApiError ? error.message : 'Ocurrió un error al procesar la solicitud.', true); if (error instanceof ApiError && error.status === 401) { sesion.clear(); updateProfile(); renderLogin(); } }
function updateProfile() { const role = sesion.role; document.querySelector('#profile-name')!.textContent = role ? roleLabels[role] : 'Sin sesión'; document.querySelector('#profile-role')!.textContent = role ? 'Sesión autenticada' : 'Inicia sesión para consultar'; document.querySelector('#profile-avatar')!.textContent = role ? roleLabels[role][0] : '?'; document.querySelector('#session-button')!.textContent = role ? 'Cerrar sesión' : 'Iniciar sesión'; }

function renderLogin() {
  title.textContent = 'Iniciar sesión';
  content.innerHTML = `<article class="panel form-panel"><div class="panel-heading"><div><h3>Acceso al sistema</h3><p>Usa las credenciales de tu cuenta de reciclaje.</p></div></div><form id="login-form" class="data-form"><label>Usuario<input name="username" required autocomplete="username" minlength="3" maxlength="80"></label><label>Contraseña<input name="password" type="password" required autocomplete="current-password" maxlength="256"></label><button class="primary-button" type="submit">Iniciar sesión</button></form><div id="feedback" class="feedback" role="status" aria-live="polite"></div></article>`;
  content.querySelector<HTMLFormElement>('#login-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try { const result = await api.login(String(form.get('username')), String(form.get('password'))); sesion.save(result); await cambiarAlmacenPorSesion(); updateProfile(); iniciarSincronizacion(); await openView('inicio'); }
    catch (error) { report(error); }
  });
}

async function list<T extends Documento>(type: TipoDocumento) { return listarDocumentos<T>(type); }
async function saveOfflineFirst<T extends Documento>(doc: T) { await guardarLocal(doc); void sincronizar(); }
const dateText = (value?: string) => value ? new Date(value).toLocaleString() : '—';
function table(headers: string[], rows: string[][]) { if (!rows.length) return '<div class="empty-state"><span>♻</span><b>No hay registros disponibles</b><p>Los datos aparecerán aquí cuando existan registros en el servidor.</p></div>'; return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
function section(titleText: string, description: string, body: string, action = '') { content.innerHTML = `<div class="section-heading"><div><h2>${esc(titleText)}</h2><p>${esc(description)}</p></div>${action}</div><article class="panel list-panel">${body}</article><div id="feedback" class="feedback" role="status" aria-live="polite"></div>`; }
function addAction(label: string) { return `<button id="add-record" class="primary-button">＋ ${esc(label)}</button>`; }

async function renderDashboard() {
  const [comercios, solicitudes, pesajes, movimientos] = await Promise.all([
    list<Comercio>('comercio'), list<SolicitudRecoleccion>('solicitud_recoleccion'), list<Pesaje>('pesaje'), list<MovimientoPuntos>('movimiento_puntos')
  ]);
  const total = movimientos.reduce((sum, movimiento) => sum + (movimiento.concepto === 'canje' ? -movimiento.puntos : movimiento.puntos), 0);
  content.innerHTML = `<div class="welcome"><div><span class="welcome-tag">♻ JUNTOS POR UN FUTURO MÁS LIMPIO</span><h2>¡Bienvenido al sistema!</h2><p>Consulta la información guardada en el servidor según los permisos de tu cuenta.</p></div><div class="welcome-art" aria-hidden="true">♻</div></div>
    <div class="section-heading"><div><h2>Resumen general</h2><p>Indicadores recibidos de la API de reciclaje.</p></div><span class="local-pill"><i></i> Datos del servidor</span></div>
    <div class="stats-grid">
      <article class="stat-card"><div class="stat-top"><span>Comercios registrados</span><span class="stat-icon green">▦</span></div><strong>${comercios.length}</strong><small>Visibles para tu rol</small></article>
      <article class="stat-card"><div class="stat-top"><span>Solicitudes</span><span class="stat-icon blue">▤</span></div><strong>${solicitudes.length}</strong><small>Registros visibles</small></article>
      <article class="stat-card"><div class="stat-top"><span>Pesajes registrados</span><span class="stat-icon orange">⚖</span></div><strong>${pesajes.length}</strong><small>Registros visibles</small></article>
      <article class="stat-card"><div class="stat-top"><span>Puntos netos globales</span><span class="stat-icon purple">✧</span></div><strong>${total.toLocaleString()} pts</strong><small>Ledger de comercios visibles</small></article>
    </div><div class="dashboard-grid"><article class="panel"><div class="panel-heading"><div><h3>Accesos rápidos</h3><p>Abre un módulo para consultar o registrar información</p></div></div><div class="quick-actions"><button data-go="comercios" class="quick-action"><span class="quick-icon green">▦</span><span><b>Comercios</b><small>Consultar registros del servidor</small></span><em>›</em></button><button data-go="solicitudes" class="quick-action"><span class="quick-icon blue">▤</span><span><b>Solicitudes</b><small>Ver recolecciones solicitadas</small></span><em>›</em></button></div></article><article class="panel connection-panel"><div class="panel-heading"><div><h3>Conexión con la API</h3><p>Los cambios se guardan primero en PouchDB</p></div><span class="status-badge"><i></i> Activa</span></div><div class="connection-row"><span class="db-symbol">◈</span><div><b>CouchDB vía backend</b><small>Sincronización protegida por sesión</small></div><strong class="status-text">ACTIVO</strong></div><p class="note">Los registros pendientes se envían al recuperar la conexión; los pesajes verificados generan su acreditación automática.</p></article></div><div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;
  content.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(button => button.addEventListener('click', () => openView(button.dataset.go!)));
}

async function showComercios() {
  const docs = await list<Comercio>('comercio');
  const canCreate = sesion.role === 'admin_plataforma' || sesion.role === 'operador_acopio';
  section('Directorio de comercios', 'Registros locales de PouchDB; los cambios se sincronizan con CouchDB.', `<div class="panel-heading"><div><h3>Comercios registrados</h3><p>${docs.length} registro(s) local(es)</p></div><button id="refresh-list" class="secondary-button">Actualizar lista</button></div>${table(['Nombre','Giro','Zona','Estado','Sincronización','Identificador'], docs.map(d => [esc(d.nombre),esc(d.giro || '—'),esc(d.zona || '—'),esc(d.activo === false ? 'inactivo' : d.estado || 'activo'),esc(d.sync_status==='pending'?'pendiente':d.sync_status==='conflict'?'conflicto':'al día'),`<code>${esc(d._id)}</code>`]))}`, canCreate ? addAction('Registrar comercio') : '');
  content.querySelector('#refresh-list')?.addEventListener('click', () => openView('comercios'));
  content.querySelector('#add-record')?.addEventListener('click', () => formDialog('Registrar comercio', [['nombre','Nombre','text'],['giro','Giro','text'],['zona','Zona','text']], async values => { const id = `comercio:${crypto.randomUUID()}`; await saveOfflineFirst({ _id:id,type:'comercio',nombre:values.nombre,giro:values.giro,zona:values.zona,activo:true,creado_en:new Date().toISOString() }); await openView('comercios'); notify('Guardado localmente; queda en cola de sincronización.'); }));
}

async function showSolicitudes() {
  const docs = await list<SolicitudRecoleccion>('solicitud_recoleccion');
  const canCreate = sesion.role === 'comercio' || sesion.role === 'admin_plataforma';
  section('Solicitudes de recolección', 'Solicitudes locales en PouchDB; los cambios se sincronizan al recuperar conexión.', `<div class="panel-heading"><div><h3>Solicitudes</h3><p>${docs.length} registro(s) local(es)</p></div><button id="refresh-list" class="secondary-button">Actualizar lista</button></div>${table(['Comercio','Estado','Fecha solicitada','Observaciones','Sincronización','Identificador'],docs.map(d => [esc(d.comercio_id),esc(d.estado),esc(d.fecha_solicitada || dateText(d.creada_en)),esc(d.observaciones || '—'),esc(d.sync_error ? `Rechazado: ${d.sync_error}` : d.sync_status==='pending'?'pendiente':d.sync_status==='conflict'?'conflicto':'al día'),`<code>${esc(d._id)}</code>`]))}`, canCreate ? addAction('Crear solicitud') : '');
  content.querySelector('#refresh-list')?.addEventListener('click', () => openView('solicitudes'));
  content.querySelector('#add-record')?.addEventListener('click', () => formDialog('Nueva solicitud', [['comercio_id','ID del comercio','text'],['fecha_solicitada','Fecha solicitada','date'],['observaciones','Observaciones','text']], async values => { const id=`solicitud:${crypto.randomUUID()}`; await saveOfflineFirst({ _id:id,type:'solicitud_recoleccion',comercio_id:values.comercio_id,fecha_solicitada:values.fecha_solicitada,observaciones:values.observaciones,estado:'pendiente',creada_en:new Date().toISOString() }); await openView('solicitudes'); notify('Guardado localmente; queda en cola de sincronización.'); }));
}

async function showPesajes() {
  const docs = await list<Pesaje>('pesaje');
  const role = sesion.role;
  const canCapture = role === 'recolector' || role === 'admin_plataforma';
  const canVerify = role === 'operador_acopio' || role === 'admin_plataforma';
  const rows = docs.map(d => [esc(d.comercio_id),esc(d.recolector_id),esc(d.lineas.map(line => `${line.material}: ${line.peso_kg} kg`).join(', ')),esc(d.estado),esc(d.sync_error ? `Rechazado: ${d.sync_error}` : d.sync_status==='pending'?'pendiente de sync':d.sync_status==='conflict'?'conflicto':'al día'),esc(dateText(d.capturado_en)),canVerify && d.estado === 'pendiente_verificacion' ? `<button class="secondary-button" data-verify="${esc(d._id)}">Verificar</button>` : `<code>${esc(d._id)}</code>`]);
  section('Registro de pesajes', 'Pesajes guardados localmente, con estado de envío y verificación.', `<div class="panel-heading"><div><h3>Pesajes</h3><p>${docs.length} registro(s) local(es)</p></div><button id="refresh-list" class="secondary-button">Actualizar lista</button></div>${table(['Comercio','Recolector','Material y peso','Verificación','Sincronización','Capturado','Acción'],rows)}`, canCapture ? addAction('Registrar pesaje') : '');
  content.querySelector('#refresh-list')?.addEventListener('click', () => openView('pesajes'));
  content.querySelectorAll<HTMLButtonElement>('[data-verify]').forEach(button => button.addEventListener('click', async () => { const doc=docs.find(item=>item._id===button.dataset.verify);if(!doc)return;try{await saveOfflineFirst({...doc,estado:'verificado' as EstadoPesaje,verificado_en:new Date().toISOString()});await openView('pesajes');notify('Verificación guardada localmente; queda en cola de sincronización.');}catch(error){report(error);}}));
  content.querySelector('#add-record')?.addEventListener('click', () => formDialog('Registrar pesaje', [['comercio_id','ID del comercio','text'],['material','Material','select'],['peso_kg','Peso en kg','number']], async values => { const id=`pesaje:${crypto.randomUUID()}`; await saveOfflineFirst({_id:id,type:'pesaje',comercio_id:values.comercio_id,recolector_id:sesion.username??'',lineas:[{material:values.material,peso_kg:Number(values.peso_kg)}],estado:'pendiente_verificacion',capturado_en:new Date().toISOString()}); await openView('pesajes');notify('Guardado localmente; queda en cola de sincronización.'); }));
}

async function showPuntos() {
  const docs=await list<MovimientoPuntos>('movimiento_puntos');
  const canQuery=sesion.role==='admin_plataforma'||sesion.role==='operador_acopio';
  const localBalance=docs.reduce((sum,d)=>sum+(d.concepto==='canje'?-d.puntos:d.puntos),0);
  section('Puntos y recompensas', 'El ledger se acredita automáticamente al verificar pesajes; las reglas se aplican en el backend.', `<article class="balance-card"><div><span>Saldo autoritativo del servidor</span><strong id="server-balance">${canQuery?'Selecciona un comercio':`${localBalance.toLocaleString()} pts · saldo local`}</strong></div>${canQuery?'<form id="balance-form" class="balance-form"><label for="balance-commerce">ID del comercio</label><input id="balance-commerce" name="comercio_id" required maxlength="200"><button class="secondary-button" type="submit">Consultar saldo</button></form>':''}<p id="balance-detail" class="note">${canQuery?'Consulta un comercio para obtener su saldo y ledger actualizados.':'Saldo calculado localmente; se actualizará al sincronizar.'}</p></article><div class="panel-heading"><div><h3>Historial de movimientos</h3><p>Las acreditaciones indican el pesaje y la versión de reglas aplicada.</p></div><button id="refresh-list" class="secondary-button">Actualizar lista</button></div>${table(['Comercio','Concepto','Puntos','Origen','Pesaje','Regla','Sincronización','Fecha'],docs.map(d=>[esc(d.comercio_id),esc(d.concepto),esc(d.puntos),esc(d.origen||'—'),esc(d.pesaje_id||'—'),esc(d.regla_version??'—'),esc(d.sync_status==='pending'?'pendiente':d.sync_status==='conflict'?'conflicto':'al día'),esc(dateText(d.creado_en))]))}<div class="note">No se permiten acreditaciones manuales desde el cliente.</div>`);
  content.querySelector('#refresh-list')?.addEventListener('click',()=>openView('puntos'));
  const updateServerBalance=async(comercioId:string)=>{try{const result=await api.saldoPuntos(comercioId);content.querySelector<HTMLElement>('#server-balance')!.textContent=`${result.saldo.toLocaleString()} pts`;content.querySelector<HTMLElement>('#balance-detail')!.textContent=`${result.movimientos.length} movimiento(s) en el servidor · comercio ${result.comercio_id}`;}catch(error){const target=content.querySelector<HTMLElement>('#balance-detail');if(target)target.textContent=error instanceof ApiError?error.message:'No se pudo consultar el saldo remoto.';}};
  if(sesion.role==='comercio'&&sesion.comercioId)void updateServerBalance(sesion.comercioId);
  content.querySelector<HTMLFormElement>('#balance-form')?.addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.currentTarget as HTMLFormElement);void updateServerBalance(String(form.get('comercio_id')).trim());});
}

type Field = [name: string, label: string, type: 'text'|'date'|'number'|'select'];
function formDialog(heading: string, fields: Field[], submit: (values: Record<string,string>) => Promise<void>) {
  const select = (name:string) => name==='concepto' ? '<option value="acreditacion">Acreditación</option><option value="canje">Canje</option>' : name==='material' ? '<option value="carton">Cartón</option><option value="papel">Papel</option><option value="plastico">Plástico</option><option value="vidrio">Vidrio</option><option value="metal">Metal</option><option value="aluminio">Aluminio</option>' : '';
  content.insertAdjacentHTML('afterbegin',`<article class="panel editor-panel"><div class="panel-heading"><div><h3>${esc(heading)}</h3><p>Los cambios se envían a la API.</p></div><button type="button" id="close-form" class="secondary-button">Cerrar</button></div><form id="record-form" class="data-form">${fields.map(([name,label,type])=>`<label>${esc(label)}${type==='select'?`<select name="${esc(name)}" required>${select(name)}</select>`:`<input name="${esc(name)}" type="${type}" ${type==='number'?'min="0.01" max="1000" step="0.01"':''} required maxlength="200">`}</label>`).join('')}<button class="primary-button" type="submit">Guardar</button></form><div id="form-feedback" class="feedback" role="status"></div></article>`);
  const commerceField=content.querySelector<HTMLInputElement>('input[name="comercio_id"]');
  if(commerceField&&sesion.role==='comercio'&&sesion.comercioId){commerceField.value=sesion.comercioId;commerceField.readOnly=true;}
  content.querySelector('#close-form')?.addEventListener('click',()=>content.querySelector('.editor-panel')?.remove());
  content.querySelector<HTMLFormElement>('#record-form')!.addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget as HTMLFormElement);const values:Record<string,string>={};form.forEach((value,key)=>{values[key]=String(value).trim();});try{await submit(values);}catch(error){const target=content.querySelector<HTMLElement>('#form-feedback');if(target){target.textContent=error instanceof ApiError?error.message:'No se pudo guardar el registro.';target.classList.add('error');}}});
}

async function openView(view: string) {
  activeView=view;document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach(button=>button.classList.toggle('active',button.dataset.view===view));title.textContent=titles[view]??titles.inicio;
  if(!sesion.token){renderLogin();return;}
  try { if(view==='inicio')await renderDashboard();else if(view==='comercios')await showComercios();else if(view==='solicitudes')await showSolicitudes();else if(view==='pesajes')await showPesajes();else if(view==='puntos')await showPuntos();await mostrarConflictos(); }
  catch(error){report(error);}
}

async function mostrarConflictos() {
  const conflicts=(await listarDocumentos()).filter(doc=>doc.sync_status==='conflict');
  if(!conflicts.length)return;
  content.insertAdjacentHTML('beforeend',`<article class="panel conflict-panel"><div class="panel-heading"><div><h3>Conflictos pendientes (${conflicts.length})</h3><p>Conservamos ambas versiones. Elige cuál debe quedar activa.</p></div></div>${conflicts.map(doc=>`<div class="conflict-row"><code>${esc(doc._id)}</code>${doc.conflict_remote?`<span>${esc(doc.sync_error||'Conflicto de revisión')}</span><button class="secondary-button" data-conflict="${esc(doc._id)}" data-choice="remote">Usar servidor</button><button class="secondary-button" data-conflict="${esc(doc._id)}" data-choice="local">Conservar local</button>`:`<span>La versión remota no está disponible para esta cuenta; se conserva el registro local para revisión administrativa.</span>`}</div>`).join('')}</article>`);
  content.querySelectorAll<HTMLButtonElement>('[data-conflict]').forEach(button=>button.addEventListener('click',async()=>{try{await resolverConflicto(button.dataset.conflict!,button.dataset.choice as 'local'|'remote');await openView(activeView);}catch(error){report(error);}}));
}

const syncLabels:Record<SyncSnapshot['state'],string>={connected:'Conectado',offline:'Sin conexión',pending:'Pendiente de sincronizar',syncing:'Sincronizando…',error:'Error de sincronización'};
let previousSyncState:SyncSnapshot['state']|undefined;
observarSync(value=>{
  const target=document.querySelector<HTMLElement>('#api-state');
  if(target)target.textContent=`${syncLabels[value.state]} · ${value.pending} pendiente(s)${value.conflicts?` · ${value.conflicts} conflicto(s)`:''}${value.state==='error'&&value.message?` · ${value.message}`:''}`;
  document.querySelector<HTMLElement>('#sync-indicator')?.setAttribute('data-state',value.state);
  const syncButton=document.querySelector<HTMLButtonElement>('#sync-button');
  if(syncButton){syncButton.disabled=value.state==='syncing';syncButton.textContent=value.state==='syncing'?'Sincronizando…':'Sincronizar';}
  if(previousSyncState==='syncing'&&value.state==='connected'&&sesion.token&&!content.querySelector('#record-form'))void openView(activeView);
  previousSyncState=value.state;
});

document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach(button=>button.addEventListener('click',()=>openView(button.dataset.view??'inicio')));
document.querySelector<HTMLButtonElement>('#session-button')!.addEventListener('click',async()=>{if(sesion.token){sesion.clear();await cambiarAlmacenPorSesion();updateProfile();renderLogin();}else renderLogin();});
document.querySelector<HTMLButtonElement>('#sync-button')!.addEventListener('click',()=>{if(!sesion.token){renderLogin();return;}void sincronizar();});
updateProfile();
if(sesion.token){iniciarSincronizacion();void openView(activeView);}else renderLogin();
