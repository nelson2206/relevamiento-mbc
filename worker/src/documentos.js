// Documentos cargados en bloque (HU01) y su clasificación en procesos con ayuda de la IA (HU02).
// El archivo va a R2 (binding DOCS); en D1 queda su ficha, las sugerencias de la IA y el historial de asociaciones documento-proceso.
// Lo que depende de index.js (validar el archivo subido y llamar a la IA) llega por `deps`, para no importar el archivo principal.
import { HttpError, ahora, uid, txt, normal, log } from './comun.js';
import { registrarAccion } from './ambito.js';
import { leerEstructura } from './estructura.js';
import { ACTOR_CONSOLA } from './matriz-sync.js';
import { complementar, alertaDe, MAX_TEXTO } from './complemento.js';

export const TIPOS_DOCUMENTO = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png'
};
export const UMBRAL_POR_DEFECTO = 0.7;
const MAX_SUGERENCIAS = 5;
const ESTADOS = ['pendiente', 'clasificado'];
const ESTADOS_IA = ['sin_analizar', 'analizando', 'analizado', 'error'];
const ACTOR = { rol: 'admin', sup: null, nombre: ACTOR_CONSOLA.nombre };   // el mismo nombre que usa la matriz: una sola persona en todas las bitácoras

const unidad = n => { n = Number(n); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
export const bajaConfianza = (confianza, umbral) => confianza != null && Number(confianza) < Number(umbral);

// Qué cambia entre lo vigente y lo que el administrador deja finalmente: agregados, quitados y confirmados de lo que sugirió la IA.
export function diferencias(vigentes, finales) {
  const fin = new Set(finales), vig = new Map(vigentes.map(v => [v.proceso_id, v]));
  return {
    agregados: finales.filter(id => !vig.has(id)),
    quitados: vigentes.filter(v => !fin.has(v.proceso_id)).map(v => v.proceso_id),
    confirmados: vigentes.filter(v => fin.has(v.proceso_id) && !v.confirmado).map(v => v.proceso_id)
  };
}

async function campanaDe(env, id) {
  const c = await env.DB.prepare('SELECT id, umbral_confianza FROM campanas WHERE id=?').bind(txt(id, 60)).first();
  if (!c) throw new HttpError(404, 'Campaña no encontrada');
  return c;
}
async function documentoDe(env, id) {
  const d = await env.DB.prepare('SELECT * FROM documentos WHERE id=?').bind(txt(id, 60)).first();
  if (!d) throw new HttpError(404, 'Documento no encontrado');
  return d;
}
// La gerencia es obligatoria; si la campaña ya tiene gerencias (por su estructura o sus procesos), debe ser una de ellas.
async function gerenciaValida(env, campId, gerencia) {
  const g = txt(gerencia, 120);
  if (!g) throw new HttpError(400, 'Selecciona una gerencia antes de cargar');
  const conocidas = new Map();
  (await leerEstructura(env, campId)).forEach(f => conocidas.set(normal(f.gerencia), f.gerencia));
  (await env.DB.prepare('SELECT DISTINCT gerencia FROM procesos WHERE campana_id=?').bind(campId).all()).results.forEach(f => { if (!conocidas.has(normal(f.gerencia))) conocidas.set(normal(f.gerencia), f.gerencia); });
  if (!conocidas.size) return g;
  const oficial = conocidas.get(normal(g));
  if (!oficial) throw new HttpError(400, 'Esa gerencia no existe en la campaña');
  return oficial;
}
// La sección es opcional («toda la gerencia»); si se indica, debe existir dentro de esa gerencia (por la estructura o por sus procesos).
async function seccionValida(env, campId, gerencia, seccion) {
  const s = txt(seccion, 120);
  if (!s) return '';
  const g = normal(gerencia), conocidas = new Map();
  (await leerEstructura(env, campId)).forEach(f => { if (f.seccion && normal(f.gerencia) === g) conocidas.set(normal(f.seccion), f.seccion); });
  (await env.DB.prepare('SELECT DISTINCT gerencia, seccion FROM procesos WHERE campana_id=?').bind(campId).all()).results.forEach(f => {
    if (f.seccion && normal(f.gerencia) === g && !conocidas.has(normal(f.seccion))) conocidas.set(normal(f.seccion), f.seccion);
  });
  const oficial = conocidas.get(normal(s));
  if (!oficial) throw new HttpError(400, 'Esa sección no existe en la gerencia');
  return oficial;
}
async function huella(buf) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
}
function exigirR2(env) {
  if (!env.DOCS) throw new HttpError(503, 'El almacenamiento de documentos no está configurado en el Worker (R2, binding DOCS)');
}
const claveR2 = (campId, id, tipo) => `${campId}/${id}.${tipo}`;

const nombreProceso = p => p.subproceso || p.proceso || p.macroproceso || p.id;

// POST /a/documentos?campana_id=&gerencia=&seccion=&nombre=   cuerpo: UN archivo (el navegador manda cada archivo de la carga por separado).
// Con la IA configurada, el documento se analiza apenas se guarda (en segundo plano), dentro de la sección indicada.
export async function rutaDocumentoSubir(env, req, url, deps, ctx) {
  exigirR2(env);
  const camp = await campanaDe(env, url.searchParams.get('campana_id'));
  const gerencia = await gerenciaValida(env, camp.id, url.searchParams.get('gerencia'));
  const seccion = await seccionValida(env, camp.id, gerencia, url.searchParams.get('seccion'));
  const nombre = txt(url.searchParams.get('nombre'), 150) || 'documento';
  const a = await deps.leerArchivo(req, Object.keys(TIPOS_DOCUMENTO), 'Formato no permitido: sube un archivo JPG, PNG, PDF o Word (.docx).');
  const hash = await huella(a.buf);
  const repetido = await env.DB.prepare('SELECT nombre FROM documentos WHERE campana_id=? AND hash=?').bind(camp.id, hash).first();
  if (repetido) throw new HttpError(409, `Ya se cargó antes como «${repetido.nombre}»`);
  const auto = !!(ctx && deps.analizarIA && deps.iaLista && deps.iaLista(env));
  const id = uid(), tipo = TIPOS_DOCUMENTO[a.tipo], t = ahora();
  await env.DOCS.put(claveR2(camp.id, id, tipo), a.buf, { httpMetadata: { contentType: a.tipo } });
  await env.DB.prepare(`INSERT INTO documentos (id, campana_id, nombre, tipo, gerencia, seccion, hash, clave_r2, tamano, estado, estado_ia, cargado_por, creado, actualizado)
    VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?,?,?,?)`).bind(id, camp.id, nombre, tipo, gerencia, seccion, hash, claveR2(camp.id, id, tipo), a.buf.byteLength, auto ? 'analizando' : 'sin_analizar', ACTOR.nombre, t, t).run();
  await registrarAccion(env, camp.id, ACTOR, 'documento_carga', { documento: id, nombre, tipo, gerencia, seccion, estado_resultante: 'pendiente' });
  log('documento_carga', { campana: camp.id, tipo, bytes: a.buf.byteLength, analisis_auto: auto });
  if (auto) ctx.waitUntil(analizarYGuardar(env, ctx, await documentoDe(env, id), camp, deps).catch(() => { /* ya quedó en estado «error» y auditado */ }));
  return { ok: true, documento: await fichaDe(env, id, camp.umbral_confianza) };
}

async function fichaDe(env, id, umbral) {
  const d = await documentoDe(env, id);
  return (await conProcesos(env, [d], umbral))[0];
}
async function conProcesos(env, docs, umbral) {
  if (!docs.length) return [];
  const ids = docs.map(d => d.id), marcas = ids.map(() => '?').join(',');
  const [filas, ext, bor] = await Promise.all([
    env.DB.prepare(`SELECT dp.documento_id, dp.proceso_id, dp.origen, dp.confianza, dp.confirmado, p.gerencia, p.seccion, p.macroproceso, p.proceso, p.subproceso
      FROM documento_procesos dp JOIN procesos p ON p.id=dp.proceso_id WHERE dp.vigente=1 AND dp.documento_id IN (${marcas}) ORDER BY dp.confianza DESC`).bind(...ids).all(),
    env.DB.prepare(`SELECT documento_id, proceso_id, estado, mensaje, puntos, descartados, motivo, actualizado FROM documento_extracciones WHERE documento_id IN (${marcas})`).bind(...ids).all(),
    env.DB.prepare(`SELECT documento_id, proceso_id, COUNT(*) AS n FROM precarga_borrador WHERE estado='borrador' AND documento_id IN (${marcas}) GROUP BY documento_id, proceso_id`).bind(...ids).all()
  ]);
  const extDe = {}, borDe = {};
  ext.results.forEach(x => { extDe[x.documento_id + '|' + x.proceso_id] = x; });
  bor.results.forEach(x => { borDe[x.documento_id + '|' + x.proceso_id] = x.n; });
  const por = {};
  filas.results.forEach(f => {
    const k = f.documento_id + '|' + f.proceso_id, e = extDe[k];
    (por[f.documento_id] = por[f.documento_id] || []).push({
      proceso_id: f.proceso_id, nombre: nombreProceso(f), gerencia: f.gerencia, origen: f.origen, confianza: f.confianza,
      confirmado: !!f.confirmado, baja: f.origen === 'ia' && bajaConfianza(f.confianza, umbral),
      // Qué pasó con la extracción de la precarga de este par (solo existe una vez confirmado el proceso).
      extraccion: e ? { estado: e.estado, mensaje: e.mensaje, puntos: e.puntos, descartados: e.descartados, motivo: e.motivo, borradores: borDe[k] || 0 } : null
    });
  });
  return docs.map(d => ({ ...d, procesos: por[d.id] || [], baja_confianza: bajaConfianza(d.confianza_min, umbral) && d.estado === 'pendiente' }));
}

// GET /a/documentos?campana_id=&gerencia=&estado=&estado_ia=&desde=&hasta=&q=&confianza=baja|sin&orden=confianza
export async function rutaDocumentos(env, url) {
  const camp = await campanaDe(env, url.searchParams.get('campana_id'));
  const umbral = unidad(camp.umbral_confianza) ?? UMBRAL_POR_DEFECTO;
  const p = n => txt(url.searchParams.get(n), 120);
  const donde = ['campana_id=?'], args = [camp.id];
  if (p('gerencia')) { donde.push('gerencia=?'); args.push(p('gerencia')); }
  if (p('seccion')) { donde.push('seccion=?'); args.push(p('seccion')); }
  if (ESTADOS.includes(p('estado'))) { donde.push('estado=?'); args.push(p('estado')); }
  if (ESTADOS_IA.includes(p('estado_ia'))) { donde.push('estado_ia=?'); args.push(p('estado_ia')); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(p('desde'))) { donde.push('substr(creado,1,10)>=?'); args.push(p('desde')); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(p('hasta'))) { donde.push('substr(creado,1,10)<=?'); args.push(p('hasta')); }
  if (p('q')) { donde.push("nombre LIKE ? ESCAPE '\\'"); args.push('%' + p('q').replace(/[\\%_]/g, '\\$&') + '%'); }
  if (p('confianza') === 'baja') { donde.push('confianza_min IS NOT NULL AND confianza_min<?'); args.push(umbral); }
  if (p('confianza') === 'sin') donde.push('confianza_min IS NULL');
  const orden = p('orden') === 'confianza' ? 'confianza_min IS NULL, confianza_min ASC, creado DESC' : 'creado DESC';
  const docs = (await env.DB.prepare(`SELECT * FROM documentos WHERE ${donde.join(' AND ')} ORDER BY ${orden} LIMIT 500`).bind(...args).all()).results;
  const resumen = (await env.DB.prepare('SELECT estado, COUNT(*) n FROM documentos WHERE campana_id=? GROUP BY estado').bind(camp.id).all()).results;
  const gerencias = (await env.DB.prepare('SELECT DISTINCT gerencia FROM documentos WHERE campana_id=? ORDER BY gerencia').bind(camp.id).all()).results.map(x => x.gerencia);
  return { ok: true, umbral, documentos: await conProcesos(env, docs, umbral), resumen: Object.fromEntries(resumen.map(r => [r.estado, r.n])), gerencias };
}

// GET /a/documentos/archivo?id=  devuelve el archivo para abrirlo antes de clasificar.
export async function rutaDocumentoArchivo(env, url, h) {
  exigirR2(env);
  const d = await documentoDe(env, url.searchParams.get('id'));
  const o = await env.DOCS.get(d.clave_r2);
  if (!o) throw new HttpError(404, 'El archivo ya no está almacenado');
  const mime = Object.keys(TIPOS_DOCUMENTO).find(k => TIPOS_DOCUMENTO[k] === d.tipo) || 'application/octet-stream';
  return new Response(o.body, { headers: Object.assign({ 'content-type': mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }, h || {}) });
}

// POST /a/documentos/gerencia  {id, gerencia, seccion?}   Cambia dónde está el documento. Sin `seccion`, se conserva si la gerencia no cambia.
export async function rutaDocumentoGerencia(env, b) {
  const d = await documentoDe(env, b.id);
  const gerencia = await gerenciaValida(env, d.campana_id, b.gerencia);
  const seccion = await seccionValida(env, d.campana_id, gerencia, b.seccion !== undefined ? b.seccion : (normal(gerencia) === normal(d.gerencia) ? d.seccion : ''));
  await env.DB.prepare('UPDATE documentos SET gerencia=?, seccion=?, actualizado=? WHERE id=?').bind(gerencia, seccion, ahora(), d.id).run();
  await registrarAccion(env, d.campana_id, ACTOR, 'documento_gerencia', { documento: d.id, anterior: d.gerencia, nueva: gerencia, seccion_anterior: d.seccion, seccion_nueva: seccion });
  const camp = await campanaDe(env, d.campana_id);
  return { ok: true, documento: await fichaDe(env, d.id, camp.umbral_confianza) };
}

// POST /a/documentos/analizar  {id}   La IA propone procesos candidatos con confianza; el resultado queda para revisión.
export async function rutaDocumentoAnalizar(env, b, ctx, deps) {
  exigirR2(env);
  const d = await documentoDe(env, b.id);
  const camp = await campanaDe(env, d.campana_id);
  return analizarYGuardar(env, ctx, d, camp, deps);
}

// Procesos entre los que la IA clasifica: los de la sección indicada; si no tiene, los de la gerencia; si tampoco, los de toda la campaña.
// (La IA solo ve hasta 600; acotar por sección es lo que evita que la lista se corte.)
export async function catalogoDe(env, d) {
  const todos = (await env.DB.prepare('SELECT id, gerencia, seccion, macroproceso, proceso, subproceso FROM procesos WHERE campana_id=? AND fuera_alcance=0 ORDER BY gerencia, seccion, orden').bind(d.campana_id).all()).results;
  const g = normal(d.gerencia), s = normal(d.seccion || '');
  const deSeccion = s ? todos.filter(p => normal(p.gerencia) === g && normal(p.seccion) === s) : [];
  if (deSeccion.length) return deSeccion.slice(0, 600);
  const deGerencia = todos.filter(p => normal(p.gerencia) === g);
  return (deGerencia.length ? deGerencia : todos).slice(0, 600);
}

// Lee el archivo, pide las sugerencias a la IA y las guarda. Si algo falla, el documento queda con estado «error» (y se relanza el error).
async function analizarYGuardar(env, ctx, d, camp, deps) {
  const obj = await env.DOCS.get(d.clave_r2);
  if (!obj) {
    await env.DB.prepare("UPDATE documentos SET estado_ia='error', actualizado=? WHERE id=?").bind(ahora(), d.id).run();
    throw new HttpError(404, 'El archivo ya no está almacenado');
  }
  const catalogo = await catalogoDe(env, d);
  if (!catalogo.length) {
    await env.DB.prepare("UPDATE documentos SET estado_ia='error', actualizado=? WHERE id=?").bind(ahora(), d.id).run();
    throw new HttpError(409, 'La campaña no tiene procesos contra los cuales clasificar');
  }
  const mime = Object.keys(TIPOS_DOCUMENTO).find(k => TIPOS_DOCUMENTO[k] === d.tipo);
  let sugeridas;
  try { sugeridas = await deps.analizarIA(env, ctx, { tipo: mime, buf: await obj.arrayBuffer() }, catalogo, d.gerencia, d.seccion || ''); }
  catch (err) {
    await env.DB.prepare("UPDATE documentos SET estado_ia='error', actualizado=? WHERE id=?").bind(ahora(), d.id).run();
    await registrarAccion(env, d.campana_id, ACTOR, 'documento_analisis_error', { documento: d.id, motivo: txt(err && err.message, 200) });
    throw err;
  }
  const validos = new Set(catalogo.map(p => p.id)), vistos = new Set(), t = ahora(), st = [];
  const nuevas = sugeridas.map(s => ({ proceso_id: s && s.proceso_id, confianza: unidad(s && s.confianza) }))
    .filter(s => validos.has(s.proceso_id) && s.confianza != null && !vistos.has(s.proceso_id) && vistos.add(s.proceso_id))
    .sort((x, y) => y.confianza - x.confianza).slice(0, MAX_SUGERENCIAS);
  // Las sugerencias anteriores sin confirmar se conservan como historial (vigente = 0); lo confirmado por el administrador no se toca.
  st.push(env.DB.prepare("UPDATE documento_procesos SET vigente=0 WHERE documento_id=? AND origen='ia' AND confirmado=0 AND vigente=1").bind(d.id));
  const yaConfirmados = new Set((await env.DB.prepare('SELECT proceso_id FROM documento_procesos WHERE documento_id=? AND vigente=1 AND confirmado=1').bind(d.id).all()).results.map(x => x.proceso_id));
  const aGuardar = nuevas.filter(s => !yaConfirmados.has(s.proceso_id));
  aGuardar.forEach(s => st.push(env.DB.prepare("INSERT INTO documento_procesos (id, documento_id, proceso_id, origen, confianza, confirmado, vigente, actor, creado) VALUES (?,?,?,'ia',?,0,1,'ia',?)").bind(uid(), d.id, s.proceso_id, s.confianza, t)));
  const minima = aGuardar.length ? Math.min(...aGuardar.map(s => s.confianza)) : null;
  st.push(env.DB.prepare("UPDATE documentos SET estado_ia='analizado', confianza_min=?, actualizado=? WHERE id=?").bind(minima, t, d.id));
  await env.DB.batch(st);
  await registrarAccion(env, d.campana_id, ACTOR, 'documento_analisis', {
    documento: d.id, estado_anterior: d.estado, estado_resultante: d.estado,
    sugeridos: nuevas.map(s => ({ proceso_id: s.proceso_id, confianza: s.confianza })), umbral: camp.umbral_confianza
  });
  return { ok: true, documento: await fichaDe(env, d.id, camp.umbral_confianza) };
}

// POST /a/documentos/borrar  {id}   Elimina el documento: su archivo, sus asociaciones y los borradores que aún no se aprobaron.
// Lo que ya se aprobó (precarga y matriz) se queda: lo aprobó el administrador.
export async function rutaDocumentoBorrar(env, b) {
  const d = await documentoDe(env, b.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM documento_procesos WHERE documento_id=?').bind(d.id),
    env.DB.prepare('DELETE FROM documento_extracciones WHERE documento_id=?').bind(d.id),
    env.DB.prepare("DELETE FROM precarga_borrador WHERE documento_id=? AND estado<>'aprobado'").bind(d.id),
    env.DB.prepare('DELETE FROM documentos WHERE id=?').bind(d.id)
  ]);
  if (env.DOCS && env.DOCS.delete) await Promise.resolve(env.DOCS.delete(d.clave_r2)).catch(() => {});
  await registrarAccion(env, d.campana_id, ACTOR, 'documento_borrado', { documento: d.id, nombre: d.nombre, gerencia: d.gerencia, seccion: d.seccion, estado: d.estado });
  return { ok: true };
}

// POST /a/documentos/procesos  {id, procesos[proceso_id]}   Deja la lista FINAL de procesos del documento:
// lo que la IA sugirió y sigue en la lista queda confirmado, lo que falta se quita, lo nuevo se agrega a mano. Lista vacía = vuelve a Pendiente.
export async function rutaDocumentoProcesos(env, b, ctx, deps) {
  const d = await documentoDe(env, b.id);
  const camp = await campanaDe(env, d.campana_id);
  const finales = [...new Set((Array.isArray(b.procesos) ? b.procesos : []).map(x => txt(x, 60)).filter(Boolean))].slice(0, 20);
  const validos = new Set((await env.DB.prepare(`SELECT id FROM procesos WHERE campana_id=? AND id IN (${finales.map(() => '?').join(',') || "''"})`).bind(d.campana_id, ...finales).all()).results.map(x => x.id));
  if (finales.some(id => !validos.has(id))) throw new HttpError(400, 'Algún proceso no existe en la campaña');
  const vigentes = (await env.DB.prepare('SELECT proceso_id, origen, confianza, confirmado FROM documento_procesos WHERE documento_id=? AND vigente=1').bind(d.id).all()).results;
  const dif = diferencias(vigentes, finales), t = ahora(), st = [];
  dif.quitados.forEach(id => {
    st.push(env.DB.prepare('UPDATE documento_procesos SET vigente=0 WHERE documento_id=? AND proceso_id=? AND vigente=1').bind(d.id, id));
    // Lo que todavía era borrador de este documento para ese proceso ya no tiene dueño; lo que se aprobó antes queda en la precarga.
    st.push(env.DB.prepare("UPDATE precarga_borrador SET estado='descartado', actualizado=?, resuelto_por=? WHERE documento_id=? AND proceso_id=? AND estado='borrador'").bind(t, ACTOR.nombre, d.id, id));
    st.push(env.DB.prepare('DELETE FROM documento_extracciones WHERE documento_id=? AND proceso_id=?').bind(d.id, id));
  });
  dif.confirmados.forEach(id => st.push(env.DB.prepare('UPDATE documento_procesos SET confirmado=1, actor=? WHERE documento_id=? AND proceso_id=? AND vigente=1').bind(ACTOR.nombre, d.id, id)));
  dif.agregados.forEach(id => st.push(env.DB.prepare("INSERT INTO documento_procesos (id, documento_id, proceso_id, origen, confianza, confirmado, vigente, actor, creado) VALUES (?,?,?,'manual',NULL,1,1,?,?)").bind(uid(), d.id, id, ACTOR.nombre, t)));
  const estado = finales.length ? 'clasificado' : 'pendiente';
  const restantes = vigentes.filter(v => finales.includes(v.proceso_id) && v.confianza != null).map(v => v.confianza);
  st.push(env.DB.prepare('UPDATE documentos SET estado=?, confianza_min=?, actualizado=? WHERE id=?').bind(estado, restantes.length ? Math.min(...restantes) : null, t, d.id));
  // Confirmar un proceso lanza la extracción de la precarga de ese par; el resultado queda como borrador para el administrador.
  const nuevos = [...dif.confirmados, ...dif.agregados];
  const lanzar = deps && deps.extraerPrecarga && ctx ? nuevos.slice(0, MAX_EXTRACCIONES) : [];
  const omitidos = deps && deps.extraerPrecarga && ctx ? nuevos.slice(MAX_EXTRACCIONES) : [];
  lanzar.forEach(id => st.push(marcarExtraccion(env, d.id, id, 'pendiente', '')));
  omitidos.forEach(id => st.push(marcarExtraccion(env, d.id, id, 'error', 'Son muchos procesos a la vez: pulsa «Extraer» para este proceso.')));
  await env.DB.batch(st);
  await registrarAccion(env, d.campana_id, ACTOR, 'documento_clasificacion', {
    documento: d.id, estado_anterior: d.estado, estado_resultante: estado,
    sugeridos_ia: vigentes.filter(v => v.origen === 'ia').map(v => ({ proceso_id: v.proceso_id, confianza: v.confianza })),
    confirmados: finales, modificaciones: dif
  });
  if (lanzar.length) ejecutarExtracciones(env, ctx, d, lanzar, deps);
  return { ok: true, documento: await fichaDe(env, d.id, camp.umbral_confianza) };
}

// ---------------------------------------------------------------- extracción de la precarga desde un documento (borradores)
const MAX_EXTRACCIONES = 8;   // pares (documento, proceso) por confirmación; el resto se extrae a pedido

function marcarExtraccion(env, documentoId, procesoId, estado, mensaje, extra) {
  const x = extra || {};
  return env.DB.prepare(`INSERT INTO documento_extracciones (documento_id, proceso_id, estado, mensaje, puntos, descartados, motivo, actualizado) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(documento_id, proceso_id) DO UPDATE SET estado=excluded.estado, mensaje=excluded.mensaje, puntos=excluded.puntos, descartados=excluded.descartados, motivo=excluded.motivo, actualizado=excluded.actualizado`)
    .bind(documentoId, procesoId, estado, txt(mensaje, 300), x.puntos || 0, x.descartados || 0, txt(x.motivo, 300), ahora());
}

// Lee el archivo de R2, lo manda a la IA y deja el resultado como borrador. Nunca lanza: un fallo queda en el estado del par.
async function extraerPar(env, ctx, d, procesoId, deps) {
  try {
    exigirR2(env);
    const p = await env.DB.prepare('SELECT * FROM procesos WHERE id=?').bind(procesoId).first();
    if (!p) throw new HttpError(404, 'El proceso ya no existe');
    const obj = await env.DOCS.get(d.clave_r2);
    if (!obj) throw new HttpError(404, 'El archivo ya no está almacenado');
    const tipo = Object.keys(TIPOS_DOCUMENTO).find(k => TIPOS_DOCUMENTO[k] === d.tipo);
    const r = await deps.extraerPrecarga(env, ctx, { tipo, buf: await obj.arrayBuffer() }, p);
    const t = ahora(), st = [];
    // Qué pasó antes con cada punto de este par: lo aprobado ya llegó a la precarga y no se vuelve a proponer; lo descartado SÍ se vuelve a proponer
    // (quien pide «Volver a leer» quiere verlo de nuevo); lo que sigue como borrador sin tocar se actualiza; lo corregido a mano no se pisa.
    const previos = new Map((await env.DB.prepare('SELECT punto, estado FROM precarga_borrador WHERE documento_id=? AND proceso_id=?').bind(d.id, procesoId).all()).results.map(x => [x.punto, x.estado]));
    const yaAprobados = r.puntos.filter(x => previos.get(x.id) === 'aprobado').length;
    r.puntos.forEach(x => st.push(env.DB.prepare(`INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado)
      VALUES (?,?,?,?,?,?,?,?, 'borrador', 0, ?, ?)
      ON CONFLICT(documento_id, proceso_id, punto) DO UPDATE SET texto=excluded.texto, cita=excluded.cita, bloque=excluded.bloque, estado='borrador', resuelto_por='', actualizado=excluded.actualizado
      WHERE precarga_borrador.estado IN ('borrador','descartado') AND precarga_borrador.editado=0`).bind(uid(), d.campana_id, procesoId, d.id, x.id, x.bloque || '', x.texto, x.cita, t, t)));
    // Un borrador anterior que esta lectura ya no encuentra queda descartado, para no dejar descripciones sin sustento.
    st.push(env.DB.prepare(`UPDATE precarga_borrador SET estado='descartado', actualizado=? WHERE documento_id=? AND proceso_id=? AND estado='borrador' AND editado=0
      AND punto NOT IN (${r.puntos.map(() => '?').join(',') || "''"})`).bind(t, d.id, procesoId, ...r.puntos.map(x => x.id)));
    const nuevos = r.puntos.length - yaAprobados;
    const motivo = !nuevos && yaAprobados ? 'Todo lo que dice el documento ya estaba aprobado para este proceso' : r.motivo;
    st.push(marcarExtraccion(env, d.id, procesoId, 'ok', '', { puntos: nuevos, descartados: r.descartados, motivo }));
    await env.DB.batch(st);
    await registrarAccion(env, d.campana_id, ACTOR, 'documento_precarga', { documento: d.id, proceso: procesoId, puntos: r.puntos.length, descartados: r.descartados });
  } catch (err) {
    const msg = txt(err && err.message, 250) || 'No se pudo leer el documento';
    log('documento_precarga_error', { campana: d.campana_id, error: msg });
    try {
      await marcarExtraccion(env, d.id, procesoId, 'error', msg).run();
      await registrarAccion(env, d.campana_id, ACTOR, 'documento_precarga_error', { documento: d.id, proceso: procesoId, motivo: msg });
    } catch (x) { /* el estado queda «pendiente»: Reintentar lo corrige */ }
  }
}
// Uno tras otro, para no saturar a la IA ni el límite de la solicitud; la respuesta ya salió.
function ejecutarExtracciones(env, ctx, d, procesos, deps) {
  ctx.waitUntil((async () => { for (const id of procesos) await extraerPar(env, ctx, d, id, deps); })());
}

// POST /a/documentos/extraer  {id, proceso_id}   Extrae (o vuelve a extraer) la precarga de un proceso ya confirmado para el documento.
export async function rutaDocumentoExtraer(env, b, ctx, deps) {
  exigirR2(env);
  const d = await documentoDe(env, b.id), camp = await campanaDe(env, d.campana_id);
  const procesoId = txt(b.proceso_id, 60);
  const par = await env.DB.prepare('SELECT 1 AS ok FROM documento_procesos WHERE documento_id=? AND proceso_id=? AND vigente=1 AND confirmado=1').bind(d.id, procesoId).first();
  if (!par) throw new HttpError(409, 'Confirma primero este proceso para el documento');
  const e = await env.DB.prepare('SELECT estado, actualizado FROM documento_extracciones WHERE documento_id=? AND proceso_id=?').bind(d.id, procesoId).first();
  // Una extracción «pendiente» reciente sigue en curso; si pasaron más de 10 minutos se considera perdida y se puede reintentar.
  if (e && e.estado === 'pendiente' && Date.now() - Date.parse(e.actualizado) < 10 * 60000) throw new HttpError(409, 'Este documento ya se está leyendo para este proceso. Espera un momento.');
  await marcarExtraccion(env, d.id, procesoId, 'pendiente', '').run();
  ejecutarExtracciones(env, ctx, d, [procesoId], deps);
  return { ok: true, documento: await fichaDe(env, d.id, camp.umbral_confianza) };
}

// Borradores y estado de extracción de una campaña, para la consola (solo administrador).
// Cada borrador trae su `alerta` frente a lo ya registrado y a los otros borradores del mismo punto: duplicado | contradice | complementa | amplia | nuevo.
export async function borradoresDeCampana(env, campId) {
  const [borradores, extracciones, vigentes] = await Promise.all([
    env.DB.prepare(`SELECT b.id, b.proceso_id, b.documento_id, d.nombre AS documento, b.punto, b.bloque, b.texto, b.cita, b.editado, b.actualizado
      FROM precarga_borrador b JOIN documentos d ON d.id=b.documento_id WHERE b.campana_id=? AND b.estado='borrador' ORDER BY b.proceso_id, b.bloque, b.punto`).bind(campId).all(),
    env.DB.prepare(`SELECT x.documento_id, x.proceso_id, x.estado, x.mensaje, x.puntos, x.descartados, x.motivo, x.actualizado FROM documento_extracciones x
      JOIN documentos d ON d.id=x.documento_id WHERE d.campana_id=?`).bind(campId).all(),
    env.DB.prepare('SELECT proceso_id, punto, texto FROM precarga WHERE proceso_id IN (SELECT id FROM procesos WHERE campana_id=?)').bind(campId).all()
  ]);
  const vigente = new Map(vigentes.results.map(v => [v.proceso_id + '|' + v.punto, v.texto]));
  const lista = borradores.results;
  lista.forEach(b => {
    const v = vigente.get(b.proceso_id + '|' + b.punto) || '';
    Object.assign(b, alertaDe(v, b.texto, lista.filter(o => o !== b && o.proceso_id === b.proceso_id && o.punto === b.punto), b.punto), { vigente: v });
  });
  return { precarga_borrador: lista, extracciones: extracciones.results };
}

// POST /a/precarga/borrador  {proceso_id, decisiones[{id, accion:'aprobar'|'descartar', texto?}]}
// Aprobar lleva el punto a la precarga del proceso (y, si el campo lo permite, a la matriz con su historial). Descartar solo cierra el borrador.
export async function rutaPrecargaBorrador(env, b, deps) {
  const p = await env.DB.prepare('SELECT id, campana_id, matriz, matriz_ia, validacion FROM procesos WHERE id=?').bind(txt(b.proceso_id, 60)).first();
  if (!p) throw new HttpError(404, 'Proceso no encontrado');
  const decisiones = (Array.isArray(b.decisiones) ? b.decisiones : []).slice(0, 40);
  if (!decisiones.length) throw new HttpError(400, 'No hay nada que resolver');
  const filas = (await env.DB.prepare(`SELECT b.*, d.nombre AS documento FROM precarga_borrador b JOIN documentos d ON d.id=b.documento_id
    WHERE b.proceso_id=? AND b.estado='borrador'`).bind(p.id).all()).results;
  const porId = new Map(filas.map(x => [x.id, x]));
  const previos = {};
  (await env.DB.prepare('SELECT punto, texto, archivos FROM precarga WHERE proceso_id=?').bind(p.id).all()).results.forEach(x => { previos[x.punto] = { texto: x.texto, archivos: JSON.parse(x.archivos || '[]') }; });
  const aprobar = [], t = ahora(), st = [], aviso = { complementados: [], duplicados: [], sin_aplicar: [] };
  decisiones.forEach(x => {
    const fila = porId.get(txt(x && x.id, 60));
    if (!fila || (x.accion !== 'aprobar' && x.accion !== 'descartar')) return;
    if (x.accion === 'descartar') { st.push(env.DB.prepare("UPDATE precarga_borrador SET estado='descartado', actualizado=?, resuelto_por=? WHERE id=?").bind(t, ACTOR.nombre, fila.id)); return; }
    const nuevo = txt(x.texto == null ? fila.texto : x.texto, MAX_TEXTO);
    if (!nuevo) return;
    // Lo aprobado se SUMA a lo que el punto ya tiene (de otro documento o de una carga anterior); nunca lo reemplaza.
    const previo = previos[fila.punto] || { texto: '', archivos: [] };
    const c = complementar(previo.texto, nuevo, fila.punto);
    if (c.relacion === 'contradice' && !x.forzar) { aviso.sin_aplicar.push({ id: fila.id, punto: fila.punto, motivo: 'contradice' }); return; }
    if (c.texto.length > MAX_TEXTO) { aviso.sin_aplicar.push({ id: fila.id, punto: fila.punto, motivo: 'largo' }); return; }
    if (c.relacion === 'duplicado') aviso.duplicados.push(fila.punto);
    else if (c.relacion !== 'nuevo') aviso.complementados.push(fila.punto);
    const archivos = [...new Set([...previo.archivos, fila.documento])].slice(0, 10);
    previos[fila.punto] = { texto: c.texto, archivos };
    aprobar.push({ punto: fila.punto, texto: c.texto, archivos });
    st.push(env.DB.prepare("UPDATE precarga_borrador SET estado='aprobado', texto=?, editado=?, actualizado=?, resuelto_por=? WHERE id=?").bind(nuevo, nuevo !== fila.texto ? 1 : fila.editado, t, ACTOR.nombre, fila.id));
  });
  if (!st.length && aviso.sin_aplicar.length) return { ok: true, escritos: [], bloqueados: [], pendientes: filas.length, ...aviso };
  if (!st.length) throw new HttpError(400, 'Esos borradores ya no están pendientes');
  const r = aprobar.length ? await deps.aplicarPrecarga(env, p, aprobar, ACTOR) : { escritos: [], bloqueados: [] };
  await env.DB.batch(st);
  await registrarAccion(env, p.campana_id, ACTOR, 'documento_precarga_revision', { proceso: p.id, aprobados: aprobar.length, descartados: st.length - aprobar.length, bloqueados: r.bloqueados.length, complementados: aviso.complementados.length, duplicados: aviso.duplicados.length, sin_aplicar: aviso.sin_aplicar.length });
  const quedan = (await env.DB.prepare("SELECT COUNT(*) AS n FROM precarga_borrador WHERE proceso_id=? AND estado='borrador'").bind(p.id).first()).n;
  return { ok: true, escritos: r.escritos, bloqueados: r.bloqueados, pendientes: quedan, ...aviso };
}

// ---------------------------------------------------------------- limpieza en cascada
// Lo que cuelga de un proceso o de una campaña y debe irse con ellos. Las sentencias van ANTES del DELETE de procesos en el mismo batch
// (usan una subconsulta sobre procesos). Un documento que se queda sin procesos confirmados vuelve a Pendiente.
export function sentenciasRastroDeProcesos(env, subconsulta, args) {
  return [
    env.DB.prepare(`DELETE FROM documento_procesos WHERE proceso_id IN (${subconsulta})`).bind(...args),
    env.DB.prepare(`DELETE FROM documento_extracciones WHERE proceso_id IN (${subconsulta})`).bind(...args),
    env.DB.prepare(`DELETE FROM precarga_borrador WHERE proceso_id IN (${subconsulta})`).bind(...args),
    env.DB.prepare(`DELETE FROM matriz_historial WHERE proceso_id IN (${subconsulta})`).bind(...args),
    env.DB.prepare(`UPDATE documentos SET estado='pendiente', confianza_min=NULL, actualizado=? WHERE estado='clasificado'
      AND NOT EXISTS (SELECT 1 FROM documento_procesos dp WHERE dp.documento_id=documentos.id AND dp.vigente=1 AND dp.confirmado=1)`).bind(ahora())
  ];
}
export function sentenciasRastroDeCampana(env, campId) {
  return [
    env.DB.prepare('DELETE FROM documento_procesos WHERE documento_id IN (SELECT id FROM documentos WHERE campana_id=?)').bind(campId),
    env.DB.prepare('DELETE FROM documento_extracciones WHERE documento_id IN (SELECT id FROM documentos WHERE campana_id=?)').bind(campId),
    env.DB.prepare('DELETE FROM precarga_borrador WHERE campana_id=?').bind(campId),
    env.DB.prepare('DELETE FROM matriz_historial WHERE campana_id=?').bind(campId),
    env.DB.prepare('DELETE FROM documentos WHERE campana_id=?').bind(campId)
  ];
}
// Los archivos de una campaña (R2) se borran por su prefijo; sin R2 configurado no hay nada que borrar.
export async function borrarArchivosDeCampana(env, campId) {
  if (!env.DOCS || !env.DOCS.list) return 0;
  let n = 0, cursor;
  do {
    const r = await env.DOCS.list({ prefix: campId + '/', cursor });
    const claves = (r.objects || []).map(o => o.key);
    if (claves.length) { await env.DOCS.delete(claves); n += claves.length; }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return n;
}

// POST /a/campana/umbral  {campana_id, umbral}   (0 a 1)
export async function rutaUmbral(env, b) {
  const camp = await campanaDe(env, b.campana_id);
  const u = unidad(b.umbral);
  if (u == null || b.umbral === '' || b.umbral == null) throw new HttpError(400, 'El umbral debe estar entre 0 y 1');
  await env.DB.prepare('UPDATE campanas SET umbral_confianza=? WHERE id=?').bind(u, camp.id).run();
  await registrarAccion(env, camp.id, ACTOR, 'documento_umbral', { anterior: camp.umbral_confianza, nuevo: u });
  return { ok: true, umbral: u };
}

// Documentos clasificados de un proceso, para la precarga y otros módulos (solo asociaciones confirmadas y vigentes).
export async function documentosDeProceso(env, procesoId) {
  return (await env.DB.prepare(`SELECT d.id, d.nombre, d.tipo, d.gerencia FROM documento_procesos dp JOIN documentos d ON d.id=dp.documento_id
    WHERE dp.proceso_id=? AND dp.vigente=1 AND dp.confirmado=1 AND d.estado='clasificado' ORDER BY d.creado`).bind(procesoId).all()).results;
}
