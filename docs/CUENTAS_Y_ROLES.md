# Cuentas y roles de prueba

## Roles del sistema

Backend (`valid_role`) y frontend (`Rol`) reconocen exactamente los mismos roles:

| Rol | Operaciones principales |
| --- | --- |
| `admin_plataforma` | Acceso administrativo amplio, alta de cuentas y comercios, gestión de solicitudes y verificación. El bootstrap de CouchDB crea el primer administrador. |
| `operador_acopio` | Aprobar solicitudes, asignar recolectores, verificar pesajes, cerrar recolecciones y consultar saldos. |
| `recolector` | Consultar solicitudes asignadas y registrar pesajes pendientes de verificación. |
| `comercio` | Crear/cancelar solicitudes propias, consultar saldo/movimientos y canjear recompensas. Cada usuario queda asociado a un `_id` de comercio. |

El formulario **Equipo y usuarios** solo muestra `operador_acopio`, `recolector` y `comercio`; no ofrece `admin_plataforma`. El backend sí acepta ese rol en `POST /api/users`, por lo que el script lo crea para facilitar pruebas aisladas. La cuenta bootstrap sigue siendo el acceso administrativo inicial.

No se inicializan usuarios de prueba fijos. `couchdb/init.sh` crea o actualiza únicamente la cuenta bootstrap indicada por `BOOTSTRAP_ADMIN_USER` y `BOOTSTRAP_ADMIN_PASSWORD` en el `.env` privado local. No agregues cuentas de prueba a ese archivo.

## Crear un conjunto de cuentas

Con Docker Compose levantado y `.env` configurado, ejecuta desde la raíz:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\crear_cuentas_prueba.ps1
```

El script lee las credenciales bootstrap sin imprimirlas, inicia sesión en `http://localhost:8091`, crea un comercio con identificador único y un usuario para cada rol. Las contraseñas aleatorias se muestran una sola vez en la consola y no se guardan en `.env` ni en archivos. Se pueden usar para iniciar sesión en `http://localhost:5173` y contra `POST /auth/login`.

## Recorrer el flujo del Proyecto 15

1. Inicia sesión como `comercio`; crea una solicitud de recolección. La cuenta ya está vinculada al comercio que creó el script.
2. Inicia sesión como `operador_acopio`; aprueba la solicitud y asígnala al usuario `recolector` generado.
3. Inicia sesión como `recolector`; registra un pesaje de al menos 20 kg de cartón para ganar 100 puntos con las reglas iniciales.
4. Vuelve a `operador_acopio`; verifica el pesaje y cierra la solicitud.
5. Regresa a `comercio`; confirma el saldo y canjea el **Kit de reciclaje** (100 puntos) o, con más saldo, el vale de 250 puntos.
6. Usa la cuenta `admin_plataforma` generada para probar el acceso administrativo, o sigue usando la cuenta bootstrap definida en `.env`.

La interfaz puede utilizar PouchDB para guardar operaciones mientras está offline. Para confirmar las transiciones del servidor y el ledger, usa **Sincronizar** cuando vuelva la conexión. Las credenciales de prueba deben tratarse como temporales y locales.
