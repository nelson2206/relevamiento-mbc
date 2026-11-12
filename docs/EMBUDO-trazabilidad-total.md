# Trazabilidad total del llenado (7 puntos de contacto)

Reestructura el funnel de Matías Tejada (`feat/funnel-trazabilidad`) según el pedido de `PROMPT-embudo-touchpoints.md`. No hay pantalla nueva: son datos extraíbles (Excel en «Matriz y validación», `GET /a/embudo/funnel` y `GET /a/embudo/export`). **No requiere migración**: usa `eventos` y `avance_diario` de la migración 026.

## Universo y avance
- **Universo**: gerencias y secciones salen de los procesos vigentes (`fuera_alcance=0`) y de la estructura de la campaña (hoja «Gerencias»). Las personas solo agregan áreas que no estén ya en esas listas, para no perder a nadie. Una gerencia sin personas aparece con 0 y «Sin iniciar».
- **Comparación tolerante**: `mismaArea` (sin tildes, mayúsculas ni espacios repetidos). El servidor devuelve el nombre canónico; el filtro del Excel normaliza igual.
- **Avance oficial** = procesos `respondido` (estado de `crearCobertura`, `cobertura.js`) ÷ procesos vigentes, sin los `no_vigente` (misma regla que `resumenCliente` de la consola). En las salidas, «Procesos vigentes» ya es esa base; `procesos_alcance` es el total con `fuera_alcance=0`.
- **Avance de lo asumido por las personas** (columna aparte, el cálculo de Matías) = procesos terminados ÷ procesos que las personas tomaron. Ejemplo: 1 de 1 = 100 % asumido, pero 1 de 62 = 1,6 % oficial.
- **Estado**: Validada (todos los vigentes validados) · Lista para validar (oficial 100 %) · Sin iniciar (0 personas registradas, 0 procesos en curso, 0 respondidos) · En levantamiento.

## Los 7 puntos y su base
| # | Punto | Evento / fuente | Base del % |
|---|---|---|---|
| 1 | Acceso generado / enviado | `acceso_gerente_generado` (al dar perfil, renovar la clave, descargar enlaces o crear una cuenta); `acceso_gerente_enviado` (el administrador MBC prepara el correo .eml: `POST /a/embudo/marcar-enviado`, canal outlook) | gerentes y supervisores activos que cubren el área |
| 2 | El gerente abre | `gerente_abrio` (una vez), `gerente_entro` (cada ingreso con la clave; las recargas `?recarga=1` no cuentan) | ídem |
| 3 | Comparte con su equipo | `enlace_compartido`, `persona_agregada`, `procesos_delegados` hechos por el gerente; personas alcanzadas | gerentes; personas cargadas |
| 4 | La persona abre | `enlace_abierto` + `persona_identificada` | personas cargadas |
| 5 | Crea su acceso | `acceso_creado` / PIN | personas cargadas |
| 6 | Empieza | `primera_respuesta` | personas cargadas |
| 7 | Avance | avance oficial | procesos vigentes |

Medianas de días: 1→2 (recibe → abre), 2→3 (abre → comparte), 3→4, 4→5, 5→6; solo pares con ambas fechas y orden coherente.

## Medido y reconstruido
Las fechas de gerentes (1 y 2) anteriores al despliegue son reconstruidas (`supervisores.creado`, `ultimo`, acciones); desde el despliegue son medidas. En el Excel, las columnas «Origen» lo dicen. Un gerente sin evento de «generado» cae a `supervisores.creado` marcado como reconstruido.

## Foto diaria
El cron (cada 15 min) toma, desde las 23:00 de Lima y una vez al día, una foto por gerencia y sección (`seccion=''` es el total de la gerencia, no se suma con sus secciones) de las campañas abiertas, con acceso del cliente activo o con respuestas en los últimos 7 días. El backfill toma una foto inicial (`reconstruido=1`) que la foto medida del mismo día reemplaza; repetir cualquiera no duplica (clave primaria).

## Salidas
- Excel «Trazabilidad del llenado»: Resumen, Embudo por gerencia (con Total), Secciones, Gerentes, Usuarios, Evolución, Definiciones.
- `GET /a/embudo/export?conjunto=eventos|personas|gerentes|gerencias|secciones|avance_diario|todos&formato=json|csv` (CSV UTF-8 con BOM, `;`).
- `GET /a/embudo/funnel`: `resumen`, `gerencias`, `secciones`, `gerentes`, `usuarios`, `evolucion`.
- Nunca incluye textos de respuestas, PIN, claves, tokens ni correos.
