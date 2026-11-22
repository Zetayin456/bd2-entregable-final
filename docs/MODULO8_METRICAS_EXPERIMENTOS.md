# Módulo 8: instrumentación y corridas reproducibles

## Métricas de la API

La ruta pública `GET /metrics` expone el formato de Prometheus. El middleware instrumenta las respuestas HTTP sin registrar IDs de documentos como etiquetas:

- `http_requests_total{method,route,status}`: peticiones agregadas por método, ruta normalizada y estado.
- `http_request_duration_seconds{method,route}`: histograma con buckets configurados entre 5 ms y 10 s.
- `business_events_total{event}`: usuarios creados, comercios, etapas de solicitud, pesajes capturados/verificados, créditos, canjes exitosos, reintentos de canje y rechazos por saldo insuficiente.

Prometheus scrapea `api:8080/metrics` y `cadvisor:8080`, persiste sus series en el volumen `prometheus_data` y publica su interfaz en `http://localhost:9090`. cAdvisor proporciona CPU y memoria por contenedor.

## Flujo de k6

`load/reciclaje.js` autentica al administrador y crea cuentas de prueba temporales para operador y recolector. Cada iteración registra un comercio, crea y aprueba una solicitud, asigna un recolector, captura y verifica un pesaje y consulta el saldo acreditado. Los nombres de ruta k6 son normalizados para que los IDs no produzcan series de alta cardinalidad.

Se exportan `business_step_duration_ms`, `business_flow_duration_ms`, `business_step_success`, `business_flow_success`, `business_steps_total` y `business_flows_completed_total`, además de las métricas HTTP integradas de k6. Cada serie k6 recibe `run_id` y `network_profile`.

## Corrida recomendada

Desde PowerShell en la raíz del repositorio:

```powershell
docker compose up --build -d api prometheus cadvisor client-sim
Invoke-RestMethod http://localhost:8091/metrics
Invoke-RestMethod http://localhost:9090/targets
.\scripts\run_experiment.ps1 -Profile degradado -Vus 10 -Duration 2m
```

El script ejecuta el target Docker `verify` (unitarias, `cargo check` y `cargo clippy`), confirma que Prometheus scrapea la API, instala netem en las interfaces de salida de API y cliente k6, ejecuta la carga, consulta Prometheus y limpia las reglas de red incluso si k6 falla. `-SkipQualityChecks` permite repetir corridas sin reconstruir las verificaciones estáticas una vez que pasaron.

Cada corrida produce `results/<run-id>-k6.json` y `results/<run-id>-prometheus.json`. Prometheus conserva la serie temporal en el volumen `prometheus_data`; el JSON registra el perfil, carga, duración, fechas y resultados de queries de tasa HTTP, p95 de latencia, CPU, memoria y `up` de cAdvisor.

Parámetros útiles:

```powershell
.\scripts\run_experiment.ps1 -Profile ideal -Vus 1 -Duration 1m
.\scripts\run_experiment.ps1 -Profile intermitente -Vus 25 -Duration 5m -SkipQualityChecks
docker build --target verify -t reciclaje-backend-verify ./backend
```

Los perfiles netem se instalan en ambos extremos: el API usa `eth1` (red `edge_net`) y el cliente k6 comparte `client-sim` en `eth0`. `ideal` aproxima 20 ms RTT sin pérdida; `degradado`, 120 ms y 2%; `intermitente`, 250 ms y 5%. Si el orden de interfaces de Docker difiere, se puede cambiar con `NETEM_API_INTERFACE` y `NETEM_CLIENT_INTERFACE`. `corte` pierde el 100% de paquetes para una comprobación manual; `clear`/`limpiar` elimina la disciplina de cola. Ejemplo de limpieza manual:

```powershell
docker compose run --rm -e NETEM_PROFILE=clear netem-api
docker compose run --rm -e NETEM_PROFILE=clear netem-client
```

Use un `.env` local válido y una base de laboratorio descartable. El setup de k6 crea usuarios y sus iteraciones dejan documentos de prueba en CouchDB. No ejecute corridas contra datos productivos. Los resultados son observaciones del entorno de laboratorio; el repositorio no establece umbrales de aceptación ni implica por sí mismo una conclusión estadística.
