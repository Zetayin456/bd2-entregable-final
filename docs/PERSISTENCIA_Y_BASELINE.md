# Persistencia CouchDB y comparación baseline

## Índices Mango

`couchdb-init` crea los índices idempotentemente al iniciar el stack. Las consultas `/_find` del backend fijan el índice con `use_index`; los nombres se mantienen en este cuadro para que sea fácil detectar desajustes entre el selector y su índice.

| Índice | Campos en orden | Consultas que lo usan |
| --- | --- | --- |
| `idx_document_type` | `type` | Listados paginados de documentos por tipo |
| `idx_rewards_active` | `type`, `activo` | Catálogo de recompensas activas |
| `idx_movements_commerce` | `type`, `comercio_id` | Saldo y listado de movimientos por comercio |
| `idx_weighings_state` | `type`, `estado` | Reconciliación de pesajes verificados |
| `idx_weighings_request` | `type`, `solicitud_id` | Duplicidad y verificación de pesajes por solicitud |
| `idx_capture_window` | `type`, `recolector_id`, `comercio_id`, `capturado_en` | Pesajes por recolector/comercio desde una fecha |

La regla de duplicidad conserva los filtros por estado y la ausencia de `solicitud_id` como filtros posteriores sobre los resultados indexados. Esto evita depender de `$ne` o `$exists:false` como condición de acceso al índice. El límite consultado es de 500 documentos; si ese volumen por hora se vuelve posible en el uso real, esa comprobación debe paginarse hasta encontrar ocho coincidencias o terminar el rango.

Para inspeccionar los índices instalados y el plan elegido, con el Compose normal en marcha:

```sh
curl -u "$COUCHDB_USER:$COUCHDB_PASSWORD" http://localhost:5984/reciclaje/_index
curl -u "$COUCHDB_USER:$COUCHDB_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"selector":{"type":"movimiento_puntos","comercio_id":"comercio:demo"},"use_index":"idx_movements_commerce"}' \
  http://localhost:5984/reciclaje/_explain
```

Confirme en `_explain` que `index.ddoc` y `index.name` señalan el índice esperado. `use_index` solicita un índice concreto, pero el plan debe comprobarse con los datos y versión desplegados.

## Decisión de modularización Rust

`main.rs` concentra rutas, autenticación y acceso a CouchDB. La instrumentación está en `observability.rs`; las reglas puras de cálculo de puntos y creación de identificadores idempotentes están en `domain.rs`. Se preservan contratos JSON y handlers. La separación de acceso a datos, autorización y handlers continúa pendiente y debe hacerse por etapas, conservando `tests/integration.mjs`.

## Baseline relacional reproducible

El perfil anterior intentaba construir `baseline-api` desde `./baseline`, pero esa carpeta no existía y PostgreSQL no tenía credenciales ni esquema/índices. Se sustituyó por un baseline de persistencia PostgreSQL 16 con `pgbench`: crea un esquema e índices explícitos, ejecuta upsert y lectura de pesajes, fija semilla, clientes, procesos paralelos y duración, y guarda salida y registros transaccionales en `results/`.

Es una comparación reproducible de persistencia relacional frente a CouchDB, no una comparación integral de API: no incluye autenticación, reglas de negocio Rust ni el costo del cliente HTTP. Para atribuir diferencias al motor de persistencia, use iguales recursos, tamaño/volumen de datos, duración y perfil de red, y registre también la versión/commit, configuración y el `RUN_ID`. No compare directamente el resultado `pgbench` con el resumen k6 del API como si midieran la misma capa.

Ejemplo (PowerShell):

```powershell
$env:RUN_ID = 'baseline-ideal-01'
$env:BASELINE_CLIENTS = '10'
$env:BASELINE_JOBS = '2'
$env:BASELINE_DURATION = '60'
$env:BASELINE_SEED = '15015'
docker compose --profile baseline --profile baseline-bench run --rm baseline-bench
```

Los archivos `results/<RUN_ID>-pgbench.txt` y `results/<RUN_ID>-txn.*` contienen el resumen y registros por transacción. Para repetir con latencia simulada, aplique un perfil `netem` antes de la corrida y use exactamente el mismo perfil al medir la API CouchDB.

## Análisis de observaciones

`scripts/run_experiment.ps1` agrega una fila a `results/observations.csv` después de cada corrida k6, con throughput, latencia media/p95, checks, perfil, VUs y marcas de tiempo. Ejecute `python analysis/analizar.py results/observations.csv` después de recolectar al menos tres corridas independientes por cada condición. El analizador no crea datos sintéticos y falla si el CSV no tiene las columnas requeridas o no alcanza el mínimo de replicación. Las filas del baseline pgbench no deben mezclarse con las del API: miden capas distintas.

Para inyectar 15 segundos de corte total a los 20 segundos del ensayo y restaurar después el perfil base: `.\scripts\run_experiment.ps1 -Profile degradado -Vus 10 -Duration 2m -InjectOutage`. Este switch requiere una duración que cubra la ventana de interrupción y reconexión; el runner limpia ambas interfaces al terminar.

Para verificar cola local y sincronización real a través del backend, inicie el stack y ejecute una instancia desechable del simulador: `docker compose run --rm -e SIM_MODE=offline-sync -e SIM_ADMIN_USER=$env:BOOTSTRAP_ADMIN_USER -e SIM_ADMIN_PASSWORD=$env:BOOTSTRAP_ADMIN_PASSWORD client-sim`. El simulador primero crea documentos únicamente en PouchDB, luego los reenvía por la API y confirma su lectura remota. Los documentos remotos de simulación tienen IDs únicos y quedan en CouchDB para inspección.
