// Pruebas unitarias de las reglas del flujo del Gerente (flujo.js: calcular), sin base de datos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcular } from '../../src/flujo.js';

const sup = (alcance = { gerencias: ['Ops'] }, id = 's1') => ({ id, nombre: 'Gerente', alcance: JSON.stringify(alcance) });
const proc = (id, gerencia, seccion, extra = {}) => ({ id, codigo: '', gerencia, seccion, macroproceso: '', proceso: 'Proc ' + id, subproceso: '', descripcion: 'd', fuente: 'inventario', fuera_alcance: 0, quitado_por: '', validacion: '', validado_en: null, ...extra });
const datos = ({ procs, estado = {}, delegados = {}, pasos = [], aprobaciones = [] }) => ({
  procs, pasos, aprobaciones,
  delegados: Object.fromEntries(Object.entries(delegados).map(([k, v]) => [k, new Set(v)])),
  cobertura: pid => ({ estado: estado[pid] || 'sin_cobertura', personas: 0, completos: 0, puntos: 0, total: 4 })
});
const paso = (n, s = 's1') => ({ supervisor_id: s, paso: n, confirmado_en: '2026-10-21T00:00:00Z' });
const PROCS = [proc('a', 'Ops', 'Planta'), proc('b', 'Ops', 'Planta'), proc('c', 'Fin', 'Tesorería')];

test('empieza en el paso 1 y solo ve lo de su alcance', () => {
  const e = calcular(datos({ procs: PROCS }), sup());
  assert.equal(e.paso_actual, 1);
  assert.deepEqual(e.procesos.map(p => p.id).sort(), ['a', 'b']);
  assert.deepEqual(e.gerencias, ['Ops']);
});

test('compuerta 1: debe quedar al menos un proceso', () => {
  assert.equal(calcular(datos({ procs: PROCS }), sup()).compuertas[1].ok, true);
  assert.equal(calcular(datos({ procs: [proc('a', 'Ops', 'P', { fuera_alcance: 1 })] }), sup()).compuertas[1].ok, false);
  assert.equal(calcular(datos({ procs: PROCS }), sup({ gerencias: ['Inexistente'] })).compuertas[1].ok, false);
});

test('compuerta 2: cada proceso necesita al menos un responsable', () => {
  const e = calcular(datos({ procs: PROCS, delegados: { a: ['p1'] } }), sup());
  assert.equal(e.compuertas[2].ok, false);
  assert.deepEqual(e.compuertas[2].faltan, ['Proc b']);
  assert.equal(calcular(datos({ procs: PROCS, delegados: { a: ['p1'], b: ['p1'] } }), sup()).compuertas[2].ok, true);
});

test('compuerta 3: respondido o no vigente; en curso y sin cobertura bloquean', () => {
  const e = (a, b) => calcular(datos({ procs: PROCS, estado: { a, b } }), sup()).compuertas[3].ok;
  assert.equal(e('respondido', 'respondido'), true);
  assert.equal(e('respondido', 'no_vigente'), true);
  assert.equal(e('respondido', 'en_curso'), false);
  assert.equal(e('respondido', 'sin_cobertura'), false);
});

test('compuerta 4: todos validados por MBC (actualizado no basta)', () => {
  const v = (x, y) => calcular(datos({ procs: [proc('a', 'Ops', 'P', { validacion: x }), proc('b', 'Ops', 'P', { validacion: y })] }), sup()).compuertas[4].ok;
  assert.equal(v('validado', 'validado'), true);
  assert.equal(v('validado', 'actualizado'), false);
  assert.equal(v('validado', ''), false);
});

test('un proceso quitado por el Gerente no cuenta en las compuertas pero se lista para restaurarlo', () => {
  const procs = [proc('a', 'Ops', 'P'), proc('q', 'Ops', 'P', { fuera_alcance: 1, quitado_por: 'Gerente' }), proc('x', 'Ops', 'P', { fuera_alcance: 1 })];
  const e = calcular(datos({ procs, delegados: { a: ['p1'] } }), sup());
  assert.equal(e.compuertas[2].ok, true, 'el quitado no exige responsable');
  assert.deepEqual(e.procesos.map(p => p.id).sort(), ['a', 'q'], 'el fuera de alcance de MBC no se lista');
  assert.equal(e.procesos.find(p => p.id === 'q').quitado, true);
});

test('los pasos se confirman en orden: la confirmación vale mientras su compuerta se cumpla', () => {
  const base = { procs: PROCS, delegados: { a: ['p'], b: ['p'] }, estado: { a: 'respondido', b: 'respondido' } };
  assert.deepEqual(calcular(datos({ ...base, pasos: [paso(1), paso(2), paso(3)] }), sup()).vigentes, [1, 2, 3]);
  assert.equal(calcular(datos({ ...base, pasos: [paso(1), paso(2), paso(3)] }), sup()).paso_actual, 4);
  // un paso confirmado salteado no cuenta aunque su compuerta se cumpla
  assert.deepEqual(calcular(datos({ ...base, pasos: [paso(2), paso(3)] }), sup()).vigentes, []);
  assert.equal(calcular(datos({ ...base, pasos: [paso(2), paso(3)] }), sup()).paso_actual, 1);
});

test('si cae la compuerta del paso 2, también se invalidan los pasos siguientes', () => {
  const e = calcular(datos({ procs: PROCS, delegados: { a: ['p'] }, estado: { a: 'respondido', b: 'respondido' }, pasos: [paso(1), paso(2), paso(3)] }), sup());
  assert.deepEqual(e.vigentes, [1], 'b quedó sin responsable: valen el 1 y nada más');
  assert.equal(e.paso_actual, 2);
});

test('si se agrega un proceso sin responder, el paso 3 deja de valer', () => {
  const procs = [...PROCS, proc('n', 'Ops', 'Planta')];
  const e = calcular(datos({ procs, delegados: { a: ['p'], b: ['p'], n: ['p'] }, estado: { a: 'respondido', b: 'respondido', n: 'sin_cobertura' }, pasos: [paso(1), paso(2), paso(3)] }), sup());
  assert.deepEqual(e.vigentes, [1, 2]);
  assert.equal(e.paso_actual, 3);
});

test('las confirmaciones de otro Supervisor no cuentan', () => {
  assert.deepEqual(calcular(datos({ procs: PROCS, pasos: [paso(1, 'otro')] }), sup()).vigentes, []);
});

test('con aprobación final el paso es 5 aunque las compuertas hayan cambiado después', () => {
  const e = calcular(datos({ procs: PROCS, aprobaciones: [{ supervisor_id: 's1', aprobado_en: 'x', gerencias: '["Ops"]', procesos: 2 }] }), sup());
  assert.equal(e.paso_actual, 5);
  assert.equal(e.aprobada, true);
});

test('una aprobación de otro Gerente no cierra el mío', () => {
  assert.equal(calcular(datos({ procs: PROCS, aprobaciones: [{ supervisor_id: 'otro' }] }), sup()).aprobada, false);
});

test('procesos incorporados de otra gerencia no lo hacen responsable de esa gerencia', () => {
  const e = calcular(datos({ procs: PROCS }), sup({ gerencias: ['Ops'], procesos: ['c'] }));
  assert.deepEqual(e.gerencias, ['Ops']);
  assert.equal(e.procesos.find(p => p.id === 'c').incorporado, true);
  assert.equal(e.procesos.find(p => p.id === 'a').incorporado, false);
  assert.equal(e.compuertas[2].faltan.length, 3, 'pero sí cuentan en las compuertas');
});

test('un Gerente con solo procesos sueltos no tiene gerencias propias (no puede dejar «aprobada» una gerencia ajena)', () => {
  assert.deepEqual(calcular(datos({ procs: PROCS }), sup({ procesos: ['c'] })).gerencias, []);
});

test('«faltan» se limita a 50 nombres para no inflar la respuesta', () => {
  const procs = Array.from({ length: 80 }, (_, i) => proc('p' + i, 'Ops', 'S'));
  assert.equal(calcular(datos({ procs }), sup()).compuertas[2].faltan.length, 50);
});

test('el proceso sin nombre se muestra con un texto en lugar de vacío', () => {
  const e = calcular(datos({ procs: [proc('a', 'Ops', 'S', { proceso: '', subproceso: '', macroproceso: '' })] }), sup());
  assert.ok(e.compuertas[2].faltan[0].length > 0);
});

test('el estado del proceso viene de la cobertura y los puntos se reportan', () => {
  const e = calcular(datos({ procs: PROCS, estado: { a: 'en_curso' } }), sup());
  assert.equal(e.procesos.find(p => p.id === 'a').estado, 'en_curso');
  assert.equal(e.procesos.find(p => p.id === 'a').total, 4);
});

// ---- perfil Supervisor: su flujo termina en el paso 3 (la validación final es del Gerente)
const supervisor = (perfil, alcance = { gerencias: ['Ops'] }) => ({ id: 's1', nombre: 'X', perfil, alcance: JSON.stringify(alcance) });
const BASE3 = { procs: PROCS, delegados: { a: ['p'], b: ['p'] }, estado: { a: 'respondido', b: 'respondido' }, pasos: [paso(1), paso(2), paso(3)] };

test('un Supervisor con los 3 pasos confirmados queda terminado', () => {
  const e = calcular(datos(BASE3), supervisor('supervisor'));
  assert.equal(e.terminado, true);
  assert.equal(e.perfil, 'supervisor');
});

test('un Gerente con los 3 pasos confirmados NO está terminado: le falta la validación final', () => {
  const e = calcular(datos(BASE3), supervisor('gerente'));
  assert.equal(e.terminado, false);
  assert.equal(e.paso_actual, 4);
});

test('sin perfil se trata como Gerente (los Supervisores anteriores a los perfiles)', () => {
  const e = calcular(datos(BASE3), supervisor(undefined));
  assert.equal(e.perfil, 'gerente');
  assert.equal(e.terminado, false);
});

test('un Supervisor a medias no está terminado', () => {
  const e = calcular(datos({ ...BASE3, pasos: [paso(1), paso(2)] }), supervisor('supervisor'));
  assert.equal(e.terminado, false);
  assert.equal(e.paso_actual, 3);
});

test('si a un Supervisor ya terminado se le cae una compuerta, deja de estar terminado', () => {
  const e = calcular(datos({ ...BASE3, estado: { a: 'respondido', b: 'en_curso' } }), supervisor('supervisor'));
  assert.equal(e.terminado, false);
  assert.deepEqual(e.vigentes, [1, 2]);
});
