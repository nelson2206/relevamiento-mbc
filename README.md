# Voz MBC · Relevamiento de procesos

Encuesta por voz para levantar el inventario de procesos de un cliente: la persona cuenta cómo funciona cada proceso, la IA revisa un
checklist por bloque, y el equipo consultor valida la matriz en una consola. Repositorio propio, **separado de Voz MBC**.

| Carpeta | Qué es |
|---|---|
| `index.html` | La encuesta que responden las personas (enlace personal `?k=`, de sección `?c=` y abierto) |
| `admin.html` | La consola del equipo consultor y, con `?cliente=`, el panel de solo lectura del cliente |
| `flujo-gerente.js` | Vista de 4 pasos del Gerente (Supervisor): procesos, delegación, avance, validación final. La carga `admin.html` |
| `flujo-admin.js` | En la consola: insignia «Validada por el gerente», indicador en el resumen y reapertura de aprobaciones |
| `worker/` | El servidor: Cloudflare Worker + D1 + Workers AI (voz) + Claude. Migraciones `migracion-NNN.sql` y `schema.sql` |

Desplegar el servidor (desde `worker/`): `npm install && npx wrangler deploy`. Secretos (nunca en el repo): `ADMIN_CODE`, `INTERNAL_CODE`
(IA vía ProcessIQ) o `ANTHROPIC_API_KEY`. La base: `npx wrangler d1 execute voz-relevamiento --remote --file=schema.sql`.

## Estado y relación con producción (TDP)

Este repositorio nació el 2026-10-21 como copia, con su historial, de la carpeta `relevamiento/` de
[`hub-encuestas-mbc`](https://github.com/nelson2206/hub-encuestas-mbc) (el repo de Voz MBC).

**Producción de TDP todavía se publica desde `hub-encuestas-mbc`** (GitHub Pages en encuesta.mbc-latam.com/relevamiento/ y el Worker
`voz-relevamiento-api`). Mientras no se haga el traspaso, un cambio hecho solo aquí **no llega a TDP**, y uno hecho en `hub-encuestas-mbc`
no llega aquí. El traspaso (publicar desde este repo sin cambiar los enlaces que ya tiene TDP) está pendiente de decisión.

La **demo** (relevamiento.mbc-latam.com, empresa ficticia, sin datos de ningún cliente) se genera desde este código con
`voz-relevamiento-demo`.

## Flujo guiado del Gerente (Supervisor)

Quien entra con clave de Supervisor (= Gerente) ve cuatro pasos en lugar del panel completo (que sigue en «Ver detalle completo»):

1. **Procesos**: revisa su inventario; puede **elegir** procesos ya cargados por MBC (se incorporan a su lista sin tocar el inventario; los «suelta» cuando no le corresponden), **crear** procesos nuevos (entran al inventario final) o **quitar** los propios (y restaurarlos).
2. **Delegación**: cada proceso con al menos una persona a cargo (existente o nueva).
3. **Avance**: todos los procesos respondidos (checklist completo).
4. **Validación final**: con todos los procesos validados por MBC, el Gerente da su aprobación; no se puede deshacer.

Las reglas las decide el Worker (`worker/src/flujo.js`), no el navegador: orden de los pasos, compuertas, advertencia antes de un cambio que reinicia
pasos ya confirmados (`409` con `requiere_confirmacion`, se repite con `forzar`) y bloqueo total tras la aprobación. MBC puede **reabrir** una
aprobación desde la consola (queda motivo y fecha). Módulos nuevos del Worker: `comun.js` (utilidades), `ambito.js` (alcance del Supervisor),
`cobertura.js` (cuándo un proceso cuenta como respondido) y `flujo.js`.

Base: `migracion-014.sql` (para una base nueva aplicar, después de `schema.sql`, las migraciones 011, 012 y 014). Prueba: con `npm run dev` corriendo,
`npm run test:flujo` (desde `worker/`) recorre el flujo en una campaña temporal y la borra. `npm run semilla` crea la campaña de demostración «Demo flujo del Gerente» (empresa ficticia, 41 procesos en 5 gerencias, tres Gerentes en etapas distintas); las claves las imprime al terminar.

## Esqueleto de la campaña (hoja «Gerencias»)

La plantilla de carga tiene una hoja `Gerencias` (`area`, `gerencia`, `seccion`) para cargar la estructura Área > Gerencia > Sección **sin procesos**. Al cargar
personas, procesos o la matriz, cada fila se vincula al esqueleto por nombre (sin importar mayúsculas ni tildes) y toma el nombre que tiene allí; lo que no esté se
agrega al esqueleto sin área y se informa en el resumen. «Agregar» amplía y actualiza el esqueleto; «Reemplazar» lo reemplaza. Una campaña sin hoja `Gerencias`
funciona como antes. El mapa agrupa por área y muestra también las gerencias y secciones que aún no tienen procesos. Base: `migracion-015.sql` (tabla `estructura`);
código: `worker/src/estructura.js`; prueba: `npm run test:estructura`.
