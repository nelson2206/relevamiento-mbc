// HU05: la matriz exportada, completada a mano y vuelta a cargar, completa los procesos existentes por su ID aunque el Excel no traiga la gerencia.
//   node --test test/unit/importar-matriz.test.mjs
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
    headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.5', 'x-admin-code': ADMIN }
  }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
// Lo que arma la consola al leer el Excel exportado: sin gerencia, con la sección de la matriz y el ID de la columna oculta.
const cargar = procesos => admin('/a/importar', { campana_id: 'c1', modo: 'agregar', upsert: true, encuestados: [], sistemas: [], procesos });
const proceso = id => db.prepare('SELECT * FROM procesos WHERE id=?').get(id);
const matriz = id => JSON.parse(proceso(id).matriz);
const historial = (id, campo) => db.prepare('SELECT * FROM matriz_historial WHERE proceso_id=? AND campo=? ORDER BY creado, rowid').all(id, campo);

test('preparación: una campaña con dos procesos, uno con el objetivo ya escrito', () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c1','Prueba','Toyota',?,?,1)").run(new Date().toISOString(), 'abcdefghij');
  [['p1', 'Contratos A'], ['p2', 'Contratos B']].forEach(([id, p]) =>
    db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, macroproceso, proceso, subproceso, fuente, matriz) VALUES (?, 'c1', ?, ?, 'Legal', ?, ?, 'inventario', ?)")
      .run(id, G, S, p, p, JSON.stringify(id === 'p1' ? { objetivo: 'Objetivo original' } : {})));
  assert.equal(proceso('p1').gerencia, G);
});

test('una fila con el ID del proceso y sin gerencia completa la matriz y conserva gerencia y sección', async () => {
  const r = await cargar([{ fila: 3, id: 'p1', seccion: '', proceso: 'Contratos A', matriz: { alcance: 'Revisión y firma de contratos', frecuencia: 'Mensual' } }]);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.procesos_actualizados, 1); assert.deepEqual(r.descartadas, []);
  assert.equal(r.campos_cambiados, 2);
  const p = proceso('p1');
  assert.equal(p.gerencia, G); assert.equal(p.seccion, S); assert.equal(p.macroproceso, 'Legal'); assert.equal(p.subproceso, 'Contratos A');
  assert.equal(matriz('p1').alcance, 'Revisión y firma de contratos');
  assert.equal(matriz('p1').frecuencia, 'Mensual');
});

test('lo que el archivo no trae no se borra: las celdas vacías conservan el valor de la herramienta', () => {
  assert.equal(matriz('p1').objetivo, 'Objetivo original');
});

test('el cambio queda en el historial con origen «importacion» y actor de la consola', () => {
  const h = historial('p1', 'alcance');
  assert.equal(h.length, 1); assert.equal(h[0].origen, 'importacion'); assert.equal(h[0].anterior, ''); assert.equal(h[0].actor_nombre, 'Equipo consultor');
  assert.equal(historial('p1', 'objetivo').length, 0);   // no vino en el archivo, no cambió
});

test('sin la columna Validado no cambia la validación; con «validado» la marca', async () => {
  assert.ok(!proceso('p1').validacion);
  await cargar([{ id: 'p2', proceso: 'Contratos B', matriz: { objetivo: 'Gestionar contratos' } }]);
  assert.ok(!proceso('p2').validacion);
  await cargar([{ id: 'p2', proceso: 'Contratos B', matriz: { objetivo: 'Gestionar contratos' }, validacion: 'validado', validado_por: 'Jefe Legal' }]);
  assert.equal(proceso('p2').validacion, 'validado'); assert.equal(proceso('p2').validado_por, 'Jefe Legal');
});

test('una fila que no es de la campaña y no trae gerencia ni sección se informa en vez de saltarse en silencio', async () => {
  const antes = db.prepare('SELECT COUNT(*) AS n FROM procesos').get().n;
  const r = await cargar([
    { fila: 7, id: '', proceso: 'Proceso inventado', matriz: { objetivo: 'x' } },
    { fila: 8, id: 'p1', proceso: 'Contratos A', matriz: { kpis: 'Contratos firmados' } }
  ]);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.procesos, 0); assert.equal(r.procesos_actualizados, 1);
  assert.equal(r.descartadas.length, 1); assert.equal(r.descartadas[0].fila, 7); assert.match(r.descartadas[0].motivo, /Proceso inventado/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM procesos').get().n, antes);
});

test('un Excel exportado sin editar (con la identificación repetida) no cuenta cambios ni ensucia el historial', async () => {
  const antes = db.prepare('SELECT COUNT(*) AS n FROM matriz_historial').get().n;
  const r = await cargar([{ fila: 3, id: 'p1', seccion: S, macroproceso: 'Legal', proceso: 'Contratos A', subproceso: 'Contratos A',
    matriz: { macroproceso: 'Legal', proceso: 'Contratos A', subproceso: 'Contratos A', seccion: S, objetivo: 'Objetivo original', alcance: 'Revisión y firma de contratos' } }]);
  assert.equal(r.campos_cambiados, 0, JSON.stringify(r));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matriz_historial').get().n, antes);
  assert.ok(!('macroproceso' in matriz('p1')));   // no se escribió la identificación en la matriz
});

test('renombrar el subproceso en el Excel sí es un cambio y se aplica', async () => {
  const r = await cargar([{ id: 'p1', proceso: 'Contratos A', subproceso: 'Contratos A (nuevo nombre)', matriz: { subproceso: 'Contratos A (nuevo nombre)' } }]);
  assert.equal(r.campos_cambiados, 1);
  assert.equal(proceso('p1').subproceso, 'Contratos A (nuevo nombre)'); assert.equal(matriz('p1').subproceso, 'Contratos A (nuevo nombre)');
});

test('el mismo proceso dos veces en el archivo: solo cuenta la primera fila y la otra se informa', async () => {
  const r = await cargar([{ fila: 4, id: 'p2', matriz: { kpis: 'Primero' } }, { fila: 5, id: 'p2', matriz: { kpis: 'Segundo' } }]);
  assert.equal(r.procesos_actualizados, 1); assert.equal(r.descartadas.length, 1); assert.equal(r.descartadas[0].fila, 5);
  assert.equal(matriz('p2').kpis, 'Primero');
});

test('cambiar el contenido de un proceso validado lo mantiene validado y se avisa; sin cambios no se avisa', async () => {
  assert.equal(proceso('p2').validacion, 'validado');
  const igual = await cargar([{ id: 'p2', matriz: { kpis: 'Primero' } }]);
  assert.equal(igual.validados_modificados, 0);
  const r = await cargar([{ id: 'p2', matriz: { kpis: 'Tercero' } }]);
  assert.equal(r.validados_modificados, 1); assert.equal(proceso('p2').validacion, 'validado');
});

test('una fila nueva con gerencia y sección sí se crea', async () => {
  const r = await cargar([{ fila: 9, gerencia: G, seccion: S, proceso: 'Contratos C', subproceso: 'Contratos C', matriz: { objetivo: 'Nuevo' } }]);
  assert.equal(r.procesos, 1); assert.deepEqual(r.descartadas, []);
});

test('cargar la matriz no crea respuestas, revisiones ni validaciones de personas: la cobertura no cambia', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM respuestas').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revisiones').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matriz_historial WHERE tipo='validacion'").get().n, 0);
});
