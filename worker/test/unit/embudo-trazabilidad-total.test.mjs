// Trazabilidad total del llenado: universo completo de gerencias y secciones (A), avance oficial vs. asumido (B), comparación tolerante (C),
// pasos 1 y 2 del gerente en vivo (D), foto diaria (E) y las hojas/conjuntos nuevos (gerentes, gerencias, secciones, avance_diario).
//   node --test test/unit/embudo-trazabilidad-total.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularFunnel, backfillEmbudo, mediana } from '../../src/embudo.js';
import { fotoDiaria } from '../../src/embudo-areas.js';
import { entorno, sembrar, eventos, G, S } from './embudo-ayuda.mjs';

const BLOQUES = [{ id: 'b1', puntos: [['a'], ['b']] }, { id: 'b2', puntos: [['c']] }, { id: 'b3', puntos: [['d']] }];
const camp = { id: 'c1', nombre: 'PRUEBA' };
const ck = (...ids) => JSON.stringify(Object.fromEntries(ids.map(i => [i, { estado: 'cubierto' }])));
const resp = (db, e, p, pregunta, checklist, texto = '') =>
  db.prepare('INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, checklist, actualizado) VALUES (?,?,?,?,?,?)').run(e, p, pregunta, texto, checklist, '2026-11-09T10:00:00.000Z');
const completar = (db, e, p) => { resp(db, e, p, 'b1', ck('a', 'b'), 'x'); resp(db, e, p, 'b2', ck('c')); resp(db, e, p, 'b3', ck('d')); };
const proceso = (db, id, g, s, extra = '') => db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso, fuente, codigo, fuera_alcance) VALUES (?, 'c1', ?, ?, ?, 'inventario', ?, ?)").run(id, g, s, 'Proceso ' + id, id, extra ? 1 : 0);
const persona = (db, id, nombre, g, s, pin = '') => db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, creado, pin_hash, pin_sal) VALUES (?, 'c1', ?, ?, ?, ?, '2026-11-01T10:00:00.000Z', ?, ?)").run(id, 'tok' + id + '0123456789012', nombre, g, s, pin, pin ? 's' : '');
const fila = (f, g) => f.gerencias.find(x => x.gerencia === g);

test('A. todas las gerencias y secciones salen de los procesos y la estructura, aunque no tengan personas', async () => {
  const e = entorno(); await sembrar(e.db);
  proceso(e.db, 'q0', 'Compras', 'Pagos'); proceso(e.db, 'q1', 'Compras', 'Pagos'); proceso(e.db, 'q2', 'Compras', 'Pagos', 'fuera');   // el fuera de alcance no cuenta
  e.db.prepare("INSERT INTO estructura (campana_id, clave, area, gerencia, seccion, orden) VALUES ('c1','finanzas|tesoreria','','Finanzas','Tesorería',0)").run();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.deepEqual(f.resumen.map(x => x.gerencia), ['Compras', G], 'una fila por gerencia con procesos o personas, aunque no tenga personas');
  const compras = f.resumen[0];
  assert.equal(compras.procesos_vigentes, 2); assert.equal(compras.personas_registradas, 0); assert.equal(compras.avance_pct, 0); assert.equal(compras.estado, 'Sin iniciar');
  assert.ok(!f.resumen.some(x => x.gerencia === 'Finanzas'), 'un área que solo está en la estructura (sin procesos ni personas) no se informa');
  assert.deepEqual(f.secciones.map(x => x.seccion).sort(), ['Pagos', S].sort());
  assert.equal(fila(f, 'Total').procesos_vigentes, 5);   // 3 de Legal + 2 de Compras
  assert.equal(fila(f, 'Compras').p1_acceso_generado, 0);
  assert.equal(fila(f, 'Compras').pct_p4_personas_abrieron, '', 'sin personas no hay porcentaje (no es 0 %)');
});

test('B. avance oficial = respondidos / vigentes (los no vigentes no cuentan); el de lo asumido va en columna aparte (caso 1 de 62)', async () => {
  const e = entorno(); await sembrar(e.db);
  for (let i = 0; i < 62; i++) proceso(e.db, 'o' + i, 'Operaciones', 'Taller');
  persona(e.db, 'e-hugo', 'Hugo Paz', 'Operaciones', 'Taller', 'h');
  e.db.prepare("INSERT INTO revisiones (encuestado_id, proceso_id, estado, actualizado) VALUES ('e-hugo','o0','vigente','2026-11-05T10:00:00.000Z')").run();
  completar(e.db, 'e-hugo', 'o0');
  let f = await calcularFunnel(e.env, camp, BLOQUES);
  const op = f.resumen.find(x => x.gerencia === 'Operaciones');
  assert.equal(op.procesos_vigentes, 62); assert.equal(op.procesos_respondidos, 1);
  assert.equal(op.avance_pct, 1.6, 'oficial: 1 de 62'); assert.equal(op.avance_asumido_pct, 100, 'asumido por Hugo: 1 de 1');
  assert.equal(op.estado, 'En levantamiento');
  // Cuatro procesos que nadie hace ya (marcados «no existe») salen del denominador.
  for (let i = 1; i <= 4; i++) e.db.prepare("INSERT INTO revisiones (encuestado_id, proceso_id, estado, actualizado) VALUES ('e-hugo',?,'no_existe','2026-11-05T10:00:00.000Z')").run('o' + i);
  f = await calcularFunnel(e.env, camp, BLOQUES);
  const op2 = f.resumen.find(x => x.gerencia === 'Operaciones');
  assert.equal(op2.procesos_vigentes, 58); assert.equal(op2.avance_pct, 1.7);
  assert.equal(f.secciones.find(x => x.seccion === 'Taller').procesos_no_vigentes, 4);
});

test('C. gerencia y sección se comparan sin tildes ni mayúsculas; el servidor devuelve el nombre canónico', async () => {
  const e = entorno(); await sembrar(e.db);
  e.db.prepare("UPDATE encuestados SET gerencia='GERENCIA LEGAL', seccion='seccion legal', pin_hash='h', pin_sal='s' WHERE id='e-carla'").run();
  persona(e.db, 'e-zeta', 'Zeta Nueva', 'Área Rara', 'Sub Rara', 'h');   // área que no está en procesos ni estructura: no se pierde
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  const carla = f.usuarios.find(u => u.usuario === 'Carla Díaz');
  assert.equal(carla.gerencia, G); assert.equal(carla.seccion, S, 'toma el nombre canónico de los procesos');
  assert.equal(fila(f, G).personas, 2); assert.equal(fila(f, G).registrados, 1);
  assert.ok(f.resumen.some(x => x.gerencia === 'Área Rara'), 'una persona en un área desconocida tampoco se pierde');
  assert.equal(f.secciones.filter(x => x.gerencia === G).length, 1, 'no se duplica la sección por la escritura');
});

// Gerente nuevo (Carla) con perfil dado desde la consola de MBC.
async function conGerente(e) {
  const r = await e.admin('POST', '/a/persona/perfil', { campana_id: 'c1', encuestado_id: 'e-carla', perfil: 'gerente' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.ok(r.clave);
  return r;
}
const entrar = (e, clave, q = '') => e.llamar('GET', '/c/campana' + q, null, { 'x-client-code': clave });

test('D1. acceso_gerente_generado: al dar el perfil y al renovar la clave; no al volver a guardar sin clave nueva', async () => {
  const e = entorno(); await sembrar(e.db);
  const r = await conGerente(e);
  let ev = eventos(e.db, 'acceso_gerente_generado');
  assert.equal(ev.length, 1); assert.equal(ev[0].actor_tipo, 'admin'); assert.equal(ev[0].persona_id, 'e-carla'); assert.equal(ev[0].reconstruido, 0);
  const d = JSON.parse(ev[0].detalle);
  assert.equal(d.motivo, 'alta'); assert.equal(d.perfil, 'gerente'); assert.ok(d.supervisor_id);
  assert.ok(!ev[0].detalle.includes(r.clave), 'la clave nunca se guarda en el evento');
  await e.admin('POST', '/a/persona/perfil', { campana_id: 'c1', encuestado_id: 'e-carla', perfil: 'gerente' });
  assert.equal(eventos(e.db, 'acceso_gerente_generado').length, 1, 'sin clave nueva no hay evento');
  await e.admin('POST', '/a/persona/perfil', { campana_id: 'c1', encuestado_id: 'e-carla', perfil: 'gerente', regenerar: true });
  ev = eventos(e.db, 'acceso_gerente_generado');
  assert.equal(ev.length, 2); assert.equal(JSON.parse(ev[1].detalle).motivo, 'regenerada');
  const dl = await e.admin('POST', '/a/personas/claves', { campana_id: 'c1', encuestado_ids: ['e-carla', 'e-beto'] });
  assert.equal(dl.claves.length, 1);
  ev = eventos(e.db, 'acceso_gerente_generado');
  assert.equal(ev.length, 3); assert.equal(JSON.parse(ev[2].detalle).motivo, 'descarga');
  // El administrador del cliente también puede crear una cuenta de supervisor (sin persona vinculada).
  const s = await e.cliente('/c/supervisores', { accion: 'crear', nombre: 'Sara Cliente', alcance: { todo: true } });
  assert.equal(s.status, 200, JSON.stringify(s));
  const ult = eventos(e.db, 'acceso_gerente_generado').pop();
  assert.equal(ult.actor_tipo, 'cliente'); assert.equal(ult.persona_id, '');
});

test('D2. acceso_gerente_enviado: solo el administrador MBC, solo gerentes/supervisores activos, canal outlook, sin clave', async () => {
  const e = entorno(); await sembrar(e.db);
  const r = await conGerente(e);
  const sin = await e.llamar('POST', '/a/embudo/marcar-enviado', { campana_id: 'c1', encuestado_ids: ['e-carla'] });
  assert.equal(sin.status, 401, 'sin código de administrador no entra');
  const gerente = await e.gerente('/a/embudo/marcar-enviado', { campana_id: 'c1', encuestado_ids: ['e-carla'] });
  assert.equal(gerente.status, 401, 'la clave de un gerente tampoco');
  assert.equal((await e.admin('POST', '/a/embudo/marcar-enviado', { campana_id: 'no-existe', encuestado_ids: ['e-carla'] })).status, 404);
  const ok = await e.admin('POST', '/a/embudo/marcar-enviado', { campana_id: 'c1', encuestado_ids: ['e-carla', 'e-beto', 'e-carla'] });
  assert.equal(ok.status, 200); assert.equal(ok.marcados, 1, 'Beto no es gerente: se ignora; el repetido cuenta una vez');
  const ev = eventos(e.db, 'acceso_gerente_enviado');
  assert.equal(ev.length, 1); assert.equal(ev[0].canal, 'outlook'); assert.equal(ev[0].actor_tipo, 'admin'); assert.equal(ev[0].persona_id, 'e-carla'); assert.equal(ev[0].gerencia, G);
  assert.ok(!ev[0].detalle.includes(r.clave));
});

test('D3. gerente_abrio una sola vez y gerente_entro en cada ingreso; las recargas y el administrador del cliente no cuentan', async () => {
  const e = entorno(); await sembrar(e.db);
  const { clave } = await conGerente(e);
  assert.equal((await entrar(e, clave)).status, 200);
  assert.equal(eventos(e.db, 'gerente_abrio').length, 1); assert.equal(eventos(e.db, 'gerente_entro').length, 1);
  const abrio = eventos(e.db, 'gerente_abrio')[0];
  assert.equal(abrio.actor_tipo, 'gerente'); assert.equal(abrio.persona_id, 'e-carla'); assert.ok(abrio.clave.startsWith('gabrio|'));
  await entrar(e, clave);                         // segundo ingreso (inicia sesión otra vez)
  assert.equal(eventos(e.db, 'gerente_abrio').length, 1, 'abrir la primera vez es idempotente'); assert.equal(eventos(e.db, 'gerente_entro').length, 2);
  await entrar(e, clave, '?recarga=1');           // recarga después de agregar/asignar: no es un ingreso
  await entrar(e, clave, '?recarga=1');
  assert.equal(eventos(e.db, 'gerente_entro').length, 2, 'las recargas no registran nada');
  await e.llamar('GET', '/c/campana', null, { 'x-client-code': 'clave-cliente-1' });
  assert.equal(eventos(e.db, 'gerente_entro').length, 2, 'el administrador del cliente no es un gerente');
  assert.ok(!JSON.stringify(eventos(e.db)).includes(clave), 'ningún evento guarda la clave');
});

test('E. foto diaria: desde las 23:00 de Lima, una vez al día, idempotente; la inicial del backfill se reemplaza', async () => {
  const e = entorno(); await sembrar(e.db);
  proceso(e.db, 'q0', 'Compras', 'Pagos');
  persona(e.db, 'e-hugo', 'Hugo Paz', G, S, 'h'); completar(e.db, 'e-hugo', 'p0');
  const filas = () => e.db.prepare('SELECT * FROM avance_diario ORDER BY dia, gerencia, seccion').all();
  // 22:00 de Lima (03:00 UTC del día siguiente): todavía no.
  const antes = await fotoDiaria(e.env, BLOQUES, { ahora: new Date('2026-11-12T03:00:00.000Z') });
  assert.match(antes.omitida, /23:00/); assert.equal(filas().length, 0);
  // Foto inicial del backfill (reconstruido=1) el mismo día.
  const bk = await backfillEmbudo(e.env, 'c1', BLOQUES);
  assert.ok(bk.foto_inicial > 0); const hoy = filas();
  assert.equal(hoy.length, bk.foto_inicial); assert.ok(hoy.every(x => x.reconstruido === 1));
  // 23:30 de Lima del 11-nov (04:30 UTC del 12): toma la foto medida y reemplaza la inicial de ese día.
  const dia = '2026-11-11';
  e.db.prepare('UPDATE avance_diario SET dia=?').run(dia);   // la inicial quedó con la fecha de hoy real; la ponemos en el día simulado
  const a = await fotoDiaria(e.env, BLOQUES, { ahora: new Date('2026-11-12T04:30:00.000Z') });
  assert.equal(a.dia, dia); assert.equal(a.campanas, 1);
  const f1 = filas();
  assert.equal(f1.length, hoy.length, 'mismas claves: reemplazó, no duplicó'); assert.ok(f1.every(x => x.reconstruido === 0));
  const legal = f1.find(x => x.gerencia === G && x.seccion === S), gerLegal = f1.find(x => x.gerencia === G && x.seccion === '');
  assert.equal(legal.procesos_vigentes, 3); assert.equal(legal.procesos_respondidos, 1); assert.equal(legal.personas, 3); assert.equal(legal.personas_con_acceso, 1);
  assert.equal(gerLegal.procesos_respondidos, 1, 'fila de la gerencia (sección vacía) = total de sus secciones');
  assert.equal(f1.find(x => x.gerencia === 'Compras' && x.seccion === '').procesos_vigentes, 1);
  // Segunda corrida del mismo día (el cron corre cada 15 minutos): no hace nada.
  const b = await fotoDiaria(e.env, BLOQUES, { ahora: new Date('2026-11-12T04:45:00.000Z') });
  assert.equal(b.campanas, 0); assert.equal(filas().length, f1.length);
  // Repetir el backfill no pisa la foto medida.
  e.db.prepare('UPDATE avance_diario SET dia=?').run(new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10));
  await backfillEmbudo(e.env, 'c1', BLOQUES);
  assert.ok(filas().every(x => x.reconstruido === 0), 'la foto medida de ese día se conserva');
});

test('hojas nuevas: gerentes, embudo por gerencia (7 puntos), usuarios y evolución', async () => {
  const e = entorno(); await sembrar(e.db);
  e.db.prepare("UPDATE supervisores SET activo=0 WHERE id='s-ger'").run();   // el gerente de la semilla no entra en esta cuenta: solo Carla
  persona(e.db, 'e-hugo', 'Hugo Paz', G, S, 'h');
  const { clave } = await conGerente(e);
  await e.admin('POST', '/a/embudo/marcar-enviado', { campana_id: 'c1', encuestado_ids: ['e-carla'] });
  await entrar(e, clave); await entrar(e, clave);
  const comp = await e.llamar('POST', '/c/enlaces', { encuestado_ids: ['e-beto'], para: 'correo' }, { 'x-client-code': clave });
  assert.equal(comp.status, 200);
  await e.llamar('POST', '/c/asignar', { encuestado_id: 'e-beto', agregar: ['p0'] }, { 'x-client-code': clave });
  await e.llamar('GET', `/r/abierta?c=abcdefghij&g=${encodeURIComponent(G)}&s=${encodeURIComponent(S)}&v=11111111-1111-4111-8111-111111111111`);
  await e.llamar('POST', '/r/identificar', { c: 'abcdefghij', id: 'e-beto', pin: '4821', v: '11111111-1111-4111-8111-111111111111' });
  await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  const f = await e.admin('GET', '/a/embudo/funnel?campana_id=c1');
  assert.equal(f.status, 200);

  const g = f.gerentes.find(x => x.gerente_nombre === 'Carla Díaz');
  assert.equal(g.perfil, 'Gerente'); assert.equal(g.activo, 'SÍ'); assert.equal(g.gerencia, G);
  assert.match(g.f_acceso_generado, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); assert.equal(g.f_acceso_generado_origen, 'medido');
  assert.ok(g.f_acceso_enviado); assert.equal(g.canal_envio, 'outlook'); assert.ok(g.f_primera_entrada); assert.equal(g.f_primera_entrada_origen, 'medido');
  assert.equal(g.n_entradas, 2); assert.equal(g.personas_compartidas, 1); assert.equal(g.personas_delegadas, 1); assert.equal(g.procesos_vigentes, 3);

  const emb = fila(f, G);
  assert.equal(emb.gerentes, 1); assert.equal(emb.p1_acceso_generado, 1); assert.equal(emb.p1_acceso_enviado, 1); assert.equal(emb.p2_gerente_abrio, 1); assert.equal(emb.p3_gerente_compartio, 1);
  assert.equal(emb.p3_personas_alcanzadas, 1); assert.equal(emb.p4_personas_abrieron, 1); assert.equal(emb.p5_personas_con_acceso, 2);   // Beto (identificó) y Hugo (con PIN)
  assert.equal(emb.p6_personas_empezaron, 0); assert.equal(emb.personas, 3);
  assert.equal(emb.pct_p1_acceso_generado, 100); assert.equal(emb.pct_p4_personas_abrieron, 33.3);   // base de 4 a 6: personas cargadas (3)
  assert.ok(emb.mediana_dias_p1_p2 !== undefined);
  assert.equal(fila(f, 'Total').gerentes, 1, 'el total no repite al gerente');
  assert.equal(f.secciones[0].p2_gerente_abrio, 1, 'también por sección');

  const u = f.usuarios.find(x => x.usuario === 'Beto Rojas');
  assert.match(u.f_abrio, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); assert.match(u.f_acceso_creado, /^\d{4}/); assert.equal(u.f_primera_respuesta, '');
  assert.equal(u.origen_abrio, 'medido'); assert.equal(u.origen_acceso_creado, 'medido');
  assert.ok(f.evolucion.length >= 2, 'la foto inicial del backfill arranca la hoja Evolución');
  assert.ok(f.evolucion.every(x => x.foto === 'inicial (reconstruida)'));
  assert.ok(!JSON.stringify(f).includes(clave) && !JSON.stringify(f).includes('@'), 'sin claves ni correos');
});

test('export: gerentes, gerencias, secciones y avance_diario en JSON y CSV (UTF-8 con BOM y «;»)', async () => {
  const e = entorno(); await sembrar(e.db);
  await conGerente(e);
  await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  const todos = await e.admin('GET', '/a/embudo/export?campana_id=c1');
  for (const k of ['eventos', 'personas', 'gerentes', 'gerencias', 'secciones', 'avance_diario']) assert.ok(Array.isArray(todos[k].filas), k);
  assert.equal(todos.gerencias.filas.length, 1); assert.equal(todos.secciones.filas.length, 1);
  assert.equal(todos.gerentes.filas.length, 2, 'la cuenta de la semilla y la nueva de Carla');
  for (const c of ['gerentes', 'gerencias', 'secciones', 'avance_diario', 'personas', 'eventos']) {
    const r = await e.admin('GET', `/a/embudo/export?campana_id=c1&conjunto=${c}&formato=csv`);
    assert.equal(r.status, 200, c); assert.ok(r.texto.startsWith('﻿'), c + ': BOM');
    const lineas = r.texto.trim().split('\r\n');
    assert.ok(lineas.length >= 2 && lineas[0].includes(';'), c + ': encabezado con ;');
  }
  assert.equal((await e.admin('GET', '/a/embudo/export?campana_id=c1&conjunto=nada')).status, 400);
  assert.equal((await e.admin('GET', '/a/embudo/export?campana_id=c1&formato=csv')).status, 400, 'CSV pide un conjunto');
  assert.equal((await e.llamar('GET', '/a/embudo/export?campana_id=c1&conjunto=gerentes')).status, 401);
});

test('mediana: ignora pares sin fecha o negativos y redondea a un decimal', () => {
  assert.equal(mediana([]), ''); assert.equal(mediana([null, -1, NaN]), '');
  assert.equal(mediana([1, 3, null]), 2); assert.equal(mediana([0.25, 5, 1.1]), 1.1); assert.equal(mediana([1.04, 2.06]), 1.6);
});
