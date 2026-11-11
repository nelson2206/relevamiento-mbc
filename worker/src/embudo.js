// Embudo de puntos de contacto: registro de eventos con fecha (gerente -> equipo -> avance), reconstrucción de lo ya ocurrido
// y extracción de datos. No hay pantalla: la vista se arma fuera con lo que devuelve exportarEmbudo.
// Definiciones y campos: docs/EMBUDO-definiciones.md y docs/EMBUDO-diccionario.md.
//
// Criterio de no invasión (obligatorio): el registro es asíncrono (ctx.waitUntil), nunca rompe la acción principal, solo guarda
// hitos (compartió, abrió, creó acceso, primera respuesta), nunca contenido de respuestas, y no usa cookies, huella del navegador,
// IP ni user-agent. El único identificador del navegador es un UUID aleatorio que ya viaja en las llamadas existentes.
import { HttpError, ahora, uid, txt, mismaArea, log } from './comun.js';
import { cubreSeccion, alcanceDe } from './ambito.js';
import { crearCobertura } from './cobertura.js';
import { puntosValidados } from './matriz-sync.js';

// ---------------------------------------------------------------- catálogo cerrado
// paso: paso del embudo (1-7) · idem: se registra una sola vez (clave única) · medido: lo registra el código (P = paquete en que se instrumenta).
export const EVENTOS = Object.freeze({
  acceso_gerente_generado: { paso: 1, idem: false, paquete: 2 },
  acceso_gerente_enviado: { paso: 1, idem: false, paquete: 2 },
  gerente_abrio: { paso: 2, idem: true, paquete: 2 },
  gerente_entro: { paso: 2, idem: false, paquete: 2 },
  enlace_compartido: { paso: 3, idem: false, paquete: 1 },
  enlace_seccion_copiado: { paso: 3, idem: false, paquete: 2 },
  persona_agregada: { paso: 3, idem: true, paquete: 1 },
  procesos_delegados: { paso: 3, idem: false, paquete: 1 },
  enlace_abierto: { paso: 4, idem: false, paquete: 1 },
  persona_identificada: { paso: 4, idem: false, paquete: 1 },
  acceso_creado: { paso: 5, idem: true, paquete: 1 },
  pin_fallido: { paso: 5, idem: false, paquete: 2 },
  primera_respuesta: { paso: 6, idem: true, paquete: 1 },
  bloque_completado: { paso: 7, idem: true, paquete: 3 },
  proceso_completo: { paso: 7, idem: true, paquete: 3 },
  proceso_validado: { paso: 7, idem: false, paquete: 3 },
  flujo_paso_confirmado: { paso: 7, idem: false, paquete: 3 },
  aprobacion_final: { paso: 7, idem: false, paquete: 3 }
});
export const ACTORES = ['gerente', 'supervisor', 'cliente', 'persona', 'admin', 'anonimo', 'sistema'];
export const CANALES = ['correo', 'enlace', 'invitacion', 'outlook', 'copiar', 'whatsapp', 'otro'];
// Lista blanca de claves de `detalle`: nunca textos de respuesta, PIN, claves, tokens ni correos.
export const DETALLE_PERMITIDO = ['procesos', 'personas', 'pin', 'perfil', 'motivo', 'supervisor_id', 'bloque', 'punto_listos', 'fuente', 'validado_por', 'reconstruido', 'aprox'];
export const VENTANA_APERTURA_MIN = 30;   // aperturas del mismo visitante y sección dentro de esta ventana cuentan una vez

const RE_VISITANTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// El visitante es un UUID aleatorio generado en el navegador; cualquier otro valor se descarta (queda sin visitante).
export const visitanteValido = v => (typeof v === 'string' && RE_VISITANTE.test(v.toLowerCase()) ? v.toLowerCase() : '');

export function limpiarDetalle(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const k of DETALLE_PERMITIDO) {
    let v = d[k];
    if (typeof v === 'string') { v = v.trim().slice(0, 80); if (!v || v.includes('@')) continue; }   // un correo nunca entra
    else if (typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
}

// Valida y completa un evento. Lanza error si el tipo no está en el catálogo (registrarEventos lo captura y lo deja en el log).
export function normalizarEvento(ev) {
  if (!ev || !EVENTOS[ev.tipo]) throw new Error('Tipo de evento fuera del catálogo: ' + (ev && ev.tipo));
  const c = txt(ev.campana_id, 60);
  if (!c) throw new Error('Evento sin campaña');
  return {
    id: uid(), campana_id: c, tipo: ev.tipo,
    actor_tipo: ACTORES.includes(ev.actor_tipo) ? ev.actor_tipo : '',
    actor_id: txt(ev.actor_id, 60), persona_id: txt(ev.persona_id, 60),
    gerencia: txt(ev.gerencia, 150), seccion: txt(ev.seccion, 150), proceso_id: txt(ev.proceso_id, 60),
    canal: CANALES.includes(ev.canal) ? ev.canal : '',
    visitante: visitanteValido(ev.visitante),
    reconstruido: ev.reconstruido ? 1 : 0,
    clave: ev.clave ? txt(ev.clave, 200) : null,   // NULL = evento que se repite (los NULL no chocan en el índice único)
    detalle: JSON.stringify(limpiarDetalle(ev.detalle)),
    creado: ev.creado || ahora(),
    ventana: ev.ventana_min ? Number(ev.ventana_min) : 0
  };
}

const COLS = ['id', 'campana_id', 'tipo', 'actor_tipo', 'actor_id', 'persona_id', 'gerencia', 'seccion', 'proceso_id', 'canal', 'visitante', 'reconstruido', 'clave', 'detalle', 'creado'];
function sentencia(env, f) {
  const vals = COLS.map(c => f[c]);
  if (!f.ventana) return env.DB.prepare(`INSERT OR IGNORE INTO eventos (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(',')})`).bind(...vals);
  // Con ventana: no repite si el mismo visitante ya abrió esa sección hace menos de N minutos (una sola sentencia, atómica).
  const desde = new Date(Date.parse(f.creado) - f.ventana * 60000).toISOString();
  return env.DB.prepare(`INSERT INTO eventos (${COLS.join(', ')}) SELECT ${COLS.map(() => '?').join(',')}
    WHERE NOT EXISTS (SELECT 1 FROM eventos WHERE campana_id=? AND tipo=? AND visitante=? AND gerencia=? AND seccion=? AND creado>?)`)
    .bind(...vals, f.campana_id, f.tipo, f.visitante, f.gerencia, f.seccion, desde);
}

// Registra uno o varios eventos SIN esperar y SIN romper la acción principal: corre en ctx.waitUntil y todo error queda solo en el log.
// Devuelve la promesa (que nunca rechaza) por si una prueba quiere esperarla.
export function registrarEventos(env, ctx, lista) {
  const p = (async () => {
    try {
      const st = [];
      for (const ev of (Array.isArray(lista) ? lista : [lista])) {
        try { st.push(sentencia(env, normalizarEvento(ev))); } catch (err) { log('evento_descartado', { tipo: ev && ev.tipo, error: String((err && err.message) || err).slice(0, 120) }); }
      }
      for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    } catch (err) { log('evento_error', { error: String((err && err.message) || err).slice(0, 200) }); }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}
export const registrarEvento = (env, ctx, ev) => registrarEventos(env, ctx, [ev]);

// ---------------------------------------------------------------- constructores de eventos (los usa index.js con una línea)
// Quién actuó en el panel del cliente: el administrador del cliente o un Supervisor/Gerente (por el perfil de su cuenta).
export function actorDe(actor) {
  if (actor && actor.rol === 'supervisor' && actor.sup) return { actor_tipo: actor.sup.perfil === 'supervisor' ? 'supervisor' : 'gerente', actor_id: actor.sup.id };
  return { actor_tipo: 'cliente', actor_id: '' };
}
const deArea = x => ({ gerencia: x.gerencia || '', seccion: x.seccion || '' });

export const eventosEnlaceCompartido = (campId, actor, personas, canal) =>
  personas.map(x => ({ campana_id: campId, tipo: 'enlace_compartido', ...actorDe(actor), persona_id: x.id, ...deArea(x), canal: canal === 'correo' ? 'correo' : 'enlace' }));
export const eventoDelegados = (campId, actor, persona, n) =>
  ({ campana_id: campId, tipo: 'procesos_delegados', ...actorDe(actor), persona_id: persona.id, ...deArea(persona), detalle: { procesos: n } });
export const eventosPersonasAgregadas = (campId, actor, nuevos) =>
  nuevos.map(x => ({ campana_id: campId, tipo: 'persona_agregada', ...actorDe(actor), persona_id: x.id, ...deArea(x), clave: 'persona_agregada|' + x.id }));
export const eventoEnlaceAbierto = (campId, gerencia, seccion, visitante) =>
  ({ campana_id: campId, tipo: 'enlace_abierto', actor_tipo: 'anonimo', gerencia, seccion, visitante, ventana_min: VENTANA_APERTURA_MIN });
// Ingreso de una persona con nombre y PIN: persona_identificada (une visitante y persona) y, si fijó su PIN por primera vez, acceso_creado.
export function eventosIngreso(e, visitante, pin, fuente) {
  const base = { campana_id: e.campana_id, actor_tipo: 'persona', actor_id: e.id, persona_id: e.id, ...deArea(e), visitante };
  const lista = [{ ...base, tipo: 'persona_identificada', detalle: { pin } }];
  if (pin === 'creado') lista.push({ ...base, tipo: 'acceso_creado', clave: 'acceso_creado|' + e.id, detalle: { fuente } });
  return lista;
}
// Primer guardado con contenido de una persona en un proceso (solo la primera vez: clave única).
export const eventoPrimeraRespuesta = (e, procesoId, bloque) =>
  ({ campana_id: e.campana_id, tipo: 'primera_respuesta', actor_tipo: 'persona', actor_id: e.id, persona_id: e.id, ...deArea(e), proceso_id: procesoId,
    clave: 'primera_respuesta|' + e.id + '|' + procesoId, detalle: { bloque } });

// ---------------------------------------------------------------- reconstrucción (una sola vez, idempotente)
const J = "json_object('reconstruido', json('true')";
// Los eventos que se repiten (sin clave natural) solo se reconstruyen hasta el primer evento medido de ese tipo: lo posterior ya lo midió el código.
// (se resta 10 s porque el evento medido se guarda unos milisegundos después de la fila que lo originó)
const antes = tipo => `(SELECT julianday(MIN(creado)) - 10.0/86400 FROM eventos WHERE campana_id=? AND tipo='${tipo}' AND reconstruido=0)`;
const ID = "lower(hex(randomblob(16)))";
const INS = 'INSERT OR IGNORE INTO eventos (id, campana_id, tipo, actor_tipo, actor_id, persona_id, gerencia, seccion, proceso_id, canal, visitante, reconstruido, clave, detalle, creado)';

// Cada elemento: [tipo del resumen, SQL, parámetros]. Todos los SELECT llevan campana_id como primer parámetro.
function sentenciasBackfill(campId) {
  const c = campId;
  return [
    // B1: la clave del gerente (primera y regeneradas con supervisor_id en acciones).
    ['acceso_gerente_generado', `${INS} SELECT ${ID}, s.campana_id, 'acceso_gerente_generado', 'sistema', s.id, s.encuestado_id, COALESCE(e.gerencia,''), COALESCE(e.seccion,''), '', '', '', 1,
        'agg|' || s.id || '|' || s.creado, ${J}, 'supervisor_id', s.id, 'perfil', s.perfil, 'motivo', 'alta'), s.creado
      FROM supervisores s LEFT JOIN encuestados e ON e.id=s.encuestado_id WHERE s.campana_id=?`, [c]],
    ['acceso_gerente_generado', `${INS} SELECT ${ID}, a.campana_id, 'acceso_gerente_generado', 'sistema', a.sid, COALESCE(s.encuestado_id,''), '', '', '', '', '', 1,
        'agg|acc|' || a.id, ${J}, 'supervisor_id', a.sid, 'perfil', COALESCE(s.perfil,''), 'motivo', 'regenerada'), a.creado
      FROM (SELECT x.*, CASE WHEN json_valid(x.detalle) THEN json_extract(x.detalle,'$.supervisor_id') END AS sid FROM acciones x WHERE x.campana_id=? AND x.accion='supervisor_clave_nueva') a
      LEFT JOIN supervisores s ON s.id=a.sid WHERE a.sid IS NOT NULL`, [c]],
    // B2: primera apertura = primera acción del supervisor (prueba que ya entró); si no tiene, su último ingreso (cota).
    ['gerente_abrio', `${INS} SELECT ${ID}, t.campana_id, 'gerente_abrio', 'sistema', t.sid, t.encuestado_id, '', '', '', '', '', 1,
        'gabrio|' || t.sid, ${J}, 'supervisor_id', t.sid, 'perfil', t.perfil, 'aprox', CASE WHEN t.primera IS NULL THEN 'ultimo' ELSE 'primera_accion' END), COALESCE(t.primera, t.ult)
      FROM (SELECT s.campana_id, s.id AS sid, s.encuestado_id, s.perfil, NULLIF(s.ultimo,'') AS ult,
              (SELECT MIN(a.creado) FROM acciones a WHERE a.campana_id=s.campana_id AND a.actor_tipo='supervisor' AND a.actor_id=s.id) AS primera
            FROM supervisores s WHERE s.campana_id=?) t WHERE COALESCE(t.primera, t.ult) IS NOT NULL`, [c]],
    // B3: último ingreso conocido del gerente (un solo punto).
    ['gerente_entro', `${INS} SELECT ${ID}, s.campana_id, 'gerente_entro', 'sistema', s.id, s.encuestado_id, '', '', '', '', '', 1,
        'gentro|' || s.id || '|' || s.ultimo, ${J}, 'supervisor_id', s.id, 'perfil', s.perfil, 'aprox', 'ultimo'), s.ultimo
      FROM supervisores s WHERE s.campana_id=? AND s.ultimo<>'' AND julianday(s.ultimo) < COALESCE(${antes('gerente_entro')}, 1e9)`, [c, c]],
    // B4: delegaciones agrupadas por persona y quien delegó (primera fecha y cantidad).
    ['procesos_delegados', `${INS} SELECT ${ID}, d.campana_id, 'procesos_delegados', CASE WHEN d.actor_tipo='supervisor' THEN COALESCE(s.perfil,'supervisor') ELSE 'cliente' END, d.actor_id, d.encuestado_id,
        COALESCE(e.gerencia,''), COALESCE(e.seccion,''), '', '', '', 1, 'del|' || d.encuestado_id || '|' || d.actor_id, ${J}, 'procesos', COUNT(*)), MIN(d.creado)
      FROM delegaciones d LEFT JOIN encuestados e ON e.id=d.encuestado_id LEFT JOIN supervisores s ON s.id=d.actor_id
      WHERE d.campana_id=? AND julianday(d.creado) < COALESCE(${antes('procesos_delegados')}, 1e9) GROUP BY d.encuestado_id, d.actor_tipo, d.actor_id`, [c, c]],
    // B5: correos y enlaces generados (la acción guardó solo la cantidad: no se sabe a qué persona).
    ['enlace_compartido', `${INS} SELECT ${ID}, a.campana_id, 'enlace_compartido', CASE WHEN a.actor_tipo='supervisor' THEN COALESCE(s.perfil,'supervisor') ELSE 'cliente' END, a.actor_id, '', '', '', '',
        CASE WHEN a.accion='correo_generado' THEN 'correo' ELSE 'enlace' END, '', 1, 'acc|' || a.id, ${J}, 'personas', COALESCE(a.n, 0)), a.creado
      FROM (SELECT x.*, CASE WHEN json_valid(x.detalle) THEN json_extract(x.detalle,'$.personas') END AS n FROM acciones x
            WHERE x.campana_id=? AND x.accion IN ('correo_generado','enlace_copiado') AND julianday(x.creado) < COALESCE(${antes('enlace_compartido')}, 1e9)) a
      LEFT JOIN supervisores s ON s.id=a.actor_id`, [c, c]],
    // B6: personas agregadas por el equipo del cliente: alta por Excel y alta del gerente comparten origen; se aproxima por una delegación (<= 5 min) del cliente o un supervisor.
    ['persona_agregada', `${INS} SELECT ${ID}, e.campana_id, 'persona_agregada', 'sistema', '', e.id, e.gerencia, e.seccion, '', '', '', 1, 'persona_agregada|' || e.id, ${J}, 'aprox', 'delegacion_cercana'), e.creado
      FROM encuestados e WHERE e.campana_id=? AND e.origen='carga' AND e.creado IS NOT NULL
        AND EXISTS (SELECT 1 FROM delegaciones d WHERE d.encuestado_id=e.id AND ABS(julianday(d.creado)-julianday(e.creado)) <= 5.0/1440)`, [c]],
    // B7: acceso creado. Registro abierto: su fecha de creación (exacta). Precargada: se fijó el PIN en un ingreso que no guardó fecha; se toma el primer rastro (cota).
    ['acceso_creado', `${INS} SELECT ${ID}, t.campana_id, 'acceso_creado', 'sistema', '', t.id, t.gerencia, t.seccion, '', '', '', 1, 'acceso_creado|' || t.id,
        ${J}, 'fuente', CASE WHEN t.origen='abierto' THEN 'registro_abierto' ELSE 'precargada' END, 'aprox', CASE WHEN t.origen='abierto' THEN 'exacto' ELSE 'cota' END), t.f
      FROM (SELECT e.campana_id, e.id, e.gerencia, e.seccion, e.origen,
              CASE WHEN e.origen='abierto' AND e.creado IS NOT NULL THEN e.creado ELSE
                NULLIF(min(COALESCE(NULLIF(e.ultimo_acceso,''),'9999'), COALESCE((SELECT MIN(actualizado) FROM revisiones WHERE encuestado_id=e.id),'9999'),
                  COALESCE((SELECT MIN(actualizado) FROM respuestas WHERE encuestado_id=e.id),'9999')), '9999') END AS f
            FROM encuestados e WHERE e.campana_id=? AND e.pin_hash<>'') t WHERE t.f IS NOT NULL`, [c]],
    // B8: último ingreso con PIN (un solo punto, sin visitante).
    ['persona_identificada', `${INS} SELECT ${ID}, e.campana_id, 'persona_identificada', 'persona', e.id, e.id, e.gerencia, e.seccion, '', '', '', 1, 'ident|' || e.id || '|' || e.ultimo_acceso, ${J}, 'aprox', 'ultimo'), e.ultimo_acceso
      FROM encuestados e WHERE e.campana_id=? AND COALESCE(e.ultimo_acceso,'')<>'' AND julianday(e.ultimo_acceso) < COALESCE(${antes('persona_identificada')}, 1e9)`, [c, c]],
    // B9: primera respuesta con contenido por persona y proceso; respuestas.actualizado se pisa: es una cota superior.
    ['primera_respuesta', `${INS} SELECT ${ID}, e.campana_id, 'primera_respuesta', 'persona', e.id, e.id, e.gerencia, e.seccion, r.proceso_id, '', '', 1,
        'primera_respuesta|' || e.id || '|' || r.proceso_id, ${J}, 'aprox', 'cota'), MIN(r.actualizado)
      FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id
      WHERE e.campana_id=? AND (trim(r.texto)<>'' OR r.sistemas NOT IN ('','[]') OR r.checklist LIKE '%"estado":"cubierto"%' OR r.checklist LIKE '%"_vigentes"%' OR r.datos LIKE '%"confidencial":"s%' OR r.datos LIKE '%"confidencial":"n%')
      GROUP BY e.id, r.proceso_id`, [c]],
    // B10: procesos validados por MBC (solo queda la última validación vigente).
    ['proceso_validado', `${INS} SELECT ${ID}, p.campana_id, 'proceso_validado', 'admin', '', '', p.gerencia, p.seccion, p.id, '', '', 1, 'val|' || p.id || '|' || p.validado_en,
        ${J}, 'validado_por', p.validado_por), p.validado_en
      FROM procesos p WHERE p.campana_id=? AND p.validacion='validado' AND p.validado_en IS NOT NULL`, [c]],
    // B11: pasos del flujo del gerente confirmados y aprobación final.
    ['flujo_paso_confirmado', `${INS} SELECT ${ID}, f.campana_id, 'flujo_paso_confirmado', COALESCE(s.perfil,'gerente'), f.supervisor_id, COALESCE(s.encuestado_id,''), '', '', '', '', '', 1,
        'flujo|' || f.supervisor_id || '|' || f.paso || '|' || f.confirmado_en, ${J}, 'bloque', 'paso ' || f.paso), f.confirmado_en
      FROM flujo_pasos f LEFT JOIN supervisores s ON s.id=f.supervisor_id WHERE f.campana_id=?`, [c]],
    ['aprobacion_final', `${INS} SELECT ${ID}, a.campana_id, 'aprobacion_final', COALESCE(s.perfil,'gerente'), a.supervisor_id, COALESCE(s.encuestado_id,''), '', '', '', '', '', 1,
        'aprob|' || a.id, ${J}, 'procesos', a.procesos), a.aprobado_en
      FROM aprobaciones a LEFT JOIN supervisores s ON s.id=a.supervisor_id WHERE a.campana_id=?`, [c]]
  ];
}

// Crea eventos aproximados desde los datos actuales. Todos quedan con reconstruido=1 y se pueden repetir sin duplicar.
// Devuelve las filas insertadas por tipo. Los datos medidos (reconstruido=0) nunca se tocan.
export async function backfillEmbudo(env, campId) {
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(txt(campId, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const lista = sentenciasBackfill(camp.id);
  const res = await env.DB.batch(lista.map(([, sql, params]) => env.DB.prepare(sql).bind(...params)));
  const insertados = {};
  lista.forEach(([tipo], i) => { insertados[tipo] = (insertados[tipo] || 0) + Number((((res || [])[i] || {}).meta || {}).changes || 0); });
  log('embudo_backfill', { campana: camp.id, total: Object.values(insertados).reduce((a, b) => a + b, 0) });
  return { ok: true, campana_id: camp.id, insertados, reconstruido: 1,
    nota: 'Los eventos reconstruidos son aproximados y llevan reconstruido=1. Repetir esta llamada no duplica filas.' };
}

// ---------------------------------------------------------------- extracción
const PASOS = ['sin contacto', '', '', 'compartido', 'abrió', 'creó acceso', 'empezó', 'completó'];
const COL_EVENTOS = ['evento_id', 'fecha_utc', 'fecha_lima', 'tipo', 'actor_tipo', 'actor_nombre', 'perfil', 'gerencia', 'seccion', 'persona_id', 'persona_nombre', 'gerente_nombre',
  'proceso_id', 'proceso_codigo', 'canal', 'visitante_corto', 'reconstruido', 'detalle'];
const COL_PERSONAS = ['campana_id', 'persona_id', 'persona_nombre', 'gerencia', 'seccion', 'cargo', 'perfil', 'gerente_nombre', 'origen', 'f_agregado', 'f_acceso_generado', 'f_acceso_enviado',
  'f_gerente_abrio', 'f_delegado', 'f_compartido', 'f_abrio', 'f_abrio_origen', 'f_acceso_creado', 'f_acceso_creado_origen', 'f_primera_respuesta', 'f_primer_proceso_completo',
  'f_ultima_actividad', 'n_aperturas', 'n_ingresos', 'ultimo_paso', 'ultimo_paso_nombre', 'dias_sin_actividad', 'procesos_asignados', 'procesos_con_respuesta', 'procesos_completos',
  'procesos_validados', 'pct_procesos_completos', 'pct_puntos', 'bloqueada'];

const LIMA = 5 * 3600 * 1000;   // Lima es UTC-5 todo el año
const fechaLima = iso => { const t = Date.parse(iso); return isNaN(t) ? '' : new Date(t - LIMA).toISOString().slice(0, 19).replace('T', ' '); };
// AAAA-MM-DD (hora de Lima) -> instante UTC de su medianoche; dias=1 da el inicio del día siguiente.
function limaAUtc(d, dias) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) || isNaN(Date.parse(d))) throw new HttpError(400, 'Las fechas deben ser AAAA-MM-DD');
  return new Date(Date.parse(d + 'T00:00:00Z') + LIMA + (dias || 0) * 86400000).toISOString();
}

// CSV para Excel en español: UTF-8 con BOM, separador «;», comillas dobles, decimales con coma, fin de línea CRLF y sin fórmulas inyectadas.
export function aCsv(columnas, filas) {
  const celda = v => {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
    let s = String(v).replace(/[\r\n]+/g, ' ');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [columnas.join(';'), ...filas.map(f => columnas.map(c => celda(f[c])).join(';'))].join('\r\n') + '\r\n';
}

const minFecha = (...a) => a.filter(Boolean).sort()[0] || '';
const maxFecha = (...a) => a.filter(Boolean).sort().pop() || '';

// Gerente de una sección: la cuenta activa con perfil gerente cuyo alcance la cubre (si hay una de acceso total y otra más específica, la específica).
function gerenteDe(cuentas, g, s) {
  const lista = cuentas.filter(c => c.activo && c.perfil === 'gerente' && cubreSeccion(c, g, s));
  const c = lista.find(x => !alcanceDe(x).todo) || lista[0];
  return c ? c.nombre : '';
}

async function conjuntoEventos(env, camp, q, cuentas) {
  const limite = Math.min(Math.max(parseInt(q.limite, 10) || 2000, 1), 5000);
  const donde = ['ev.campana_id=?'], args = [camp.id];
  if (q.desde) { donde.push('ev.creado>=?'); args.push(limaAUtc(q.desde, 0)); }
  if (q.hasta) { donde.push('ev.creado<?'); args.push(limaAUtc(q.hasta, 1)); }
  if (q.despues) {
    const [t, i] = String(q.despues).split('|');
    if (!t || !i) throw new HttpError(400, 'Cursor inválido');
    donde.push('(ev.creado>? OR (ev.creado=? AND ev.id>?))'); args.push(t, t, i);
  }
  const r = (await env.DB.prepare(`SELECT ev.id, ev.creado, ev.tipo, ev.actor_tipo, ev.actor_id, ev.persona_id, ev.gerencia, ev.seccion, ev.proceso_id, ev.canal, ev.visitante, ev.reconstruido, ev.detalle,
      e.nombre AS persona_nombre, p.codigo AS proceso_codigo, s.nombre AS actor_nombre
    FROM eventos ev LEFT JOIN encuestados e ON e.id=ev.persona_id LEFT JOIN procesos p ON p.id=ev.proceso_id LEFT JOIN supervisores s ON s.id=ev.actor_id
    WHERE ${donde.join(' AND ')} ORDER BY ev.creado, ev.id LIMIT ?`).bind(...args, limite + 1).all()).results;
  const hay = r.length > limite, filas = r.slice(0, limite);
  return {
    filas: filas.map(x => ({
      evento_id: x.id, fecha_utc: x.creado, fecha_lima: fechaLima(x.creado), tipo: x.tipo, actor_tipo: x.actor_tipo,
      actor_nombre: x.actor_nombre || (x.actor_tipo === 'cliente' ? 'Administrador del cliente' : x.actor_tipo === 'persona' ? (x.persona_nombre || '') : ''),
      perfil: x.actor_tipo, gerencia: x.gerencia, seccion: x.seccion, persona_id: x.persona_id, persona_nombre: x.persona_nombre || '',
      gerente_nombre: x.gerencia ? gerenteDe(cuentas, x.gerencia, x.seccion) : '', proceso_id: x.proceso_id, proceso_codigo: x.proceso_codigo || '',
      canal: x.canal, visitante_corto: (x.visitante || '').slice(0, 8), reconstruido: x.reconstruido, detalle: x.detalle })),
    siguiente: hay ? filas[filas.length - 1].creado + '|' + filas[filas.length - 1].id : null
  };
}

async function conjuntoPersonas(env, camp, bloques, cuentas) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(camp.id, ...a).all().then(r => r.results);
  const [enc, procs, revs, resp, pre, asig, evs, vis, aperturas] = await Promise.all([
    q('SELECT id, nombre, rol, gerencia, seccion, estado, actualizado, origen, creado, pin_hash<>\'\' AS con_pin, pin_bloqueo<>\'\' AS bloqueada, ultimo_acceso FROM encuestados WHERE campana_id=? ORDER BY gerencia, seccion, nombre'),
    q('SELECT id, gerencia, seccion, fuente, fuera_alcance, creado_por, validacion FROM procesos WHERE campana_id=?'),
    q('SELECT r.encuestado_id, r.proceso_id, r.estado FROM revisiones r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    // El texto no se necesita, solo saber si hay: nunca se trae lo que dijeron las personas.
    q("SELECT r.encuestado_id, r.proceso_id, r.pregunta, CASE WHEN length(trim(r.texto))>0 THEN 'x' ELSE '' END AS texto, r.sistemas, r.checklist, r.datos, r.actualizado FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?"),
    q('SELECT pc.proceso_id, pc.punto FROM precarga pc JOIN procesos p ON p.id=pc.proceso_id WHERE p.campana_id=?'),
    q('SELECT a.encuestado_id, a.proceso_id, a.origen FROM asignaciones a JOIN encuestados e ON e.id=a.encuestado_id WHERE e.campana_id=?'),
    q("SELECT persona_id, tipo, MIN(creado) AS primero, MAX(creado) AS ultimo, COUNT(*) AS n, MIN(CASE WHEN reconstruido=0 THEN creado END) AS primero_medido FROM eventos WHERE campana_id=? AND persona_id<>'' GROUP BY persona_id, tipo"),
    q("SELECT persona_id, visitante FROM eventos WHERE campana_id=? AND persona_id<>'' AND visitante<>'' GROUP BY persona_id, visitante"),
    q("SELECT visitante, gerencia, seccion, MIN(creado) AS primero, COUNT(*) AS n FROM eventos WHERE campana_id=? AND tipo='enlace_abierto' AND visitante<>'' GROUP BY visitante, gerencia, seccion")
  ]);
  const validados = await puntosValidados(env, camp.id);
  const cobertura = crearCobertura({ bloques, revisiones: revs, respuestas: resp, precarga: pre.concat(validados) });
  const porPersona = {};
  evs.forEach(x => { (porPersona[x.persona_id] = porPersona[x.persona_id] || {})[x.tipo] = x; });
  const visitantesDe = {}, personasDe = {};
  vis.forEach(x => { (visitantesDe[x.persona_id] = visitantesDe[x.persona_id] || []).push(x.visitante); (personasDe[x.visitante] = personasDe[x.visitante] || new Set()).add(x.persona_id); });
  const cuentaDe = {}; cuentas.forEach(c => { if (c.encuestado_id) cuentaDe[c.encuestado_id] = c; });
  const procesosVigentes = procs.filter(p => !p.fuera_alcance), procPorId = new Map(procs.map(p => [p.id, p]));
  // «Con respuesta»: texto, sistemas marcados, respuesta estructurada con datos o un punto marcado/confirmado por la persona (misma idea que primera_respuesta).
  const tieneContenido = r => !!(r.texto || (r.sistemas && r.sistemas !== '[]') || /"confidencial":"(si|no)"/.test(r.datos || '') || /"estado":"cubierto"|"_vigentes"/.test(r.checklist || ''));
  const ahoraIso = ahora();

  return enc.map(e => {
    const ev = porPersona[e.id] || {}, f = t => (ev[t] || {}).primero || '';
    const origenDe = t => (ev[t] ? (ev[t].primero_medido ? 'medido' : 'reconstruido') : '');
    // Procesos que ve la persona (misma lista que la encuesta): su sección sin los que MBC le quitó, los que agregó y los que eligió o le asignaron.
    const excl = new Set(asig.filter(a => a.encuestado_id === e.id && a.origen === 'excluido').map(a => a.proceso_id));
    const elegidos = new Set(asig.filter(a => a.encuestado_id === e.id && a.origen !== 'excluido').map(a => a.proceso_id));
    const suyos = procesosVigentes.filter(p => {
      const enSeccion = mismaArea(p.gerencia, e.gerencia) && mismaArea(p.seccion, e.seccion) && !(p.fuente === 'nuevo' && p.creado_por === e.id);
      return (enSeccion && !excl.has(p.id)) || p.creado_por === e.id || elegidos.has(p.id);
    });
    let completos = 0, validadosN = 0, conResp = 0, listos = 0, total = 0, primerCompleto = '';
    const respDe = resp.filter(r => r.encuestado_id === e.id);
    suyos.forEach(p => {
      const a = cobertura.persona(p.id, e.id);
      listos += a.listos; total += a.total;
      if (a.completo) { completos++; if (p.validacion === 'validado') validadosN++; }
      if (respDe.some(r => r.proceso_id === p.id && tieneContenido(r))) conResp++;
    });
    if (ev.proceso_completo) primerCompleto = ev.proceso_completo.primero;

    // Apertura: primero lo medido (visitantes que solo se identificaron con esta persona), luego lo inferido de su identificación o su acceso.
    const propios = (visitantesDe[e.id] || []).filter(v => personasDe[v].size === 1), ambiguos = (visitantesDe[e.id] || []).filter(v => personasDe[v].size > 1);
    const deSeccion = (lista) => aperturas.filter(a => lista.includes(a.visitante) && mismaArea(a.gerencia, e.gerencia) && mismaArea(a.seccion, e.seccion));
    const medidas = deSeccion(propios);
    let fAbrio = minFecha(...medidas.map(a => a.primero)), origenAbrio = fAbrio ? 'medido' : '';
    const nAperturas = medidas.reduce((s, a) => s + a.n, 0);
    if (!fAbrio) {
      fAbrio = minFecha(f('persona_identificada'), f('acceso_creado'));
      origenAbrio = fAbrio ? 'inferido' : (deSeccion(ambiguos).length ? 'ambiguo' : '');
    }
    const contacto3 = minFecha(f('enlace_compartido'), f('procesos_delegados'), f('persona_agregada'));
    const ultimoPaso = (suyos.length && completos === suyos.length) ? 7 : f('primera_respuesta') ? 6 : f('acceso_creado') ? 5 : fAbrio ? 4 : contacto3 ? 3 : 0;
    const ultima = maxFecha(e.ultimo_acceso || '', e.actualizado || '', ...respDe.map(r => r.actualizado), (ev.persona_identificada || {}).ultimo, (ev.primera_respuesta || {}).ultimo, (ev.acceso_creado || {}).ultimo);
    const cuenta = cuentaDe[e.id];
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      campana_id: camp.id, persona_id: e.id, persona_nombre: e.nombre, gerencia: e.gerencia, seccion: e.seccion, cargo: e.rol || '',
      perfil: cuenta ? cuenta.perfil : 'responsable', gerente_nombre: gerenteDe(cuentas, e.gerencia, e.seccion), origen: e.origen,
      f_agregado: e.creado || '', f_acceso_generado: f('acceso_gerente_generado'), f_acceso_enviado: f('acceso_gerente_enviado'), f_gerente_abrio: f('gerente_abrio'),
      f_delegado: f('procesos_delegados'), f_compartido: f('enlace_compartido'), f_abrio: fAbrio, f_abrio_origen: origenAbrio,
      f_acceso_creado: f('acceso_creado'), f_acceso_creado_origen: origenDe('acceso_creado'), f_primera_respuesta: f('primera_respuesta'),
      f_primer_proceso_completo: primerCompleto, f_ultima_actividad: ultima, n_aperturas: nAperturas, n_ingresos: (ev.persona_identificada || {}).n || 0,
      ultimo_paso: ultimoPaso, ultimo_paso_nombre: PASOS[ultimoPaso],
      dias_sin_actividad: ultima ? Math.max(0, Math.floor((Date.parse(ahoraIso) - Date.parse(ultima)) / 86400000)) : '',
      procesos_asignados: suyos.length, procesos_con_respuesta: conResp, procesos_completos: completos, procesos_validados: validadosN,
      pct_procesos_completos: pct(completos, suyos.length), pct_puntos: pct(listos, total), bloqueada: e.bloqueada ? 1 : 0
    };
  });
}

// GET /a/embudo/export?campana_id=&conjunto=eventos|personas|todos&formato=json|csv&desde=&hasta=&limite=&despues=
// Solo lectura. Nunca devuelve textos de respuestas, PIN, claves, tokens ni correos; el nombre de la persona sí.
export async function exportarEmbudo(env, url, bloques, h) {
  const q = Object.fromEntries(url.searchParams.entries());
  const camp = await env.DB.prepare('SELECT id, nombre FROM campanas WHERE id=?').bind(txt(q.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const conjunto = q.conjunto || 'todos', formato = q.formato || 'json';
  if (!['eventos', 'personas', 'todos'].includes(conjunto)) throw new HttpError(400, 'conjunto debe ser eventos, personas o todos');
  if (!['json', 'csv'].includes(formato)) throw new HttpError(400, 'formato debe ser json o csv');
  if (formato === 'csv' && conjunto === 'todos') throw new HttpError(400, 'En CSV elige un conjunto: eventos o personas (un archivo por tabla).');
  const cuentas = (await env.DB.prepare('SELECT id, nombre, perfil, alcance, activo, encuestado_id FROM supervisores WHERE campana_id=?').bind(camp.id).all()).results;
  const salida = { ok: true, generado: ahora(), campana_id: camp.id };
  if (conjunto !== 'personas') salida.eventos = await conjuntoEventos(env, camp, q, cuentas);
  if (conjunto !== 'eventos') salida.personas = { filas: await conjuntoPersonas(env, camp, bloques, cuentas) };
  if (formato === 'json') return new Response(JSON.stringify(salida), { status: 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, h || {}) });
  const eventos = conjunto === 'eventos', conj = salida[conjunto];
  const cab = { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="embudo-${conjunto}-${salida.generado.slice(0, 10)}.csv"` };
  if (eventos && conj.siguiente) cab['x-siguiente'] = conj.siguiente;   // cursor para pedir la página siguiente (parámetro «despues»)
  return new Response(aCsv(eventos ? COL_EVENTOS : COL_PERSONAS, conj.filas), { status: 200, headers: Object.assign(cab, h || {}, { 'Access-Control-Expose-Headers': 'x-siguiente, content-disposition' }) });
}
