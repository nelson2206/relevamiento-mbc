// Pruebas unitarias de cobertura.js: cuándo un proceso cuenta como respondido.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCobertura } from '../../src/cobertura.js';

// Tres bloques de ejemplo con 4 puntos en total (a, b | c | d)
const BLOQUES = [{ id: 'b1', puntos: [['a'], ['b']] }, { id: 'b2', puntos: [['c']] }, { id: 'b3', puntos: [['d']] }];
const ck = (...ids) => JSON.stringify(Object.fromEntries(ids.map(i => [i, { estado: 'cubierto' }])));
const resp = (e, p, pregunta, checklist, texto = '', sistemas = '[]') => ({ encuestado_id: e, proceso_id: p, pregunta, checklist, texto, sistemas });
const cob = (o = {}) => crearCobertura({ bloques: BLOQUES, revisiones: [], respuestas: [], precarga: [], ...o });

test('sin ninguna actividad: sin cobertura', () => {
  assert.equal(cob()('p1').estado, 'sin_cobertura');
});

test('una persona completa los 3 bloques: respondido', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b')), resp('e1', 'p1', 'b2', ck('c')), resp('e1', 'p1', 'b3', ck('d'))] });
  const r = c('p1');
  assert.equal(r.estado, 'respondido');
  assert.equal(r.puntos, 4);
  assert.equal(r.total, 4);
});

test('faltando un punto no está respondido', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b')), resp('e1', 'p1', 'b2', ck('c'))] });
  assert.notEqual(c('p1').estado, 'respondido');
  assert.equal(c('p1').puntos, 3);
});

test('«no aplica» cuenta como punto listo', () => {
  const na = JSON.stringify({ a: { estado: 'cubierto' }, b: { estado: 'no_aplica' } });
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', na), resp('e1', 'p1', 'b2', ck('c')), resp('e1', 'p1', 'b3', ck('d'))] });
  assert.equal(c('p1').estado, 'respondido');
});

test('un punto en estado «falta» no cuenta', () => {
  const falta = JSON.stringify({ a: { estado: 'cubierto' }, b: { estado: 'falta' } });
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', falta), resp('e1', 'p1', 'b2', ck('c')), resp('e1', 'p1', 'b3', ck('d'))] });
  assert.notEqual(c('p1').estado, 'respondido');
});

test('cobertura combinada: dos personas cubren puntos distintos y entre las dos completan', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b')), resp('e2', 'p1', 'b2', ck('c')), resp('e2', 'p1', 'b3', ck('d'))] });
  assert.equal(c('p1').estado, 'respondido');
  assert.equal(c('p1').completos, 1);
});

test('los puntos que cargó el equipo (precarga) cuentan', () => {
  const c = cob({ precarga: [{ proceso_id: 'p1', punto: 'a' }, { proceso_id: 'p1', punto: 'b' }, { proceso_id: 'p1', punto: 'c' }], respuestas: [resp('e1', 'p1', 'b3', ck('d'))] });
  assert.equal(c('p1').estado, 'respondido');
});

test('la precarga sola, sin ninguna persona, no hace respondido un proceso', () => {
  const c = cob({ precarga: ['a', 'b', 'c', 'd'].map(punto => ({ proceso_id: 'p1', punto })) });
  assert.equal(c('p1').estado, 'sin_cobertura');
});

test('un punto que no existe en los bloques se ignora (no suma de más)', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b', 'zzz'))] });
  assert.equal(c('p1').puntos, 2);
  assert.equal(c('p1').total, 4);
});

test('en curso: alguien tomó el proceso (revisión vigente o con cambio)', () => {
  for (const estado of ['vigente', 'cambio']) {
    assert.equal(cob({ revisiones: [{ encuestado_id: 'e1', proceso_id: 'p1', estado }] })('p1').estado, 'en_curso', estado);
  }
});

test('en curso: respondió algo de texto aunque no haya checklist', () => {
  assert.equal(cob({ respuestas: [resp('e1', 'p1', 'b1', '{}', 'algo')] })('p1').estado, 'en_curso');
  assert.equal(cob({ respuestas: [resp('e1', 'p1', 'b2', '{}', '', '["SAP"]')] })('p1').estado, 'en_curso', 'una lista de sistemas también cuenta');
});

test('una fila vacía (sin texto, sin sistemas, sin checklist) no cuenta como actividad', () => {
  assert.equal(cob({ respuestas: [resp('e1', 'p1', 'b1', '{}', '   ', '[]')] })('p1').estado, 'sin_cobertura');
});

test('no vigente: todos dicen «ya no existe» y nadie lo toma', () => {
  assert.equal(cob({ revisiones: [{ encuestado_id: 'e1', proceso_id: 'p1', estado: 'no_existe' }] })('p1').estado, 'no_vigente');
});

test('«no participo» no cuenta como tomarlo', () => {
  assert.equal(cob({ revisiones: [{ encuestado_id: 'e1', proceso_id: 'p1', estado: 'no_participo' }] })('p1').estado, 'sin_cobertura');
});

test('si uno dice «no existe» y otro lo toma, está en curso (no «no vigente»)', () => {
  const c = cob({ revisiones: [{ encuestado_id: 'e1', proceso_id: 'p1', estado: 'no_existe' }, { encuestado_id: 'e2', proceso_id: 'p1', estado: 'vigente' }] });
  assert.equal(c('p1').estado, 'en_curso');
});

test('formato anterior: las 6 preguntas q1..q6 con contenido completan el proceso', () => {
  const rs = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(q => resp('e1', 'p1', q, '{}', 'texto'));
  assert.equal(cob({ respuestas: rs })('p1').estado, 'respondido');
  assert.notEqual(cob({ respuestas: rs.slice(0, 5) })('p1').estado, 'respondido', 'con 5 de 6 no');
});

test('los procesos no se mezclan entre sí', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b')), resp('e1', 'p1', 'b2', ck('c')), resp('e1', 'p1', 'b3', ck('d'))] });
  assert.equal(c('p1').estado, 'respondido');
  assert.equal(c('p2').estado, 'sin_cobertura');
});

test('checklist dañado o vacío no rompe el cálculo', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', 'no es json', 'x'), resp('e1', 'p1', 'b2', null, 'x'), resp('e1', 'p1', 'b3', '', 'x'), resp('e1', 'p1', 'b1', 'null')] });
  assert.doesNotThrow(() => c('p1'));
  assert.equal(c('p1').estado, 'en_curso');
});

test('sin bloques definidos nada puede estar respondido (evita aprobar sin checklist)', () => {
  const c = crearCobertura({ bloques: [], revisiones: [{ encuestado_id: 'e1', proceso_id: 'p1', estado: 'vigente' }], respuestas: [resp('e1', 'p1', 'b1', ck('a'), 'x')], precarga: [] });
  assert.notEqual(c('p1').estado, 'respondido');
});

// ---- avance de una persona en un proceso (para el equipo del Gerente y del Supervisor)
test('cobertura.persona: puntos listos y total de una persona', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b')), resp('e2', 'p1', 'b1', ck('a'))] });
  assert.deepEqual(c.persona('p1', 'e1'), { listos: 2, total: 4, completo: false });
  assert.deepEqual(c.persona('p1', 'e2'), { listos: 1, total: 4, completo: false });
});

test('cobertura.persona: completo solo cuando cubrió todos los puntos', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b')), resp('e1', 'p1', 'b2', ck('c')), resp('e1', 'p1', 'b3', ck('d'))] });
  assert.equal(c.persona('p1', 'e1').completo, true);
  assert.equal(c.persona('p1', 'e1').listos, 4);
});

test('cobertura.persona: una persona sin nada tiene 0 puntos y no está completa; los puntos del equipo (precarga) cuentan', () => {
  assert.deepEqual(cob().persona('p1', 'nadie'), { listos: 0, total: 4, completo: false });
  const conPre = cob({ precarga: [{ proceso_id: 'p1', punto: 'a' }, { proceso_id: 'p1', punto: 'b' }] });
  assert.equal(conPre.persona('p1', 'e1').listos, 2);
});

test('cobertura.persona: el formato anterior (q1..q6) cuenta como completo', () => {
  const rs = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(q => resp('e1', 'p1', q, '{}', 'texto'));
  assert.equal(cob({ respuestas: rs }).persona('p1', 'e1').completo, true);
});

test('cobertura.persona: no mezcla personas ni procesos', () => {
  const c = cob({ respuestas: [resp('e1', 'p1', 'b1', ck('a', 'b'))] });
  assert.equal(c.persona('p2', 'e1').listos, 0);
  assert.equal(c.persona('p1', 'e2').listos, 0);
});
