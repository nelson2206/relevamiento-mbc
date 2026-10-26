// Pruebas unitarias de estructura.js: esqueleto Área > Gerencia > Sección y vinculación de filas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararEstructura, areasDeEstructura } from '../../src/estructura.js';

const sinTilde = x => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fila = (area, gerencia, seccion, orden = 0) => ({ clave: sinTilde(gerencia) + '|' + sinTilde(seccion), area, gerencia, seccion, orden });
const H = (area, gerencia, seccion) => ({ area, gerencia, seccion });

test('sin esqueleto (ni existente ni hoja) está inactivo y no toca los nombres', () => {
  const E = prepararEstructura([], []);
  assert.equal(E.activo(), false);
  assert.deepEqual(E.vincular('Libre', 'Sec', 'procesos'), ['Libre', 'Sec']);
  assert.equal(E.resultado().total, 0);
});

test('una hoja con filas lo activa; descarta filas sin gerencia', () => {
  const E = prepararEstructura([], [H('A', 'Logística', 'Importaciones'), H('A', '', 'Huérfana'), H('', '   ', 'x')]);
  assert.equal(E.activo(), true);
  assert.equal(E.resultado().total, 1);
});

test('vincula por nombre sin importar mayúsculas ni tildes', () => {
  const E = prepararEstructura([], [H('Ops', 'Logística', 'Importaciones')]);
  assert.deepEqual(E.vincular('LOGISTICA', 'importaciones', 'procesos'), ['Logística', 'Importaciones']);
  assert.equal(E.resultado().sin_vincular.length, 0);
});

test('una sección desconocida se crea, se informa y hereda el área de su gerencia', () => {
  const E = prepararEstructura([], [H('Ops', 'Logística', 'Importaciones')]);
  assert.deepEqual(E.vincular('logistica', 'Transporte', 'procesos'), ['Logística', 'Transporte']);
  const r = E.resultado();
  assert.equal(r.total, 2);
  assert.deepEqual(r.sin_vincular, [{ gerencia: 'Logística', seccion: 'Transporte', procesos: 1, personas: 0 }]);
  const sql = [];
  E.sentencias({ DB: { prepare: s => ({ bind: (...a) => { sql.push({ s, a }); return {}; } }) } }, 'c1');
  const insertTransporte = sql.find(x => x.a.includes('Transporte'));
  assert.ok(insertTransporte && insertTransporte.a.includes('Ops'), 'la fila nueva se guarda con el área de la gerencia');
});

test('cuenta cuántas filas de cada tipo no estaban vinculadas', () => {
  const E = prepararEstructura([], [H('', 'G', 'S1')]);
  E.vincular('G', 'S2', 'procesos'); E.vincular('G', 'S2', 'procesos'); E.vincular('g', 's2', 'personas');
  assert.deepEqual(E.resultado().sin_vincular, [{ gerencia: 'G', seccion: 'S2', procesos: 2, personas: 1 }], 'una sola entrada, aunque escrita distinto');
});

test('personas: sin sección o con una desconocida van a la única sección de la gerencia', () => {
  const E = prepararEstructura([], [H('', 'Finanzas', 'Tesorería')]);
  assert.deepEqual(E.vincular('Finanzas', '', 'personas', true), ['Finanzas', 'Tesorería']);
  assert.deepEqual(E.vincular('Finanzas', 'Tesoreria', 'personas', true), ['Finanzas', 'Tesorería']);
  assert.equal(E.resultado().sin_vincular.length, 0);
});

test('personas: con varias secciones y una desconocida NO se adivina: se crea la sección', () => {
  const E = prepararEstructura([], [H('', 'Ops', 'Planta'), H('', 'Ops', 'Logística')]);
  assert.deepEqual(E.vincular('Ops', 'Almacén', 'personas', true), ['Ops', 'Almacén']);
  assert.equal(E.resultado().sin_vincular.length, 1);
});

test('procesos: nunca se reubican a la fuerza aunque la gerencia tenga una sola sección', () => {
  const E = prepararEstructura([], [H('', 'Finanzas', 'Tesorería')]);
  assert.deepEqual(E.vincular('Finanzas', 'Impuestos', 'procesos', false), ['Finanzas', 'Impuestos']);
});

test('sin sección en un proceso no se puede crear fila: se devuelve tal cual', () => {
  const E = prepararEstructura([], [H('', 'Ops', 'Planta')]);
  const antes = E.resultado().total;
  assert.deepEqual(E.vincular('Ops', '', 'procesos', false), ['Ops', '']);
  assert.equal(E.resultado().total, antes, 'no inventa una fila vacía');
});

test('gerencia nueva y sección nueva: se crea sin área', () => {
  const E = prepararEstructura([], [H('A', 'Ops', 'Planta')]);
  assert.deepEqual(E.vincular('Nueva', 'S', 'personas', true), ['Nueva', 'S']);
  assert.equal(E.resultado().sin_vincular[0].gerencia, 'Nueva');
});

test('el área es de la gerencia: se copia a todas sus secciones', () => {
  const E = prepararEstructura([], [H('', 'Ops', 'Planta'), H('Industria', 'Ops', 'Logística')]);
  const sql = []; E.sentencias({ DB: { prepare: () => ({ bind: (...a) => { sql.push(a); return {}; } }) } }, 'c1');
  assert.ok(sql.every(a => a.includes('Industria')), 'ambas filas quedan con el área');
});

test('una carga nueva cambia el área de una gerencia existente (solo actualiza, no duplica)', () => {
  const E = prepararEstructura([fila('Vieja', 'Finanzas', 'Tesorería'), fila('Vieja', 'Finanzas', 'Contabilidad', 1)], [H('Nueva', 'finanzas', 'tesoreria')]);
  assert.equal(E.resultado().total, 2);
  assert.equal(E.resultado().nuevas, 0);
  const sql = []; E.sentencias({ DB: { prepare: s => ({ bind: (...a) => { sql.push({ s, a }); return {}; } }) } }, 'c1');
  assert.equal(sql.length, 2, 'una actualización por cada sección de la gerencia');
  assert.ok(sql.every(x => x.s.startsWith('UPDATE') && x.a[0] === 'Nueva'));
});

test('si la hoja trae una fila existente sin área, no borra el área que ya tenía', () => {
  const E = prepararEstructura([fila('Ops', 'Logística', 'Importaciones')], [H('', 'Logística', 'Importaciones')]);
  const sql = []; E.sentencias({ DB: { prepare: s => ({ bind: (...a) => { sql.push({ s, a }); return {}; } }) } }, 'c1');
  assert.equal(sql.length, 0, 'sin cambios');
});

test('avisa cuando una gerencia aparece en dos áreas dentro de la misma hoja', () => {
  const E = prepararEstructura([], [H('A', 'Doble', 'S1'), H('B', 'Doble', 'S2')]);
  assert.equal(E.resultado().avisos.length, 1);
  assert.match(E.resultado().avisos[0], /Doble/);
});

test('no avisa si la gerencia repite la misma área (distinta escritura)', () => {
  const E = prepararEstructura([], [H('Soporte', 'Fin', 'S1'), H('SOPORTE', 'Fin', 'S2')]);
  assert.equal(E.resultado().avisos.length, 0);
});

test('modo agregar: lo existente se respeta y se usa su escritura', () => {
  const E = prepararEstructura([fila('Ops', 'Logística', 'Importaciones')], []);
  assert.equal(E.activo(), true);
  assert.deepEqual(E.vincular('logistica', 'IMPORTACIONES', 'procesos'), ['Logística', 'Importaciones']);
});

test('una gerencia declarada sin sección sirve para dar el nombre y se completa luego', () => {
  const E = prepararEstructura([], [H('Soporte', 'Legal', '')]);
  assert.equal(E.resultado().total, 1);
  assert.deepEqual(E.vincular('legal', 'Contratos', 'procesos'), ['Legal', 'Contratos']);
  const sql = []; E.sentencias({ DB: { prepare: () => ({ bind: (...a) => { sql.push(a); return {}; } }) } }, 'c1');
  assert.ok(sql.some(a => a.includes('Contratos') && a.includes('Soporte')), 'la sección nueva hereda el área');
});

test('estructuras grandes: 2000 filas se procesan en tiempo razonable', () => {
  const hoja = Array.from({ length: 2000 }, (_, i) => H('A' + (i % 10), 'G' + (i % 100), 'S' + i));
  const t = Date.now();
  const E = prepararEstructura([], hoja);
  for (let i = 0; i < 200; i++) E.vincular('g' + (i % 100), 's' + i, 'procesos');
  assert.equal(E.resultado().total, 2000);
  assert.ok(Date.now() - t < 3000, 'tardó ' + (Date.now() - t) + ' ms');
});

test('areasDeEstructura: solo gerencias con al menos una sección, ordenadas', () => {
  const r = areasDeEstructura([fila('', 'Legal', ''), fila('', 'Zeta', 'B', 1), fila('', 'Zeta', 'A', 2), fila('', 'Alfa', 'X', 3)]);
  assert.deepEqual(r, [{ gerencia: 'Alfa', secciones: ['X'] }, { gerencia: 'Zeta', secciones: ['A', 'B'] }]);
});
