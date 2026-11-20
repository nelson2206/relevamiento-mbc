# HU05 — Cargar la matriz completada a mano y que los procesos queden completos

> Documento autosuficiente: describe el problema, su causa en el código, el comportamiento esperado y cómo verificarlo.
> Los números de línea son aproximados: guíate por los nombres de función.

## Historia de usuario
**Como** consultor del equipo,
**quiero** descargar la matriz de procesos con campos incompletos, llenarla a mano con lo que cuentan las entrevistas y volver a cargarla,
**para** que esos procesos figuren con la información completa en la vista del proceso sin escribir cada campo en la consola.

## Vocabulario
- **Matriz**: `procesos.matriz` (JSON por campo). El Excel «Matriz de procesos» (`exportarMatriz`, `admin.html`) es una fila por proceso con las columnas de `MATRIZ`.
- **ID herramienta**: última columna del Excel, oculta («no modificar»). Contiene `procesos.id` y es la forma de reconocer cada fila al volver a cargar.
- **Upsert**: carga con `upsert: true` en `POST /a/importar` (`rutaImportar`): una fila que coincide con un proceso de la campaña (por ID o código) lo actualiza; si no coincide, lo crea.
- **Cobertura**: `worker/src/cobertura.js`. Mide lo que responde el responsable en la encuesta (PRs #18 y #19); una carga de consola **no** cuenta.

## Problema observado
Al volver a cargar el Excel exportado, las filas no se aplicaban y la consola no decía por qué.

## Causa raíz en el código
- `rutaImportar` (`worker/src/index.js`, bloque de procesos) pedía `gerencia`, `seccion` y un nombre en **toda** fila, antes de buscar el proceso por ID.
- El Excel de la matriz no trae columna de gerencia (`MATRIZ` solo tiene `macroproceso` y `seccion`), así que `gerencia` llegaba vacía y la fila se saltaba sin aviso, incluso con un ID válido.

## Comportamiento esperado
- Una fila con el **ID** (o código) de un proceso de la campaña actualiza ese proceso aunque no traiga gerencia ni sección: **conservan las del proceso**, y lo mismo macroproceso, proceso y subproceso si vienen vacíos.
- **Celda vacía = conservar.** Solo se escriben las celdas con valor (`leerMatrizExcel`) y la matriz se combina con `json_patch`: nada se borra desde el Excel.
- Cada campo que cambia queda en `matriz_historial` con origen `importacion` y actor «Equipo consultor», y deja de contar como «de la IA» (`matriz_ia`).
- Validación: solo una fila con `Validado = Sí` pasa a `validado`; sin esa columna la validación no cambia.
- Una fila sin ID/código reconocido **solo se crea** si trae gerencia y sección. Si no, se informa en `descartadas` (con el número de fila de Excel y el motivo) en vez de saltarse en silencio.
- Listas cerradas (Datos personales: Sí/No; Estándar TDP: Sí/No/Parcialmente/Programado): «si», «SI» o «parcialmente» se llevan a la opción exacta; un valor que no coincide se carga tal cual y la vista previa lo avisa.
- **Identificación sin editar no cuenta como cambio.** El Excel repite Macroproceso, Proceso, Subproceso y Sección tomados de las columnas del proceso; si coinciden con ellas no se escriben en la matriz, no suman a `campos_cambiados` ni ensucian el historial. Si se editan (p. ej. se renombra el subproceso), sí se aplican.
- **Mismo proceso repetido** en el archivo: solo cuenta la primera fila; la otra va a `descartadas`.
- **Proceso ya validado:** si la carga cambia su contenido sigue validado (igual que al editar desde la consola) y la respuesta trae `validados_modificados` para que la consola lo avise.
- La respuesta de `/a/importar` agrega `campos_cambiados`, `validados_modificados` y `descartadas`. La consola los muestra en la vista previa y en el resultado.
- **No cambia la cobertura**: la carga no crea `respuestas`, `revisiones` ni eventos de validación de personas.

## Cómo verificar
1. `cd worker && npm run test:unit` — `test/unit/importar-matriz.test.mjs` cubre la actualización por ID sin gerencia, celdas vacías, validación, filas descartadas, filas nuevas e historial.
2. Manual (`npm run dev`):
   1. En «Matriz y validación», exportar la matriz.
   2. En el Excel, llenar campos vacíos de 2-3 procesos; dejar otros vacíos; poner «Sí» en Validado en una fila y un valor fuera de lista en Datos personales en otra.
   3. En «Carga y configuración», subir el archivo: la vista previa indica cuántas filas completan procesos y avisa del valor fuera de lista.
   4. Importar y abrir cada proceso: campos completos, lo no tocado se conserva, solo la fila con «Sí» queda validada y el historial muestra origen «importación».
   5. Confirmar que los indicadores de cobertura no cambiaron.
