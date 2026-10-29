// Sincronización matriz ↔ encuesta (HU03). procesos.matriz es la única fuente de las respuestas por campo:
// la encuesta la lee y la escribe por el mapa punto → campo, y cada cambio deja su fila en matriz_historial.
// Lo que depende de index.js llega por parámetros, para no importar el archivo principal.
import { HttpError, ahora, uid, txt, log } from './comun.js';

// Punto del checklist → campo de la matriz (1 a 1). Los puntos que no figuran (riesgos, inicio_fin, manual_sistema)
// quedan solo con checklist: su contenido ya se resume dentro de objetivo o alcance.
export const PUNTO_CAMPO = {
  objetivo: 'objetivo', actividades: 'alcance', aprobaciones: 'aprobadores', carga: 'carga',
  sistemas: 'tecnologia', terceros: 'terceros',
  datos_personales: 'detalle_dp', finalidad_dp: 'finalidad_dp', documentacion: 'documentacion',
  estandar_tdp: 'estandar_tdp', estandar_global: 'estandar_tmc', normativa: 'normativa', kpis: 'kpis'
};
export const ORIGENES = ['ia', 'precarga', 'documento', 'encuesta', 'consola', 'importacion'];

export const ACTOR_IA = { rol: 'ia', id: '', nombre: 'IA' };
export const ACTOR_CONSOLA = { rol: 'admin', id: '', nombre: 'Equipo consultor' };
export const actorEncuestado = e => ({ rol: 'encuestado', id: e.id, nombre: e.nombre || '' });

// Sentencias que registran, campo por campo, lo que cambió entre `antes` y `despues` (objetos de la matriz).
export function sentenciasHistorial(env, p, antes, despues, actor, origen, tipo) {
  const t = ahora();
  return Object.keys(despues).filter(k => (tipo && tipo !== 'cambio') || String(antes[k] || '') !== String(despues[k] || '')).map(k =>
    env.DB.prepare(`INSERT INTO matriz_historial (id, campana_id, proceso_id, campo, tipo, anterior, nuevo, origen, actor_rol, actor_id, actor_nombre, creado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(uid(), p.campana_id, p.id, k, tipo || 'cambio', String(antes[k] || ''), String(despues[k] || ''), origen, actor.rol, actor.id || '', actor.nombre || '', t));
}

// Claves de la matriz que tocó un cambio: las del objeto nuevo más las que se borraron.
export const clavesCambiadas = (antes, despues) => [...new Set([...Object.keys(antes), ...Object.keys(despues)])];
export function conBorrados(antes, despues) {
  const out = Object.assign({}, despues);
  Object.keys(antes).forEach(k => { if (!(k in out)) out[k] = ''; });
  return out;
}

// Último evento de cada campo de un proceso (cambio o validación): da el origen que se muestra y si quedó validado.
export async function ultimosEventos(env, filtro) {
  const donde = filtro.proceso_id ? 'proceso_id=?' : 'campana_id=?';
  const r = await env.DB.prepare(`SELECT proceso_id, campo, tipo, origen, actor_nombre, creado FROM matriz_historial WHERE ${donde} ORDER BY creado, rowid`)
    .bind(filtro.proceso_id || filtro.campana_id).all();
  const out = {};
  r.results.forEach(x => {
    const campos = (out[x.proceso_id] = out[x.proceso_id] || {}), previo = campos[x.campo];
    // origen_valor: de dónde viene el texto vigente (una validación o su revocación no cambian de dónde viene).
    campos[x.campo] = Object.assign({}, x, { origen_valor: x.tipo === 'cambio' ? x.origen : (previo ? previo.origen_valor : 'inventario') });
  });
  return out;
}

// ¿Puede una fuente automática (IA, precarga del equipo) escribir este campo? Solo si está vacío o es una descripción automática
// (matriz_ia lo marca), y nunca en una fila validada. Lo que escribió una persona de la consola o un archivo importado no se pisa.
// Que una persona haya validado la descripción no la congela: con información nueva se actualiza y la validación vuelve a pedirse.
export function puedeAutomatico(p, m, ia, k) {
  if (p.validacion === 'validado') return false;
  return !String(m[k] || '').trim() || !!ia[k];
}

// Lo que la encuesta muestra de un proceso: por punto, el texto vigente de la matriz y de dónde viene.
// validado = alguien confirmó que sigue vigente (o MBC validó toda la fila: mbc); desactualizado = hay respuestas que aún no se reflejan.
export function valoresDeProceso(p, m, eventos, estado) {
  const out = {}, mbc = p.validacion === 'validado', desactualizado = !!(estado && estado.desactualizado);
  Object.keys(PUNTO_CAMPO).forEach(punto => {
    const campo = PUNTO_CAMPO[punto], texto = String(m[campo] || '').trim();
    if (!texto) return;
    const ev = (eventos || {})[campo];
    out[punto] = {
      texto, campo,
      origen: ev ? ev.origen_valor : 'inventario',
      validado: mbc || (!!ev && ev.tipo === 'validacion'),
      mbc, desactualizado,
      actualizado: ev ? ev.creado : (p.actualizado_en || '')
    };
  });
  return out;
}

// Puntos que alguna persona confirmó vigentes, con la forma de la precarga ({proceso_id, punto}) para que cuenten como cubiertos.
export async function puntosValidados(env, campId) {
  const eventos = await ultimosEventos(env, { campana_id: campId }), out = [];
  Object.keys(eventos).forEach(pid => Object.keys(PUNTO_CAMPO).forEach(punto => {
    const ev = eventos[pid][PUNTO_CAMPO[punto]];
    if (ev && ev.tipo === 'validacion') out.push({ proceso_id: pid, punto });
  }));
  return out;
}

// La persona confirma que la descripción de un punto sigue vigente. Las descripciones son un resumen automático: no se editan
// desde la encuesta; cuando la persona cuenta algo nuevo, la IA las actualiza y la validación vuelve a pedirse.
export async function validarCampoDeEncuesta(env, e, p, punto) {
  const campo = PUNTO_CAMPO[punto];
  if (!campo) throw new HttpError(400, 'Este punto no tiene un campo para validar');
  const valor = String(JSON.parse(p.matriz || '{}')[campo] || '');
  if (!valor) throw new HttpError(400, 'Este punto todavía no tiene una descripción');
  await env.DB.batch(sentenciasHistorial(env, p, { [campo]: valor }, { [campo]: valor }, actorEncuestado(e), 'encuesta', 'validacion'));
  log('campo', { campana: p.campana_id, proceso: p.id, punto, validado: true });
  return { campo, texto: valor, validado: true };
}

// GET /a/campana/historial?id=&proceso_id=&campo=&origen=&actor=&desde=&hasta=&limite=&pagina=
export async function rutaHistorialMatriz(env, url) {
  const q = k => txt(url.searchParams.get(k), 80);
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(q('id')).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const w = ['h.campana_id=?'], a = [camp.id];
  if (q('proceso_id')) { w.push('h.proceso_id=?'); a.push(q('proceso_id')); }
  if (q('campo')) { w.push('h.campo=?'); a.push(q('campo')); }
  if (ORIGENES.includes(q('origen'))) { w.push('h.origen=?'); a.push(q('origen')); }
  if (q('actor')) { w.push('h.actor_nombre LIKE ?'); a.push('%' + q('actor') + '%'); }
  if (q('desde')) { w.push('h.creado>=?'); a.push(q('desde')); }
  if (q('hasta')) { w.push('h.creado<=?'); a.push(q('hasta') + (q('hasta').length === 10 ? 'T23:59:59.999Z' : '')); }
  const limite = Math.min(500, Math.max(1, Number(q('limite')) || 100)), pagina = Math.max(0, Number(q('pagina')) || 0);
  const r = await env.DB.prepare(`SELECT h.id, h.proceso_id, h.campo, h.tipo, h.anterior, h.nuevo, h.origen, h.actor_rol, h.actor_id, h.actor_nombre, h.creado,
      p.codigo, p.macroproceso, p.proceso, p.subproceso
    FROM matriz_historial h LEFT JOIN procesos p ON p.id=h.proceso_id WHERE ${w.join(' AND ')}
    ORDER BY h.creado DESC, h.rowid DESC LIMIT ? OFFSET ?`).bind(...a, limite + 1, pagina * limite).all();
  return { ok: true, cambios: r.results.slice(0, limite), hay_mas: r.results.length > limite };
}
