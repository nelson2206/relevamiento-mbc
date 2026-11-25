// Plantilla con la matriz en la hoja Procesos (coincidencia por código o ruta, dry_run) y Constructor del mapa
// (crear/eliminar estructura, mover entre procesos, borrar grupos).
//   node --test test/unit/constructor-carga.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const G = 'Gerencia Legal', S = 'Sección Legal';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };

async function admin(ruta, cuerpo) {
  const r = await worker.fetch(new Request('http://worker.local' + ruta, {
    method: 'POST', body: JSON.stringify(cuerpo),
    headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.6', 'x-admin-code': ADMIN }
  }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const importar = (procesos, extra = {}) => admin('/a/importar', { campana_id: 'c1', modo: 'agregar', upsert: true, encuestados: [], sistemas: [], procesos, ...extra });
const proceso = id => db.prepare('SELECT * FROM procesos WHERE id=?').get(id);
const matriz = id => JSON.parse(proceso(id).matriz);
const n = sql => db.prepare(sql).get().n;

test('preparación', () => {
  const t = new Date().toISOString();
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c1','Prueba','Toyota',?,?,1)").run(t, 'abcdefghij');
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c2','Otra','Toyota',?,?,1)").run(t, 'klmnopqrst');
  [['p1', 'LEG-01', 'Contratos A'], ['p2', '', 'Contratos B'], ['p3', '', 'Poderes']].forEach(([id, cod, nom]) =>
    db.prepare("INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, fuente, matriz) VALUES (?, 'c1', ?, ?, ?, 'Legal', 'Contratación', ?, 'inventario', ?)")
      .run(id, cod, G, S, nom, JSON.stringify(id === 'p1' ? { objetivo: 'Objetivo original' } : {})));
  db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, macroproceso, proceso, subproceso, fuente, matriz) VALUES ('o1','c2','GX','SX','M','P','Ajeno','inventario','{}')").run();
  db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, origen, creado) VALUES ('e1','c1','tokenprueba00001','Ana',?,?,'carga',?)").run('Gerencia Ventas', 'Sección Ventas', t);
});

// ---- Hoja Procesos con la matriz ----
test('una fila de la hoja Procesos con código existente actualiza ese proceso y conserva lo que no trae', async () => {
  const r = await importar([{ codigo: 'LEG-01', gerencia: G, seccion: S, macroproceso: 'Legal', proceso: 'Contratación', subproceso: 'Contratos A', matriz: { alcance: 'Revisión', objetivo: 'Objetivo nuevo' } }]);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.procesos, 0); assert.equal(r.procesos_actualizados, 1); assert.equal(r.campos_cambiados, 2);
  assert.equal(matriz('p1').alcance, 'Revisión'); assert.equal(matriz('p1').objetivo, 'Objetivo nuevo');
});

test('sin código, la ruta gerencia+sección+macro+proceso+subproceso reconoce el proceso (sin mayúsculas ni tildes)', async () => {
  const r = await importar([{ gerencia: 'gerencia legal', seccion: 'seccion legal', macroproceso: 'LEGAL', proceso: 'Contratacion', subproceso: 'contratos b', matriz: { kpis: 'Contratos firmados' } }]);
  assert.equal(r.procesos, 0); assert.equal(r.procesos_actualizados, 1, JSON.stringify(r));
  assert.equal(matriz('p2').kpis, 'Contratos firmados');
  assert.equal(n("SELECT COUNT(*) AS n FROM procesos WHERE campana_id='c1'"), 3);
});

test('una fila nueva sin campos de matriz se crea con la matriz vacía', async () => {
  const r = await importar([{ gerencia: G, seccion: S, macroproceso: 'Legal', proceso: 'Contratación', subproceso: 'Litigios' }]);
  assert.equal(r.procesos, 1);
  const p = db.prepare("SELECT matriz FROM procesos WHERE subproceso='Litigios'").get();
  assert.equal(p.matriz, '{}');
});

test('dry_run informa los campos que cambiarían y no escribe nada', async () => {
  const antes = n('SELECT COUNT(*) AS n FROM matriz_historial');
  const r = await importar([{ fila: 4, codigo: 'LEG-01', gerencia: G, seccion: S, matriz: { objetivo: 'Otro objetivo', frecuencia: 'Mensual' } }], { dry_run: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.dry_run, true); assert.equal(r.campos_cambiados, 2); assert.equal(r.procesos_actualizados, 1);
  assert.equal(r.cambios[0].fila, 4);
  const obj = r.cambios[0].campos.find(c => c.campo === 'objetivo');
  assert.equal(obj.anterior, 'Objetivo nuevo'); assert.equal(obj.nuevo, 'Otro objetivo');
  assert.equal(matriz('p1').objetivo, 'Objetivo nuevo');   // no se escribió
  assert.equal(n('SELECT COUNT(*) AS n FROM matriz_historial'), antes);
});

// ---- Constructor: estructura ----
test('crear una gerencia la guarda en el servidor y siembra el esqueleto con lo que ya existe', async () => {
  const r = await admin('/a/estructura/crear', { campana_id: 'c1', gerencia: 'Gerencia Nueva' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const claves = r.estructura.map(f => f.gerencia + '|' + f.seccion);
  assert.ok(claves.includes('Gerencia Nueva|'));
  assert.ok(claves.includes(G + '|' + S) && claves.includes('Gerencia Ventas|Sección Ventas'), 'siembra procesos y personas');
  assert.equal((await admin('/a/estructura/crear', { campana_id: 'c1', gerencia: 'gerencia nueva' })).status, 409);
});

test('crear una sección exige que exista la gerencia y reemplaza el marcador sin sección', async () => {
  assert.equal((await admin('/a/estructura/crear', { campana_id: 'c1', gerencia: 'No existe', seccion: 'X' })).status, 404);
  const r = await admin('/a/estructura/crear', { campana_id: 'c1', gerencia: 'Gerencia Nueva', seccion: 'Sección Nueva' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const claves = r.estructura.map(f => f.gerencia + '|' + f.seccion);
  assert.ok(claves.includes('Gerencia Nueva|Sección Nueva')); assert.ok(!claves.includes('Gerencia Nueva|'));
  assert.equal((await admin('/a/estructura/crear', { campana_id: 'c1', gerencia: 'Gerencia Nueva', seccion: 'sección nueva' })).status, 409);
});

test('no se elimina una sección con procesos o personas; una vacía sí', async () => {
  const conProcesos = await admin('/a/estructura/eliminar', { campana_id: 'c1', gerencia: G, seccion: S });
  assert.equal(conProcesos.status, 409); assert.match(conProcesos.error || conProcesos.mensaje || JSON.stringify(conProcesos), /proceso/);
  assert.equal((await admin('/a/estructura/eliminar', { campana_id: 'c1', gerencia: 'Gerencia Ventas' })).status, 409);   // tiene una persona
  const r = await admin('/a/estructura/eliminar', { campana_id: 'c1', gerencia: 'Gerencia Nueva' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(!r.estructura.some(f => f.gerencia === 'Gerencia Nueva'));
});

// ---- Constructor: mover entre macroprocesos y procesos ----
test('mover con «proceso» cambia la columna y el campo de la matriz, y «Deshacer» lo restaura', async () => {
  const previo = [{ id: 'p3', gerencia: G, seccion: S, macroproceso: 'Legal', proceso: 'Contratación', validacion: '', actualizado_en: '' }];
  const r = await admin('/a/proceso/mover', { campana_id: 'c1', proceso_ids: ['p3'], gerencia: G, seccion: S, macroproceso: 'Societario', proceso: 'Representación' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(proceso('p3').macroproceso, 'Societario'); assert.equal(proceso('p3').proceso, 'Representación');
  assert.equal(matriz('p3').proceso, 'Representación'); assert.equal(r.procesos[0].proceso, 'Representación');
  const u = await admin('/a/proceso/mover', { campana_id: 'c1', movimientos: previo });
  assert.equal(u.status, 200, JSON.stringify(u));
  assert.equal(proceso('p3').macroproceso, 'Legal'); assert.equal(proceso('p3').proceso, 'Contratación');
});

test('un proceso sin subproceso que pasa a colgar de otro proceso conserva su nombre como subproceso; deshacer lo restaura', async () => {
  db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, macroproceso, proceso, subproceso, fuente, matriz) VALUES ('p9','c1',?,?,'Legal','Archivo','','inventario','{}')").run(G, S);
  const r = await admin('/a/proceso/mover', { campana_id: 'c1', proceso_ids: ['p9'], gerencia: G, seccion: S, proceso: 'Contratación' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(proceso('p9').proceso, 'Contratación'); assert.equal(proceso('p9').subproceso, 'Archivo');
  await admin('/a/proceso/mover', { campana_id: 'c1', movimientos: [{ id: 'p9', gerencia: G, seccion: S, macroproceso: 'Legal', proceso: 'Archivo', subproceso: '', validacion: '', actualizado_en: '' }] });
  assert.equal(proceso('p9').proceso, 'Archivo'); assert.equal(proceso('p9').subproceso, '');
  db.prepare("DELETE FROM procesos WHERE id='p9'").run();
});

test('sin «proceso» el movimiento no toca el proceso', async () => {
  await admin('/a/proceso/mover', { campana_id: 'c1', proceso_ids: ['p3'], gerencia: G, seccion: S, macroproceso: 'Legal' });
  assert.equal(proceso('p3').proceso, 'Contratación');
});

// ---- Constructor: editar y borrar ----
test('editar un proceso de otra campaña se rechaza; editar la ubicación actualiza la matriz y deja la fila «actualizado»', async () => {
  assert.equal((await admin('/a/proceso', { campana_id: 'c1', id: 'o1', gerencia: G, seccion: S, proceso: 'x' })).status, 404);
  const r = await admin('/a/proceso', { campana_id: 'c1', id: 'p2', gerencia: G, seccion: S, macroproceso: 'Legal', proceso: 'Contratación', subproceso: 'Contratos B2' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(proceso('p2').subproceso, 'Contratos B2'); assert.equal(matriz('p2').subproceso, 'Contratos B2'); assert.equal(proceso('p2').validacion, 'actualizado');
});

test('borrar un proceso exige que sea de la campaña cuando se indica', async () => {
  assert.equal((await admin('/a/proceso/borrar', { campana_id: 'c1', proceso_id: 'o1' })).status, 404);
  assert.ok(proceso('o1'));
});

test('borrar un grupo se rechaza entero si algún subproceso tiene respuestas; sin respuestas borra sus filas', async () => {
  db.prepare("INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, actualizado) VALUES ('e1','p3','b1','algo','2026-11-04T12:00:00.000Z')").run();
  const antes = n("SELECT COUNT(*) AS n FROM procesos WHERE campana_id='c1'");
  const bloqueado = await admin('/a/proceso/borrar-grupo', { campana_id: 'c1', gerencia: G, seccion: S, macroproceso: 'Legal' });
  assert.equal(bloqueado.status, 409);
  assert.equal(n("SELECT COUNT(*) AS n FROM procesos WHERE campana_id='c1'"), antes);
  db.prepare("DELETE FROM respuestas WHERE proceso_id='p3'").run();
  const r = await admin('/a/proceso/borrar-grupo', { campana_id: 'c1', gerencia: G, seccion: S, macroproceso: 'Legal', proceso: 'Contratación' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.borrados.length, antes);
  assert.equal(n("SELECT COUNT(*) AS n FROM procesos WHERE campana_id='c1'"), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM procesos WHERE campana_id='c2'"), 1);   // la otra campaña no se toca
});
