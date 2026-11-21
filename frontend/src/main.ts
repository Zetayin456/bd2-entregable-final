import PouchDB from 'pouchdb-browser';
import './style.css';

type Comercio = {
  _id?: string;
  _rev?: string;
  type: string;
  nombre: string;
  estado: string;
  createdAt?: string;
};

const db = new PouchDB<Comercio>('sistema_reciclaje_local');

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('No se encontró el contenedor #app');

app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-icon">♻</div>
        <div><strong>EcoGestión</strong><small>RECICLAJE INCENTIVADO</small></div>
      </div>
      <div class="menu-label">MENÚ PRINCIPAL</div>
      <nav class="navigation">
        <button class="nav-link active" data-view="inicio"><span>⌂</span> Inicio</button>
        <button class="nav-link" data-view="comercios"><span>▦</span> Comercios</button>
        <button class="nav-link" data-view="solicitudes"><span>▤</span> Solicitudes</button>
        <button class="nav-link" data-view="pesajes"><span>⚖</span> Pesajes</button>
        <button class="nav-link" data-view="puntos"><span>✧</span> Puntos y recompensas</button>
      </nav>
      <div class="sidebar-bottom">
        <div class="offline-status"><i></i><div><b>Almacenamiento local</b><small>PouchDB disponible</small></div></div>
        <small class="version">Sistema de Gestión · Versión inicial</small>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div><span class="eyebrow">PLATAFORMA DE RECICLAJE</span><h1 id="page-title">Panel principal</h1></div>
        <div class="profile"><div class="avatar">A</div><div><b>Administrador</b><small>Vista de demostración</small></div></div>
      </header>
      <section id="content" class="content">
        <div class="welcome">
          <div><span class="welcome-tag">♻ JUNTOS POR UN FUTURO MÁS LIMPIO</span><h2>¡Bienvenido al sistema!</h2><p>Administra comercios, solicitudes de recolección y actividades de reciclaje desde un solo lugar.</p></div>
          <div class="welcome-art" aria-hidden="true">♻</div>
        </div>

        <div class="section-heading"><div><h2>Resumen general</h2><p>Indicadores de los registros guardados en este dispositivo.</p></div><span class="local-pill"><i></i> Datos locales</span></div>
        <div class="stats-grid">
          <article class="stat-card"><div class="stat-top"><span>Comercios registrados</span><span class="stat-icon green">▦</span></div><strong id="stat-comercios">0</strong><small>Registros locales</small></article>
          <article class="stat-card"><div class="stat-top"><span>Solicitudes</span><span class="stat-icon blue">▤</span></div><strong>—</strong><small>Módulo por integrar</small></article>
          <article class="stat-card"><div class="stat-top"><span>Pesajes registrados</span><span class="stat-icon orange">⚖</span></div><strong>—</strong><small>Módulo por integrar</small></article>
          <article class="stat-card"><div class="stat-top"><span>Puntos entregados</span><span class="stat-icon purple">✧</span></div><strong>—</strong><small>Módulo por integrar</small></article>
        </div>

        <div class="dashboard-grid">
          <article class="panel">
            <div class="panel-heading"><div><h3>Accesos rápidos</h3><p>Acciones disponibles en esta versión</p></div></div>
            <div class="quick-actions">
              <button id="quick-add" class="quick-action"><span class="quick-icon green">＋</span><span><b>Registrar comercio</b><small>Guardar un comercio en este dispositivo</small></span><em>›</em></button>
              <button id="quick-list" class="quick-action"><span class="quick-icon blue">☷</span><span><b>Consultar comercios</b><small>Ver los registros almacenados</small></span><em>›</em></button>
            </div>
          </article>
          <article class="panel connection-panel">
            <div class="panel-heading"><div><h3>Estado del sistema</h3><p>Almacenamiento del navegador</p></div><span class="status-badge"><i></i> Disponible</span></div>
            <div class="connection-row"><span class="db-symbol">◈</span><div><b>PouchDB</b><small>Base de datos local</small></div><strong class="status-text">ACTIVO</strong></div>
            <p class="note">Los registros de esta prueba se guardan en el almacenamiento local del navegador. La sincronización con el servidor todavía está pendiente.</p>
          </article>
        </div>
        <div id="feedback" class="feedback" role="status" aria-live="polite"></div>
      </section>
      <footer>© 2026 Sistema de Gestión de Residuos y Reciclaje Incentivado</footer>
    </main>
  </div>
`;

const content = document.querySelector<HTMLElement>('#content')!;
const title = document.querySelector<HTMLElement>('#page-title')!;
const feedback = document.querySelector<HTMLElement>('#feedback')!;

function notify(message: string, error = false) {
  feedback.textContent = message;
  feedback.className = error ? 'feedback error' : 'feedback success';
}

async function getComercios() {
  const result = await db.allDocs({ include_docs: true });
  return result.rows
    .map(row => row.doc)
    .filter((doc): doc is Comercio => Boolean(doc && doc.type === 'comercio'));
}

async function updateStats() {
  const comercios = await getComercios();
  const stat = document.querySelector<HTMLElement>('#stat-comercios');
  if (stat) stat.textContent = String(comercios.length);
}

async function registrarComercio() {
  const nombre = window.prompt('Escribe el nombre del comercio:');
  if (!nombre || !nombre.trim()) return;
  try {
    const result = await db.post({
      type: 'comercio',
      nombre: nombre.trim(),
      estado: 'activo',
      createdAt: new Date().toISOString()
    });
    notify(`Comercio guardado correctamente. Identificador: ${result.id}`);
    await updateStats();
    if (document.querySelector('.commerce-table')) await mostrarComercios();
  } catch (error) {
    notify(`No se pudo guardar el comercio: ${String(error)}`, true);
  }
}

async function mostrarComercios() {
  const comercios = await getComercios();
  const target = document.querySelector<HTMLElement>('#commerce-list');
  if (!target) return;
  if (comercios.length === 0) {
    target.innerHTML = '<div class="empty-state"><span>▦</span><b>Aún no hay comercios registrados</b><p>Usa el botón “Registrar comercio” para agregar el primero.</p></div>';
    return;
  }
  target.innerHTML = `
    <div class="table-wrap"><table class="commerce-table">
      <thead><tr><th>Nombre del comercio</th><th>Estado</th><th>Identificador</th></tr></thead>
      <tbody>${comercios.map(item => `<tr><td><b>${escapeHtml(item.nombre)}</b></td><td><span class="table-status">${escapeHtml(item.estado)}</span></td><td><code>${escapeHtml(item._id ?? '')}</code></td></tr>`).join('')}</tbody>
    </table></div>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char] ?? char));
}

async function openView(view: string) {
  document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  feedback.textContent = '';
  if (view === 'inicio') {
    title.textContent = 'Panel principal';
    content.innerHTML = `
      <div class="welcome"><div><span class="welcome-tag">♻ JUNTOS POR UN FUTURO MÁS LIMPIO</span><h2>¡Bienvenido al sistema!</h2><p>Administra comercios, solicitudes de recolección y actividades de reciclaje desde un solo lugar.</p></div><div class="welcome-art">♻</div></div>
      <div class="section-heading"><div><h2>Resumen general</h2><p>Indicadores de los registros guardados en este dispositivo.</p></div><span class="local-pill"><i></i> Datos locales</span></div>
      <div class="stats-grid">
        <article class="stat-card"><div class="stat-top"><span>Comercios registrados</span><span class="stat-icon green">▦</span></div><strong id="stat-comercios">0</strong><small>Registros locales</small></article>
        <article class="stat-card"><div class="stat-top"><span>Solicitudes</span><span class="stat-icon blue">▤</span></div><strong>—</strong><small>Módulo por integrar</small></article>
        <article class="stat-card"><div class="stat-top"><span>Pesajes registrados</span><span class="stat-icon orange">⚖</span></div><strong>—</strong><small>Módulo por integrar</small></article>
        <article class="stat-card"><div class="stat-top"><span>Puntos entregados</span><span class="stat-icon purple">✧</span></div><strong>—</strong><small>Módulo por integrar</small></article>
      </div>
      <div class="dashboard-grid">
        <article class="panel"><div class="panel-heading"><div><h3>Accesos rápidos</h3><p>Acciones disponibles en esta versión</p></div></div><div class="quick-actions">
          <button id="quick-add" class="quick-action"><span class="quick-icon green">＋</span><span><b>Registrar comercio</b><small>Guardar un comercio en este dispositivo</small></span><em>›</em></button>
          <button id="quick-list" class="quick-action"><span class="quick-icon blue">☷</span><span><b>Consultar comercios</b><small>Ver los registros almacenados</small></span><em>›</em></button>
        </div></article>
        <article class="panel connection-panel"><div class="panel-heading"><div><h3>Estado del sistema</h3><p>Almacenamiento del navegador</p></div><span class="status-badge"><i></i> Disponible</span></div>
          <div class="connection-row"><span class="db-symbol">◈</span><div><b>PouchDB</b><small>Base de datos local</small></div><strong class="status-text">ACTIVO</strong></div>
          <p class="note">Los registros de esta prueba se guardan en el almacenamiento local del navegador. La sincronización con el servidor todavía está pendiente.</p></article>
      </div><div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;
    await updateStats();
    bindQuickActions();
    return;
  }

  const labels: Record<string, string> = {
    comercios: 'Comercios', solicitudes: 'Solicitudes', pesajes: 'Pesajes', puntos: 'Puntos y recompensas'
  };
  title.textContent = labels[view] ?? 'Panel principal';

  if (view === 'comercios') {
    content.innerHTML = `<div class="section-heading"><div><h2>Directorio de comercios</h2><p>Registros guardados localmente con PouchDB.</p></div><button id="add-commerce" class="primary-button">＋ Registrar comercio</button></div><article class="panel list-panel"><div class="panel-heading"><div><h3>Comercios registrados</h3><p>Información disponible en este dispositivo</p></div><button id="refresh-commerce" class="secondary-button">Actualizar lista</button></div><div id="commerce-list"></div></article><div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;
    document.querySelector('#add-commerce')?.addEventListener('click', registrarComercio);
    document.querySelector('#refresh-commerce')?.addEventListener('click', mostrarComercios);
    await mostrarComercios();
    return;
  }

  const descriptions: Record<string, string> = {
    solicitudes: 'Aquí se administrarán las solicitudes de recolección y su seguimiento.',
    pesajes: 'Aquí se registrarán y consultarán los pesajes de materiales reciclables.',
    puntos: 'Aquí se consultarán los saldos y movimientos de puntos de los participantes.'
  };
  const symbols: Record<string, string> = { solicitudes: '▤', pesajes: '⚖', puntos: '✧' };
  content.innerHTML = `<article class="panel coming-panel"><div class="coming-icon">${symbols[view] ?? '♻'}</div><span class="coming-label">MÓDULO EN DESARROLLO</span><h2>${labels[view]}</h2><p>${descriptions[view]}</p><small>La interfaz está preparada como punto de partida. Este módulo se conectará con la API de Rust en las siguientes etapas.</small></article>`;
}

function bindQuickActions() {
  document.querySelector('#quick-add')?.addEventListener('click', registrarComercio);
  document.querySelector('#quick-list')?.addEventListener('click', () => openView('comercios'));
}

document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach(button => {
  button.addEventListener('click', () => openView(button.dataset.view ?? 'inicio'));
});

bindQuickActions();
updateStats().catch(error => notify(`Error al consultar PouchDB: ${String(error)}`, true));
