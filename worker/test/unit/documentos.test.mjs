// Carga masiva de documentos (HU01) y su clasificación en procesos con IA (HU02): estados, gerencia, filtros, umbral, historial y auditoría.
// La IA se reemplaza por una función falsa y R2 por un mapa en memoria.   node --test test/unit/documentos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { rutaDocumentoAnalizar, rutaDocumentoSubir, bajaConfianza, diferencias, ESQUEMA_CLASIFICAR, mensajeErrorIA } from '../../src/documentos.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const almacen = new Map();
const DOCS = {
  put: async (k, v) => { almacen.set(k, v); },
  get: async k => (almacen.has(k) ? { body: almacen.get(k), arrayBuffer: async () => almacen.get(k) } : null)
};
const env = { DB: d1, DOCS, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const H = { origin: ORIGEN, 'x-admin-code': ADMIN, 'cf-connecting-ip': '10.0.0.3' };

async function llamar(metodo, ruta, cuerpo, tipo = 'application/json') {
  const bytes = cuerpo instanceof Uint8Array;
  const r = await worker.fetch(new Request('http://worker.local' + ruta, {
    method: metodo, body: cuerpo ? (bytes ? cuerpo : JSON.stringify(cuerpo)) : undefined, headers: { ...H, 'content-type': tipo }
  }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const pdf = txt => new TextEncoder().encode('%PDF-1.4\n' + txt);
const subir = (nombre, gerencia, bytes = pdf(nombre), tipo = 'application/pdf') =>
  llamar('POST', `/a/documentos?campana_id=c1&gerencia=${encodeURIComponent(gerencia)}&nombre=${encodeURIComponent(nombre)}`, bytes, tipo);
const acciones = accion => db.prepare('SELECT * FROM acciones WHERE accion=? ORDER BY creado').all(accion).map(a => ({ ...a, detalle: JSON.parse(a.detalle) }));

test('preparación: campaña con dos gerencias y tres procesos', () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada) VALUES ('c1','Prueba','Toyota',?)").run(new Date().toISOString());
  [['p1', 'Legal', 'Contratos'], ['p2', 'Legal', 'Cumplimiento'], ['p3', 'Finanzas', 'Tesorería']].forEach(([id, g, s]) =>
    db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, macroproceso, proceso, subproceso) VALUES (?,?,?,?,?,?,?)").run(id, 'c1', g, s, 'Macro ' + id, 'Proceso ' + id, 'Sub ' + id));
  assert.equal(db.prepare('SELECT umbral_confianza u FROM campanas').get().u, 0.7);
});

test('HU01: la carga exige gerencia y rechaza una que no existe en la campaña', async () => {
  assert.equal((await subir('a.pdf', '')).status, 400);
  assert.equal((await subir('a.pdf', 'Marketing')).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documentos').get().n, 0);
});

test('HU01: valida el tipo antes de guardar (formato y firma del PDF)', async () => {
  assert.equal((await subir('a.exe', 'Legal', pdf('x'), 'application/x-msdownload')).status, 415);
  assert.equal((await subir('falso.pdf', 'Legal', new TextEncoder().encode('no soy un pdf'))).status, 415);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documentos').get().n, 0);
});

test('HU01: cada archivo queda Pendiente, con gerencia, tipo, usuario y fecha; la auditoría lo registra', async () => {
  const r = await subir('Contratos 2026.pdf', 'legal');
  assert.equal(r.status, 200);
  const d = r.documento;
  assert.equal(d.estado, 'pendiente'); assert.equal(d.estado_ia, 'sin_analizar');
  assert.equal(d.gerencia, 'Legal'); assert.equal(d.tipo, 'pdf'); assert.equal(d.nombre, 'Contratos 2026.pdf');
  assert.ok(d.cargado_por && d.creado);
  assert.ok(almacen.has(d.clave_r2));
  const a = acciones('documento_carga');
  assert.equal(a.length, 1); assert.equal(a[0].detalle.estado_resultante, 'pendiente');
  await subir('Flujo caja.pdf', 'Finanzas');
  await subir('Otro.pdf', 'Legal');
});

test('HU01: la bandeja filtra por gerencia, estado y nombre, y la gerencia se puede cambiar', async () => {
  const todos = await llamar('GET', '/a/documentos?campana_id=c1');
  assert.equal(todos.documentos.length, 3); assert.equal(todos.resumen.pendiente, 3);
  assert.equal((await llamar('GET', '/a/documentos?campana_id=c1&gerencia=Finanzas')).documentos.length, 1);
  assert.equal((await llamar('GET', '/a/documentos?campana_id=c1&q=caja')).documentos.length, 1);
  assert.equal((await llamar('GET', '/a/documentos?campana_id=c1&estado=clasificado')).documentos.length, 0);
  const hoy = new Date().toISOString().slice(0, 10);
  assert.equal((await llamar('GET', `/a/documentos?campana_id=c1&desde=${hoy}&hasta=${hoy}`)).documentos.length, 3);
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Otro')).documentos[0].id;
  assert.equal((await llamar('POST', '/a/documentos/gerencia', { id, gerencia: 'Finanzas' })).documento.gerencia, 'Finanzas');
  assert.equal((await llamar('POST', '/a/documentos/gerencia', { id, gerencia: 'Nada' })).status, 400);
  assert.equal(acciones('documento_gerencia')[0].detalle.anterior, 'Legal');
});

test('HU01: se puede abrir el archivo guardado', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Contratos')).documentos[0].id;
  const r = await worker.fetch(new Request('http://worker.local/a/documentos/archivo?id=' + id, { headers: H }), env, { waitUntil() {} });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok((await r.text()).startsWith('%PDF-'));
});

test('HU02: el análisis guarda sugerencias con confianza y deja el documento Pendiente y analizado', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Contratos')).documentos[0].id;
  const ia = async () => [{ proceso_id: 'p1', confianza: 0.92 }, { proceso_id: 'p2', confianza: 0.4 }, { proceso_id: 'inventado', confianza: 0.99 }, { proceso_id: 'p1', confianza: 0.1 }];
  const r = await rutaDocumentoAnalizar(env, { id }, { waitUntil() {} }, { analizarIA: ia });
  const d = r.documento;
  assert.equal(d.estado, 'pendiente'); assert.equal(d.estado_ia, 'analizado');
  assert.deepEqual(d.procesos.map(p => [p.proceso_id, p.confianza, p.baja]), [['p1', 0.92, false], ['p2', 0.4, true]]);
  assert.equal(d.confianza_min, 0.4); assert.equal(d.baja_confianza, true);
  assert.equal(acciones('documento_analisis')[0].detalle.sugeridos.length, 2);
});

test('HU02: filtro y prioridad por baja confianza, y umbral configurable', async () => {
  const baja = await llamar('GET', '/a/documentos?campana_id=c1&confianza=baja');
  assert.equal(baja.documentos.length, 1);
  const orden = await llamar('GET', '/a/documentos?campana_id=c1&orden=confianza');
  assert.equal(orden.documentos[0].nombre, 'Contratos 2026.pdf');
  assert.equal((await llamar('POST', '/a/campana/umbral', { campana_id: 'c1', umbral: 0.3 })).umbral, 0.3);
  assert.equal((await llamar('GET', '/a/documentos?campana_id=c1&confianza=baja')).documentos.length, 0);
  assert.equal((await llamar('POST', '/a/campana/umbral', { campana_id: 'c1', umbral: 3 })).umbral, 1);
  assert.equal((await llamar('POST', '/a/campana/umbral', { campana_id: 'c1', umbral: '' })).status, 400);
  await llamar('POST', '/a/campana/umbral', { campana_id: 'c1', umbral: 0.7 });
});

test('HU02: confirmar con modificaciones clasifica el documento y audita lo sugerido, lo confirmado y los cambios', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Contratos')).documentos[0].id;
  // acepta p1, elimina p2 (sugerencia incorrecta) y agrega p3 que la IA no vio
  const r = await llamar('POST', '/a/documentos/procesos', { id, procesos: ['p1', 'p3'] });
  assert.equal(r.status, 200);
  assert.equal(r.documento.estado, 'clasificado');
  assert.deepEqual(r.documento.procesos.map(p => [p.proceso_id, p.origen, p.confirmado]).sort(), [['p1', 'ia', true], ['p3', 'manual', true]]);
  const a = acciones('documento_clasificacion')[0].detalle;
  assert.equal(a.estado_anterior, 'pendiente'); assert.equal(a.estado_resultante, 'clasificado');
  assert.deepEqual(a.sugeridos_ia.map(s => s.proceso_id).sort(), ['p1', 'p2']);
  assert.deepEqual(a.confirmados, ['p1', 'p3']);
  assert.deepEqual(a.modificaciones, { agregados: ['p3'], quitados: ['p2'], confirmados: ['p1'] });
  // el historial conserva la asociación quitada
  const h = db.prepare("SELECT vigente FROM documento_procesos WHERE documento_id=? AND proceso_id='p2'").get(id);
  assert.equal(h.vigente, 0);
  assert.equal((await llamar('GET', '/a/documentos?campana_id=c1&estado=clasificado')).documentos.length, 1);
});

test('HU02: un proceso que no es de la campaña se rechaza y una lista vacía devuelve el documento a Pendiente', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Contratos')).documentos[0].id;
  assert.equal((await llamar('POST', '/a/documentos/procesos', { id, procesos: ['zzz'] })).status, 400);
  assert.equal((await llamar('POST', '/a/documentos/procesos', { id, procesos: [] })).documento.estado, 'pendiente');
});

test('HU02: re-analizar no pisa lo confirmado y conserva las sugerencias anteriores como historial', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Flujo')).documentos[0].id;
  await rutaDocumentoAnalizar(env, { id }, { waitUntil() {} }, { analizarIA: async () => [{ proceso_id: 'p3', confianza: 0.9 }] });
  await llamar('POST', '/a/documentos/procesos', { id, procesos: ['p3'] });
  const r = await rutaDocumentoAnalizar(env, { id }, { waitUntil() {} }, { analizarIA: async () => [{ proceso_id: 'p3', confianza: 0.5 }, { proceso_id: 'p1', confianza: 0.6 }] });
  // El documento está en Finanzas: p1 (Legal) queda fuera del catálogo y se descarta aunque la IA lo devuelva.
  assert.deepEqual(r.documento.procesos.map(p => [p.proceso_id, p.confirmado]).sort(), [['p3', true]]);
  assert.equal(r.documento.estado, 'clasificado');
});

test('HU02: si la IA falla, el documento queda con estado de análisis «error» y se audita', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Otro')).documentos[0].id;
  await assert.rejects(rutaDocumentoAnalizar(env, { id }, { waitUntil() {} }, { analizarIA: async () => { throw new Error('caída'); } }));
  assert.equal(db.prepare('SELECT estado_ia FROM documentos WHERE id=?').get(id).estado_ia, 'error');
  assert.equal(acciones('documento_analisis_error').length, 1);
});

test('sin R2 configurado la carga responde 503 con un mensaje claro', async () => {
  const sinR2 = { ...env, DOCS: undefined };
  const r = await worker.fetch(new Request('http://worker.local/a/documentos?campana_id=c1&gerencia=Legal', { method: 'POST', body: pdf('x'), headers: { ...H, 'content-type': 'application/pdf' } }), sinR2, { waitUntil() {} });
  assert.equal(r.status, 503);
});

test('ayudantes puros: bajaConfianza y diferencias', () => {
  assert.ok(bajaConfianza(0.5, 0.7)); assert.equal(bajaConfianza(0.7, 0.7), false); assert.equal(bajaConfianza(null, 0.7), false);
  assert.deepEqual(diferencias([{ proceso_id: 'a', confirmado: 0 }, { proceso_id: 'b', confirmado: 1 }], ['b', 'c']), { agregados: ['c'], quitados: ['a'], confirmados: [] });
});

// ---------------------------------------------------------------- sección, duplicados, análisis automático y borrado
const subirSec = (nombre, gerencia, seccion, bytes = pdf(nombre)) =>
  llamar('POST', `/a/documentos?campana_id=c1&gerencia=${encodeURIComponent(gerencia)}&seccion=${encodeURIComponent(seccion)}&nombre=${encodeURIComponent(nombre)}`, bytes, 'application/pdf');

test('sección: se guarda la oficial (sin importar mayúsculas o tildes), vacía = toda la gerencia, y una que no es de la gerencia se rechaza', async () => {
  const r = await subirSec('Cumpl.pdf', 'Legal', 'cumplimiento');
  assert.equal(r.status, 200); assert.equal(r.documento.seccion, 'Cumplimiento');
  assert.equal((await subirSec('Sin sec.pdf', 'Legal', '')).documento.seccion, '');
  assert.equal((await subirSec('Mala.pdf', 'Legal', 'Tesorería')).status, 400);   // existe, pero en Finanzas
  assert.equal(acciones('documento_carga').pop().detalle.seccion, '');
});

test('duplicados: el mismo contenido en la campaña se rechaza (409) y no guarda otro archivo', async () => {
  const antes = db.prepare('SELECT COUNT(*) n FROM documentos').get().n, claves = almacen.size;
  const r = await subirSec('Copia de Cumpl.pdf', 'Finanzas', 'Tesorería', pdf('Cumpl.pdf'));
  assert.equal(r.status, 409); assert.match(r.error, /Cumpl\.pdf/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documentos').get().n, antes); assert.equal(almacen.size, claves);
});

test('el catálogo de la IA se acota a la sección; sin procesos en ella cae a la gerencia', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Cumpl')).documentos.find(d => d.nombre === 'Cumpl.pdf').id;
  let visto = null;
  const ia = async (e, c, a, catalogo, ger, sec) => { visto = { ids: catalogo.map(p => p.id), ger, sec }; return [{ proceso_id: 'p1', confianza: 0.9 }, { proceso_id: 'p2', confianza: 0.8 }]; };
  const r = await rutaDocumentoAnalizar(env, { id }, { waitUntil() {} }, { analizarIA: ia });
  assert.deepEqual(visto, { ids: ['p2'], ger: 'Legal', sec: 'Cumplimiento' });
  assert.deepEqual(r.documento.procesos.map(p => p.proceso_id), ['p2']);   // p1 es de otra sección: no se acepta
  db.prepare("UPDATE documentos SET seccion='Fantasma' WHERE id=?").run(id);
  await rutaDocumentoAnalizar(env, { id }, { waitUntil() {} }, { analizarIA: ia });
  assert.deepEqual(visto.ids.sort(), ['p1', 'p2']);   // toda la gerencia Legal
});

test('análisis automático: con IA lista se lanza al cargar (analizando → analizado); si falla queda «error» sin romper la carga', async () => {
  const ps = [], ctx = { waitUntil: p => ps.push(p) };
  const cargar = async (nombre, deps) => {
    const req = new Request(`http://worker.local/a/documentos?campana_id=c1&gerencia=Legal&seccion=Contratos&nombre=${nombre}`, { method: 'POST', body: pdf(nombre), headers: { ...H, 'content-type': 'application/pdf' } });
    const base = { leerArchivo: async rq => ({ tipo: 'application/pdf', buf: await rq.arrayBuffer() }), ...deps };
    return rutaDocumentoSubir(env, req, new URL(req.url), base, ctx);
  };
  const ok = await cargar('auto-ok.pdf', { iaLista: () => true, analizarIA: async () => [{ proceso_id: 'p1', confianza: 0.95 }] });
  assert.equal(ok.documento.estado_ia, 'analizando');
  await Promise.all(ps);
  const ficha = (await llamar('GET', '/a/documentos?campana_id=c1&q=auto-ok')).documentos[0];
  assert.equal(ficha.estado_ia, 'analizado'); assert.deepEqual(ficha.procesos.map(p => p.proceso_id), ['p1']);
  const mal = await cargar('auto-mal.pdf', { iaLista: () => true, analizarIA: async () => { throw new Error('caída'); } });
  assert.equal(mal.documento.estado_ia, 'analizando');
  await Promise.all(ps);
  assert.equal(db.prepare("SELECT estado_ia FROM documentos WHERE nombre='auto-mal.pdf'").get().estado_ia, 'error');
  const sin = await cargar('auto-sin.pdf', { iaLista: () => false, analizarIA: async () => [] });
  assert.equal(sin.documento.estado_ia, 'sin_analizar');   // sin IA configurada no se lanza nada
});

test('borrar: quita ficha, asociaciones, borradores sin aprobar y el archivo; lo ya aprobado se conserva', async () => {
  const doc = (await llamar('GET', '/a/documentos?campana_id=c1&q=auto-ok')).documentos[0];
  db.prepare("INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES ('b1','c1','p1',?,'objetivo','b1','x','y','borrador',0,'t','t')").run(doc.id);
  db.prepare("INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES ('b2','c1','p1',?,'alcance','b1','x','y','aprobado',0,'t','t')").run(doc.id);
  const r = await llamar('POST', '/a/documentos/borrar', { id: doc.id });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documentos WHERE id=?').get(doc.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documento_procesos WHERE documento_id=?').get(doc.id).n, 0);
  assert.deepEqual(db.prepare('SELECT id FROM precarga_borrador WHERE documento_id=?').all(doc.id).map(x => x.id), ['b2']);
  assert.equal(acciones('documento_borrado').length, 1);
  assert.equal((await llamar('POST', '/a/documentos/borrar', { id: doc.id })).status, 404);
});

test('cambiar de gerencia limpia la sección; cambiar solo la sección la valida', async () => {
  const id = (await llamar('GET', '/a/documentos?campana_id=c1&q=Cumpl')).documentos.find(d => d.nombre === 'Cumpl.pdf').id;
  assert.equal((await llamar('POST', '/a/documentos/gerencia', { id, gerencia: 'Legal', seccion: 'Contratos' })).documento.seccion, 'Contratos');
  assert.equal((await llamar('POST', '/a/documentos/gerencia', { id, gerencia: 'Legal', seccion: 'Tesorería' })).status, 400);
  const r = await llamar('POST', '/a/documentos/gerencia', { id, gerencia: 'Finanzas' });
  assert.equal(r.documento.gerencia, 'Finanzas'); assert.equal(r.documento.seccion, '');
});

test('clasificar: el esquema no depende del catálogo (un enum con cientos de ids la API lo rechaza por complejo)', () => {
  assert.equal(JSON.stringify(ESQUEMA_CLASIFICAR).includes('enum'), false);
});

test('clasificar: una clave rechazada se explica; otro error conserva el mensaje de reintento', () => {
  const rechazo = new Error('502 {"error":{"type":"processiq_proxy","message":"Anthropic rechazo la clave central del intermediario"}}');
  assert.match(mensajeErrorIA(rechazo, 'reintenta'), /renovarla/);
  assert.equal(mensajeErrorIA(new Error('429 rate limit'), 'reintenta'), 'reintenta');
});
