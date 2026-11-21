# Módulo 6: suite y verificación del sistema

## Pruebas automatizadas

- `backend/src/main.rs` contiene pruebas unitarias para cálculo de puntos, materiales y límites, transiciones de solicitudes por rol e identidad del evento de verificación/id de movimiento determinista.
- `tests/integration.mjs` ejecuta un flujo contra una instancia activa: inicio de sesión correcto e incorrecto, rutas protegidas, roles y alcance por comercio, listado y cambios incrementales para el cliente, flujo y transiciones de solicitud, asociación de pesajes, límites, duplicados, ráfagas, verificación y saldo/idempotencia de puntos.
- El target `verify` de Docker corre las unitarias, `cargo check` y Clippy con warnings como errores.
- `client-sim` actualmente solo crea una base PouchDB y queda en espera; no simula llamadas ni replicación contra la API. `load/reciclaje.js` es una prueba k6 de disponibilidad HTTP (`/salud`), no una carga del flujo de negocio. El modo `netem` aplica latencia/pérdida de paquetes; no es una prueba automática de aceptación.

## Requisitos y preparación

Docker Desktop con el motor Linux iniciado; Node.js 18 o posterior; en Windows, PowerShell 7 es opcional. `.env` debe definir `COUCHDB_USER`, `COUCHDB_PASSWORD`, `COUCHDB_PROXY_SECRET`, `JWT_SECRET`, `BOOTSTRAP_ADMIN_USER` y `BOOTSTRAP_ADMIN_PASSWORD`. Los secretos de aplicación deben ser locales y no se imprimen ni se incluyen en la suite. La inicialización de CouchDB usa esos valores y `couchdb/lab.ini` ya no declara una cuenta administrativa fija.

Desde la raíz del proyecto:

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://localhost:8091/salud
Invoke-WebRequest http://localhost:5173
node tests/integration.mjs
```

El último comando requiere que el stack siga activo. Crea usuarios y registros con IDs únicos de prueba en CouchDB; no elimina documentos ni usuarios al terminar para evitar borrar datos compartidos. Ejecútalo contra una instancia local o una base descartable, nunca contra datos de producción.

Pruebas unitarias y calidad del backend:

```powershell
docker build --target verify -t reciclaje-backend-verify ./backend
```

También se pueden ejecutar desde Rust local con el toolchain apropiado:

```powershell
Set-Location backend
cargo test --all-targets --locked
cargo check --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
Set-Location ..
```

Build del frontend:

```powershell
Set-Location frontend
npm ci
npm run build
Set-Location ..
```

Prueba k6 opcional, independiente de la suite de integración:

```powershell
docker compose --profile load run --rm k6
```

## Comprobación manual de la sincronización PouchDB en navegador

1. Abre `http://localhost:5173`, inicia sesión con una cuenta de comercio y crea una solicitud. Confirma en Network que `POST /auth/login`, `GET /api/changes` y `PUT /api/docs/<id>` llegan a la API sin enviar credenciales CouchDB desde el navegador.
2. Desconecta temporalmente el navegador de la red, guarda un cambio local y confirma el estado pendiente. Reconecta, usa **Sincronizar** y confirma que el documento aparece en CouchDB/API y pasa a sincronizado.
3. Repite con un pesaje inválido y confirma que la respuesta de API deja el motivo de rechazo visible en el registro y en el indicador de sincronización.
4. Inicia sesión con recolector y operador, registra y verifica un pesaje, y consulta el saldo de comercio. La suite Node automatiza el contrato HTTP y la acreditación; este recorrido comprueba además el cliente PouchDB real.

## Resultado y limitaciones

Para dar la suite por aprobada deben terminar correctamente `docker compose config --quiet`, el build `verify`, el build del frontend, la suite Node y el chequeo `/salud`. La prueba Node usa la API y CouchDB reales, y valida el movimiento de puntos idempotente. La verificación en navegador sigue siendo manual porque el repositorio no incluye Playwright/Webdriver. La prueba de carga actual solo mide disponibilidad y no reemplaza pruebas de rendimiento del flujo autenticado.

### Ejecución en el entorno de desarrollo actual

El 21-11-2026 pasaron `cargo fmt --check`, `node --check tests/integration.mjs`, `docker compose config --quiet` y `git diff --check`. No se pudo iniciar ni probar la suite integrada: Docker Desktop no respondió a `docker info`. `cargo test --all-targets --locked` no alcanzó a compilar porque falta `link.exe` (Visual C++ Build Tools). `npm run build` no encontró `tsc`; `npm ci` terminó con un error interno de npm. Repetir esos pasos después de iniciar Docker Desktop, instalar el workload de C++ de Visual Studio y restaurar dependencias con `npm ci`.
