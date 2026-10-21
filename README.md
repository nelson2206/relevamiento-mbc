# Voz MBC · Relevamiento de procesos

Encuesta por voz para levantar el inventario de procesos de un cliente: la persona cuenta cómo funciona cada proceso, la IA revisa un
checklist por bloque, y el equipo consultor valida la matriz en una consola. Repositorio propio, **separado de Voz MBC**.

| Carpeta | Qué es |
|---|---|
| `index.html` | La encuesta que responden las personas (enlace personal `?k=`, de sección `?c=` y abierto) |
| `admin.html` | La consola del equipo consultor y, con `?cliente=`, el panel de solo lectura del cliente |
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
