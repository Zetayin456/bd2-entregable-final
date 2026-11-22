# Módulo 7: recompensas, operación y trabajo offline

## Recompensas y ledger

- `GET /api/rewards` entrega recompensas activas desde CouchDB. `couchdb/init.sh` crea el catálogo inicial de kit de reciclaje (100 puntos) y vale de comercio (250 puntos) sin reemplazar documentos existentes.
- `POST /api/rewards/{recompensa_id}/redeem` acepta `{ "request_id": "<idempotency-key>" }` y solo permite canjes de una sesión de comercio.
- El servidor toma el costo desde el documento de recompensa, valida saldo y usa `saldo:{comercio_id}` con revisión `_rev` de CouchDB como punto de serialización para créditos y débitos. Los IDs de movimiento `canje:{comercio_id}:{request_id}` evitan duplicar el ledger en reintentos. Los movimientos siguen siendo la historia auditable y `GET /api/points/balance` conserva el contrato anterior.
- Respuestas relevantes: `409 saldo_insuficiente` para saldo bajo; reintento con la misma clave y misma recompensa devuelve éxito idempotente; reutilizar la clave para otro canje devuelve `409 solicitud_canje_duplicada`.

## Ciclo operativo en la interfaz

1. El administrador registra comercios y crea cuentas desde **Equipo**; una cuenta de comercio queda vinculada a un comercio existente. Operadores y recolectores se crean desde el mismo formulario.
2. El comercio registra una solicitud pendiente desde **Solicitudes**. El administrador u operador la aprueba y selecciona un recolector. La API comprueba que el usuario asignado tenga rol de recolector.
3. El recolector ve sus solicitudes asignadas y registra un pesaje asociado. El registro se guarda primero en PouchDB; la API conserva sus controles de fecha, material, duplicidad y permisos.
4. El administrador u operador verifica el pesaje. El backend acredita puntos una sola vez. La solicitud solo puede cerrarse después de existir un pesaje verificado asociado.
5. El comercio consulta su saldo, revisa el catálogo y canjea una recompensa. La operación requiere conexión con la API y descuenta puntos en el ledger autoritativo.

## Prueba real de cola offline

`client-sim` conserva el modo inactivo habitual. Ejecutado con `SIM_MODE=offline-sync`, escribe un comercio y una solicitud en una base PouchDB local sin hacer solicitudes HTTP, confirma que ambos documentos están pendientes, se autentica al simular la reconexión y los envía por la API. Al final vuelve a consultarlos en CouchDB a través del backend y comprueba que la cola local quedó sincronizada.

La prueba de integración nueva `tests/rewards.mjs` crea datos de prueba con IDs únicos, verifica un pesaje de 20 kg de cartón para obtener 100 puntos, canjea la recompensa de 100 puntos, reintenta con la misma clave, comprueba que se rechaza un canje adicional sin saldo y verifica el saldo final. Como la prueba deja los datos en CouchDB, debe ejecutarse solo en un entorno local o descartable.

## Ejecución

```powershell
docker compose up --build -d
node tests/integration.mjs
node tests/rewards.mjs
$env:SIM_ADMIN_USER = (Select-String '^BOOTSTRAP_ADMIN_USER=' .env).Line.Split('=', 2)[1].Trim('"')
$env:SIM_ADMIN_PASSWORD = (Select-String '^BOOTSTRAP_ADMIN_PASSWORD=' .env).Line.Split('=', 2)[1].Trim('"')
docker compose run --rm -e SIM_MODE=offline-sync -e SIM_ADMIN_USER -e SIM_ADMIN_PASSWORD client-sim
Remove-Item Env:SIM_ADMIN_USER, Env:SIM_ADMIN_PASSWORD
```

Las credenciales de administrador se pasan al contenedor solo durante la ejecución puntual del modo offline. Para la interfaz, abre `http://localhost:5173`. El stack debe estar activo antes de ejecutar las pruebas Node o el modo `offline-sync`.
