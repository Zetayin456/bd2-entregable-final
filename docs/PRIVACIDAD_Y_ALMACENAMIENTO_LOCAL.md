# Privacidad y almacenamiento local del cliente web

## Estado comprobado en el código

### Sesión y token

`frontend/src/data/api.ts` guarda en `localStorage` las claves `reciclaje.jwt`, `reciclaje.role`, `reciclaje.user` y, cuando aplica, `reciclaje.comercio`. El JWT se adjunta después como `Authorization: Bearer ...`. El formulario de inicio de sesión no guarda la contraseña en la sesión de la aplicación. No se usa `sessionStorage` para el token ni una cookie `HttpOnly`.

El token y los demás datos de sesión permanecen disponibles en el almacenamiento del origen hasta que la aplicación ejecuta `sesion.clear()` al cerrar sesión explícitamente o al recibir un 401 en las llamadas normales. Como `localStorage` está disponible a JavaScript del mismo origen, cualquier script ejecutado en ese origen podría leer el JWT; la implementación no ofrece la barrera `HttpOnly` de una cookie. El aislamiento de origen del navegador protege frente a otros orígenes, pero no frente a XSS o código comprometido del mismo sitio.

### Datos de negocio offline

`frontend/src/data/pouch.ts` instancia `pouchdb-browser` sin indicar otro adaptador. PouchDB usa IndexedDB en los navegadores modernos. Las bases se nombran así:

- Usuario administrador: `sistema_reciclaje_local` (nombre común a todas las cuentas `admin_plataforma` del mismo origen/navegador).
- Resto de usuarios autenticados: `sistema_reciclaje_local_<rol>_<usuario>_<comercio>`, codificando esos componentes.
- Sin sesión: `sistema_reciclaje_guest`.

La base local contiene documentos de comercios (nombre, giro, zona y estado), solicitudes (comercio, fechas, observaciones, recolector y estado), pesajes (comercio, recolector, material, kilogramos y fechas), y movimientos de puntos. También persiste metadatos de sincronización: revisión remota, estado `pending`/`synced`/`conflict`/`rejected`, fecha local, mensaje de error, copia remota en conflicto y cursor de cambios. El código no guarda el JWT dentro de los documentos PouchDB.

La sincronización marca o actualiza los documentos, pero no destruye la base anterior. Cerrar sesión limpia las claves de `localStorage` y cambia/cierra la conexión a la base activa; **no elimina los datos PouchDB del usuario anterior**. El manejador de expiración 401 limpia las claves y muestra el inicio de sesión, pero tampoco destruye el almacenamiento local. Las bases permanecen en el perfil del navegador y pueden reabrirse desde el mismo origen. Además, la base local de administradores es compartida por todas las cuentas con ese rol, aunque la API aplique autorización en las operaciones remotas.

## Persistencia y cifrado

- **Persistencia del navegador:** IndexedDB sobrevive normalmente al cierre de pestaña y navegador, pero el código no llama `navigator.storage.persist()` ni consulta `navigator.storage.estimate()`. Por ello, la aplicación no solicita almacenamiento persistente y no conoce el espacio usado/disponible. El navegador puede eliminar datos bajo políticas de cuota/presión de almacenamiento; los modos privados pueden ser temporales.
- **Cifrado en reposo:** no se encontró cifrado aplicado por la aplicación a `localStorage`, a los documentos PouchDB/IndexedDB ni al cursor local. No hay uso de Web Crypto, una biblioteca de cifrado ni gestión local de claves en `frontend/src/`. No se debe afirmar que estos datos están cifrados en reposo. Un cifrado completo del disco configurado por el sistema operativo sería externo y no puede comprobarse desde este repositorio.
- **Credenciales CouchDB:** el cliente web habla con la API y no persiste las credenciales administrativas de CouchDB. Esto reduce exposición de credenciales de infraestructura, pero no cifra los datos locales ni el JWT.

Esta evaluación describe el código del repositorio; no determina la configuración de cifrado del dispositivo, del perfil del navegador ni de un despliegue externo.

## Limitaciones y mejoras pendientes

1. Definir una política explícita para datos locales al cerrar sesión: conservar la cola offline con aviso y protección, o purgarla después de sincronizar/confirmar. No borrar automáticamente cambios pendientes sin una política de recuperación.
2. Usar una base por identidad completa también para administradores y revisar la base `guest`, para evitar que cuentas distintas del mismo navegador reutilicen documentos locales.
3. Evaluar una sesión basada en cookie `Secure`, `HttpOnly` y `SameSite` con controles CSRF adecuados, o tokens de vida corta en memoria. Si se mantiene `localStorage`, endurecer CSP, sanitización y defensa XSS; el token no debe considerarse protegido contra scripts del mismo origen.
4. Si el riesgo y los requisitos lo justifican, diseñar cifrado de documentos locales con Web Crypto y una clave protegida por una credencial/almacén separado. Cifrar con una clave que se guarda junto a los datos no ofrece una protección efectiva frente a quien pueda leer el origen.
5. Solicitar `navigator.storage.persist()` cuando corresponda y mostrar si el navegador lo concede; tratar el rechazo como posible pérdida de cola y mantener exportación/recuperación o reintentos seguros.
6. Establecer clasificación, minimización, retención y borrado de datos personales/comerciales, incluyendo conflictos, rechazos, cuentas compartidas, dispositivos perdidos y sesiones vencidas. Añadir pruebas para cambio de cuenta, cierre de sesión, persistencia offline y limpieza autorizada.

## Fuentes técnicas del comportamiento del navegador

La elección de IndexedDB corresponde al adaptador predeterminado de PouchDB en navegadores modernos. El almacenamiento web es por origen; por defecto, el navegador trata la persistencia como *best effort* salvo que conceda almacenamiento persistente. Véanse la [documentación de adaptadores de PouchDB](https://pouchdb.com/adapters.html), la [guía de cuotas y expulsión de almacenamiento de MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) y la [política de mismo origen de MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).
