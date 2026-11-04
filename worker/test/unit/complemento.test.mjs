// Lo que se aprueba desde un documento se SUMA a lo que el punto ya tiene; nunca lo reemplaza. Duplicados y contradicciones se avisan.
//   node --test test/unit/complemento.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { comparar, complementar, alertaDe } from '../../src/complemento.js';
import { crearD1 } from './d1-memoria.mjs';

test('comparar: nuevo, duplicado, amplía, complementa y contradice', () => {
  assert.equal(comparar('', 'Gestionar contratos'), 'nuevo');
  assert.equal(comparar('Gestionar los contratos del área', 'gestionar los contratos'), 'duplicado');
  assert.equal(comparar('Se usa SAP para registrar pagos', 'Se usa SAP para registrar los pagos'), 'duplicado');
  assert.equal(comparar('Se usa SAP', 'Se usa SAP y además SharePoint para archivar'), 'amplia');
  assert.equal(comparar('Se usa SAP para pagos', 'Los contratos se firman con notarías externas'), 'complementa');
  assert.equal(comparar('Se revisa cada 15 días con el jefe del área', 'Se revisa cada 30 días con el jefe del área'), 'contradice');
  assert.equal(comparar('Se usan notarías externas para firmar contratos', 'No se usan notarías externas para firmar contratos'), 'contradice');
});

test('complementar: suma sin perder lo vigente', () => {
  assert.equal(complementar('Uno', 'Dos').texto, 'Uno\nDos');
  assert.equal(complementar('Uno', 'Uno').texto, 'Uno');
  assert.equal(complementar('Uno', 'Uno y dos').texto, 'Uno y dos');
  assert.equal(complementar('', 'Dos').texto, 'Dos');
});

test('alertaDe: toma la peor relación con lo vigente y con los otros borradores', () => {
  const r = alertaDe('Se usa SAP para pagos', 'Se revisa cada 30 días con el jefe del área', [{ texto: 'Se revisa cada 15 días con el jefe del área', documento: 'otro.pdf' }]);
  assert.equal(r.alerta, 'contradice'); assert.equal(r.con, 'otro.pdf');
});

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const llamar = async (ruta, cuerpo) => {
  const r = await worker.fetch(new Request('http://worker.local' + ruta, { method: cuerpo ? 'POST' : 'GET', body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    headers: { origin: ORIGEN, 'x-admin-code': ADMIN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.7' } }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
};
const uno = (sql, ...a) => db.prepare(sql).get(...a);
const t = new Date().toISOString();
const borrador = (id, doc, punto, texto) => db.prepare("INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES (?, 'c1', 'p1', ?, ?, 'b1', ?, 'cita', 'borrador', 0, ?, ?)").run(id, doc, punto, texto, t, t);
const aprobar = (...decisiones) => llamar('/a/precarga/borrador', { proceso_id: 'p1', decisiones });
const matrizObjetivo = () => JSON.parse(uno("SELECT matriz FROM procesos WHERE id='p1'").matriz).objetivo;

test('preparación: dos documentos con borradores del mismo punto', () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada) VALUES ('c1','Prueba','Toyota',?)").run(t);
  db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso) VALUES ('p1','c1','Legal','Contratos','Contratos')").run();
  for (const [id, n] of [['d1', 'uno.pdf'], ['d2', 'dos.pdf'], ['d3', 'tres.pdf']])
    db.prepare("INSERT INTO documentos (id, campana_id, nombre, tipo, gerencia, creado, actualizado) VALUES (?, 'c1', ?, 'pdf', 'Legal', ?, ?)").run(id, n, t, t);
});

test('el segundo documento complementa el punto en vez de reemplazarlo', async () => {
  borrador('b1', 'd1', 'objetivo', 'Gestionar los contratos del área');
  assert.equal((await aprobar({ id: 'b1', accion: 'aprobar' })).status, 200);
  borrador('b2', 'd2', 'objetivo', 'Controlar los vencimientos y renovaciones');
  const r = await aprobar({ id: 'b2', accion: 'aprobar' });
  assert.deepEqual(r.complementados, ['objetivo']);
  const p = uno("SELECT texto, archivos FROM precarga WHERE proceso_id='p1' AND punto='objetivo'");
  assert.equal(p.texto, 'Gestionar los contratos del área\nControlar los vencimientos y renovaciones');
  assert.deepEqual(JSON.parse(p.archivos), ['uno.pdf', 'dos.pdf']);
  assert.equal(matrizObjetivo(), p.texto);
});

test('un duplicado no repite el texto: solo suma la fuente', async () => {
  borrador('b3', 'd3', 'objetivo', 'Gestionar los contratos del área');
  const r = await aprobar({ id: 'b3', accion: 'aprobar' });
  assert.deepEqual(r.duplicados, ['objetivo']);
  const p = uno("SELECT texto, archivos FROM precarga WHERE proceso_id='p1' AND punto='objetivo'");
  assert.equal(p.texto, 'Gestionar los contratos del área\nControlar los vencimientos y renovaciones');
  assert.deepEqual(JSON.parse(p.archivos), ['uno.pdf', 'dos.pdf', 'tres.pdf']);
});

test('dos borradores del mismo punto aprobados juntos se suman entre sí', async () => {
  borrador('b4', 'd1', 'sistemas', 'SAP para pagos');
  borrador('b5', 'd2', 'sistemas', 'SharePoint para archivar contratos firmados');
  await aprobar({ id: 'b4', accion: 'aprobar' }, { id: 'b5', accion: 'aprobar' });
  assert.equal(uno("SELECT texto FROM precarga WHERE proceso_id='p1' AND punto='sistemas'").texto, 'SAP para pagos\nSharePoint para archivar contratos firmados');
});

test('una contradicción no se aplica sola: queda pendiente y avisa; con «forzar» se suma, sin reemplazar', async () => {
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p1','b1','actividades','Se revisa cada 15 días con el jefe del área','[]',?,?)").run(t, t);
  borrador('b6', 'd2', 'actividades', 'Se revisa cada 30 días con el jefe del área');
  const c = await llamar('/a/campana?id=c1');
  const alerta = (c.precarga_borrador || []).find(x => x.id === 'b6');
  if (alerta) assert.equal(alerta.alerta, 'contradice');
  const r = await aprobar({ id: 'b6', accion: 'aprobar' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.sin_aplicar.map(x => x.motivo), ['contradice']);
  assert.equal(uno("SELECT estado FROM precarga_borrador WHERE id='b6'").estado, 'borrador');
  assert.equal(uno("SELECT texto FROM precarga WHERE proceso_id='p1' AND punto='actividades'").texto, 'Se revisa cada 15 días con el jefe del área');
  await aprobar({ id: 'b6', accion: 'aprobar', forzar: true });
  assert.equal(uno("SELECT texto FROM precarga WHERE proceso_id='p1' AND punto='actividades'").texto, 'Se revisa cada 15 días con el jefe del área\nSe revisa cada 30 días con el jefe del área');
});

// ---- «Guardar precarga» desde la ficha: una vista desactualizada no pisa ni borra lo guardado después
const guardar = (puntos, extra) => llamar('/a/precarga', { proceso_id: 'p1', puntos, ...extra });
const precarga = punto => uno("SELECT texto, archivos FROM precarga WHERE proceso_id='p1' AND punto=?", punto);

test('guardar con la vista al día reemplaza (corrección intencional) y puede vaciar', async () => {
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p1','b1','normativa','Texto original','[\"a.pdf\"]',?,?)").run(t, t);
  assert.equal((await guardar([{ punto: 'normativa', texto: 'Texto corregido', base: 'Texto original', archivos: ['a.pdf'] }])).status, 200);
  assert.equal(precarga('normativa').texto, 'Texto corregido');
  await guardar([{ punto: 'normativa', texto: '', base: 'Texto corregido' }]);
  assert.equal(precarga('normativa'), undefined);
});

test('guardar con la vista desactualizada vacía: no borra lo que se aprobó después', async () => {
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p1','b1','terceros','Notarías externas','[\"a.pdf\"]',?,?)").run(t, t);
  const r = await guardar([{ punto: 'terceros', texto: '', base: '' }]);
  assert.deepEqual(r.conservados, ['terceros']);
  assert.equal(precarga('terceros').texto, 'Notarías externas');
});

test('guardar con la vista desactualizada y texto nuevo: se suma y se unen las fuentes', async () => {
  const r = await guardar([{ punto: 'terceros', texto: 'Proveedores de custodia', base: '', archivos: ['b.pdf'] }]);
  assert.deepEqual(r.complementados, ['terceros']);
  const p = precarga('terceros');
  assert.equal(p.texto, 'Notarías externas\nProveedores de custodia');
  assert.deepEqual(JSON.parse(p.archivos), ['a.pdf', 'b.pdf']);
});

test('vista desactualizada que contradice: no se aplica; con forzar se suma', async () => {
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p1','b1','kpis','Se mide cada 15 días el cumplimiento','[]',?,?)").run(t, t);
  const r = await guardar([{ punto: 'kpis', texto: 'Se mide cada 30 días el cumplimiento', base: '' }]);
  assert.deepEqual(r.sin_aplicar.map(x => x.motivo), ['contradice']);
  assert.equal(precarga('kpis').texto, 'Se mide cada 15 días el cumplimiento');
  await guardar([{ punto: 'kpis', texto: 'Se mide cada 30 días el cumplimiento', base: '' }], { forzar: true });
  assert.equal(precarga('kpis').texto, 'Se mide cada 15 días el cumplimiento\nSe mide cada 30 días el cumplimiento');
});
