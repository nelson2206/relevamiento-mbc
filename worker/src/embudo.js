// Embudo de puntos de contacto: registro de eventos con fecha (gerente -> equipo -> avance), reconstrucción de lo ya ocurrido
// y extracción de datos. No hay pantalla: la vista se arma fuera con lo que devuelve exportarEmbudo.
// Definiciones y campos: docs/EMBUDO-definiciones.md y docs/EMBUDO-diccionario.md.
//
// Criterio de no invasión (obligatorio): el registro es asíncrono (ctx.waitUntil), nunca rompe la acción principal, solo guarda
// hitos (compartió, abrió, creó acceso, primera respuesta), nunca contenido de respuestas, y no usa cookies, huella del navegador,
// IP ni user-agent. El único identificador del navegador es un UUID aleatorio que ya viaja en las llamadas existentes.
import { HttpError, ahora, uid, txt, normal, mismaArea, log } from './comun.js';
import { cubreSeccion, alcanceDe, claveArea } from './ambito.js';
import { cargarBase, avanceAreas, estadoArea, tieneContenido, guardarFoto, diaLima, LIMA } from './embudo-areas.js';

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
  aprobacion_final: { paso: 7, idem: false, paquete: 3 },
  encuesta_terminada: { paso: 7, idem: true, paquete: 3 }   // la persona marcó «Terminé» (declarativo); guarda la fecha que hoy no existe
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

// La persona marcó «Terminé» (solo la primera vez: clave única; si la consola revierte el estado y vuelve a enviar, conserva la primera fecha).
export const eventoEncuestaTerminada = e =>
  ({ campana_id: e.campana_id, tipo: 'encuesta_terminada', actor_tipo: 'persona', actor_id: e.id, persona_id: e.id, ...deArea(e), clave: 'encuesta_terminada|' + e.id });

// Pasos 1 y 2 del gerente. La clave se genera cuando MBC (o el administrador del cliente) da el perfil o la renueva; se marca como enviada cuando el
// administrador de MBC prepara el correo (.eml); el panel /c cuenta como entrada solo el ingreso con la clave (no las recargas).
// sup: {id, perfil, encuestado_id} · area: {id, gerencia, seccion} de la persona (opcional) · quien: 'admin' | 'cliente'
const deCuenta = (campId, tipo, sup, area, extra) => ({ campana_id: campId, tipo, persona_id: (area && area.id) || sup.encuestado_id || '', ...deArea(area || {}),
  detalle: { supervisor_id: sup.id, perfil: sup.perfil || '', ...(extra && extra.detalle) }, ...(extra && extra.campos) });
export const eventoGerenteGenerado = (campId, sup, area, motivo, quien) =>
  deCuenta(campId, 'acceso_gerente_generado', sup, area, { campos: { actor_tipo: quien === 'cliente' ? 'cliente' : 'admin' }, detalle: { motivo } });
export const eventoGerenteEnviado = (campId, sup, area, canal) =>
  deCuenta(campId, 'acceso_gerente_enviado', sup, area, { campos: { actor_tipo: 'admin', canal: canal || 'outlook' } });
// gerente_entro en cada ingreso (se repite) y gerente_abrio la primera vez (una sola, con clave: coincide con la del backfill).
export const eventosGerenteIngreso = (campId, actor) => {
  const sup = actor.sup, a = actorDe(actor);
  return [{ ...deCuenta(campId, 'gerente_abrio', sup, null, { campos: { ...a, actor_id: sup.id } }), clave: 'gabrio|' + sup.id },
    deCuenta(campId, 'gerente_entro', sup, null, { campos: { ...a, actor_id: sup.id } })];
};

// POST /a/embudo/marcar-enviado {campana_id, encuestado_ids[]}: el administrador de MBC avisa que preparó el correo (.eml) de acceso de un Gerente o
// Supervisor. Es una acción del consultor (no de los usuarios): el envío sale por Outlook, fuera de la herramienta, y no hay píxel de rastreo.
export async function rutaMarcarEnviado(env, b, ctx) {
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(txt(b && b.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const ids = [...new Set((Array.isArray(b.encuestado_ids) ? b.encuestado_ids : []).map(x => txt(x, 60)).filter(Boolean))].slice(0, 300);
  const lista = [];
  for (let i = 0; i < ids.length; i += 30) {
    const tanda = ids.slice(i, i + 30);
    const r = (await env.DB.prepare(`SELECT s.id, s.perfil, s.encuestado_id, e.gerencia, e.seccion FROM supervisores s JOIN encuestados e ON e.id=s.encuestado_id
      WHERE s.campana_id=? AND s.activo=1 AND s.perfil IN ('supervisor','gerente') AND s.encuestado_id IN (${tanda.map(() => '?').join(',')})`).bind(camp.id, ...tanda).all()).results;
    r.forEach(x => lista.push(eventoGerenteEnviado(camp.id, x, { id: x.encuestado_id, gerencia: x.gerencia, seccion: x.seccion }, 'outlook')));
  }
  if (lista.length) registrarEventos(env, ctx, lista);
  return { ok: true, marcados: lista.length };
}

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
      FROM aprobaciones a LEFT JOIN supervisores s ON s.id=a.supervisor_id WHERE a.campana_id=?`, [c]],
    // B12: encuestas ya marcadas como terminadas. No se guardó la fecha del envío: se toma la última actualización de la persona (cota superior).
    ['encuesta_terminada', `${INS} SELECT ${ID}, e.campana_id, 'encuesta_terminada', 'persona', e.id, e.id, e.gerencia, e.seccion, '', '', '', 1, 'encuesta_terminada|' || e.id,
        ${J}, 'aprox', 'cota'), COALESCE(NULLIF(e.actualizado,''), e.creado)
      FROM encuestados e WHERE e.campana_id=? AND e.estado='enviado' AND COALESCE(NULLIF(e.actualizado,''), e.creado) IS NOT NULL`, [c]]
  ];
}

// Crea eventos aproximados desde los datos actuales. Todos quedan con reconstruido=1 y se pueden repetir sin duplicar.
// Devuelve las filas insertadas por tipo. Los datos medidos (reconstruido=0) nunca se tocan.
export async function backfillEmbudo(env, campId, bloques) {
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(txt(campId, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const lista = sentenciasBackfill(camp.id);
  const res = await env.DB.batch(lista.map(([, sql, params]) => env.DB.prepare(sql).bind(...params)));
  const insertados = {};
  lista.forEach(([tipo], i) => { insertados[tipo] = (insertados[tipo] || 0) + Number((((res || [])[i] || {}).meta || {}).changes || 0); });
  // Foto inicial del avance (reconstruido=1): arranca la serie de «Evolución». La foto medida de las 23:00 de ese día la reemplaza; repetirla no duplica.
  let foto = 0;
  if (bloques) foto = await guardarFoto(env, camp.id, diaLima(), avanceAreas(await cargarBase(env, camp, bloques)), true);
  log('embudo_backfill', { campana: camp.id, total: Object.values(insertados).reduce((a, b) => a + b, 0), foto });
  return { ok: true, campana_id: camp.id, insertados, foto_inicial: foto, reconstruido: 1,
    nota: 'Los eventos reconstruidos son aproximados y llevan reconstruido=1. Repetir esta llamada no duplica filas.' };
}

// ---------------------------------------------------------------- extracción
const PASOS = ['sin contacto', '', '', 'compartido', 'abrió', 'creó acceso', 'empezó', 'completó'];
const COL_EVENTOS = ['evento_id', 'fecha_utc', 'fecha_lima', 'tipo', 'actor_tipo', 'actor_nombre', 'perfil', 'gerencia', 'seccion', 'persona_id', 'persona_nombre', 'gerente_nombre',
  'proceso_id', 'proceso_codigo', 'canal', 'visitante_corto', 'reconstruido', 'detalle'];
const COL_PERSONAS = ['campana_id', 'persona_id', 'persona_nombre', 'gerencia', 'seccion', 'cargo', 'perfil', 'gerente_nombre', 'origen', 'f_agregado', 'f_acceso_generado', 'f_acceso_enviado',
  'f_gerente_abrio', 'f_delegado', 'f_compartido', 'f_abrio', 'f_abrio_origen', 'f_acceso_creado', 'f_acceso_creado_origen', 'f_primera_respuesta', 'f_primer_proceso_completo',
  'f_ultima_actividad', 'n_aperturas', 'n_ingresos', 'ultimo_paso', 'ultimo_paso_nombre', 'dias_sin_actividad', 'procesos_asignados', 'procesos_con_respuesta', 'procesos_completos',
  'procesos_validados', 'pct_procesos_completos', 'pct_puntos', 'bloqueada', 'f_primera_respuesta_origen', 'f_encuesta_terminada', 'f_encuesta_terminada_origen'];

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

// base: lo que devuelve cargarBase (se comparte con las áreas y la foto diaria para leer cada tabla una sola vez).
async function conjuntoPersonas(env, camp, bloques, cuentas, base) {
  base = base || await cargarBase(env, camp, bloques);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(camp.id, ...a).all().then(r => r.results);
  const { enc, procs, revs, resp, asig, cobertura } = base;
  const [evs, vis, aperturas] = await Promise.all([
    q("SELECT persona_id, tipo, MIN(creado) AS primero, MAX(creado) AS ultimo, COUNT(*) AS n, MIN(CASE WHEN reconstruido=0 THEN creado END) AS primero_medido FROM eventos WHERE campana_id=? AND persona_id<>'' GROUP BY persona_id, tipo"),
    q("SELECT persona_id, visitante FROM eventos WHERE campana_id=? AND persona_id<>'' AND visitante<>'' GROUP BY persona_id, visitante"),
    q("SELECT visitante, gerencia, seccion, MIN(creado) AS primero, COUNT(*) AS n FROM eventos WHERE campana_id=? AND tipo='enlace_abierto' AND visitante<>'' GROUP BY visitante, gerencia, seccion")
  ]);
  const porPersona = {};
  evs.forEach(x => { (porPersona[x.persona_id] = porPersona[x.persona_id] || {})[x.tipo] = x; });
  const visitantesDe = {}, personasDe = {};
  vis.forEach(x => { (visitantesDe[x.persona_id] = visitantesDe[x.persona_id] || []).push(x.visitante); (personasDe[x.visitante] = personasDe[x.visitante] || new Set()).add(x.persona_id); });
  const cuentaDe = {}; cuentas.forEach(c => { if (c.encuestado_id) cuentaDe[c.encuestado_id] = c; });
  // Mapas por persona y claves de área precalculadas: con ~300 personas y ~300 procesos evita recorrer las listas completas por cada persona.
  const procesosVigentes = procs.filter(p => !p.fuera_alcance);
  const claveProc = new Map(procesosVigentes.map(p => [p.id, normal(p.gerencia) + '|' + normal(p.seccion)]));
  const porEnc = (lista) => { const m = new Map(); lista.forEach(x => { if (!m.has(x.encuestado_id)) m.set(x.encuestado_id, []); m.get(x.encuestado_id).push(x); }); return m; };
  const asigDe = porEnc(asig), respPor = porEnc(resp), revPor = porEnc(revs);
  const ahoraIso = ahora();

  return enc.map(e => {
    const ev = porPersona[e.id] || {}, f = t => (ev[t] || {}).primero || '';
    const origenDe = t => (ev[t] ? (ev[t].primero_medido ? 'medido' : 'reconstruido') : '');
    // Procesos que ve la persona (misma lista que la encuesta): su sección sin los que MBC le quitó, los que agregó y los que eligió o le asignaron.
    const misAsig = asigDe.get(e.id) || [], claveE = normal(e.gerencia) + '|' + normal(e.seccion);
    const excl = new Set(misAsig.filter(a => a.origen === 'excluido').map(a => a.proceso_id));
    const elegidos = new Set(misAsig.filter(a => a.origen !== 'excluido').map(a => a.proceso_id));
    const suyos = procesosVigentes.filter(p => {
      const enSeccion = claveProc.get(p.id) === claveE && !(p.fuente === 'nuevo' && p.creado_por === e.id);
      return (enSeccion && !excl.has(p.id)) || p.creado_por === e.id || elegidos.has(p.id);
    });
    let completos = 0, validadosN = 0, conResp = 0, listos = 0, total = 0, primerCompleto = '';
    const respDe = respPor.get(e.id) || [];
    suyos.forEach(p => {
      const a = cobertura.persona(p.id, e.id);
      listos += a.listos; total += a.total;
      if (a.completo) { completos++; if (p.validacion === 'validado') validadosN++; }
      if (respDe.some(r => r.proceso_id === p.id && tieneContenido(r))) conResp++;
    });
    if (ev.proceso_completo) primerCompleto = ev.proceso_completo.primero;

    // Funnel de trazabilidad: los procesos de la persona son los que confirmó o eligió más los que creó ella (N). Iniciado = 1 pregunta con contenido,
    // avanzado = 2 o más, terminado = completo según cobertura.js (lo ya completo cuenta también como iniciado y avanzado).
    const esNuevo = p => p.fuente === 'nuevo' && p.creado_por === e.id;
    const revDe = new Set((revPor.get(e.id) || []).map(r => r.proceso_id));
    const mios = suyos.filter(p => esNuevo(p) || revDe.has(p.id) || elegidos.has(p.id));
    let nIni = 0, nAv = 0, nTer = 0;
    mios.forEach(p => {
      const preguntas = new Set(respDe.filter(r => r.proceso_id === p.id && tieneContenido(r)).map(r => r.pregunta)).size;
      const listo = cobertura.persona(p.id, e.id).completo;
      if (listo) nTer++;
      if (preguntas >= 1 || listo) nIni++;
      if (preguntas >= 2 || listo) nAv++;
    });

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
      pct_procesos_completos: pct(completos, suyos.length), pct_puntos: pct(listos, total), bloqueada: e.bloqueada ? 1 : 0,
      // Solo para el funnel (no salen en el CSV):
      estado: e.estado, registrada: (e.con_pin || f('acceso_creado')) ? 1 : 0, f_encuesta_terminada: f('encuesta_terminada'),
      f_contacto: contacto3, f_primera_respuesta_origen: origenDe('primera_respuesta'), f_encuesta_terminada_origen: origenDe('encuesta_terminada'),
      n_confirmados: mios.length - mios.filter(esNuevo).length, n_nuevos: mios.filter(esNuevo).length, n_procesos: mios.length,
      n_iniciados: nIni, n_avanzados: nAv, n_terminados: nTer
    };
  });
}

// ---------------------------------------------------------------- tablas por gerencia, sección y gerente
export const DIAS_INACTIVA = 7;
export const ETAPAS_FUNNEL = ['Registro de usuario', 'Con procesos seleccionados', 'Proceso iniciado', 'Proceso avanzado', 'Procesos terminados', 'Encuesta terminada'];
const dia = iso => (iso ? fechaLima(iso).slice(0, 10) : '');
const fh = iso => (iso ? fechaLima(iso).slice(0, 16) : '');   // AAAA-MM-DD HH:MM en hora de Lima
const diasDesde = iso => (iso ? Math.max(0, Math.floor((Date.parse(ahora()) - Date.parse(iso)) / 86400000)) : '');
const porcentaje = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const pct1 = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const pctOVacio = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : '');   // base 0: sin porcentaje (no es 0 %, no aplica)
const entre = (desde, hasta) => (desde && hasta ? (Date.parse(hasta) - Date.parse(desde)) / 86400000 : null);
// Mediana en días con un decimal; los pares sin ambas fechas o con la segunda antes que la primera (cotas del backfill) no cuentan.
export function mediana(lista) {
  const v = lista.filter(x => typeof x === 'number' && !isNaN(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return '';
  const m = v.length >> 1, r = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  return Math.round(r * 10) / 10;
}
const PERFIL_GER = { gerente: 'Gerente', supervisor: 'Supervisor' };

// Etapas que alcanzó una persona. Las etapas 1 a 5 son acumulativas (alcanzar una exige haber alcanzado las anteriores); la 6 (declarativa) solo exige estar registrada.
function etapasDe(r) {
  const reg = !!r.registrada;
  const sel = reg && r.n_procesos > 0, ini = sel && r.n_iniciados > 0, av = ini && r.n_avanzados > 0, ter = av && r.n_terminados === r.n_procesos;
  return [reg, sel, ini, av, ter, reg && r.estado === 'enviado'];
}

// Cuentas con perfil Gerente o Supervisor: fechas de cada paso (1 y 2), con cuántas personas compartieron (3) y su avance oficial. Todo sale de los eventos.
async function tablaGerentes(env, camp, cuentas, base, areas) {
  const q = sql => env.DB.prepare(sql).bind(camp.id).all().then(r => r.results);
  const [fases, compartidos] = await Promise.all([
    q(`SELECT tipo, CASE WHEN json_valid(detalle) THEN COALESCE(NULLIF(json_extract(detalle,'$.supervisor_id'),''), actor_id) ELSE actor_id END AS sid,
        MIN(creado) AS primero, MAX(creado) AS ultimo, COUNT(*) AS n, MIN(CASE WHEN reconstruido=0 THEN creado END) AS primero_medido, MAX(canal) AS canal
      FROM eventos WHERE campana_id=? AND tipo IN ('acceso_gerente_generado','acceso_gerente_enviado','gerente_abrio','gerente_entro') GROUP BY tipo, sid`),
    q(`SELECT actor_id AS sid, tipo, COUNT(*) AS n, COUNT(DISTINCT NULLIF(persona_id,'')) AS personas, MIN(creado) AS primero
      FROM eventos WHERE campana_id=? AND tipo IN ('enlace_compartido','persona_agregada','procesos_delegados') AND actor_id<>'' AND actor_tipo IN ('gerente','supervisor') GROUP BY actor_id, tipo`)
  ]);
  const fase = new Map(fases.map(f => [f.tipo + '|' + f.sid, f])), comp = new Map(compartidos.map(f => [f.tipo + '|' + f.sid, f]));
  const encPor = new Map(base.enc.map(e => [e.id, e]));
  const vigentes = base.procs.filter(p => !p.fuera_alcance);
  return cuentas.filter(c => PERFIL_GER[c.perfil]).map(c => {
    const F = t => fase.get(t + '|' + c.id) || {}, C = t => comp.get(t + '|' + c.id) || {};
    const origen = x => (x.primero ? (x.primero_medido ? 'medido' : 'reconstruido') : '');
    const gen = F('acceso_gerente_generado'), enviado = F('acceso_gerente_enviado'), abrio = F('gerente_abrio'), entro = F('gerente_entro');
    const al = alcanceDe(c), gs = new Set(al.gerencias.map(normal)), ss = new Set(al.secciones.map(x => claveArea(x.g, x.s))), ids = new Set(al.procesos);
    const ssGer = new Set(al.secciones.map(x => normal(x.g)));
    // Avance oficial de su alcance: procesos respondidos / procesos vigentes (sin los «ya no se hace»), con la regla de cobertura.js.
    let den = 0, resp = 0;
    vigentes.forEach(p => {
      if (!(al.todo || ids.has(p.id) || gs.has(normal(p.gerencia)) || ss.has(claveArea(p.gerencia, p.seccion)))) return;
      const est = areas.estados.get(p.id);
      if (est === 'no_vigente') return;
      den++; if (est === 'respondido') resp++;
    });
    const yo = c.encuestado_id ? encPor.get(c.encuestado_id) : null;
    const canon = yo ? areas.canon(yo.gerencia, yo.seccion) : null;
    const fGen = gen.primero || c.creado || '', fAbrio = abrio.primero || '';
    const fRecibe = enviado.primero || fGen;
    const compartio = ['enlace_compartido', 'persona_agregada', 'procesos_delegados'].map(C);
    const fComp = compartio.map(x => x.primero).filter(Boolean).sort()[0] || '';
    const fUlt = [entro.ultimo || '', c.ultimo || '', abrio.primero || ''].sort().pop() || '';
    return {
      cuenta: c, gs, ss, ssGer, todo: al.todo, compartio: compartio.some(x => x.n > 0), d_recibe_abre: entre(fRecibe, fAbrio), d_abre_comparte: entre(fAbrio, fComp),
      campana_id: camp.id, supervisor_id: c.id, persona_id: c.encuestado_id || '', gerente_nombre: c.nombre, perfil: PERFIL_GER[c.perfil], activo: c.activo ? 'SÍ' : 'NO',
      gerencia: canon ? canon.gerencia : (al.todo ? 'Todas' : al.gerencias[0] || ''),
      alcance: al.todo ? 'Acceso total' : [...al.gerencias, ...al.secciones.map(x => x.s)].join(' · ').slice(0, 150),
      procesos_vigentes: den, procesos_respondidos: resp, avance_pct: pctOVacio(resp, den),
      f_acceso_generado: fGen, f_acceso_generado_origen: gen.primero ? origen(gen) : (fGen ? 'reconstruido' : ''), f_acceso_enviado: enviado.primero || '', f_acceso_enviado_origen: origen(enviado),
      canal_envio: enviado.canal || '', f_primera_entrada: fAbrio, f_primera_entrada_origen: origen(abrio), f_ultima_entrada: fUlt,
      n_entradas: entro.n || (c.ultimo ? 1 : 0), dias_sin_entrar: fUlt ? diasDesde(fUlt) : '',
      personas_compartidas: C('enlace_compartido').personas || 0, personas_agregadas: C('persona_agregada').personas || 0, personas_delegadas: C('procesos_delegados').personas || 0,
      f_primer_compartir: fComp
    };
  });
}

// Grupo de personas (de una sección o de una gerencia): etapas del funnel de Matías y los pasos 4 a 6 del embudo.
const grupoNuevo = () => ({ etapas: [0, 0, 0, 0, 0, 0], inactivos: 0, procesos: 0, terminados: 0, ultima: '', personas: 0, alcanzadas: 0, abrieron: 0, acceso: 0, empezaron: 0, d34: [], d45: [], d56: [] });
function sumarPersona(g, r, inactiva) {
  etapasDe(r).forEach((v, i) => { if (v) g.etapas[i]++; });
  if (inactiva) g.inactivos++;
  g.procesos += r.n_procesos; g.terminados += r.n_terminados; g.ultima = maxFecha(g.ultima, r.f_ultima_actividad);
  g.personas++;
  if (r.f_contacto) g.alcanzadas++;
  if (r.f_abrio) g.abrieron++;
  if (r.registrada) g.acceso++;
  if (r.f_primera_respuesta) g.empezaron++;
  g.d34.push(entre(r.f_contacto, r.f_abrio)); g.d45.push(entre(r.f_abrio, r.f_acceso_creado)); g.d56.push(entre(r.f_acceso_creado, r.f_primera_respuesta));
}
function mezclar(lista) {
  const t = grupoNuevo();
  lista.forEach(g => {
    g.etapas.forEach((n, i) => { t.etapas[i] += n; });
    ['inactivos', 'procesos', 'terminados', 'personas', 'alcanzadas', 'abrieron', 'acceso', 'empezaron'].forEach(k => { t[k] += g[k]; });
    t.ultima = maxFecha(t.ultima, g.ultima); t.d34.push(...g.d34); t.d45.push(...g.d45); t.d56.push(...g.d56);
  });
  return t;
}

// Una fila de gerencia o de sección con el avance oficial, el funnel de personas de Matías y los 7 puntos de contacto.
// Bases de los %: puntos 1 a 3 sobre los gerentes con acceso; 4 a 6 sobre las personas cargadas; 7 sobre los procesos vigentes.
function filaArea(area, g, cuentasArea) {
  const e = g.etapas, base = e[0], den = area.vigentes - area.no_vigentes;
  const ger = cuentasArea.length, n = fn => cuentasArea.filter(fn).length;
  const gen = n(x => x.f_acceso_generado), env = n(x => x.f_acceso_enviado), abrio = n(x => x.f_primera_entrada), comp = n(x => x.compartio);
  const ultima = maxFecha(g.ultima, ...cuentasArea.map(x => x.f_ultima_entrada));
  const oficial = pct1(area.respondidos, den), asumido = porcentaje(g.terminados, g.procesos);
  return {
    gerencia: area.gerencia, seccion: area.seccion || '',
    procesos_alcance: area.vigentes, procesos_no_vigentes: area.no_vigentes, procesos_vigentes: den, procesos_respondidos: area.respondidos, procesos_en_curso: area.en_curso,
    procesos_sin_cobertura: area.sin_cobertura, procesos_validados: area.validados,
    avance_pct: oficial, avance_asumido_pct: asumido,
    estado: estadoArea({ ...area, personas_registradas: base }),
    personas: g.personas, personas_registradas: base,
    gerentes_nombres: cuentasArea.map(x => x.gerente_nombre).join('; ').slice(0, 300),
    // Funnel de personas (Matías): cantidades y %, todo sobre los registrados.
    registrados: e[0], con_procesos: e[1], pct_con_procesos: porcentaje(e[1], base), iniciados: e[2], pct_iniciados: porcentaje(e[2], base),
    avanzados: e[3], pct_avanzados: porcentaje(e[3], base), terminados: e[4], pct_terminados: porcentaje(e[4], base), encuesta_terminada: e[5], pct_encuesta_terminada: porcentaje(e[5], base),
    inactivos: g.inactivos, pct_inactivos: porcentaje(g.inactivos, base),
    // Los 7 puntos de contacto.
    gerentes: ger, p1_acceso_generado: gen, p1_acceso_enviado: env, p2_gerente_abrio: abrio, p3_gerente_compartio: comp, p3_personas_alcanzadas: g.alcanzadas,
    p4_personas_abrieron: g.abrieron, p5_personas_con_acceso: g.acceso, p6_personas_empezaron: g.empezaron, p7_procesos_respondidos: area.respondidos,
    pct_p1_acceso_generado: pctOVacio(gen, ger), pct_p1_acceso_enviado: pctOVacio(env, ger), pct_p2_gerente_abrio: pctOVacio(abrio, ger), pct_p3_gerente_compartio: pctOVacio(comp, ger),
    pct_p3_personas_alcanzadas: pctOVacio(g.alcanzadas, g.personas), pct_p4_personas_abrieron: pctOVacio(g.abrieron, g.personas), pct_p5_personas_con_acceso: pctOVacio(g.acceso, g.personas),
    pct_p6_personas_empezaron: pctOVacio(g.empezaron, g.personas), pct_p7_avance_oficial: den ? oficial : '',
    mediana_dias_p1_p2: mediana(cuentasArea.map(x => x.d_recibe_abre)), mediana_dias_p2_p3: mediana(cuentasArea.map(x => x.d_abre_comparte)),
    mediana_dias_p3_p4: mediana(g.d34), mediana_dias_p4_p5: mediana(g.d45), mediana_dias_p5_p6: mediana(g.d56),
    ultima_actividad: dia(ultima), dias_sin_actividad: diasDesde(ultima)
  };
}

// Todo lo que sale de la campaña, calculado una sola vez: personas, áreas y gerentes.
async function construirTablas(env, camp, bloques) {
  const cuentas = (await env.DB.prepare('SELECT id, nombre, perfil, alcance, activo, encuestado_id, creado, ultimo FROM supervisores WHERE campana_id=?').bind(camp.id).all()).results;
  const base = await cargarBase(env, camp, bloques);
  const areas = avanceAreas(base);
  const personas = await conjuntoPersonas(env, camp, bloques, cuentas, base);
  const gerentes = await tablaGerentes(env, camp, cuentas, base, areas);
  const activos = gerentes.filter(x => x.cuenta.activo);
  const inactiva = r => r.estado !== 'enviado' && Number(diasDesde(r.f_ultima_actividad || r.f_agregado)) >= DIAS_INACTIVA;

  // Cada persona se ubica en el nombre canónico de su gerencia y sección (comparación tolerante), no en el texto con que se cargó.
  const porSec = new Map(), porGer = new Map();
  personas.forEach(r => {
    const c = areas.canon(r.gerencia, r.seccion), ks = normal(c.gerencia) + '|' + normal(c.seccion), kg = normal(c.gerencia);
    r.gerencia = c.gerencia; r.seccion = c.seccion;
    const i = inactiva(r);
    if (!porSec.has(ks)) porSec.set(ks, grupoNuevo());
    if (!porGer.has(kg)) porGer.set(kg, grupoNuevo());
    sumarPersona(porSec.get(ks), r, i); sumarPersona(porGer.get(kg), r, i);
    r.inactivo = i;
  });
  const cubreSec = (x, g, s) => x.todo || x.gs.has(normal(g)) || x.ss.has(claveArea(g, s));
  const cubreGer = (x, g) => x.todo || x.gs.has(normal(g)) || x.ssGer.has(normal(g));
  const vacio = grupoNuevo();
  const gerencias = areas.gerencias.map(a => filaArea(a, porGer.get(normal(a.gerencia)) || vacio, activos.filter(x => cubreGer(x, a.gerencia))));
  const secciones = areas.secciones.map(a => filaArea(a, porSec.get(normal(a.gerencia) + '|' + normal(a.seccion)) || vacio, activos.filter(x => cubreSec(x, a.gerencia, a.seccion))));
  const suma = areas.gerencias.reduce((t, a) => { Object.keys(a).forEach(k => { if (typeof a[k] === 'number') t[k] = (t[k] || 0) + a[k]; }); return t; }, { gerencia: 'Total', seccion: '' });
  const total = filaArea(suma, mezclar([...porGer.values()]), activos);
  return { cuentas, base, areas, personas, gerentes, gerencias, secciones, total };
}

// Serie diaria guardada por el cron (y la foto inicial del backfill). El avance oficial se calcula igual que en vivo.
async function conjuntoAvanceDiario(env, camp, q) {
  const donde = ['campana_id=?'], args = [camp.id];
  if (q && q.desde) { donde.push('dia>=?'); args.push(String(q.desde)); }
  if (q && q.hasta) { donde.push('dia<=?'); args.push(String(q.hasta)); }
  const r = (await env.DB.prepare(`SELECT * FROM avance_diario WHERE ${donde.join(' AND ')} ORDER BY dia, gerencia, seccion LIMIT 20000`).bind(...args).all()).results;
  return r.map(x => {
    const den = x.procesos_vigentes - x.procesos_no_vigentes;
    return { campana_id: x.campana_id, dia: x.dia, gerencia: x.gerencia, seccion: x.seccion, nivel: x.seccion ? 'seccion' : 'gerencia', procesos_alcance: x.procesos_vigentes,
      procesos_no_vigentes: x.procesos_no_vigentes, procesos_vigentes: den, procesos_sin_cobertura: x.procesos_sin_cobertura, procesos_en_curso: x.procesos_en_curso,
      procesos_respondidos: x.procesos_respondidos, procesos_validados: x.procesos_validados, avance_pct: pct1(x.procesos_respondidos, den),
      puntos_cubiertos: x.puntos_cubiertos, puntos_total: x.puntos_total, personas: x.personas, personas_con_acceso: x.personas_con_acceso,
      personas_con_respuesta: x.personas_con_respuesta, foto: x.reconstruido ? 'inicial (reconstruida)' : 'medida', generado: x.generado };
  });
}

const gerentesFilas = t => t.gerentes.map(x => { const { cuenta, gs, ss, ssGer, todo, compartio, d_recibe_abre, d_abre_comparte, ...fila } = x; return fila; });
const personasFilas = t => t.personas.map(r => { const { inactivo, ...fila } = r; return fila; });

export const COL_GERENCIAS = ['gerencia', 'seccion', 'procesos_alcance', 'procesos_no_vigentes', 'procesos_vigentes', 'procesos_respondidos', 'procesos_en_curso', 'procesos_sin_cobertura', 'procesos_validados',
  'avance_pct', 'avance_asumido_pct', 'estado', 'personas', 'personas_registradas', 'gerentes', 'gerentes_nombres',
  'p1_acceso_generado', 'p1_acceso_enviado', 'p2_gerente_abrio', 'p3_gerente_compartio', 'p3_personas_alcanzadas', 'p4_personas_abrieron', 'p5_personas_con_acceso', 'p6_personas_empezaron', 'p7_procesos_respondidos',
  'pct_p1_acceso_generado', 'pct_p1_acceso_enviado', 'pct_p2_gerente_abrio', 'pct_p3_gerente_compartio', 'pct_p3_personas_alcanzadas', 'pct_p4_personas_abrieron', 'pct_p5_personas_con_acceso', 'pct_p6_personas_empezaron', 'pct_p7_avance_oficial',
  'mediana_dias_p1_p2', 'mediana_dias_p2_p3', 'mediana_dias_p3_p4', 'mediana_dias_p4_p5', 'mediana_dias_p5_p6',
  'registrados', 'con_procesos', 'iniciados', 'avanzados', 'terminados', 'encuesta_terminada', 'inactivos', 'ultima_actividad', 'dias_sin_actividad'];
export const COL_GERENTES = ['campana_id', 'supervisor_id', 'persona_id', 'gerente_nombre', 'perfil', 'activo', 'gerencia', 'alcance', 'procesos_vigentes', 'procesos_respondidos', 'avance_pct',
  'f_acceso_generado', 'f_acceso_generado_origen', 'f_acceso_enviado', 'f_acceso_enviado_origen', 'canal_envio', 'f_primera_entrada', 'f_primera_entrada_origen', 'f_ultima_entrada', 'n_entradas', 'dias_sin_entrar',
  'personas_compartidas', 'personas_agregadas', 'personas_delegadas', 'f_primer_compartir'];
export const COL_AVANCE = ['campana_id', 'dia', 'gerencia', 'seccion', 'nivel', 'procesos_alcance', 'procesos_no_vigentes', 'procesos_vigentes', 'procesos_sin_cobertura', 'procesos_en_curso', 'procesos_respondidos',
  'procesos_validados', 'avance_pct', 'puntos_cubiertos', 'puntos_total', 'personas', 'personas_con_acceso', 'personas_con_respuesta', 'foto', 'generado'];

// GET /a/embudo/export?campana_id=&conjunto=eventos|personas|gerentes|gerencias|secciones|avance_diario|todos&formato=json|csv&desde=&hasta=&limite=&despues=
// Solo lectura. Nunca devuelve textos de respuestas, PIN, claves, tokens ni correos; el nombre de la persona sí.
const CONJUNTOS = ['eventos', 'personas', 'gerentes', 'gerencias', 'secciones', 'avance_diario'];
export async function exportarEmbudo(env, url, bloques, h) {
  const q = Object.fromEntries(url.searchParams.entries());
  const camp = await env.DB.prepare('SELECT id, nombre FROM campanas WHERE id=?').bind(txt(q.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const conjunto = q.conjunto || 'todos', formato = q.formato || 'json';
  if (conjunto !== 'todos' && !CONJUNTOS.includes(conjunto)) throw new HttpError(400, 'conjunto debe ser ' + CONJUNTOS.join(', ') + ' o todos');
  if (!['json', 'csv'].includes(formato)) throw new HttpError(400, 'formato debe ser json o csv');
  if (formato === 'csv' && conjunto === 'todos') throw new HttpError(400, 'En CSV elige un conjunto (' + CONJUNTOS.join(', ') + '): un archivo por tabla.');
  const quiere = c => conjunto === 'todos' || conjunto === c;
  const salida = { ok: true, generado: ahora(), campana_id: camp.id };
  if (quiere('eventos')) {
    const cuentas = (await env.DB.prepare('SELECT id, nombre, perfil, alcance, activo, encuestado_id FROM supervisores WHERE campana_id=?').bind(camp.id).all()).results;
    salida.eventos = await conjuntoEventos(env, camp, q, cuentas);
  }
  if (['personas', 'gerentes', 'gerencias', 'secciones'].some(quiere)) {
    const t = await construirTablas(env, camp, bloques);
    if (quiere('personas')) salida.personas = { filas: personasFilas(t) };
    if (quiere('gerentes')) salida.gerentes = { filas: gerentesFilas(t) };
    if (quiere('gerencias')) salida.gerencias = { filas: t.gerencias };
    if (quiere('secciones')) salida.secciones = { filas: t.secciones };
  }
  if (quiere('avance_diario')) salida.avance_diario = { filas: await conjuntoAvanceDiario(env, camp, q) };
  if (formato === 'json') return new Response(JSON.stringify(salida), { status: 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, h || {}) });
  const columnas = { eventos: COL_EVENTOS, personas: COL_PERSONAS, gerentes: COL_GERENTES, gerencias: COL_GERENCIAS, secciones: COL_GERENCIAS, avance_diario: COL_AVANCE }[conjunto];
  const conj = salida[conjunto];
  const cab = { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="embudo-${conjunto}-${salida.generado.slice(0, 10)}.csv"` };
  if (conjunto === 'eventos' && conj.siguiente) cab['x-siguiente'] = conj.siguiente;   // cursor para pedir la página siguiente (parámetro «despues»)
  return new Response(aCsv(columnas, conj.filas), { status: 200, headers: Object.assign(cab, h || {}, { 'Access-Control-Expose-Headers': 'x-siguiente, content-disposition' }) });
}

// ---------------------------------------------------------------- funnel de trazabilidad (botón de Matriz y validación y su Excel)
// Tablas simples, sin gráficos. Reglas en docs/EMBUDO-trazabilidad-total.md y docs/EMBUDO-funnel-trazabilidad.md. Todo sale de los datos ya medidos; no guarda nada.
export async function calcularFunnel(env, camp, bloques) {
  const t = await construirTablas(env, camp, bloques);
  const resumen = t.gerencias.map(g => ({ gerencia: g.gerencia, procesos_vigentes: g.procesos_vigentes, procesos_respondidos: g.procesos_respondidos, avance_pct: g.avance_pct, avance_asumido_pct: g.avance_asumido_pct,
    procesos_validados: g.procesos_validados, estado: g.estado, personas_registradas: g.personas_registradas, gerentes_nombres: g.gerentes_nombres, ultima_actividad: g.ultima_actividad, dias_sin_actividad: g.dias_sin_actividad }));
  const usuarios = t.personas.map(r => ({ gerencia: r.gerencia, seccion: r.seccion, usuario: r.persona_nombre, creado: dia(r.f_agregado), ultima_actividad: dia(r.f_ultima_actividad),
    confirmados: r.n_confirmados, nuevos: r.n_nuevos, total: r.n_procesos, iniciados: r.n_iniciados, avanzados: r.n_avanzados, terminados: r.n_terminados,
    pct_iniciados: porcentaje(r.n_iniciados, r.n_procesos), pct_avanzados: porcentaje(r.n_avanzados, r.n_procesos), pct_terminados: porcentaje(r.n_terminados, r.n_procesos),
    encuesta_terminada: r.estado === 'enviado' ? 'SÍ' : 'NO', inactivo: r.inactivo ? 'SÍ' : 'NO',
    f_abrio: fh(r.f_abrio), f_acceso_creado: fh(r.f_acceso_creado), f_primera_respuesta: fh(r.f_primera_respuesta), f_encuesta_terminada: fh(r.f_encuesta_terminada),
    origen_abrio: r.f_abrio_origen, origen_acceso_creado: r.f_acceso_creado_origen, origen_primera_respuesta: r.f_primera_respuesta_origen, origen_encuesta_terminada: r.f_encuesta_terminada_origen }))
    .sort((a, b) => a.gerencia.localeCompare(b.gerencia, 'es') || a.seccion.localeCompare(b.seccion, 'es') || a.usuario.localeCompare(b.usuario, 'es'));
  const gerentes = gerentesFilas(t).map(x => ({ ...x, f_acceso_generado: fh(x.f_acceso_generado), f_acceso_enviado: fh(x.f_acceso_enviado), f_primera_entrada: fh(x.f_primera_entrada),
    f_ultima_entrada: fh(x.f_ultima_entrada), f_primer_compartir: fh(x.f_primer_compartir) }))
    .sort((a, b) => a.gerencia.localeCompare(b.gerencia, 'es') || a.gerente_nombre.localeCompare(b.gerente_nombre, 'es'));
  const evolucion = await conjuntoAvanceDiario(env, camp, {});
  return { ok: true, generado: ahora(), campana: { id: camp.id, nombre: camp.nombre }, dias_inactiva: DIAS_INACTIVA, etapas: ETAPAS_FUNNEL, resumen,
    gerencias: t.gerencias.concat([t.total]), secciones: t.secciones, gerentes, usuarios, evolucion };
}
