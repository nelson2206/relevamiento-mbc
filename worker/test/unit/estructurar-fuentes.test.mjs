// «Estructurar con IA» usa las dos fuentes: información previa de documentos (precarga aprobada) + respuestas de las encuestas.
//   node --test test/unit/estructurar-fuentes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { textoParaClaude } from '../../src/index.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const estructurar = async pid => {
  const r = await worker.fetch(new Request('http://worker.local/a/estructurar', { method: 'POST', body: JSON.stringify({ proceso_id: pid }),
    headers: { origin: ORIGEN, 'x-admin-code': ADMIN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.8' } }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
};
const camp = { cliente: 'Toyota', estandares: '' };
const p = { codigo: 'P1', gerencia: 'Legal', seccion: 'Contratos', proceso: 'Contratos', fuente: 'inventario', matriz: '{}' };
const pre = [{ punto: 'objetivo', texto: 'Gestionar los contratos', archivos: '["manual.pdf"]' }];
const resp = [{ encuestado_id: 'e1', proceso_id: 'p1', pregunta: 'b1', texto: 'Revisamos cada 15 días', sistemas: '[]', checklist: '{}' }];

test('el texto para la IA trae las dos fuentes, con el nombre del documento', () => {
  const t = textoParaClaude(camp, p, [{ id: 'e1', rol: 'Analista', gerencia: 'Legal', seccion: 'Contratos' }], [], resp, [], pre);
  assert.match(t, /FUENTE 1 · INFORMACIÓN PREVIA DE DOCUMENTOS/);
  assert.match(t, /\(Fuente: manual\.pdf\)/);
  assert.match(t, /FUENTE 2 · RESPUESTAS DE LAS ENCUESTAS/);
  assert.match(t, /Revisamos cada 15 días/);
});

test('sin respuestas, el texto lo dice y trabaja solo con documentos', () => {
  const t = textoParaClaude(camp, p, [], [], [], [], pre);
  assert.match(t, /todavía nadie respondió/);
  assert.match(t, /manual\.pdf/);
});

test('un proceso sin respuestas ni documentos da 409; solo con documentos ya no lo rechaza por falta de respuestas', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada) VALUES ('c1','Prueba','Toyota',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso) VALUES ('p1','c1','Legal','Contratos','Contratos')").run();
  const vacio = await estructurar('p1');
  assert.equal(vacio.status, 409); assert.match(vacio.error, /ni documentos/);
  const t = new Date().toISOString();
  db.prepare("INSERT INTO precarga (proceso_id, bloque, punto, texto, archivos, creado, actualizado) VALUES ('p1','b1','objetivo','Gestionar los contratos','[\"manual.pdf\"]',?,?)").run(t, t);
  const conDocs = await estructurar('p1');
  assert.notEqual(conDocs.status, 409, 'pasa la validación; sin clave de IA falla después, con otro error');
});
