// Un campo de la matriz conserva los dos aportes automáticos: lo de los documentos (precarga) y lo de la IA; cada fuente solo cambia el suyo.
//   node --test test/unit/matriz-aportes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { completarMatriz } from '../../src/index.js';
import { partesDe, componer } from '../../src/complemento.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const llamar = async (ruta, cuerpo) => {
  const r = await worker.fetch(new Request('http://worker.local' + ruta, { method: 'POST', body: JSON.stringify(cuerpo),
    headers: { origin: ORIGEN, 'x-admin-code': ADMIN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.9' } }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
};
const proc = () => { const p = db.prepare("SELECT * FROM procesos WHERE id='p1'").get(); return { ...p, m: JSON.parse(p.matriz), ia: JSON.parse(p.matriz_ia) }; };
const t = new Date().toISOString();
const dato = (valor, estado = 'dicho') => ({ campos: { objetivo: { valor, estado, evidencia: 'x' } } });

test('partesDe / componer: deduce los aportes de datos anteriores y no repite', () => {
  assert.deepEqual(partesDe('Doc', { estado: 'precarga' }), { pre: 'Doc', ia: '' });
  assert.deepEqual(partesDe('IA', { estado: 'dicho' }), { pre: '', ia: 'IA' });
  assert.equal(componer('Gestionar contratos', 'Gestionar contratos del área y vigilar vencimientos'), 'Gestionar contratos del área y vigilar vencimientos');
  assert.equal(componer('Doc', ''), 'Doc');
});

test('preparación', () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada) VALUES ('c1','Prueba','Toyota',?)").run(t);
  db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso) VALUES ('p1','c1','Legal','Contratos','Contratos')").run();
  db.prepare("INSERT INTO documentos (id, campana_id, nombre, tipo, gerencia, creado, actualizado) VALUES ('d1','c1','manual.pdf','pdf','Legal',?,?)").run(t, t);
});

test('la IA escribe primero; luego la precarga se SUMA en la matriz sin borrar lo de la IA', async () => {
  await completarMatriz(env, db.prepare("SELECT * FROM procesos WHERE id='p1'").get(), dato('Controlar vencimientos y renovaciones de contratos'));
  assert.equal(proc().m.objetivo, 'Controlar vencimientos y renovaciones de contratos');
  db.prepare("INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES ('b1','c1','p1','d1','objetivo','b1','Administrar la firma de contratos con notarías','c','borrador',0,?,?)").run(t, t);
  const r = await llamar('/a/precarga/borrador', { proceso_id: 'p1', decisiones: [{ id: 'b1', accion: 'aprobar' }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  const p = proc();
  assert.match(p.m.objetivo, /Administrar la firma de contratos con notarías/);
  assert.match(p.m.objetivo, /Controlar vencimientos y renovaciones de contratos/);
  assert.equal(p.ia.objetivo.pre, 'Administrar la firma de contratos con notarías');
  assert.equal(p.ia.objetivo.ia, 'Controlar vencimientos y renovaciones de contratos');
});

test('al regenerar con IA solo cambia su parte; lo de los documentos se conserva', async () => {
  await completarMatriz(env, db.prepare("SELECT * FROM procesos WHERE id='p1'").get(), dato('Controlar vencimientos, renovaciones y garantías'));
  const p = proc();
  assert.match(p.m.objetivo, /Administrar la firma de contratos con notarías/);
  assert.match(p.m.objetivo, /garantías/);
  assert.doesNotMatch(p.m.objetivo, /Controlar vencimientos y renovaciones de contratos/);
});

test('corregir el texto de los documentos reemplaza solo su parte (sin duplicar el anterior)', async () => {
  const r = await llamar('/a/precarga', { proceso_id: 'p1', puntos: [{ punto: 'objetivo', texto: 'Gestionar la firma de contratos', base: 'Administrar la firma de contratos con notarías', archivos: ['manual.pdf'] }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  const p = proc();
  assert.match(p.m.objetivo, /Gestionar la firma de contratos/);
  assert.doesNotMatch(p.m.objetivo, /Administrar la firma/);
  assert.match(p.m.objetivo, /garantías/);
});

test('vaciar los documentos deja la parte de la IA; si no había IA, se retira el campo', async () => {
  await llamar('/a/precarga', { proceso_id: 'p1', puntos: [{ punto: 'objetivo', texto: '', base: 'Gestionar la firma de contratos' }] });
  const p = proc();
  assert.equal(p.m.objetivo, 'Controlar vencimientos, renovaciones y garantías');
  assert.equal(p.ia.objetivo.pre, '');
});

test('lo que escribió una persona no se pisa por ninguna de las dos fuentes', async () => {
  db.prepare("UPDATE procesos SET matriz=?, matriz_ia='{}' WHERE id='p1'").run(JSON.stringify({ objetivo: 'Texto del equipo' }));
  await completarMatriz(env, db.prepare("SELECT * FROM procesos WHERE id='p1'").get(), dato('Otra cosa'));
  assert.equal(proc().m.objetivo, 'Texto del equipo');
  const r = await llamar('/a/precarga', { proceso_id: 'p1', puntos: [{ punto: 'objetivo', texto: 'Del documento', base: '' }] });
  assert.deepEqual(r.bloqueados.map(x => x.punto), ['objetivo']);
  assert.equal(proc().m.objetivo, 'Texto del equipo');
});
