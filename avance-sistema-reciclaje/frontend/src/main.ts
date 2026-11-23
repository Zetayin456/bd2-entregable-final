import {
  listarComerciosAPI,
  crearComercioAPI,
  listarSolicitudesAPI,
  crearSolicitudAPI,
  listarPesajesAPI,
  crearPesajeAPI,
  verificarPesajeAPI,
  iniciarSesionAPI,
  haySesionAdmin,
  haySesionRecolector,
  obtenerUsuarioSesion,
  listarMovimientosPuntosAPI,
  consultarSaldoAPI,
  crearMovimientoPuntosAPI,
  sincronizarPendientesAPI
} from './data/api';
import './style.css';
import { listarCola, guardarEnCola } from './data/pouch';
import type { MovimientoPuntosAPI } from './data/api';

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
        <div class="offline-status"><i></i><div><b>API del sistema</b><small>Conectada al servidor</small></div></div>
        <small class="version">Sistema de Gestión · Versión inicial</small>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div><span class="eyebrow">PLATAFORMA DE RECICLAJE</span><h1 id="page-title">Panel principal</h1></div>
        <div class="profile">
          <div class="avatar">A</div>
          <div><b>Administrador</b><small id="session-status">Sesión no iniciada</small></div>
          <button id="login-button" class="secondary-button">Iniciar sesión</button>
        </div>
      </header>
      <section id="content" class="content">
        <div class="welcome">
          <div><span class="welcome-tag">♻ JUNTOS POR UN FUTURO MÁS LIMPIO</span><h2>¡Bienvenido al sistema!</h2><p>Administra comercios, solicitudes de recolección y actividades de reciclaje desde un solo lugar.</p></div>
          <div class="welcome-art" aria-hidden="true">♻</div>
        </div>
        <div class="section-heading"><div><h2>Resumen general</h2><p>Indicadores consultados desde el servidor.</p></div><span class="local-pill"><i></i> API conectada</span></div>
        <div class="stats-grid">
          <article class="stat-card"><div class="stat-top"><span>Comercios registrados</span><span class="stat-icon green">▦</span></div><strong id="stat-comercios">0</strong><small>Registros del servidor</small></article>
          <article class="stat-card"><div class="stat-top"><span>Solicitudes</span><span class="stat-icon blue">▤</span></div><strong id="stat-solicitudes">0</strong><small>Solicitudes registradas</small></article>
          <article class="stat-card"><div class="stat-top"><span>Pesajes registrados</span><span class="stat-icon orange">⚖</span></div><strong id="stat-pesajes">0</strong><small>Pesajes registrados</small></article>
          <article class="stat-card"><div class="stat-top"><span>Pesajes verificados</span><span class="stat-icon purple">✧</span></div><strong id="stat-verificados">0</strong><small>Verificados por administrador</small></article>
        </div>
        <div class="dashboard-grid">
          <article class="panel">
            <div class="panel-heading"><div><h3>Accesos rápidos</h3><p>Acciones disponibles</p></div></div>
            <div class="quick-actions">
              <button id="quick-add" class="quick-action"><span class="quick-icon green">＋</span><span><b>Registrar comercio</b><small>Agregar un comercio</small></span><em>›</em></button>
              <button id="quick-list" class="quick-action"><span class="quick-icon blue">☷</span><span><b>Consultar comercios</b><small>Ver los registros</small></span><em>›</em></button>
            </div>
          </article>
          <article class="panel connection-panel">
            <div class="panel-heading"><div><h3>Estado del sistema</h3><p>Conexión con el servidor</p></div><span class="status-badge"><i></i> Disponible</span></div>
            <div class="connection-row"><span class="db-symbol">◈</span><div><b>API Rust y CouchDB</b><small>Servidor local</small></div><strong class="status-text">ACTIVO</strong></div>
            <p class="note">Los registros se consultan y guardan mediante la API del sistema.</p>
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

function notify(message: string, error = false) {
  const actual = document.querySelector<HTMLElement>('#feedback');
  if (!actual) return;
  actual.textContent = message;
  actual.className = error ? 'feedback error' : 'feedback success';
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char] ?? char));
}

function actualizarSesion() {
  const status = document.querySelector<HTMLElement>('#session-status');
  const button = document.querySelector<HTMLButtonElement>('#login-button');
  if (status) status.textContent = haySesionAdmin() ? 'Administrador autenticado' : 'Sesión no iniciada';
  if (button) button.textContent = haySesionAdmin() ? 'Sesión activa' : 'Iniciar sesión';
}

async function loginAdministrador(): Promise<boolean> {
  if (haySesionAdmin()) return true;

  const usuario = window.prompt('Usuario administrador:');
  if (!usuario) return false;

  const contrasena = window.prompt('Contraseña del administrador:');
  if (!contrasena) return false;

  try {
    await iniciarSesionAPI(usuario, contrasena);
    actualizarSesion();
    notify('Inicio de sesión correcto. Ya puedes realizar operaciones de administrador.');
    return true;
  } catch (error) {
    notify(`No se pudo iniciar sesión: ${String(error)}`, true);
    return false;
  }
}

async function loginRecolector(): Promise<boolean> {
  if (haySesionRecolector()) return true;

  const usuario = window.prompt('Usuario del recolector:');
  if (!usuario) return false;

  const contrasena = window.prompt('Contraseña del recolector:');
  if (!contrasena) return false;

  try {
    await iniciarSesionAPI(usuario, contrasena);

    if (!haySesionRecolector()) {
      notify('Esta cuenta no tiene permisos de recolector.', true);
      return false;
    }

    actualizarSesion();
    notify('Inicio de sesión correcto. Ya puedes registrar pesajes.');
    return true;
  } catch (error) {
    notify(`No se pudo iniciar sesión: ${String(error)}`, true);
    return false;
  }
}

async function asegurarSesion(): Promise<boolean> {
  if (haySesionAdmin()) return true;
  return await loginAdministrador();
}



async function getComercios() {
  return await getComerciosDisponibles();
}

async function getComerciosDisponibles() {
  if (navigator.onLine) {
    try {
      return await listarComerciosAPI();
    } catch {
      // Si falla el servidor, se consultan los datos locales.
    }
  }

  const registros = await listarCola();

  return registros
    .filter(registro =>
      registro.tipo_registro === 'comercio' &&
      registro.estado_sync !== 'rechazado'
    )
    .map(registro => ({
      ...registro.datos,
      _id: registro._id
    })) as Awaited<ReturnType<typeof listarComerciosAPI>>;
}

async function getSolicitudesDisponibles() {
  if (navigator.onLine) {
    try {
      return await listarSolicitudesAPI();
    } catch {
      // Si falla el servidor, se consultan los datos locales.
    }
  }

  const registros = await listarCola();

  return registros
    .filter(registro =>
      registro.tipo_registro === 'solicitud' &&
      registro.estado_sync !== 'rechazado'
    )
    .map(registro => ({
      ...registro.datos,
      _id: registro._id
    })) as Awaited<ReturnType<typeof listarSolicitudesAPI>>;
}

async function updateStats() {
  try {
    const [comercios, solicitudes, pesajes] = await Promise.all([
      listarComerciosAPI(),
      listarSolicitudesAPI(),
      listarPesajesAPI()
    ]);

    const asignar = (id: string, valor: number) => {
      const elemento = document.querySelector<HTMLElement>(`#${id}`);
      if (elemento) elemento.textContent = String(valor);
    };

    asignar('stat-comercios', comercios.length);
    asignar('stat-solicitudes', solicitudes.length);
    asignar('stat-pesajes', pesajes.length);
    asignar('stat-verificados', pesajes.filter(p => p.estado === 'verificado').length);
  } catch (error) {
    notify(`No se pudo actualizar el resumen: ${String(error)}`, true);
  }
}

async function registrarComercio() {
  const nombre = window.prompt('Escribe el nombre del comercio:');
  if (!nombre || !nombre.trim()) return;

  try {
    const result = await crearComercioAPI({
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
    target.innerHTML = '<div class="empty-state"><span>▦</span><b>Aún no hay comercios registrados</b><p>Usa el botón Registrar comercio para agregar el primero.</p></div>';
    return;
  }

  target.innerHTML = `
    <div class="table-wrap"><table class="commerce-table">
      <thead><tr><th>Nombre del comercio</th><th>Estado</th><th>Identificador</th></tr></thead>
      <tbody>${comercios.map(item => `<tr><td><b>${escapeHtml(item.nombre)}</b></td><td><span class="table-status">${escapeHtml(item.estado)}</span></td><td><code>${escapeHtml(item._id ?? '')}</code></td></tr>`).join('')}</tbody>
    </table></div>`;
}

async function mostrarSolicitudes() {
  const target = document.querySelector<HTMLElement>('#solicitudes-list');
  if (!target) return;

  try {
   const [solicitudes, comercios] = await Promise.all([
  getSolicitudesDisponibles(),
  getComerciosDisponibles()
]);

    if (solicitudes.length === 0) {
      target.innerHTML = '<div class="empty-state"><b>Aún no hay solicitudes</b><p>Registra una solicitud para comenzar.</p></div>';
      return;
    }

    target.innerHTML = `
      <div class="table-wrap"><table class="commerce-table">
        <thead><tr><th>Comercio</th><th>Tipo de residuo</th><th>Dirección</th><th>Cantidad aproximada</th><th>Estado</th><th>Identificador</th></tr></thead>
        <tbody>${solicitudes.map(item => {
          const comercio = comercios.find(c => c._id === item.comercio_id);
          return `<tr>
            <td><b>${escapeHtml(comercio?.nombre ?? item.comercio_id)}</b></td>
            <td>${escapeHtml(item.tipo_residuo)}</td>
            <td>${escapeHtml(item.direccion)}</td>
            <td>${item.cantidad_aproximada} kg</td>
            <td><span class="table-status">${escapeHtml(item.estado ?? 'pendiente')}</span></td>
            <td><code>${escapeHtml(item._id ?? '')}</code></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  } catch (error) {
    target.innerHTML = '<div class="empty-state">No se pudieron cargar las solicitudes.</div>';
    notify(`Error al consultar solicitudes: ${String(error)}`, true);
  }
}

async function registrarSolicitud(event: Event) {
  event.preventDefault();
  const formulario = event.currentTarget as HTMLFormElement;
  const datos = new FormData(formulario);

  const solicitud = {
    comercio_id: String(datos.get('comercio_id') ?? ''),
    tipo_residuo: String(datos.get('tipo_residuo') ?? ''),
    direccion: String(datos.get('direccion') ?? '').trim(),
    cantidad_aproximada: Number(datos.get('cantidad_aproximada')),
    createdAt: new Date().toISOString()
  };

  try {
    const resultado = await crearSolicitudAPI(solicitud);
    formulario.reset();
    notify(`Solicitud registrada correctamente. Identificador: ${resultado.id}`);
    await mostrarSolicitudes();
    await updateStats();
  } catch (error) {
    notify(`No se pudo registrar la solicitud: ${String(error)}`, true);
  }
}

// ========================
// PESAJES
// ========================

async function mostrarPesajes() {
  const target = document.querySelector<HTMLElement>('#pesajes-list');
  if (!target) return;

  try {
    
const registrosLocales = await listarCola();

    let pesajesServidor: Awaited<ReturnType<typeof listarPesajesAPI>> = [];

    if (navigator.onLine) {
      try {
        pesajesServidor = await listarPesajesAPI();
      } catch {
        // Si falla el servidor, se muestran los registros locales.
      }
    }

    const registrosLocalesPesaje = registrosLocales.filter(registro =>
      registro.tipo_registro === 'pesaje' &&
      registro.estado_sync !== 'rechazado' &&
      (
        !navigator.onLine ||
        registro.estado_sync === 'pendiente' ||
        pesajesServidor.length === 0
      )
    );

    const idsServidor = new Set(
      pesajesServidor.map(pesaje => pesaje._id)
    );

    const pesajesLocales = registrosLocalesPesaje
      .filter(registro => !idsServidor.has(registro._id))
      .map(registro => ({
        ...registro.datos,
        _id: registro._id
      })) as Awaited<ReturnType<typeof listarPesajesAPI>>;

    const pesajes = [...pesajesServidor, ...pesajesLocales];

    const idsPendientesLocales = new Set(
      registrosLocales
        .filter(registro =>
          registro.tipo_registro === 'pesaje' &&
          registro.estado_sync === 'pendiente'
        )
        .map(registro => registro._id)
    );
  


    if (pesajes.length === 0) {
      target.innerHTML = '<div class="empty-state"><b>Aún no hay pesajes registrados</b><p>Registra el primer pesaje usando el formulario.</p></div>';
      return;
    }

    
target.innerHTML = `
  <div class="table-wrap"><table class="commerce-table">
    <thead>
      <tr>
        <th>Residuo</th>
        <th>Peso</th>
        <th>Comercio</th>
        <th>Recolector</th>
        <th>Estado</th>
        <th>Identificador</th>
        <th>Acción</th>
      </tr>
    </thead>
    <tbody>
      ${pesajes.map(p => `<tr>
        <td>${escapeHtml(p.tipo_residuo)}</td>
        <td>${p.peso_kg} kg</td>
        <td><code>${escapeHtml(p.comercio_id)}</code></td>
        <td><code>${escapeHtml(p.recolector_id)}</code></td>
        <td><span class="table-status">${escapeHtml(p.estado ?? 'pendiente')}</span></td>
        <td><code>${escapeHtml(p._id ?? '')}</code></td>
        <td>${p.estado === 'verificado'
          ? 'Verificado'
          : idsPendientesLocales.has(p._id ?? '')
            ? 'Pendiente de sincronización'
            : `<button class="secondary-button verify-pesaje" data-id="${escapeHtml(p._id ?? '')}">Verificar</button>`}
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;


    target.querySelectorAll<HTMLButtonElement>('.verify-pesaje').forEach(button => {
      button.addEventListener('click', async () => {
        const autorizado = await asegurarSesion();
        if (!autorizado) return;

        try {
          await verificarPesajeAPI(button.dataset.id ?? '');
          notify('Pesaje verificado correctamente.');
          await mostrarPesajes();
          await updateStats();
        } catch (error) {
          notify(`No se pudo verificar el pesaje: ${String(error)}`, true);
        }
      });
    });
  } catch (error) {
    target.innerHTML = '<div class="empty-state">No se pudieron cargar los pesajes.</div>';
    notify(`Error al consultar pesajes: ${String(error)}`, true);
  }
}

async function registrarPesaje(event: Event) {
  event.preventDefault();
    const autorizado = await loginRecolector();
  if (!autorizado) return;

  const recolectorId = obtenerUsuarioSesion();

  if (!recolectorId) {
    notify('No se pudo identificar al recolector autenticado.', true);
    return;
  }

  const formulario = event.currentTarget as HTMLFormElement;
  const datos = new FormData(formulario);

  const solicitudSelect = formulario.elements.namedItem('solicitud_id') as HTMLSelectElement;
const opcionSolicitud = solicitudSelect.selectedOptions[0];

const comercioIdSolicitud = opcionSolicitud?.dataset.comercioId ?? '';
const comercioId = String(datos.get('comercio_id') ?? '').trim();

if (!comercioIdSolicitud || comercioId !== comercioIdSolicitud) {
  notify('El comercio no coincide con la solicitud seleccionada. Selecciona nuevamente la solicitud.', true);
  return;
}

const pesaje = {
  solicitud_id: String(datos.get('solicitud_id') ?? '').trim(),
  comercio_id: comercioId,
  recolector_id: recolectorId,
  tipo_residuo: opcionSolicitud.dataset.tipoResiduo ?? '',
  peso_kg: Number(datos.get('peso_kg'))
};

  try {
    const resultado = await crearPesajeAPI(pesaje);
    formulario.reset();
    notify(`Pesaje registrado. Identificador: ${resultado.id}. Estado inicial: pendiente de verificación.`);
    await mostrarPesajes();
    await updateStats();
  } catch (error) {
    notify(`No se pudo registrar el pesaje: ${String(error)}`, true);
  }
}

// ========================
// PUNTOS
// ========================


async function mostrarPuntos() {
  const comercioSelect = document.querySelector<HTMLSelectElement>('#puntos-comercio');
  const saldoTarget = document.querySelector<HTMLElement>('#saldo-puntos');
  const movimientosTarget = document.querySelector<HTMLElement>('#movimientos-list');

  if (!comercioSelect || !saldoTarget || !movimientosTarget) return;

  const comercioId = comercioSelect.value;

  if (!comercioId) {
    saldoTarget.textContent = 'Selecciona un comercio';
    movimientosTarget.innerHTML = '<div class="empty-state">Selecciona un comercio para consultar sus movimientos.</div>';
    return;
  }

  const registrosLocales = await listarCola();

  const pendientes = registrosLocales.filter(
    registro =>
      registro.tipo_registro === 'movimiento_puntos' &&
      registro.estado_sync !== 'sincronizado'
  );

  let movimientosConfirmados: MovimientoPuntosAPI[] = [];

  if (navigator.onLine) {
    try {
      const [saldo, movimientos] = await Promise.all([
        consultarSaldoAPI(comercioId),
        listarMovimientosPuntosAPI(comercioId)
      ]);

      saldoTarget.textContent = `${saldo.saldo_puntos ?? 0} puntos`;
      movimientosConfirmados = movimientos;
    } catch (error) {
      saldoTarget.textContent = 'No disponible';
      notify(`No se pudieron consultar los puntos: ${String(error)}`, true);
    }
  } else {
    saldoTarget.textContent = 'No disponible sin conexión';
  }

  const tablaConfirmados = movimientosConfirmados.length > 0
    ? movimientosConfirmados.map(m => `
        <tr>
          <td>${escapeHtml(m.operacion ?? 'movimiento')}</td>
          <td>${m.puntos}</td>
          <td><code>${escapeHtml(m.pesaje_id ?? '')}</code></td>
          <td><span class="local-pill">Confirmado</span></td>
        </tr>
      `).join('')
    : '';

  const tablaPendientes = pendientes.length > 0
    ? pendientes.map(registro => `
        <tr>
          <td>Acreditación solicitada</td>
          <td>${Number(registro.datos.puntos) || 0}</td>
          <td><code>${escapeHtml(String(registro.datos.pesaje_id ?? ''))}</code></td>
          <td>
            <span class="local-pill">Pendiente de sincronización</span>
            ${registro.ultimo_error
              ? `<small>${escapeHtml(registro.ultimo_error)}</small>`
              : ''}
          </td>
        </tr>
      `).join('')
    : '';

  if (!tablaConfirmados && !tablaPendientes) {
    movimientosTarget.innerHTML =
      '<div class="empty-state">No hay movimientos confirmados ni solicitudes pendientes en este dispositivo.</div>';
    return;
  }

  movimientosTarget.innerHTML = `
    <div class="table-wrap">
      <table class="commerce-table">
        <thead>
          <tr>
            <th>Operación</th>
            <th>Puntos</th>
            <th>Pesaje asociado</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${tablaConfirmados}
          ${tablaPendientes}
        </tbody>
      </table>
    </div>
    ${pendientes.length > 0
      ? '<p class="note">Las solicitudes pendientes todavía no forman parte del saldo confirmado.</p>'
      : ''}
  `;
}


async function acreditarPuntos(event: Event) {
  event.preventDefault();

  const formulario = event.currentTarget as HTMLFormElement;
  const datos = new FormData(formulario);

  const pesajeId = String(datos.get('pesaje_id') ?? '').trim();
  const puntos = Number(datos.get('puntos'));

  if (!pesajeId || !Number.isInteger(puntos) || puntos <= 0) {
    notify('Ingresa un identificador de pesaje y una cantidad válida de puntos.', true);
    return;
  }

  // Sin conexión: guardar la solicitud localmente.
  if (!navigator.onLine) {
    try {
      await guardarEnCola('movimiento_puntos', {
        pesaje_id: pesajeId,
        puntos
      });

      formulario.reset();

      notify(
        'Solicitud guardada localmente. Los puntos quedan pendientes de sincronización y todavía no se suman al saldo.'
      );

      await mostrarPuntos();
    } catch (error) {
      notify(`No se pudo guardar la solicitud local: ${String(error)}`, true);
    }

    return;
  }

  // Con conexión: conservar la autorización del administrador.
  const autorizado = await asegurarSesion();
  if (!autorizado) return;

  try {
    await crearMovimientoPuntosAPI(pesajeId, puntos);

    formulario.reset();

    notify('Puntos acreditados correctamente al comercio asociado al pesaje.');

    await mostrarPuntos();
  } catch (error) {
    notify(`No se pudieron acreditar los puntos: ${String(error)}`, true);
  }
}


// ========================
// NAVEGACIÓN Y PANTALLAS
// ========================

async function openView(view: string) {
  document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
  });

  document.querySelector<HTMLElement>('#feedback')?.replaceChildren();

  if (view === 'inicio') {
    title.textContent = 'Panel principal';
    content.innerHTML = `
      <div class="welcome"><div><span class="welcome-tag">♻ JUNTOS POR UN FUTURO MÁS LIMPIO</span><h2>¡Bienvenido al sistema!</h2><p>Administra comercios, solicitudes de recolección y actividades de reciclaje desde un solo lugar.</p></div><div class="welcome-art">♻</div></div>
      <div class="section-heading"><div><h2>Resumen general</h2><p>Indicadores consultados desde el servidor.</p></div><span class="local-pill"><i></i> API conectada</span></div>
      <div class="stats-grid">
        <article class="stat-card"><div class="stat-top"><span>Comercios registrados</span><span class="stat-icon green">▦</span></div><strong id="stat-comercios">0</strong><small>Registros del servidor</small></article>
        <article class="stat-card"><div class="stat-top"><span>Solicitudes</span><span class="stat-icon blue">▤</span></div><strong id="stat-solicitudes">0</strong><small>Solicitudes registradas</small></article>
        <article class="stat-card"><div class="stat-top"><span>Pesajes registrados</span><span class="stat-icon orange">⚖</span></div><strong id="stat-pesajes">0</strong><small>Pesajes registrados</small></article>
        <article class="stat-card"><div class="stat-top"><span>Pesajes verificados</span><span class="stat-icon purple">✧</span></div><strong id="stat-verificados">0</strong><small>Verificados por administrador</small></article>
      </div>
      <div class="dashboard-grid">
        <article class="panel"><div class="panel-heading"><div><h3>Accesos rápidos</h3><p>Acciones disponibles</p></div></div><div class="quick-actions">
          <button id="quick-add" class="quick-action"><span class="quick-icon green">＋</span><span><b>Registrar comercio</b><small>Agregar un comercio</small></span><em>›</em></button>
          <button id="quick-list" class="quick-action"><span class="quick-icon blue">☷</span><span><b>Consultar comercios</b><small>Ver los registros</small></span><em>›</em></button>
        </div></article>
        <article class="panel connection-panel"><div class="panel-heading"><div><h3>Estado del sistema</h3><p>Conexión con el servidor</p></div><span class="status-badge"><i></i> Disponible</span></div>
          <div class="connection-row"><span class="db-symbol">◈</span><div><b>API Rust y CouchDB</b><small>Servidor local</small></div><strong class="status-text">ACTIVO</strong></div>
          <p class="note">Los registros se consultan y guardan mediante la API del sistema.</p></article>
      </div><div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;

    bindQuickActions();
    await updateStats();
    return;
  }

  const labels: Record<string, string> = {
    comercios: 'Comercios',
    solicitudes: 'Solicitudes',
    pesajes: 'Pesajes',
    puntos: 'Puntos y recompensas'
  };
  title.textContent = labels[view] ?? 'Panel principal';

  if (view === 'comercios') {
    content.innerHTML = `
      <div class="section-heading"><div><h2>Directorio de comercios</h2><p>Registros consultados desde el servidor.</p></div><button id="add-commerce" class="primary-button">＋ Registrar comercio</button></div>
      <article class="panel list-panel"><div class="panel-heading"><div><h3>Comercios registrados</h3><p>Información disponible en el servidor</p></div><button id="refresh-commerce" class="secondary-button">Actualizar lista</button></div><div id="commerce-list"></div></article>
      <div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;
    document.querySelector('#add-commerce')?.addEventListener('click', registrarComercio);
    document.querySelector('#refresh-commerce')?.addEventListener('click', mostrarComercios);
    await mostrarComercios();
    return;
  }

  if (view === 'solicitudes') {
      const comercios = await getComerciosDisponibles();

    content.innerHTML = `
      <div class="section-heading"><div><h2>Solicitudes de recolección</h2><p>Registra y consulta las solicitudes de los comercios.</p></div></div>
      <article class="panel list-panel">
        <div class="panel-heading"><div><h3>Nueva solicitud</h3><p>Completa los datos para solicitar una recolección.</p></div></div>
        ${comercios.length === 0
          ? '<p class="note">Primero debes registrar un comercio para poder crear una solicitud.</p>'
          : `<form id="solicitud-form" class="form-grid">
              <label>Comercio<select name="comercio_id" required><option value="">Selecciona un comercio</option>${comercios.map(c => `<option value="${escapeHtml(c._id ?? '')}">${escapeHtml(c.nombre)}</option>`).join('')}</select></label>
              <label>Tipo de residuo<select name="tipo_residuo" required><option value="">Selecciona el residuo</option><option>Plástico</option><option>Papel</option><option>Cartón</option><option>Vidrio</option><option>Metal</option><option>Orgánico</option><option>Otro</option></select></label>
              <label>Dirección de recolección<input name="direccion" required maxlength="250" placeholder="Escribe la dirección"></label>
              <label>Cantidad aproximada (kg)<input name="cantidad_aproximada" type="number" required min="0.01" step="0.01" placeholder="Ej. 25"></label>
              <div class="form-actions"><button type="submit" class="primary-button">Registrar solicitud</button></div>
            </form>`}
      </article>
      <article class="panel list-panel"><div class="panel-heading"><div><h3>Solicitudes registradas</h3><p>Información consultada desde el servidor.</p></div><button id="refresh-solicitudes" class="secondary-button">Actualizar lista</button></div><div id="solicitudes-list"></div></article>
      <div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;

    document.querySelector('#solicitud-form')?.addEventListener('submit', registrarSolicitud);
    document.querySelector('#refresh-solicitudes')?.addEventListener('click', mostrarSolicitudes);
    await mostrarSolicitudes();
    return;
  }

  if (view === 'pesajes') {
  const [solicitudes, comercios] = await Promise.all([
    getSolicitudesDisponibles(),
    getComerciosDisponibles()
  ]);

    content.innerHTML = `
      <div class="section-heading"><div><h2>Control de pesajes</h2><p>Registra el peso de los materiales y consulta su estado de verificación.</p></div></div>
      <article class="panel list-panel">
        <div class="panel-heading"><div><h3>Registrar nuevo pesaje</h3><p>Completa los datos del pesaje realizado.</p></div></div>
        ${solicitudes.length === 0 || comercios.length === 0
          ? '<p class="note">Necesitas registrar primero un comercio y una solicitud para crear un pesaje.</p>'
          : `<form id="pesaje-form" class="form-grid">
              <label>Solicitud
  <select name="solicitud_id" id="solicitud-select" required>
    <option value="">Selecciona una solicitud</option>
    ${solicitudes.map(s => {
      const comercio = comercios.find(c => c._id === s.comercio_id);
      return `<option
        value="${escapeHtml(s._id ?? '')}"
        data-comercio-id="${escapeHtml(s.comercio_id)}"
        data-tipo-residuo="${escapeHtml(s.tipo_residuo)}"
        data-comercio-nombre="${escapeHtml(comercio?.nombre ?? 'Comercio no encontrado')}"
      >${escapeHtml(s._id ?? '')} — ${escapeHtml(s.tipo_residuo)} — ${escapeHtml(String(s.cantidad_aproximada))} kg — ${escapeHtml(comercio?.nombre ?? 'Comercio no encontrado')}</option>`;
    }).join('')}
  </select>
</label>

<label>Comercio asociado
  <input id="comercio-display" type="text" disabled placeholder="Se asignará al seleccionar solicitud">
  <input type="hidden" name="comercio_id" id="comercio-id">
</label>

<label>Recolector autenticado
  <input id="recolector-id" value="Se asignará al iniciar sesión" readonly>
</label>

<label>Tipo de residuo
  <input name="tipo_residuo" id="tipo-residuo" required readonly placeholder="Se asignará según la solicitud">
</label>
              
              <label>Peso en kilogramos<input name="peso_kg" type="number" min="0.01" step="0.01" required placeholder="Ej. 15.5"></label>
              <div class="form-actions"><button type="submit" class="primary-button">Registrar pesaje</button></div>
            </form>`}
      </article>
      <article class="panel list-panel"><div class="panel-heading"><div><h3>Pesajes registrados</h3><p>Los pesajes nuevos quedan pendientes de verificación.</p></div><button id="refresh-pesajes" class="secondary-button">Actualizar lista</button></div><div id="pesajes-list"></div></article>
      <div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;

    document.querySelector('#pesaje-form')?.addEventListener('submit', registrarPesaje);
    const solicitudSelect = document.querySelector<HTMLSelectElement>('#solicitud-select');
const comercioIdInput = document.querySelector<HTMLInputElement>('#comercio-id');
const comercioDisplay = document.querySelector<HTMLInputElement>('#comercio-display');
const tipoResiduoInput = document.querySelector<HTMLInputElement>('#tipo-residuo');

solicitudSelect?.addEventListener('change', () => {
  const opcion = solicitudSelect.selectedOptions[0];

  if (!opcion?.value) {
    if (comercioIdInput) comercioIdInput.value = '';
    if (comercioDisplay) comercioDisplay.value = '';
    if (tipoResiduoInput) tipoResiduoInput.value = '';
    return;
  }

  if (comercioIdInput) {
    comercioIdInput.value = opcion.dataset.comercioId ?? '';
  }

  if (comercioDisplay) {
    comercioDisplay.value = opcion.dataset.comercioNombre ?? '';
  }

  if (tipoResiduoInput) {
    tipoResiduoInput.value = opcion.dataset.tipoResiduo ?? '';
  }
});
    document.querySelector('#refresh-pesajes')?.addEventListener('click', mostrarPesajes);
    await mostrarPesajes();
    return;
  }

  if (view === 'puntos') {
    const comercios = await getComerciosDisponibles();

    content.innerHTML = `
      <div class="section-heading"><div><h2>Administración de puntos</h2><p>Consulta saldos y movimientos de puntos de cada comercio.</p></div></div>
      <article class="panel list-panel">
        <div class="panel-heading"><div><h3>Consultar saldo</h3><p>Selecciona el comercio que deseas consultar.</p></div></div>
        ${comercios.length === 0
          ? '<p class="note">Primero debes registrar un comercio.</p>'
          : `<div class="form-grid"><label>Comercio<select id="puntos-comercio"><option value="">Selecciona un comercio</option>${comercios.map(c => `<option value="${escapeHtml(c._id ?? '')}">${escapeHtml(c.nombre)}</option>`).join('')}</select></label><div><p>Saldo disponible</p><h2 id="saldo-puntos">Selecciona un comercio</h2></div></div>`}
      </article>
      <article class="panel list-panel">
        <div class="panel-heading"><div><h3>Acreditar puntos</h3><p>Solo se pueden acreditar puntos a un pesaje verificado.</p></div></div>
        <form id="puntos-form" class="form-grid">
          <label>Identificador del pesaje verificado<input name="pesaje_id" required placeholder="ID del pesaje"></label>
          <label>Cantidad de puntos<input name="puntos" type="number" min="1" step="1" required placeholder="Ej. 50"></label>
          <div class="form-actions"><button type="submit" class="primary-button">Acreditar puntos</button></div>
        </form>
      </article>
      <article class="panel list-panel"><div class="panel-heading"><div><h3>Movimientos de puntos</h3><p>Historial del comercio seleccionado.</p></div><button id="refresh-puntos" class="secondary-button">Actualizar</button></div><div id="movimientos-list"><div class="empty-state">Selecciona un comercio.</div></div></article>
      <div id="feedback" class="feedback" role="status" aria-live="polite"></div>`;

    document.querySelector('#puntos-comercio')?.addEventListener('change', mostrarPuntos);
    document.querySelector('#refresh-puntos')?.addEventListener('click', mostrarPuntos);
    document.querySelector('#puntos-form')?.addEventListener('submit', acreditarPuntos);
    return;
  }
}

function bindQuickActions() {
  document.querySelector('#quick-add')?.addEventListener('click', registrarComercio);
  document.querySelector('#quick-list')?.addEventListener('click', () => openView('comercios'));
}

document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach(button => {
  button.addEventListener('click', () => openView(button.dataset.view ?? 'inicio'));
});

document.querySelector('#login-button')?.addEventListener('click', async () => {
  if (!haySesionAdmin()) await loginAdministrador();
  else notify('La sesión de administrador está activa.');
});

actualizarSesion();
bindQuickActions();
updateStats().catch(error => notify(`Error al consultar el servidor: ${String(error)}`, true));

// SINCRONIZACION AUTOMATICA AL RECUPERAR INTERNET

async function ejecutarSincronizacion() {
  try {
    const resultado = await sincronizarPendientesAPI();

    if (resultado.sincronizados > 0) {
      notify(`Se sincronizaron ${resultado.sincronizados} registro(s).`);
      await updateStats();
    }
  } catch (error) {
    notify(`Error al sincronizar: ${String(error)}`, true);
  }
}

// Detectar cuando vuelve la conexión
window.addEventListener('online', () => {
  void ejecutarSincronizacion();
});

// Sincronizar pendientes al abrir la aplicación
if (navigator.onLine) {
  void ejecutarSincronizacion();
}


