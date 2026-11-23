# Módulo 5: validaciones y antifraude

## Reglas aplicadas

- Pesajes admiten `carton`, `papel`, `plastico`, `vidrio`, `metal` y `aluminio` (coinciden con `config:puntos`). Se aceptan de 1 a 10 líneas; cada peso debe ser finito y estar entre 0.01 y 1,000 kg; el total máximo es 2,000 kg.
- La fecha `capturado_en` debe ser ISO 8601/RFC 3339, no más de 5 minutos en el futuro ni más de 30 días atrás. La ventana de 30 días permite sincronizar trabajo offline.
- Solo se verifica un pesaje pendiente. La verificación conserva comercio, recolector, solicitud, fecha y líneas originales. Un pesaje verificado es inmutable; reintentar el mismo evento devuelve éxito sin duplicar puntos.
- Si un pesaje incluye `solicitud_id`, la solicitud debe existir, pertenecer al mismo comercio y estar `aprobada` o `asignada`. Si indica un recolector asignado, debe coincidir con quien captura.
- Se permite un pesaje por solicitud. Sin solicitud, el límite es 8 pesajes por recolector y comercio en una hora. El servidor calcula la ventana con `capturado_en`, así que reintentar una sincronización no consume una captura adicional.
- Comercios pueden crear solicitudes `pendiente` y cancelar sus propias solicitudes pendientes. Operadores y administradores pueden usar estas transiciones: `pendiente → aprobada/rechazada/cancelada`, `aprobada → asignada/cancelada`, `asignada → completada/cancelada`. Estados terminales no se reabren. El comercio de una solicitud no se puede cambiar.
- Los rechazos de negocio incluyen `error` (código estable) y `message` (texto apto para mostrar). El log registra código, estado HTTP y rol; no registra contenido del documento, credenciales ni identidad del usuario. La interfaz presenta el mensaje en el estado de sincronización y junto al registro local rechazado.

## Preparación manual

1. Configura `.env` según `.env.example` y levanta los servicios con `docker compose up --build -d`.
2. Inicia sesión como `BOOTSTRAP_ADMIN_USER` y `BOOTSTRAP_ADMIN_PASSWORD` usando `POST http://localhost:8091/auth/login` con JSON `{"username":"...","password":"..."}`. Conserva el `token` devuelto.
3. Crea un documento comercio desde la interfaz y copia su `_id`. Como administrador, crea usuarios de prueba con `POST /api/users`: uno con `role: "operador_acopio"`, uno con `role: "recolector"` y `comercio_id` igual al `_id` del comercio para el usuario `comercio`. Usa contraseñas de prueba fuertes.
4. Para las llamadas siguientes usa `Authorization: Bearer <token>` y `Content-Type: application/json`. El endpoint de guardado es `PUT /api/docs/<_id>`; reemplaza IDs y tokens. En PowerShell se puede formar el encabezado con `$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }` y enviar JSON con `Invoke-RestMethod -Method Put -Uri $url -Headers $headers -Body ($doc | ConvertTo-Json -Depth 10)`.

## Casos de prueba y resultado esperado

Usa un pesaje válido como base: `{"_id":"pesaje:prueba-1","type":"pesaje","comercio_id":"comercio:ID","recolector_id":"usuario_recolector","lineas":[{"material":"carton","peso_kg":10}],"estado":"pendiente_verificacion","capturado_en":"<fecha ISO actual>"}`. El backend asigna el recolector autenticado y el estado pendiente; se puede omitir `recolector_id` en la petición.

| Caso | Acción | Resultado esperado |
| --- | --- | --- |
| Captura válida | Enviar el pesaje base con token de recolector | `201`, estado pendiente, registro local sincronizado |
| Material no permitido | Cambiar `material` a `organico` | `400`, `material_no_permitido`; texto visible en la interfaz |
| Peso fuera de rango | Usar `peso_kg: 0`, negativo, `1000.01` o más de 2,000 kg sumando líneas | `400`, código `peso_fuera_rango` o `peso_total_fuera_rango` |
| Demasiadas líneas | Enviar 11 líneas | `400`, `lineas_pesaje_invalidas` |
| Fecha incorrecta | Enviar fecha inválida, de hace 31 días o más de 5 minutos futura | `400`, código de fecha correspondiente |
| Solicitud inexistente | Añadir `solicitud_id` con ID que no existe | `400`, `solicitud_no_valida` |
| Solicitud de otro comercio o no aprobada | Asociar solicitud cuyo comercio no coincide o estado `pendiente` | `409`, `solicitud_no_aprobada` |
| Solicitud duplicada | Guardar otro pesaje con el mismo `solicitud_id` | `409`, `pesaje_duplicado` |
| Ráfaga sospechosa | Sin solicitud, enviar 9 pesajes distintos dentro de una hora para mismo recolector/comercio | Los primeros 8 se aceptan; el siguiente devuelve `429`, `frecuencia_sospechosa` |
| Flujo de solicitud válido | Comercio crea `pendiente`; operador cambia a `aprobada`; luego a `asignada`; finalmente a `completada` | Cada transición aceptada; usar `_rev` actual de CouchDB en cada actualización |
| Transición inválida | Intentar `pendiente → completada`, reabrir `rechazada`, o cambiar el comercio de una solicitud | `409`, código `transicion_estado_invalida` o `comercio_no_coincide` |
| Sin permiso | Comercio intenta verificar un pesaje o recolector intenta aprobar solicitud | `403`; no hay cambio remoto |
| Verificación válida | Operador cambia solo `estado` a `verificado` y añade `verificado_en` al pesaje pendiente | `201`; movimiento de puntos automático y saldo actualizado |
| Alterar al verificar | Cambiar línea, comercio, recolector, fecha o solicitud en la petición de verificación | `409`, `datos_pesaje_alterados`; sin puntos |
| Reintento idempotente | Reenviar la misma verificación luego de leer el `_rev` más reciente | Respuesta exitosa; sigue existiendo un único `movimiento_puntos:pesaje:<id>` |
| Alterar verificado | Cambiar cualquier dato de un pesaje verificado | `409`, `pesaje_verificado_inmutable`; saldo sin cambios |

Para comprobar saldo e idempotencia, consulta `GET /api/points/balance?comercio_id=<id>` con un token de comercio asociado o de operador/administrador. Cuenta el movimiento cuyo `pesaje_id` corresponde a la prueba: debe aparecer exactamente una vez, y `saldo` debe sumar los puntos configurados para ese pesaje.
