// Cálculo por persona de la extracción (avance según cobertura.js, último paso, días sin actividad) y formato CSV con paginación.
//   node --test test/unit/embudo-personas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportarEmbudo, aCsv, registrarEventos } from '../../src/embudo.js';
import { crearCobertura } from '../../src/cobertura.js';
import { entorno, sembrar, eventos, G, S } from './embudo-ayuda.mjs';

const BLOQUES = [{ id: 'b1', puntos: [['a'], ['b']] }, { id: 'b2', puntos: [['c']] }, { id: 'b3', puntos: [['d']] }];
const ck = (...ids) => JSON.stringify(Object.fromEntries(ids.map(i => [i, { estado: 'cubierto' }])));
const resp = (db, e, p, pregunta, checklist, texto = '') =>
  db.prepare("INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, checklist, actualizado) VALUES (?,?,?,?,?,?)").run(e, p, pregunta, texto, checklist, '2026-11-09T10:00:00.000Z');
const pedir = async (e, qs) => (await exportarEmbudo(e.env, new URL('http://x/a/embudo/export?campana_id=c1&' + qs), BLOQUES, {}));

test('el % de avance y los procesos completos coinciden con crearCobertura', async () => {
  const e = entorno(); await sembrar(e.db);
  // Beto: p0 completo (los 4 puntos), p1 a medias (2 de 4), p2 nada. Carla: nada.
  resp(e.db, 'e-beto', 'p0', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p0', 'b2', ck('c')); resp(e.db, 'e-beto', 'p0', 'b3', ck('d'));
  resp(e.db, 'e-beto', 'p1', 'b1', ck('a', 'b'));
  e.db.prepare("UPDATE procesos SET validacion='validado' WHERE id='p0'").run();
  const filas = (await (await pedir(e, 'conjunto=personas')).json()).personas.filas;
  const b = filas.find(f => f.persona_id === 'e-beto');

  const rows = e.db.prepare('SELECT encuestado_id, proceso_id, pregunta, texto, sistemas, checklist FROM respuestas').all();
  const cob = crearCobertura({ bloques: BLOQUES, revisiones: [], respuestas: rows, precarga: [] });
  const esperado = ['p0', 'p1', 'p2'].map(p => cob.persona(p, 'e-beto'));
  assert.deepEqual(esperado.map(x => x.listos), [4, 2, 0]);
  assert.equal(b.procesos_asignados, 3);
  assert.equal(b.procesos_completos, esperado.filter(x => x.completo).length);
  assert.equal(b.procesos_completos, 1); assert.equal(b.procesos_validados, 1);
  assert.equal(b.pct_procesos_completos, 33.3);
  assert.equal(b.pct_puntos, Math.round((6 / 12) * 1000) / 10);
  assert.equal(b.procesos_con_respuesta, 2);
  const c = filas.find(f => f.persona_id === 'e-carla');
  assert.equal(c.procesos_completos, 0); assert.equal(c.pct_puntos, 0);
});

test('ultimo_paso 7 cuando completó todo lo asignado; días sin actividad desde la última huella', async () => {
  const e = entorno(); await sembrar(e.db);
  ['p0', 'p1', 'p2'].forEach(p => { resp(e.db, 'e-beto', p, 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', p, 'b2', ck('c')); resp(e.db, 'e-beto', p, 'b3', ck('d')); });
  const hace = d => new Date(Date.now() - d * 86400000).toISOString();
  e.db.prepare("UPDATE encuestados SET ultimo_acceso=?, actualizado=? WHERE id='e-beto'").run(hace(10), hace(12));
  e.db.prepare("UPDATE respuestas SET actualizado=?").run(hace(10));
  await registrarEventos(e.env, e.ctx, [{ campana_id: 'c1', tipo: 'primera_respuesta', persona_id: 'e-beto', proceso_id: 'p0', clave: 'x', creado: hace(10) }]);
  const b = (await (await pedir(e, 'conjunto=personas')).json()).personas.filas.find(f => f.persona_id === 'e-beto');
  assert.equal(b.ultimo_paso, 7); assert.equal(b.ultimo_paso_nombre, 'completó');
  assert.equal(b.dias_sin_actividad, 10);
  const c = (await (await pedir(e, 'conjunto=personas')).json()).personas.filas.find(f => f.persona_id === 'e-carla');
  assert.equal(c.ultimo_paso, 0); assert.equal(c.dias_sin_actividad, '', 'sin actividad no se inventa un número');
});

test('CSV: BOM UTF-8, separador «;», comillas, coma decimal y sin fórmulas inyectadas', () => {
  const csv = aCsv(['a', 'b', 'c'], [{ a: 'texto; con punto y coma', b: 'dice "hola"', c: 33.3 }, { a: '=SUMA(1;2)', b: '-peligro', c: 5 }, { a: 'dos\nlíneas', b: null, c: 0 }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  const lineas = csv.slice(1).split('\r\n');
  assert.equal(lineas[0], 'a;b;c');
  assert.equal(lineas[1], '"texto; con punto y coma";"dice ""hola""";33,3');
  assert.equal(lineas[2], `"'=SUMA(1;2)";'-peligro;5`);
  assert.equal(lineas[3], 'dos líneas;;0');
  assert.equal(lineas[4], '');
});

test('exportación CSV de personas: cabecera, tipo de contenido y descarga', async () => {
  const e = entorno(); await sembrar(e.db);
  const r = await e.admin('GET', '/a/embudo/export?campana_id=c1&conjunto=personas&formato=csv');
  assert.equal(r.status, 200);
  assert.match(r.cabeceras.get('content-type'), /text\/csv; charset=utf-8/);
  assert.match(r.cabeceras.get('content-disposition'), /embudo-personas-\d{4}-\d{2}-\d{2}\.csv/);
  assert.equal(r.texto.charCodeAt(0), 0xFEFF);
  const filas = r.texto.slice(1).trim().split('\r\n');
  assert.equal(filas.length, 3);
  assert.ok(filas[0].startsWith('campana_id;persona_id;persona_nombre;gerencia;seccion'));
  assert.ok(!r.texto.includes('@toyota.test'), 'nunca correos');
  assert.ok(!r.texto.includes('tokenbeto'), 'nunca tokens');
});

test('paginación de eventos por cursor: sin repetir ni saltar filas, y filtro por fecha de Lima', async () => {
  const e = entorno(); await sembrar(e.db);
  const lista = [];
  for (let i = 0; i < 7; i++) lista.push({ campana_id: 'c1', tipo: 'enlace_compartido', persona_id: 'e-beto', canal: 'correo', creado: '2026-11-0' + (1 + i) + 'T15:00:00.000Z' });
  lista.push({ campana_id: 'c1', tipo: 'enlace_compartido', persona_id: 'e-carla', canal: 'enlace', creado: '2026-11-03T15:00:00.000Z' });
  await registrarEventos(e.env, e.ctx, lista);
  const vistos = []; let cursor = '', vueltas = 0;
  do {
    const r = await pedir(e, 'conjunto=eventos&limite=3' + (cursor ? '&despues=' + encodeURIComponent(cursor) : ''));
    const j = await r.json();
    j.eventos.filas.forEach(f => vistos.push(f.evento_id));
    cursor = j.eventos.siguiente; vueltas++;
  } while (cursor && vueltas < 10);
  assert.equal(vistos.length, 8); assert.equal(new Set(vistos).size, 8); assert.equal(vueltas, 3);

  // 03-nov 15:00 UTC = 10:00 en Lima: el día 2026-11-03 de Lima trae los 2 eventos de ese día
  const dia = (await (await pedir(e, 'conjunto=eventos&desde=2026-11-03&hasta=2026-11-03')).json()).eventos.filas;
  assert.equal(dia.length, 2);
  assert.equal(dia[0].fecha_lima, '2026-11-03 10:00:00'); assert.equal(dia[0].persona_nombre === 'Beto Rojas' || dia[0].persona_nombre === 'Carla Díaz', true);
  assert.equal(dia[0].gerente_nombre, '');
  // primera página en CSV trae el cursor en la cabecera
  const csv = await pedir(e, 'conjunto=eventos&formato=csv&limite=2');
  assert.ok(csv.headers.get('x-siguiente'));
});
