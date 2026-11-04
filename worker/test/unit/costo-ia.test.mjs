// Lo que dispara (o no) una llamada de estructuración: un duplicado no marca el proceso como pendiente; la tarea automática recoge procesos con
// solo documentos; y los aportes de la matriz se guardan aunque el texto visible no cambie.   node --test test/unit/costo-ia.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { completarMatriz, completarPendientes } from '../../src/index.js';
import { comparar } from '../../src/complemento.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const llamar = async (ruta, cuerpo) => {
  const r = await worker.fetch(new Request('http://worker.local' + ruta, { method: 'POST', body: JSON.stringify(cuerpo),
    headers: { origin: ORIGEN, 'x-admin-code': ADMIN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.10' } }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
};
const uno = (sql, ...a) => db.prepare(sql).get(...a);
const hace = min => new Date(Date.now() - min * 60000).toISOString();

test('«sin» en medio de la frase no es negación; al inicio sí', () => {
  assert.equal(comparar('Contratos vencidos sin renovar', 'Porcentaje de contratos renovados a tiempo', 'kpis'), 'complementa');
  assert.equal(comparar('Se usan indicadores de renovación', 'Sin indicadores de renovación', 'kpis'), 'contradice');
  assert.equal(comparar('Se usan notarías externas para firmar', 'No se usan notarías externas para firmar', 'terceros'), 'contradice');
});

test('preparación', () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, ia_auto) VALUES ('c1','Prueba','Toyota',?,1)").run(hace(0));
  for (const id of ['p1', 'p2', 'p3']) db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso) VALUES (?,'c1','Legal','Contratos',?)").run(id, 'Proceso ' + id);
  db.prepare("INSERT INTO documentos (id, campana_id, nombre, tipo, gerencia, creado, actualizado) VALUES ('d1','c1','manual.pdf','pdf','Legal',?,?)").run(hace(0), hace(0));
  db.prepare("INSERT INTO documentos (id, campana_id, nombre, tipo, gerencia, creado, actualizado) VALUES ('d2','c1','manual.docx','docx','Legal',?,?)").run(hace(0), hace(0));
});

test('aprobar un duplicado suma la fuente pero NO cambia la fecha de la precarga (no marca el proceso como pendiente)', async () => {
  const antes = hace(120);
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p1','b2','terceros','Proveedores y notarías.','[\"manual.pdf\"]',?,?)").run(antes, antes);
  db.prepare("INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES ('b1','c1','p1','d2','terceros','b2','Proveedores y notarías.','c','borrador',0,?,?)").run(hace(0), hace(0));
  const r = await llamar('/a/precarga/borrador', { proceso_id: 'p1', decisiones: [{ id: 'b1', accion: 'aprobar' }] });
  assert.deepEqual(r.duplicados, ['terceros']);
  const fila = uno("SELECT archivos, actualizado FROM precarga WHERE proceso_id='p1' AND punto='terceros'");
  assert.deepEqual(JSON.parse(fila.archivos), ['manual.pdf', 'manual.docx'], 'la fuente sí se agrega');
  assert.equal(fila.actualizado, antes, 'la fecha no cambia');
  // en cambio, un texto distinto sí actualiza la fecha
  db.prepare("INSERT INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES ('b2','c1','p1','d1','terceros','b2','Custodia externa de archivos.','c','borrador',0,?,?)").run(hace(0), hace(0));
  await llamar('/a/precarga/borrador', { proceso_id: 'p1', decisiones: [{ id: 'b2', accion: 'aprobar' }] });
  assert.ok(uno("SELECT actualizado FROM precarga WHERE proceso_id='p1' AND punto='terceros'").actualizado > antes);
});

test('la tarea automática toma procesos con solo documentos (esperando 10 min) y deja pasar los recientes o sin información', async () => {
  const viejo = hace(60), reciente = hace(2);
  db.prepare("UPDATE precarga SET actualizado=? WHERE proceso_id='p1'").run(viejo);
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p2','b1','objetivo','Gestionar contratos','[]',?,?)").run(reciente, reciente);
  // p3 no tiene nada. Sin clave de IA, el intento falla y queda marcado en matriz_ia._fallo: eso prueba que fue tomado.
  await completarPendientes(env, { waitUntil() {} });
  const fallo = id => JSON.parse(uno('SELECT matriz_ia FROM procesos WHERE id=?', id).matriz_ia)._fallo;
  assert.ok(fallo('p1'), 'p1 (solo documentos, hace 1 h) fue tomado');
  assert.equal(fallo('p2'), undefined, 'p2 (documentos de hace 2 min) todavía espera');
  assert.equal(fallo('p3'), undefined, 'p3 (sin información) no se toca');
});

test('los aportes de cada fuente se guardan aunque el texto visible del campo no cambie', async () => {
  const texto = 'Gestionar contratos del área y vigilar sus vencimientos';
  db.prepare("UPDATE procesos SET matriz=?, matriz_ia=? WHERE id='p3'").run(JSON.stringify({ objetivo: texto }), JSON.stringify({ objetivo: { estado: 'precarga', en: hace(5), pre: texto, ia: '' } }));
  // la IA aporta algo que ya está contenido en lo de los documentos: el texto visible no cambia, pero su aporte debe quedar registrado
  await completarMatriz(env, db.prepare("SELECT * FROM procesos WHERE id='p3'").get(), { campos: { objetivo: { valor: 'Gestionar contratos del área', estado: 'dicho', evidencia: 'x' } } });
  const p = db.prepare("SELECT matriz, matriz_ia FROM procesos WHERE id='p3'").get();
  assert.equal(JSON.parse(p.matriz).objetivo, texto);
  assert.equal(JSON.parse(p.matriz_ia).objetivo.ia, 'Gestionar contratos del área');
});
