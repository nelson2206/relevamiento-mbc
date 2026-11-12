# Funnel de trazabilidad del llenado (HU)

Tablas simples y un Excel, sin gráficos. Se apoya en el embudo de eventos (`worker/src/embudo.js`) y no guarda nada nuevo salvo la fecha del «Terminé».

## Dónde está
- Consola de administración (`admin.html`), campaña abierta, módulo **Matriz y validación**: botón **Exportar trazabilidad (Excel)** junto a «Exportar matriz». No hay pantalla ni pestaña propia. Si la matriz tiene una gerencia elegida en su filtro, el Excel trae solo esa (y su nombre la incluye).
- El panel del cliente **no** lo trae. API: `GET /a/embudo/funnel?campana_id=` (código de administrador). Cálculo: `calcularFunnel`.

## Las 6 etapas (por usuario; % sobre «Registro de usuario»)
| # | Etapa | Regla |
|---|---|---|
| 1 | Registro de usuario | Creó su acceso (PIN). Base del 100 %. |
| 2 | Con procesos seleccionados | Confirmó o eligió al menos un proceso, o creó uno nuevo. |
| 3 | Proceso iniciado | Al menos 1 pregunta con contenido en algún proceso. |
| 4 | Proceso avanzado | Algún proceso con 2 o más preguntas con contenido. |
| 5 | Procesos terminados | Todos sus procesos completos según `cobertura.js`. |
| 6 | Encuesta terminada | Marcó «Terminé» (`encuestados.estado='enviado'`). Declarativa: solo exige estar registrada. |

Las etapas 1 a 5 son acumulativas, así que cada una es menor o igual que la anterior. La 6 puede quedar por encima de la 5. El ingreso al enlace ya no es una etapa ni una columna: todos los porcentajes se calculan sobre los registrados.

**Total de procesos** de una persona = procesos confirmados + procesos nuevos. Iniciado, avanzado y terminado se cuentan sobre ese total; un proceso completo cuenta también como iniciado y avanzado.

## Gerencias
- **Avance** = procesos terminados ÷ procesos de las personas de la gerencia.
- **Estado**: *Validada* si todos sus procesos vigentes tienen `validacion='validado'` (lo marca MBC); *Lista para validar* si el avance es 100 %; *En levantamiento* en otro caso.
- **Última actividad** y **días sin actividad**, en hora de Lima.
- **Inactivo** (usuario): 7 días o más sin actividad y sin encuesta terminada (`DIAS_INACTIVA` en `embudo.js`).

## Excel
Hojas `Resumen`, `Gerencias`, `Secciones`, `Usuarios` y `Definiciones`; una fila de encabezado, filtros activados, sin celdas combinadas ni gráficos. Nombre: `Trazabilidad del llenado - <campaña> - <fecha>.xlsx`.
- **Resumen**: una fila por gerencia con Estado, Avance %, Última actividad y Días sin actividad.
- **Gerencias** y **Secciones**: el mismo funnel, una fila por gerencia (más una fila Total) o por sección. Columnas: primero las cantidades (Registrados, Con procesos seleccionados, Iniciados, Avanzados, Terminados, Encuesta terminada e Inactivos) y a la derecha sus **porcentajes**, todos sobre los registrados. Al final, **Avance de procesos %** (procesos terminados ÷ procesos de las personas): el avance real del trabajo, distinto del % de personas.
- **Usuarios**: una fila por persona. Primero los datos de la persona, luego las cantidades (Procesos confirmados, Procesos nuevos, Total de procesos, Iniciados, Avanzados, Terminados), luego los porcentajes (% Iniciados, % Avanzados, % Terminados, sobre su total de procesos) y al final los SÍ/NO (Encuesta terminada, Inactivo). Sin formato «x de N».

## Cambios de datos
- Evento nuevo `encuesta_terminada` (paso 7, una vez por persona): se registra en `/r/enviar` y el backfill (`POST /a/embudo/backfill`) reconstruye los ya enviados con su última actualización (cota, `reconstruido=1`). Sin migración: usa la tabla `eventos` existente.
- «Ingreso al enlace» y el resto de eventos solo existen desde el despliegue del embudo (ver `EMBUDO-definiciones.md`).

## Pendiente de confirmar
1. «Terminado» usa la regla de «Completo» del sistema (17 puntos), no «todas las preguntas con texto».
2. Excel sin fila fija: la librería de la página no la soporta; los filtros sí.
3. «Primera sesión» queda fuera del funnel y no se guarda.
