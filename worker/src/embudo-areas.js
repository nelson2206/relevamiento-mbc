// Avance por gerencia y sección para la trazabilidad total del llenado: el universo sale de los procesos vigentes y de la estructura de la campaña
// (no de las personas), de modo que una gerencia sin personas aparece con 0 y «Sin iniciar». El avance oficial usa la MISMA regla que la consola y el
// panel del cliente: estado 'respondido' de crearCobertura (cobertura.js); los 'no_vigente' no cuentan en el denominador (como resumenCliente en admin.html).
// También guarda la foto diaria (tabla avance_diario) que corre el cron. Reglas: docs/EMBUDO-trazabilidad-total.md.
import { ahora, normal, log } from './comun.js';
import { crearCobertura } from './cobertura.js';
import { puntosValidados } from './matriz-sync.js';
import { leerEstructura } from './estructura.js';

export const LIMA = 5 * 3600 * 1000;   // Lima es UTC-5 todo el año
export const diaLima = (d = new Date()) => new Date(d.getTime() - LIMA).toISOString().slice(0, 10);
export const horaLima = (d = new Date()) => new Date(d.getTime() - LIMA).getUTCHours();
export const HORA_FOTO = 23;   // el cron toma la foto del día desde las 23:00 de Lima

// «Con respuesta»: texto, sistemas marcados, respuesta estructurada con datos o un punto marcado/confirmado por la persona (misma idea que primera_respuesta).
export const tieneContenido = r => !!(r.texto || (r.sistemas && r.sistemas !== '[]') || /"confidencial":"(si|no)"/.test(r.datos || '') || /"estado":"cubierto"|"_vigentes"/.test(r.checklist || ''));

// Todo lo que se lee de la campaña, una sola vez, para el funnel, el Excel y la foto diaria. Nunca trae el texto de las respuestas (solo si lo hay).
export async function cargarBase(env, camp, bloques) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(camp.id, ...a).all().then(r => r.results);
  const [enc, procs, revs, resp, pre, asig, estructura, validados] = await Promise.all([
    q('SELECT id, nombre, rol, gerencia, seccion, estado, actualizado, origen, creado, pin_hash<>\'\' AS con_pin, pin_bloqueo<>\'\' AS bloqueada, ultimo_acceso FROM encuestados WHERE campana_id=? ORDER BY gerencia, seccion, nombre'),
    q('SELECT id, gerencia, seccion, fuente, fuera_alcance, creado_por, validacion FROM procesos WHERE campana_id=?'),
    q('SELECT r.encuestado_id, r.proceso_id, r.estado FROM revisiones r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    q("SELECT r.encuestado_id, r.proceso_id, r.pregunta, CASE WHEN length(trim(r.texto))>0 THEN 'x' ELSE '' END AS texto, r.sistemas, r.checklist, r.datos, r.actualizado FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?"),
    q('SELECT pc.proceso_id, pc.punto FROM precarga pc JOIN procesos p ON p.id=pc.proceso_id WHERE p.campana_id=?'),
    q('SELECT a.encuestado_id, a.proceso_id, a.origen FROM asignaciones a JOIN encuestados e ON e.id=a.encuestado_id WHERE e.campana_id=?'),
    leerEstructura(env, camp.id),
    puntosValidados(env, camp.id)
  ]);
  const cobertura = crearCobertura({ bloques, revisiones: revs, respuestas: resp, precarga: pre.concat(validados) });
  return { enc, procs, revs, resp, pre, asig, estructura, cobertura };
}

const pct1 = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function estadoArea(a) {
  const den = a.vigentes - a.no_vigentes;
  if (den > 0 && a.validados === den) return 'Validada';
  if (den > 0 && a.respondidos === den) return 'Lista para validar';
  if (!a.personas_registradas && !a.en_curso && !a.respondidos) return 'Sin iniciar';
  return 'En levantamiento';
}

// Universo: la estructura de la campaña, los procesos vigentes (fuera_alcance=0) y, solo para no perder a nadie, las áreas de las personas ya cargadas.
// Los nombres se unifican con la comparación tolerante (sin tildes, mayúsculas ni espacios repetidos) y toman la primera escritura vista.
// Devuelve las secciones (una por gerencia+sección) y las gerencias (suma de sus secciones), con el mapa `canon` para ubicar cualquier par de nombres.
export function avanceAreas(base) {
  const gers = new Map(), secs = new Map();   // clave normalizada -> fila
  const nueva = (g, s) => ({ gerencia: g, seccion: s, vigentes: 0, no_vigentes: 0, sin_cobertura: 0, en_curso: 0, respondidos: 0, validados: 0, puntos_cubiertos: 0, puntos_total: 0,
    personas: 0, personas_registradas: 0, personas_con_respuesta: 0 });
  const canon = (g, s) => {
    const kg = normal(g), ks = normal(s);
    if (!gers.has(kg)) gers.set(kg, { nombre: String(g == null ? '' : g).trim(), secciones: new Map() });
    const ge = gers.get(kg);
    if (!ge.secciones.has(ks)) { const f = nueva(ge.nombre, String(s == null ? '' : s).trim()); ge.secciones.set(ks, f); secs.set(kg + '|' + ks, f); }
    return ge.secciones.get(ks);
  };
  (base.estructura || []).forEach(f => canon(f.gerencia, f.seccion));
  const vigentes = base.procs.filter(p => !p.fuera_alcance);
  vigentes.forEach(p => canon(p.gerencia, p.seccion));
  base.enc.forEach(e => canon(e.gerencia, e.seccion));

  const estados = new Map();   // proceso -> estado de cobertura.js (para quien necesite el avance de un alcance propio)
  vigentes.forEach(p => {
    const a = canon(p.gerencia, p.seccion), cb = base.cobertura(p.id);
    estados.set(p.id, cb.estado);
    a.vigentes++;
    if (cb.estado === 'no_vigente') { a.no_vigentes++; return; }
    if (cb.estado === 'respondido') a.respondidos++; else if (cb.estado === 'en_curso') a.en_curso++; else a.sin_cobertura++;
    if (p.validacion === 'validado') a.validados++;
    a.puntos_cubiertos += cb.puntos; a.puntos_total += cb.total;
  });
  const conResp = new Set();
  base.resp.forEach(r => { if (tieneContenido(r)) conResp.add(r.encuestado_id); });
  base.enc.forEach(e => {
    const a = canon(e.gerencia, e.seccion);
    a.personas++; if (e.con_pin) a.personas_registradas++; if (conResp.has(e.id)) a.personas_con_respuesta++;
  });

  const sumar = (t, a) => { Object.keys(a).forEach(k => { if (typeof a[k] === 'number') t[k] += a[k]; }); return t; };
  const secciones = [], gerencias = [];
  // Un área que solo figura en la estructura (sin procesos vigentes ni personas) es un resto del organigrama: no se informa.
  const conContenido = a => a.vigentes > 0 || a.personas > 0;
  [...gers.values()].sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')).forEach(ge => {
    const lista = [...ge.secciones.values()].filter(conContenido).sort((x, y) => x.seccion.localeCompare(y.seccion, 'es'));
    if (!lista.length) return;
    const g = lista.reduce(sumar, nueva(ge.nombre, ''));
    g.secciones = lista.filter(s => s.seccion).length;
    gerencias.push(g);
    lista.forEach(s => { if (s.seccion) secciones.push(s); });
  });
  gerencias.forEach(g => { g.estado = estadoArea(g); g.avance_pct = pct1(g.respondidos, g.vigentes - g.no_vigentes); });
  secciones.forEach(s => { s.estado = estadoArea(s); s.avance_pct = pct1(s.respondidos, s.vigentes - s.no_vigentes); });
  return { gerencias, secciones, estados, canon: (g, s) => { const a = canon(g, s); return { gerencia: a.gerencia, seccion: a.seccion }; } };
}

// ---------------------------------------------------------------- foto diaria (tabla avance_diario)
const COLS_FOTO = ['campana_id', 'dia', 'gerencia', 'seccion', 'procesos_vigentes', 'procesos_sin_cobertura', 'procesos_en_curso', 'procesos_respondidos', 'procesos_no_vigentes',
  'procesos_validados', 'puntos_cubiertos', 'puntos_total', 'personas', 'personas_con_acceso', 'personas_con_respuesta', 'reconstruido', 'generado'];

// Una fila por sección y una por gerencia (seccion = '': total de la gerencia, no se suma con sus secciones).
export function filasFoto(campId, dia, areas, reconstruido) {
  const t = ahora();
  const fila = a => [campId, dia, a.gerencia, a.seccion, a.vigentes, a.sin_cobertura, a.en_curso, a.respondidos, a.no_vigentes, a.validados, a.puntos_cubiertos, a.puntos_total,
    a.personas, a.personas_registradas, a.personas_con_respuesta, reconstruido ? 1 : 0, t];
  return areas.gerencias.map(fila).concat(areas.secciones.map(fila));
}

// Escribe la foto de un día. La foto medida (reconstruido=0) reemplaza a la inicial (reconstruido=1) del mismo día; la inicial nunca pisa a la medida.
// Repetirla es seguro: la clave primaria (campaña, día, gerencia, sección) evita duplicados.
export async function guardarFoto(env, campId, dia, areas, reconstruido) {
  const filas = filasFoto(campId, dia, areas, reconstruido);
  const marcas = COLS_FOTO.map(() => '?').join(',');
  const sql = reconstruido
    ? `INSERT OR IGNORE INTO avance_diario (${COLS_FOTO.join(', ')}) VALUES (${marcas})`
    : `INSERT INTO avance_diario (${COLS_FOTO.join(', ')}) VALUES (${marcas}) ON CONFLICT(campana_id, dia, gerencia, seccion) DO UPDATE SET ` +
      COLS_FOTO.slice(4).map(c => `${c}=excluded.${c}`).join(', ') + ' WHERE avance_diario.reconstruido=1';
  const st = filas.map(f => env.DB.prepare(sql).bind(...f));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return filas.length;
}

// Cron (cada 15 min): desde las 23:00 de Lima toma, una sola vez al día, la foto de cada campaña activa. Antes de esa hora no lee nada.
export async function fotoDiaria(env, bloques, opciones = {}) {
  const ahoraD = opciones.ahora || new Date();
  if (!opciones.forzar && horaLima(ahoraD) < HORA_FOTO) return { omitida: 'antes de las 23:00 de Lima', campanas: 0 };
  const dia = diaLima(ahoraD), reciente = new Date(ahoraD.getTime() - 7 * 86400000).toISOString();
  const camps = (await env.DB.prepare(`SELECT c.id, c.nombre FROM campanas c WHERE (c.abierta=1 OR c.cliente_activo=1
      OR EXISTS (SELECT 1 FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=c.id AND r.actualizado>?))
      AND NOT EXISTS (SELECT 1 FROM avance_diario d WHERE d.campana_id=c.id AND d.dia=? AND d.reconstruido=0)`).bind(reciente, dia).all()).results;
  let filas = 0;
  for (const camp of camps) {
    try {
      const areas = avanceAreas(await cargarBase(env, camp, bloques));
      filas += await guardarFoto(env, camp.id, dia, areas, false);
    } catch (err) { log('foto_diaria_error', { campana: camp.id, error: String((err && err.message) || err).slice(0, 200) }); }
  }
  log('foto_diaria', { dia, campanas: camps.length, filas });
  return { dia, campanas: camps.length, filas };
}
