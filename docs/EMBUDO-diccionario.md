# Embudo: diccionario de datos

> Versión inicial (Paquete 1). Todos los ejemplos usan valores ficticios.
> Extracción: `GET /a/embudo/export?campana_id=&conjunto=eventos|personas|todos&formato=json|csv&desde=&hasta=&limite=&despues=` con el código de administrador (`x-admin-code`). Solo lectura.
> Nunca incluye textos de respuestas, PIN, claves, tokens ni correos. El nombre de la persona sí.

## Parámetros

| Parámetro | Valores | Notas |
|---|---|---|
| `campana_id` | obligatorio | |
| `conjunto` | `eventos`, `personas`, `todos` (por defecto) | `todos` solo en JSON. En CSV es un archivo por tabla. |
| `formato` | `json` (por defecto), `csv` | CSV: UTF-8 con BOM, separador `;`, comillas dobles, decimales con coma, fin de línea CRLF; un valor que empieza con `=`, `+`, `-` o `@` se prefija con `'` |
| `desde`, `hasta` | `AAAA-MM-DD` hora de Lima (ambos inclusivos) | Filtran `eventos`. `personas` los ignora. |
| `limite` | 2000 por defecto, máximo 5000 | Solo `eventos` |
| `despues` | cursor `siguiente` de la página anterior | Paginación por clave `creado\|id`, sin repetir ni saltar. En CSV el cursor viene en la cabecera `x-siguiente`. |

JSON: `{ ok, generado, campana_id, eventos: { filas, siguiente }, personas: { filas } }`. `siguiente` es `null` en la última página.

Consulta de ejemplo sin pasar por la ruta (solo eventos):
```
cd worker
npx wrangler d1 execute voz-relevamiento --remote --json --command "SELECT tipo, COUNT(*) n, MIN(creado) desde, MAX(creado) hasta FROM eventos WHERE campana_id='<ID>' GROUP BY tipo ORDER BY n DESC"
```

## Conjunto `eventos` (una fila por evento)

| Campo | Significado | Origen | Formato | Ejemplo |
|---|---|---|---|---|
| `evento_id` | Identificador del evento | medido/reconstruido | UUID o hex de 32 | `0f3c…` |
| `fecha_utc` | Cuándo ocurrió | ambos (reconstruido = aproximada) | ISO UTC | `2026-11-12T15:04:05.123Z` |
| `fecha_lima` | La misma fecha en hora de Lima (UTC-5) | derivado | `AAAA-MM-DD HH:MM:SS` | `2026-11-12 10:04:05` |
| `tipo` | Tipo de evento (catálogo cerrado) | — | texto | `enlace_compartido` |
| `actor_tipo` | Quién lo hizo: `gerente`, `supervisor`, `cliente`, `persona`, `admin`, `anonimo`, `sistema` | — | texto | `gerente` |
| `actor_nombre` | Nombre de quien lo hizo (gerente o supervisor por su cuenta; la persona en sus propios eventos) | derivado | texto | `Gerente Ficticio` |
| `perfil` | Igual que `actor_tipo` (perfil de la cuenta que actuó) | — | texto | `gerente` |
| `gerencia`, `seccion` | Copia del momento: sobrevive a mover o renombrar procesos | — | texto | `Gerencia Legal` / `Sección Legal` |
| `persona_id` | Persona sobre la que trata el evento (destinatario, quien abre, quien responde) | — | id | `e-ana` |
| `persona_nombre` | Nombre de esa persona | derivado | texto | `Ana Ficticia` |
| `gerente_nombre` | Gerente activo cuyo alcance cubre esa sección (vacío si no hay) | derivado | texto | `Gerente Ficticio` |
| `proceso_id`, `proceso_codigo` | Proceso del evento (solo `primera_respuesta`) | — | id / texto | `p0` / `PR-00` |
| `canal` | `correo` o `enlace` (herramienta del gerente); más canales en el Paquete 2 | medido | texto | `correo` |
| `visitante_corto` | Primeros 8 caracteres del identificador aleatorio del navegador | medido | texto | `5e0c1d2a` |
| `reconstruido` | 1 si lo creó el backfill | — | 0/1 | `0` |
| `detalle` | JSON con lista blanca de claves: `procesos`, `personas`, `pin` (`creado`/`ok`), `perfil`, `motivo`, `supervisor_id`, `bloque`, `punto_listos`, `fuente`, `validado_por`, `reconstruido`, `aprox` | — | JSON | `{"procesos":2}` |

### Tipos de evento del Paquete 1

| Tipo | Paso | Cuándo | Se repite |
|---|---|---|---|
| `enlace_compartido` | 3 | El gerente genera el correo o el enlace de una persona (un evento por persona). Es «preparado», no «enviado»: el .eml queda como borrador de Outlook | Sí |
| `procesos_delegados` | 3 | El gerente asigna procesos a una persona (`detalle.procesos` = cuántos) | Sí |
| `persona_agregada` | 3 | El gerente o el administrador del cliente agrega a una persona | No (una por persona) |
| `enlace_abierto` | 4 | Alguien carga el enlace de sección con un visitante válido. Anónimo (sin `persona_id`) | Sí, con ventana de 30 min |
| `persona_identificada` | 4 | La persona entra con nombre y PIN (`detalle.pin` = `creado` u `ok`). Une visitante y persona; cuenta como ingreso | Sí |
| `acceso_creado` | 5 | La persona fija su PIN por primera vez (`detalle.fuente` = `precargada` o `registro_abierto`) | No (una por persona) |
| `primera_respuesta` | 6 | Primer guardado con contenido de la persona en un proceso (`detalle.bloque`) | No (una por persona y proceso) |

Tipos reservados para los Paquetes 2 y 3 (ya en el catálogo; el backfill reconstruye algunos): `acceso_gerente_generado`, `acceso_gerente_enviado`, `gerente_abrio`, `gerente_entro`, `enlace_seccion_copiado`, `pin_fallido`, `bloque_completado`, `proceso_completo`, `proceso_validado`, `flujo_paso_confirmado`, `aprobacion_final`.

## Conjunto `personas` (una fila por persona)

Las columnas `f_*` son la **primera vez** que la persona alcanzó ese paso, en UTC ISO; vacío = no ocurrió o no se pudo medir. Las columnas `*_origen` dicen si la fecha es medida, inferida o reconstruida.

| Campo | Significado | Origen | Formato | Ejemplo |
|---|---|---|---|---|
| `campana_id`, `persona_id`, `persona_nombre` | Identificación | datos de la campaña | texto | `c1`, `e-ana`, `Ana Ficticia` |
| `gerencia`, `seccion`, `cargo` | Ubicación y cargo | datos de la campaña | texto | `Gerencia Legal` |
| `perfil` | `responsable` (persona común), `supervisor` o `gerente` (si tiene cuenta de panel) | datos | texto | `responsable` |
| `gerente_nombre` | Gerente activo que cubre su sección (el de alcance más específico) | derivado | texto | `Gerente Ficticio` |
| `origen` | `carga` (Excel) o `abierto` (se registró sola) | datos | texto | `carga` |
| `f_agregado` | Cuándo se cargó o registró | datos | ISO | `2026-11-01T10:00:00.000Z` |
| `f_acceso_generado`, `f_acceso_enviado`, `f_gerente_abrio` | Pasos 1 y 2 (solo si la persona tiene cuenta de gerente o supervisor) | Paquete 2 | ISO | vacío en el Paquete 1 salvo reconstruido |
| `f_delegado` | Primera delegación de procesos a la persona | medido o reconstruido | ISO | `2026-11-12T15:00:00.000Z` |
| `f_compartido` | Primer correo o enlace generado para la persona | medido (reconstruido no sabe a quién) | ISO | `2026-11-12T15:01:00.000Z` |
| `f_abrio` | Primera apertura del enlace | medido o inferido | ISO | `2026-11-12T16:30:00.000Z` |
| `f_abrio_origen` | `medido`, `inferido`, `ambiguo` o vacío | derivado | texto | `medido` |
| `f_acceso_creado` | Cuándo fijó su PIN | medido o reconstruido | ISO | `2026-11-12T16:32:00.000Z` |
| `f_acceso_creado_origen` | `medido`, `reconstruido` o vacío | derivado | texto | `medido` |
| `f_primera_respuesta` | Primera respuesta con contenido en cualquier proceso | medido o reconstruido (cota superior) | ISO | `2026-11-13T09:00:00.000Z` |
| `f_primer_proceso_completo` | Primer proceso completo según `cobertura.js` | Paquete 3 | ISO | vacío en el Paquete 1 |
| `f_ultima_actividad` | Última huella de la propia persona (ingreso, respuesta, acceso) | derivado | ISO | `2026-11-14T08:00:00.000Z` |
| `n_aperturas` | Aperturas medidas atribuidas a la persona | medido | entero | `2` |
| `n_ingresos` | Ingresos con nombre y PIN registrados | medido (+1 reconstruido, el último) | entero | `3` |
| `ultimo_paso` | Máximo paso alcanzado: 0 sin contacto, 3 compartido/delegado/agregado, 4 abrió, 5 creó acceso, 6 empezó, 7 completó todo lo asignado | derivado | 0-7 | `6` |
| `ultimo_paso_nombre` | Texto del paso | derivado | texto | `empezó` |
| `dias_sin_actividad` | Días enteros entre `f_ultima_actividad` y el momento de la extracción; vacío si nunca hubo | derivado | entero | `4` |
| `procesos_asignados` | Procesos que ve la persona (los mismos que su encuesta): su sección sin los que MBC le quitó, los que agregó y los que eligió o le asignaron | datos | entero | `12` |
| `procesos_con_respuesta` | De esos, los que tienen al menos una respuesta con contenido | datos | entero | `5` |
| `procesos_completos` | De esos, los completos según `cobertura.js` | derivado | entero | `2` |
| `procesos_validados` | Completos cuyo proceso MBC marcó como validado | derivado | entero | `1` |
| `pct_procesos_completos` | `procesos_completos / procesos_asignados` × 100 (1 decimal) | derivado | número | `16,7` |
| `pct_puntos` | Puntos listos / (procesos asignados × puntos por proceso) × 100 | derivado | número | `41,3` |
| `bloqueada` | 1 si la persona está bloqueada por intentos de PIN | datos | 0/1 | `0` |

## Fórmulas sugeridas para la vista externa

- **Conversión entre pasos** (por gerencia o sección): `personas con f_paso_N / personas con f_paso_(N-1)`. Por ejemplo, «abrió» sobre «compartido»: `COUNT(f_abrio) / COUNT(f_compartido)`.
- **Tiempo mediano entre pasos**: `MEDIANA(f_siguiente - f_anterior)` solo con filas donde ambas fechas existan y su origen sea `medido`. Excluir lo reconstruido o inferido para no sesgar tiempos.
- **Personas detenidas** (sin avance en más de N días): `ultimo_paso < 7` y `dias_sin_actividad > N` (o `dias_sin_actividad` vacío y `f_compartido` con más de N días de antigüedad: nunca respondieron). Ordenar por `gerente_nombre` para saber a quién llamar.
- **Cuello de botella por gerencia**: el primer paso cuya conversión baje de un umbral (por ejemplo 50 %).
- **Alcance de la muestra**: filtrar `reconstruido = 0` en `eventos` para lo medido y declarar la fecha de despliegue como inicio de la serie.

## Preguntas que responde, y con qué
| Pregunta | Dónde mirar |
|---|---|
| ¿El gerente compartió con su equipo? | `f_compartido`, `f_delegado` por persona; `enlace_compartido` / `procesos_delegados` por gerente |
| ¿La persona abrió el enlace? | `f_abrio` y `f_abrio_origen` |
| ¿Creó su acceso? | `f_acceso_creado` |
| ¿Empezó? ¿Hace cuánto no avanza? | `f_primera_respuesta`, `dias_sin_actividad`, `pct_puntos` |
| ¿Cuántos visitantes anónimos abrieron una sección y no se identificaron? | `eventos` con `tipo = enlace_abierto` agrupados por `visitante_corto` y sección, restando los que tienen `persona_identificada` |
