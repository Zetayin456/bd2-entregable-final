# FASE 6. ESTRUCTURACIÓN, CONCLUSIONES TÉCNICAS Y REFERENCIAS

**UNIVERSIDAD DE EL SALVADOR**  
**FACULTAD MULTIDISCIPLINARIA DE OCCIDENTE**  
**DEPARTAMENTO DE INGENIERÍA Y ARQUITECTURA**  
**ASIGNATURA:** Bases de Datos II (Ciclo II - 2026)  
**TEMA:** Sistema de Gestión de Residuos y Reciclaje Incentivado para Comercios y Centros Urbanos  
**INTEGRANTES:**
- Fabricio Edgardo Morales Tobar - Carnet: MT20005
- Allison Johanna Gómez López - Carnet: GL23019
- Brandon Douglas Arana Martinez - Carnet: AM23104

---
s
## 15. Conclusiones y Referencias (APA 7.ª Edición)

### 15.1 Conclusiones Técnicas

A partir de la construcción de la arquitectura distribuida local-first, la instrumentación de métricas de metrología de software (ISO/IEC 25010) y la ejecución del análisis estadístico inferencial sobre los experimentos controlados en contenedores Docker, se derivan las siguientes conclusiones técnicas:

1. **Sobre la Continuidad Operativa en Escenarios de Red Intermitente:**  
   La implementación del patrón *Offline-First* combinando PouchDB en el cliente navegador (IndexedDB) y Apache CouchDB en el backend desacopló exitosamente la captura de datos de la disponibilidad inmediata de la red. Durante las emulaciones de degradación y cortes totales de tráfico ($P_2$), se registró una tasa de retención de transacciones del 100% ($M_5$), evitando la pérdida de pesajes y solicitudes durante fallas de conectividad.

2. **Sobre el Throughput y Procesamiento Concurrente (OE1 y $H_1^{TPS}$):**  
   El backend desarrollado exclusivamente en Rust (Axum/Tokio) sobre Apache CouchDB ($A_1$) superó significativamente a la línea base monolítica relacional síncrona ($A_0$). El análisis no paramétrico de Mann-Whitney U arrojó un valor $p = 3.39 \times 10^{-8}$ ($\alpha = 0.05$) con un tamaño del efecto Delta de Cliff $\delta = 1.000$ (efecto grande perfecto). El throughput mediano alcanzado por $A_1$ fue de **277.59 TPS** frente a **119.21 TPS** de la línea base, rechazando formalmente la hipótesis nula $H_0^{TPS}$.

3. **Sobre la Consistencia Eventual y Convergencia de Datos (OE2, OE3 y $H_1^{E}$):**  
   La estrategia de saldos mediante documentos de movimiento inmutables (`movimiento_puntos`) eliminó los bloqueos de fila caliente (*hot-row contention*) característicos de las bases relacionales síncronas. Los identificadores idempotentes derivados del pesaje previnieron la duplicación de acreditaciones tras la reconexión de clientes intermitentes, logrando la convergencia total de réplicas sin conflictos ni discrepancias de saldo.

4. **Sobre la Eficiencia de Recursos y Viabilidad Técnica (OE4 y OE5):**  
   El binario compilado en Rust demostró un consumo óptimo de memoria residente ($RSS < 150 \text{ MiB}$ bajo carga máxima) y ausencia de pausas por recolector de basura (*Garbage Collector*). La combinación de tipado estático con `serde` e instrumentación estructurada (`tracing` y `metrics`) garantizó una mantenibilidad y analizabilidad alineadas a la norma ISO/IEC 25010:2011.

---

### 15.2 Recomendaciones y Trabajo Futuro

* **Despliegue de Estudio Piloto en Campo:** Se recomienda desplegar una versión de prueba (*piloto*) en comercios reales de Santa Ana para medir perfiles reales de fluctuación de red 4G/LTE y validar la usabilidad del cliente PWA en dispositivos móviles de gama baja.
* **Mecanismos Avanzados de Purga y Almacenamiento Persistente:** Solicitar explícitamente almacenamiento persistente mediante `navigator.storage.persist()` en el navegador para evitar que el motor de almacenamiento local elimine bases de datos IndexedDB por baja cuota de disco.
* **Integración con Pasarelas de Pago:** Desarrollar adaptadores en la capa de aplicación del backend en Rust para permitir la transferencia directa del incentivo económico o canje por servicios municipales.

---

### 15.3 Referencias (Formato APA 7.ª Edición)

* Anderson, J. C., Lehnardt, J., & Slater, N. (2010). *CouchDB: The definitive guide*. O'Reilly Media.
* Asamblea Legislativa de la República de El Salvador. (2020). *Ley de Gestión Integral de Residuos y Fomento del Reciclaje* (Decreto Legislativo n.º 1008). Diario Oficial.
* Basili, V. R., Caldiera, G., & Rombach, H. D. (1994). The goal question metric approach. In J. J. Marciniak (Ed.), *Encyclopedia of software engineering* (Vol. 1, pp. 528-532). John Wiley & Sons.
* Brewer, E. (2012). CAP twelve years later: How the "rules" have changed. *Computer*, 45(2), 23-29. https://doi.org/10.1109/MC.2012.37
* Cliff, N. (1993). Dominance statistics: Ordinal analyses to answer ordinal questions. *Psychological Bulletin*, 114(3), 494-509. https://doi.org/10.1037/0033-2909.114.3.494
* Cohen, J. (1988). *Statistical power analysis for the behavioral sciences* (2nd ed.). Lawrence Erlbaum Associates.
* Dean, J., & Barroso, L. A. (2013). The tail at scale. *Communications of the ACM*, 56(2), 74-80. https://doi.org/10.1145/2408776.2408794
* Efron, B., & Tibshirani, R. J. (1993). *An introduction to the bootstrap*. Chapman & Hall.
* Gilbert, S., & Lynch, N. (2002). Brewer's conjecture and the feasibility of consistent, available, partition-tolerant web services. *ACM SIGACT News*, 33(2), 51-59. https://doi.org/10.1145/564585.564601
* Holm, S. (1979). A simple sequentially rejective multiple test procedure. *Scandinavian Journal of Statistics*, 6(2), 65-70.
* Hubert, B., Graf, T., Maxwell, G., van Mook, R., van Oosterhout, M., Schroeder, P. B., Spaans, J., & Larroy, P. (2002). *Linux advanced routing & traffic control HOWTO*. https://lartc.org/howto/
* Hulley, S. B., Cummings, S. R., Browner, W. S., Grady, D. G., & Newman, T. B. (2013). *Designing clinical research* (4th ed.). Lippincott Williams & Wilkins.
* International Organization for Standardization & International Electrotechnical Commission. (2011). *Systems and software engineering - Systems and software Quality Requirements and Evaluation (SQuaRE) - System and software quality models* (ISO/IEC 25010:2011). ISO.
* Jain, R. (1991). *The art of computer systems performance analysis: Techniques for experimental design, measurement, simulation, and modeling*. John Wiley & Sons.
* Jung, R., Jourdan, J.-H., Krebbers, R., & Dreyer, D. (2018). RustBelt: Securing the foundations of the Rust programming language. *Proceedings of the ACM on Programming Languages*, 2(POPL), Article 66. https://doi.org/10.1145/3158154
* Kitchenham, B., & Charters, S. (2007). *Guidelines for performing systematic literature reviews in software engineering* (EBSE Technical Report EBSE-2007-01). Keele University & University of Durham.
* Kleppmann, M., Wiggins, A., van Hardenberg, P., & McGranaghan, M. (2019). Local-first software: You own your data, in spite of the cloud. In *Proceedings of the 2019 ACM SIGPLAN International Symposium on New Ideas, New Paradigms, and Reflections on Programming and Software (Onward! 2019)* (pp. 154-178). ACM. https://doi.org/10.1145/3359591.3359737
* Kruskal, W. H., & Wallis, W. A. (1952). Use of ranks in one-criterion variance analysis. *Journal of the American Statistical Association*, 47(260), 583-621. https://doi.org/10.1080/01621459.1952.10483441
* Levene, H. (1960). Robust tests for equality of variances. In I. Olkin et al. (Eds.), *Contributions to probability and statistics: Essays in honor of Harold Hotelling* (pp. 278-292). Stanford University Press.
* Mann, H. B., & Whitney, D. R. (1947). On a test of whether one of two random variables is stochastically larger than the other. *The Annals of Mathematical Statistics*, 18(1), 50-60. https://doi.org/10.1214/aoms/1177730491
* Martin, R. C. (2017). *Clean architecture: A craftsman's guide to software structure and design*. Prentice Hall.
* Matsakis, N. D., & Klock, F. S., II. (2014). The Rust language. *ACM SIGAda Ada Letters*, 34(3), 103-104. https://doi.org/10.1145/2692956.2663188
* Pereira, R., Couto, M., Ribeiro, F., Rua, R., Cunha, J., Fernandes, J. P., & Saraiva, J. (2017). Energy efficiency across programming languages: How do energy, time, and memory relate? In *Proceedings of the 10th ACM SIGPLAN International Conference on Software Language Engineering (SLE 2017)* (pp. 256-267). ACM. https://doi.org/10.1145/3136014.3136031
* Romano, J., Kromrey, J. D., Coraggio, J., & Skowronek, J. (2006). *Appropriate statistics for ordinal level data: Should we really be using t-test and Cohen's d for evaluating group differences on the NSSE and other surveys?* [Paper presentation]. Annual Meeting of the Florida Association of Institutional Research.
* Shapiro, M., Preguiça, N., Baquero, C., & Zawirski, M. (2011). Conflict-free replicated data types. In *Stabilization, Safety, and Security of Distributed Systems (SSS 2011)* (pp. 386-400). Springer. https://doi.org/10.1007/978-3-642-24550-3_29
* Shapiro, S. S., & Wilk, M. B. (1965). An analysis of variance test for normality (complete samples). *Biometrika*, 52(3-4), 591-611. https://doi.org/10.1093/biomet/52.3-4.591
* Vogels, W. (2009). Eventually consistent. *Communications of the ACM*, 52(1), 40-44. https://doi.org/10.1145/1435417.1435432
* Wobbrock, J. O., Findlay, E. R., Gergle, D., & Higgins, J. J. (2011). The aligned rank transform for nonparametric factorial analyses using only ANOVA procedures. In *Proceedings of the SIGCHI Conference on Human Factors in Computing Systems (CHI '11)* (pp. 143-146). ACM. https://doi.org/10.1145/1978942.1978963
* Wohlin, C., Runeson, P., Höst, M., Ohlsson, M. C., Regnell, B., & Wesslén, A. (2012). *Experimentation in software engineering*. Springer. https://doi.org/10.1007/978-3-642-29044-9
```

