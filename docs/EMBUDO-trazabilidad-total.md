# Trazabilidad del llenado: reporte oficial v2.0 (HU-TRZ-020)

El Excel «Trazabilidad del llenado» (botón en «Matriz y validación», `GET /a/embudo/funnel`) pasó de la versión 1.x (embudo de 7 puntos de contacto) a la **versión 2.0**, centrada en **procesos**. **No requiere migración**: usa `eventos` y `avance_diario` de la migración 026.

El embudo de 7 puntos, las medianas de días y la vista de gerentes **ya no salen en el Excel**, pero siguen disponibles para un reporte interno en `GET /a/embudo/export` (conjuntos `eventos`, `personas`, `gerentes`, `gerencias`, `secciones`, `avance_diario`). La foto diaria del cron sigue guardándose, pero ya no hay hoja «Evolución» en el Excel.

## Principio: dos miradas que no se mezclan
- **Resumen y Gerencia miran PROCESOS** (el avance de la gerencia).
- **Secciones y Usuarios miran USUARIOS resolviendo procesos.** Los conteos de Usuarios son de lo que resolvió cada persona y **no suman** a los de Gerencia: un proceso lo pueden resolver varias personas, o cubrirse entre varias personas y documentos.

Cada indicador de proceso usa la misma lógica que el panel y la consola (`crearCobertura`, `worker/src/cobertura.js`); la exportación no tiene lógica propia de «completo». «Pregunta respondida» se define una sola vez (`preguntaRespondida`, en `cobertura.js`) y la usan el área y la persona: texto, sistemas, confidencialidad respondida o un punto «cubierto». **Confirmar que la descripción precargada sigue vigente (`_vigentes`) no cuenta como responder.**

## Indicadores de procesos
| Indicador | Regla |
|---|---|
| Procesos vigentes | Procesos en alcance (`fuera_alcance=0`), sin los «no vigentes». **Incluye los nuevos**, igual que el panel y la consola. Es el denominador del avance oficial; crece si se agregan procesos nuevos |
| Procesos nuevos | De los vigentes, los creados por las personas (`fuente='nuevo'`) |
| Procesos iniciados | Al menos 1 pregunta respondida en el proceso, por cualquier persona (`cobertura(pid).preguntas ≥ 1`; la sola confirmación de la descripción vigente no cuenta) |
| Procesos avanzados | Al menos 2 preguntas distintas respondidas (`preguntas ≥ 2`) |
| Procesos terminados | Estado `respondido` de `cobertura.js` (la regla de «Completo» del panel) |
| Procesos validados | `procesos.validacion='validado'` (lo marca MBC) |
| Avance oficial % | Terminados ÷ vigentes × 100. **Sin vigentes, la celda queda vacía.** En la fila Total es Σ terminados ÷ Σ vigentes |
| Estado | Sin iniciar (0 personas registradas y 0 procesos en curso) · En levantamiento · Lista para validar (avance 100 %) · **Validada (todos los vigentes terminados Y validados por MBC)** |

Los conteos de procesos son **acumulativos**: un terminado cuenta también como avanzado e iniciado. No importa cuántas personas lo hayan respondido.

## Indicadores de usuarios
| Indicador | Regla |
|---|---|
| Usuarios cargados | Personas dadas de alta en la campaña; una fila de Usuarios cada una |
| Usuarios registrados | Las que crearon su acceso (PIN); `Registrado = SÍ` en Usuarios |
| Con procesos seleccionados | Registrados que confirmaron o eligieron al menos un proceso, o crearon uno nuevo |
| Usuarios con algún proceso iniciado / avanzado / con todos sus procesos terminados | Registrados con al menos un proceso iniciado / con al menos uno avanzado / con todos sus procesos terminados (acumulativos, sobre personas) |
| Procesos de una persona | Los que creó, le asignaron o tomó (revisión vigente o con cambio) o en los que respondió, con la misma regla de participación de `cobertura.js`. Los que ella marcó «ya no se hace», o que quedaron no vigentes para todos, **no cuentan** (no se pueden terminar y Gerencia tampoco los cuenta) |
| Encuestas terminadas | Personas que marcaron «Terminé» |
| Última actividad / Días sin actividad | Solo actividad de los **usuarios** (no incluye ingresos de gerentes ni supervisores; ese dato queda en el export interno como `ultima_entrada_gerente`). Días **calendario** en hora de Lima entre esa fecha y el corte; vacío si no hubo actividad |
| Inactivo | **SÍ**: 7 días calendario o más sin actividad, sin encuesta terminada y con procesos pendientes (todos los usuarios cargados). **NO**: al día. **ACABADO**: terminó todos sus procesos; no se considera inactivo aunque lleve días sin entrar. «Inactivos» de Secciones cuenta solo los SÍ |
| % Avance del usuario | Terminados ÷ **total de procesos** (seleccionados + nuevos) × 100; vacío si no tiene procesos. Nunca pasa de 100 % |

## Pestañas del Excel (en este orden, con autofiltro)
1. **Resumen** — vista ejecutiva, una fila por gerencia de la campaña (incluidas las que no tienen personas) y una fila **Total**: vigentes, nuevos, terminados, avance oficial, estado, personas registradas y días sin actividad. Es un subconjunto de Gerencia (mismo cálculo).
2. **Gerencia** — el detalle de procesos: vigentes, nuevos, iniciados, avanzados, terminados, validados, avance oficial, estado, última actividad y días sin actividad, con fila **Total** al final (Σ/Σ, no promedio de porcentajes).
3. **Secciones** — una fila por sección (y «(sin sección)» si hay procesos o personas sin sección, para que Σ secciones = gerencia): estado, vigentes, nuevos, avance oficial (de los procesos de la sección), **usuarios** cargados/registrados/con procesos/con algún proceso iniciado/con algún proceso avanzado/con todos sus procesos terminados, encuestas terminadas e inactivos. Una persona puede resolver procesos de otra sección: una sección puede estar al 100 % sin que todos sus usuarios hayan terminado.
4. **Usuarios** — una fila por persona cargada, con `Registrado` SÍ/NO, `Fecha de alta` (cuando se cargó la persona), sus procesos (seleccionados, nuevos, total, iniciados, avanzados, terminados) y `% Avance del usuario`.
5. **Definiciones** — un renglón por indicador; el primero indica el corte del reporte.

Cuadres: filas de Usuarios = Σ «Usuarios cargados»; `Registrado = SÍ` = Σ «Usuarios registrados»; Σ vigentes de Secciones (con «(sin sección)») = vigentes de la gerencia.

## Corte
Todo es «al momento de generar» el reporte: ese instante (hora de Lima, `corte`) es el corte de las cifras, de los días sin actividad y de la inactividad. Figura en la hoja Definiciones y la fecha del nombre del archivo es la de Lima de ese corte.

## Universo
**Toda gerencia y sección de la campaña se informa, sin excepción**: salen de la estructura, de los procesos (incluso los fuera de alcance) y de las personas cargadas. Las que no tienen procesos vigentes ni personas aparecen con sus conteos en 0 y «Sin iniciar» (el avance oficial queda vacío si no hay vigentes). La única salvedad es la sección vacía, que no es una sección real: solo aparece como «(sin sección)» si tiene procesos vigentes o personas. Todos los usuarios cargados salen en Usuarios, tengan avance o no. La comparación de nombres es tolerante (`mismaArea`: sin tildes, mayúsculas ni espacios repetidos).

## Pendiente de confirmar con MBC
- «Procesos nuevos» = `fuente='nuevo'`: verificar con datos reales (la maqueta mostraba nuevos igual a vigentes en Legal y Transversal).
- Exclusión de usuarios de prueba («Test 1», «test4»): no se aplica todavía.
- **Actualizar la HU**: se quitó Evolución (y su escenario 8), Secciones y Usuarios cambiaron de columnas, el corte es «al generar», `Validada` exige terminados y el denominador del % de usuario es el total de procesos.

## Salidas
- Excel «Trazabilidad del llenado» (cinco pestañas arriba).
- `GET /a/embudo/funnel?campana_id=`: `resumen`, `gerencias` (con Total), `secciones`, `usuarios`, `corte`.
- `GET /a/embudo/export`: conjuntos internos.
- Nunca incluye textos de respuestas, PIN, claves, tokens ni correos.
