---
title: "Sistema de gestión de residuos y reciclaje incentivado para comercios y centros urbanos"
subtitle: "Memoria técnica del Proyecto 15"
author: "Equipo del proyecto"
date: "23 de noviembre de 2026"
lang: es-SV
geometry: margin=2.54cm
fontsize: 12pt
linestretch: 2.0
colorlinks: true
linkcolor: blue
header-includes:
  - \usepackage{hanging}
---

\newpage

# 2. Resumen

Se implementó un sistema web para gestionar solicitudes de recolección de residuos de comercios, asignación de recolectores, registro y verificación de pesajes, acreditación de puntos y canje de recompensas. El backend está desarrollado en Rust y persiste documentos en Apache CouchDB. El cliente TypeScript usa PouchDB para conservar datos y cambios locales en el navegador y sincronizarlos con la API.

La evaluación de carga compara condiciones de red del mismo API Rust+CouchDB, no motores de base de datos ni APIs completas equivalentes. `analysis.json` incluye tres corridas válidas por condición: ideal (media 38.9878 solicitudes/s; DE 4.1772) e intermitente (media 9.2737 solicitudes/s; DE 0.5474). La prueba global fue ANOVA, *F* = 149.2368, *p* = 0.0002578. La comparación post hoc Welch tuvo *p* ajustado de Holm = 0.0058430 y delta de Cliff = 1.0. La muestra inferencial contiene únicamente corridas con flujo de negocio completamente exitoso y cero fallos HTTP. Los resultados representan el entorno de laboratorio y no demuestran por sí solos una ventaja de producto ni permiten atribuir causalidad a un componente aislado.

El baseline PostgreSQL/`pgbench` mide upsert y lectura indexada sobre una tabla, no un servidor API alternativo. Las series de CPU y RAM atribuibles al contenedor API están vacías en las corridas archivadas y los hilos no fueron medidos. La revisión bibliográfica fue exploratoria: la matriz registra antecedentes preseleccionados, pero no un cribado sistemático terminado. Los datos locales web se almacenan en IndexedDB/PouchDB y el JWT en `localStorage`; la aplicación no cifra estos datos en reposo.

**Palabras clave:** reciclaje, comercio, incentivos, Rust, CouchDB, PouchDB, sincronización offline, red degradada.

# 3. Introducción

La gestión de materiales reciclables requiere coordinar generadores, recolectores y centros de acopio, conservar evidencia de las cantidades recibidas y vincular esa actividad con incentivos verificables. El Proyecto 15 aborda esa coordinación por medio de una aplicación web con flujo de trabajo por roles y operación tolerante a interrupciones de conectividad.

La memoria presenta el problema, el respaldo bibliográfico disponible, el diseño y la implementación, y los resultados experimentales efectivamente registrados. Distingue entre funcionalidades implementadas, herramientas listas para ejecutarse y resultados ya medidos. Esta separación evita convertir una configuración experimental en un resultado o una búsqueda exploratoria en una revisión sistemática.

# 4. Planteamiento del problema y contexto

El problema de diseño es cómo registrar y coordinar solicitudes de recolección, pesajes y recompensas cuando los participantes cumplen funciones distintas y la conexión puede ser intermitente. El sistema debe preservar trazabilidad de las transiciones y evitar duplicar pesajes o puntos al reintentar una sincronización.

El repositorio incorpora como fuente de contexto local un diagnóstico institucional del mercado de reciclaje de El Salvador (Ministerio de Medio Ambiente y Recursos Naturales [MARN], 2023). La matriz bibliográfica informa que se revisó la ficha y no el informe completo; por ello esta memoria no atribuye cifras del mercado, prevalencias ni cuellos de botella específicos a ese documento. La caracterización cuantitativa de PYMES, latencia real de conectividad y tiempos actuales de recolección permanece pendiente de levantamiento de campo.

**Pregunta de trabajo.** ¿Cómo se comporta el flujo autenticado de gestión de recolecciones en el API Rust+CouchDB bajo las condiciones de red de laboratorio registradas, y cómo se conservan y sincronizan cambios locales del cliente cuando se recupera la conectividad?

# 5. Justificación, alcance y delimitación

La solución integra un flujo auditable con persistencia documental y una cola local, elementos pertinentes para procesos en los que la conectividad no puede darse por continua. Los incentivos están asociados a pesajes verificados y sus movimientos se registran en un ledger, con validaciones de saldo e idempotencia en el canje.

El alcance comprende aplicación web, API, CouchDB, sincronización PouchDB, pruebas automatizadas y herramientas de carga/telemetría. No comprende despliegue productivo, evaluación del impacto ambiental, medición de cambio de conducta de comercios, ni una comparación causal PostgreSQL-versus-CouchDB. Tampoco se dispone de un servidor PostgreSQL que replique autenticación, reglas, orquestación y contratos HTTP del servicio Rust.

# 6. Objetivos e hipótesis

**Objetivo general.** Implementar y evaluar en laboratorio un sistema web de gestión de recolecciones incentivadas para comercios, con backend Rust, persistencia CouchDB y cliente con capacidad offline-first.

**Objetivos específicos.** (a) Implementar el flujo por roles desde la solicitud hasta el cierre y el ledger de puntos; (b) conservar localmente datos y cambios pendientes en el cliente y sincronizarlos con la API; (c) instrumentar y ejecutar corridas repetibles de carga bajo perfiles de red; y (d) describir estadísticamente las observaciones válidas sin extrapolar más allá del diseño.

**Hipótesis experimental.** H0: la media de throughput de corridas válidas del API no difiere entre las condiciones ideal e intermitente observadas. H1: al menos una media difiere. El contraste es exploratorio: hay tres corridas válidas por grupo, las condiciones se ejecutaron en secuencia y el registro no documenta aleatorización del orden. Por tanto, la significancia estadística no elimina posibles efectos temporales o de entorno.

# 7. Estado del arte y brecha de investigación

La matriz de antecedentes contiene seis fuentes académicas/técnicas preseleccionadas y una fuente gris contextual. Dal’Pizzol y Rossetto (2018) describen una PWA offline-first con PouchDB/CouchDB; Kleppmann et al. (2019) exponen principios local-first; Zhang et al. (2022) estudian rendimiento de Rust en programas con funcionalidad equivalente; y trabajos de Li et al. (2021), Bestari et al. (2026) y Dillman-Hasso (2026) abordan incentivos o su persistencia en conductas proambientales. La matriz separa el nivel de revisión y la aplicabilidad de cada fuente.

El registro consigna cadenas exploratorias ejecutadas mediante un índice web y consulta de páginas fuente. ScienceDirect se revisó parcialmente a nivel de registros; no consta búsqueda directa y exportación en IEEE Xplore, ACM Digital Library o Scopus. No hay conteos reproducibles de resultados, duplicados y exclusiones ni cribado completo. La brecha es provisional: en la búsqueda realizada no se identificó un estudio que reúna comercios salvadoreños, recompensas, sincronización PouchDB/CouchDB y API Rust bajo red degradada. No se presenta como ausencia absoluta de literatura ni como revisión sistemática concluida.

# 8. Marco conceptual

**Offline-first y local-first.** El cliente conserva datos en el dispositivo y puede registrar cambios sin conexión; al recuperar conectividad intenta sincronizarlos. Esto mejora la continuidad operativa, pero introduce decisiones de conflicto, retención, separación por identidad y protección del almacenamiento local (Dal’Pizzol & Rossetto, 2018; Kleppmann et al., 2019).

**Trazabilidad e idempotencia.** Cada etapa del proceso tiene actor y estado; los identificadores deterministas de movimientos previenen dobles acreditaciones o débitos en reintentos. La verificación del pesaje es la condición para acreditar puntos.

**Medición de desempeño.** Una comparación interpretable requiere describir la unidad medida y mantener equivalentes las cargas. Los benchmarks de componentes no permiten concluir superioridad de sistemas completos si difieren las capas y responsabilidades (Zhang et al., 2022). Por ello el baseline SQL se informa separadamente del flujo HTTP autenticado.

# 9. Diseño metodológico

El trabajo combina desarrollo de software y un experimento de laboratorio de medidas repetidas independientes por corrida. La condición de red es el factor de comparación; el throughput HTTP del flujo k6 es la variable de respuesta primaria del análisis archivado. Las corridas con éxito de negocio inferior a 100% o fallos HTTP distintos de cero se excluyeron del contraste de throughput, pero se conservaron para el resumen descriptivo de fiabilidad.

La comparación estadística disponible incluye condiciones `A1_ideal_vus10_1m` y `A1_intermitente_vus10_1m`, con tres corridas válidas cada una. El analizador aplicó Shapiro-Wilk, ANOVA de una vía cuando ambas muestras no rechazaron normalidad, contraste post hoc Welch, ajuste de Holm, delta de Cliff e intervalo bootstrap de diferencia de medianas. El mínimo de tres réplicas permite correr el análisis configurado, pero limita la potencia y la generalización. No se documentan aleatorización del orden ni replicación en varios hosts.

Docker Compose proporciona un entorno de laboratorio reproducible con API, CouchDB, Prometheus, cAdvisor, k6, simulador offline y perfiles de red `netem`. Las pruebas de integración y recompensas verifican rutas y reglas del flujo; no sustituyen el protocolo experimental ni miden adopción o impacto ambiental.

# 10. Arquitectura y diseño del sistema

El backend está implementado exclusivamente en Rust y expone una API HTTP autenticada. CouchDB conserva usuarios, comercios, solicitudes, pesajes, movimientos de puntos, recompensas y saldos. Se definen índices Mango para listados por tipo, recompensas activas, movimientos por comercio, estados/solicitudes de pesajes y ventanas de captura. La documentación pide verificar el plan mediante `/_explain`.

El frontend está desarrollado en TypeScript. PouchDB mantiene una base local en el navegador y la sincronización utiliza la API Rust como intermediario de CouchDB. Los documentos guardados pueden llevar estados locales `pending`, `synced`, `conflict` o `rejected`. El simulador `client-sim` permite escribir documentos sin HTTP, reenviarlos al reconectar y comprobar su lectura remota.

El baseline separado usa PostgreSQL y `pgbench` para hacer upsert y lectura indexada sobre `baseline_documents`. No es un servidor API alternativo: no reproduce autenticación, autorización, reglas de negocio, idempotencia, orquestación Rust ni el costo del cliente HTTP. No se combinan sus observaciones con k6 ni se calcula una comparación integral entre arquitecturas.

# 11. Implementación funcional y seguridad

Los roles del flujo son `admin_plataforma`, `operador_acopio`, `recolector` y `comercio`. El comercio crea solicitudes; operador o administración pueden aprobar/rechazar, asignar y verificar; el recolector registra pesajes de sus solicitudes; y la recolección se completa cuando existe un pesaje verificado. Las validaciones incluyen materiales permitidos, límites de peso/fecha, relación con solicitud y recolector, prevención de duplicados y transiciones permitidas.

El backend calcula puntos tras la verificación y conserva movimientos idempotentes. El catálogo permite al comercio consultar recompensas y solicitar canjes; el servidor comprueba el saldo autoritativo, descuenta puntos y registra el débito con clave de idempotencia.

La auditoría local encontró el JWT y los metadatos de sesión en `localStorage`; datos de negocio y sincronización en PouchDB sobre IndexedDB. El código de aplicación no cifra esos datos en reposo, no solicita almacenamiento persistente al navegador y no elimina la base offline al cerrar sesión. Además, las cuentas `admin_plataforma` usan el mismo nombre de base local. Estas son limitaciones de privacidad y separación de datos, no garantías de protección. La evaluación detallada está en `docs/PRIVACIDAD_Y_ALMACENAMIENTO_LOCAL.md`.

# 12. Instrumentación, corridas y metrología

El backend expone `/metrics` en formato Prometheus con contador de solicitudes, histograma de latencia por ruta normalizada y contadores de eventos de negocio. Prometheus está configurado para scrapear `api:8080`; cAdvisor expone series de recursos del host/contendedores. k6 recorre el ciclo autenticado de solicitud, asignación, pesaje, verificación y puntos. `scripts/run_experiment.ps1` captura JSON por corrida y actualiza el CSV; el modo offline del simulador reporta convergencia cuando la sincronización concluye.

La revisión de resultados detectó que los JSON archivados no tienen muestras válidas de CPU/RAM atribuidas al servicio API (`data.result` vacío en esas consultas). Las series agregadas de cAdvisor no identifican el servicio API y no sirven para atribuirle consumo. El CSV no incluye CPU ni RAM. No se recolectó ni registró un conteo directo de hilos; no se informa ni estima esa cantidad. La metrología de recursos del backend queda pendiente de corregir y validar en nuevas corridas.

# 13. Resultados

Los valores siguientes son los incluidos en `results/analysis.json`. Se muestran con redondeo decimal para legibilidad; el archivo JSON es la fuente de precisión completa.

\newpage

**Tabla 1**  
*Throughput de las corridas válidas por condición de red (10 VUs, 1 min)*

| Condición | Media RPS | Mediana RPS | DE | Rango RPS |
|:--|--:|--:|--:|--:|
| Ideal (*n* = 3) | 38.9878 | 40.1732 | 4.1772 | 34.3459-42.4442 |
| Intermitente (*n* = 3) | 9.2737 | 9.4904 | 0.5474 | 8.6511-9.6795 |

Shapiro-Wilk: condición ideal, *W* = 0.9396, *p* = 0.5258; intermitente, *W* = 0.8825, *p* = 0.3317. ANOVA de una vía: *F* = 149.2368, *p* = 0.0002578. Contraste post hoc Welch: *t* = 12.2163, *p* sin ajustar = 0.0058430, *p* de Holm = 0.0058430; delta de Cliff = 1.0; intervalo bootstrap del 95% para la diferencia de medianas = [24.6664, 33.7930] RPS. Con alfa = 0.05, el JSON marca rechazo de igualdad para esta comparación.

En el resumen de fiabilidad de todas las corridas, la condición ideal reunió cinco ejecuciones: tres sin errores y dos excluidas del contraste de throughput; su éxito medio de flujo fue 0.6833 y la tasa media de fallos HTTP fue 0.1286. La condición intermitente reunió tres ejecuciones, todas sin errores; éxito medio de flujo 1.0 y tasa de fallos HTTP 0.0. La diferencia entre ese resumen y el conjunto inferencial se debe a que las corridas fallidas no entran al contraste de throughput.

Estos resultados indican una diferencia estadística de throughput entre las dos condiciones observadas para el API en este laboratorio. No estiman una mejora porcentual, no comparan PostgreSQL con CouchDB y no prueban superioridad de una arquitectura completa. La interpretación debe considerar el pequeño número de réplicas y la ausencia de aleatorización documentada.

# 14. Discusión, viabilidad y limitaciones

El sistema cubre el flujo funcional y ofrece mecanismos para sincronización y trazabilidad, mientras que los resultados cuantitativos actuales se restringen a carga de API en dos perfiles de red. Los estudios sobre incentivos respaldan medir conducta observada y persistencia, pero los datos de pruebas técnicas no evidencian que los comercios aumenten el reciclaje ni que mantengan el comportamiento después de retirar una recompensa (Bestari et al., 2026; Dillman-Hasso, 2026; Li et al., 2021).

La viabilidad técnica para laboratorio está respaldada por construcción del stack y pruebas automatizadas documentadas. La viabilidad operativa, económica, legal y ambiental requiere validación con comercios, recolectores y entidades locales. Antes de cualquier uso real, las prioridades son: mejorar protección de token/datos locales, establecer retención y borrado, aislar bases por identidad, instrumentar CPU/RAM del contenedor API y conteo verificable de hilos si se mantiene como métrica, ampliar réplicas y documentar orden aleatorio, y completar una búsqueda bibliográfica con cribado y conteos reproducibles.

La referencia PostgreSQL/`pgbench` es útil para caracterizar una carga SQL de persistencia, pero no es equivalente al flujo autenticado de k6. Para comparar servicios completos se requiere otro API que replique contratos, autenticación, autorización y reglas con recursos, datos, red y cliente equivalentes; hasta entonces no se atribuyen diferencias a los motores de persistencia.

# 15. Conclusiones y trabajo futuro

El Proyecto 15 dispone de un flujo de producto implementado que vincula comercios, solicitudes, recolectores, pesajes verificados, puntos y canjes idempotentes, junto con cliente PouchDB y API Rust/CouchDB. El stack incluye automatización de pruebas, simulación de red y carga.

La evidencia experimental vigente permite una comparación estadística limitada entre las condiciones ideal e intermitente del mismo API. El análisis registró diferencias de throughput con Holm *p* = 0.0058430; no hay base para conclusiones comparativas entre APIs completas ni para medir CPU/RAM del API en las corridas guardadas. El uso de hilos permanece sin medir.

La revisión bibliográfica es exploratoria y la brecha propuesta es provisional. La memoria hace visibles esas limitaciones y no sustituye trabajo de campo ni cierre de protocolo. El trabajo futuro debe completar la búsqueda sistemática, obtener datos locales primarios, corregir la atribución de métricas de recursos, ejecutar más réplicas con orden aleatorio, formalizar privacidad y retención, y evaluar adopción y persistencia del efecto de los incentivos.

# Referencias

\begingroup
\setlength{\leftskip}{0.5in}
\setlength{\parindent}{-0.5in}

Bestari, L. R., Goto, D., & Tran, D. (2026). The effects of monetary incentives and environmental information nudges on household waste sorting behavior: Experimental evidence from community-based waste banks in Indonesia. *Resources, Conservation and Recycling, 232*, Article 108991. https://doi.org/10.1016/j.resconrec.2026.108991

Dal’Pizzol, M., & Rossetto, A. G. de M. (2018). *Offline-first multidatabase progressive web apps com PouchDB/CouchDB*. I Congresso de Tecnologia da Informação do IFSUL Campus Passo Fundo. https://congressoti.passofundo.ifsul.edu.br/flipbook/anais/2018/pdf/anais.pdf

Dillman-Hasso, N. H. (2026). A meta-analysis on the persistent effects of incentives on pro-environmental behavior change interventions. *Journal of Environmental Psychology, 109*, Article 102860. https://doi.org/10.1016/j.jenvp.2025.102860

Kleppmann, M., Wiggins, A., van Hardenberg, P., & McGranaghan, M. (2019). Local-first software: You own your data, in spite of the cloud. *Proceedings of Onward! 2019*, 154-178. https://doi.org/10.1145/3359591.3359737

Li, C., Wang, Y., Li, Y., Huang, Y., & Harder, M. K. (2021). The incentives may not be the incentive: A field experiment in recycling of residential food waste. *Resources, Conservation and Recycling, 168*, Article 105316. https://doi.org/10.1016/j.resconrec.2020.105316

Ministerio de Medio Ambiente y Recursos Naturales. (2023). *Diagnóstico del mercado de reciclaje de El Salvador y articulación de la cadena de valor en el marco de la economía circular*. Biblioteca Ambiental MARN. https://cidoc.ambiente.gob.sv/documento/diagnostico-del-mercado-de-reciclaje-de-el-salvador-y-articulacion-de-la-cadena-de-valor-en-el-marco-de-la-economia-circular/

Mozilla. (s. f.). *Storage quotas and eviction criteria*. MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria

PouchDB. (s. f.). *Adapters*. https://pouchdb.com/adapters.html

Zhang, Y., Zhang, Y., Portokalidis, G., & Xu, J. (2022). Towards understanding the runtime performance of Rust. In *Proceedings of the 37th IEEE/ACM International Conference on Automated Software Engineering* (Article 140). https://doi.org/10.1145/3551349.3559494

\par
\endgroup

# Apéndice A. Evidencia y archivos reproducibles

- Observaciones originales por corrida: `results/observations.csv`.
- Análisis estadístico y alcance del baseline: `results/analysis.json`.
- Código del análisis: `analysis/analizar.py`.
- Registro bibliográfico, búsqueda exploratoria, criterios y limitaciones: `docs/revision_bibliografica/Matriz_antecedentes_y_registro_busqueda_Proyecto15.xlsx`.
- Diseño de persistencia y alcance de `pgbench`: `docs/PERSISTENCIA_Y_BASELINE.md`.
- Instrumentación, CPU/RAM e hilos: `docs/MODULO8_METRICAS_EXPERIMENTOS.md`.
- Privacidad y almacenamiento local: `docs/PRIVACIDAD_Y_ALMACENAMIENTO_LOCAL.md`.
- Funciones del producto y modo offline: `docs/MODULO7_FLUJOS_PRODUCTO.md`.

# Apéndice B. Comandos de reproducción del análisis

Desde la raíz del repositorio, con Python y las dependencias NumPy/SciPy instaladas:

```powershell
python .\analysis\analizar.py .\results\observations.csv --output .\results\analysis.json
```

El PDF se exporta desde este Markdown con Pandoc y XeLaTeX. Al regenerarlo, primero actualice y revise el JSON de análisis; no agregue valores de corridas aisladas que no estén en el análisis citado.
