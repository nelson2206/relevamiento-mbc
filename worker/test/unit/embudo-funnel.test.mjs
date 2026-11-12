// Reporte de trazabilidad oficial v2.0: conteos de procesos (acumulativos), avance oficial = terminados / vigentes, estado, secciones y usuarios.
//   node --test test/unit/embudo-funnel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularFunnel, backfillEmbudo, diasCalendario } from '../../src/embudo.js';
import { entorno, sembrar, eventos, abierta, identificar, V1, V2, G, S, CLAVE_GERENTE } from './embudo-ayuda.mjs';

const BLOQUES = [{ id: 'b1', puntos: [['a'], ['b']] }, { id: 'b2', puntos: [['c']] }, { id: 'b3', puntos: [['d']] }];
const ck = (...ids) => JSON.stringify(Object.fromEntries(ids.map(i => [i, { estado: 'cubierto' }])));
const resp = (db, e, p, pregunta, checklist, texto = '') =>
  db.prepare('INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, checklist, actualizado) VALUES (?,?,?,?,?,?)').run(e, p, pregunta, texto, checklist, '2026-11-09T10:00:00.000Z');
const revisar = (db, e, p) => db.prepare("INSERT INTO revisiones (encuestado_id, proceso_id, estado, actualizado) VALUES (?,?, 'vigente', '2026-11-05T10:00:00.000Z')").run(e, p);
const fila = (f, g) => f.gerencias.find(x => x.gerencia === g);

// Beto: se identifica (crea su PIN), confirma p0 y p1, completa p0 y deja p1 con una sola pregunta. Carla: nunca entró; un visitante anónimo abrió el enlace.
async function escenario() {
  const e = entorno(); await sembrar(e.db);
  await abierta(e, V1); await abierta(e, V2);
  await identificar(e, 'e-beto', '4821', V1);
  revisar(e.db, 'e-beto', 'p0'); revisar(e.db, 'e-beto', 'p1');
  resp(e.db, 'e-beto', 'p0', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p0', 'b2', ck('c')); resp(e.db, 'e-beto', 'p0', 'b3', ck('d'));
  resp(e.db, 'e-beto', 'p1', 'b1', ck('a'), 'algo');
  const hace = d => new Date(Date.now() - d * 86400000).toISOString();
  e.db.prepare("UPDATE encuestados SET creado=?, actualizado=? WHERE id='e-carla'").run(hace(10), hace(10));
  return e;
}
const camp = { id: 'c1', nombre: 'PRUEBA' };

test('Secciones mira usuarios (cargados, registrados, iniciados, avanzados, terminados); Gerencia mira procesos; los visitantes que nunca se registraron no cuentan', async () => {
  const e = await escenario();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.deepEqual(Object.keys(f).filter(k => ['gerentes', 'etapas'].includes(k)), [], 'el reporte v2.0 ya no trae gerentes ni el embudo de 7 puntos');
  // Solo Beto está registrado: el visitante anónimo V2 y Carla (sin acceso) no entran.
  const s = f.secciones[0];
  assert.deepEqual([s.usuarios_registrados, s.con_procesos, s.encuestas_terminadas], [1, 1, 0]);
  // Vista de usuarios: Beto llegó a «avanzado» (tiene p0 terminado) pero no terminó todos sus procesos (p1 va por la mitad).
  assert.deepEqual([s.usuarios_iniciados, s.usuarios_avanzados, s.usuarios_terminados], [1, 1, 0]);
  assert.equal(s.usuarios_cargados, 2, 'Beto y Carla; solo Beto está registrado');
  assert.deepEqual([s.procesos_vigentes, s.procesos_nuevos], [3, 0]);
  assert.ok(!('procesos_iniciados' in s) && !('procesos_terminados' in s), 'Secciones ya no cuenta procesos iniciados/avanzados/terminados: eso es de Gerencia');
  const t = fila(f, 'Total');
  assert.equal(t.avance_pct, 33.3, 'avance oficial: 1 terminado de los 3 procesos vigentes');
  assert.deepEqual([t.procesos_vigentes, t.procesos_nuevos, t.procesos_iniciados, t.procesos_avanzados, t.procesos_terminados], [3, 0, 2, 1, 1]);
  assert.deepEqual(f.gerencias.map(x => x.gerencia), [G, 'Total'], 'una fila por gerencia y el total al final');
  assert.equal(f.secciones[0].avance_pct, 33.3);
  assert.ok(f.resumen.every(r => !('avance_asumido_pct' in r) && !('gerentes_nombres' in r) && !('procesos_respondidos' in r)), 'se eliminaron los campos de la versión 1.x');
});

test('Encuesta terminada guarda la fecha una sola vez y es independiente de «Procesos terminados»', async () => {
  const e = await escenario();
  await e.llamar('POST', '/r/enviar', { k: 'tokenbeto0123456789' });
  await e.llamar('POST', '/r/enviar', { k: 'tokenbeto0123456789' });
  const ev = eventos(e.db, 'encuesta_terminada');
  assert.equal(ev.length, 1); assert.equal(ev[0].persona_id, 'e-beto'); assert.equal(ev[0].reconstruido, 0);
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.equal(f.secciones[0].encuestas_terminadas, 1); assert.equal(fila(f, 'Total').procesos_terminados, 1, 'terminar la encuesta no cambia los procesos terminados');
  const bk = await backfillEmbudo(e.env, 'c1');
  assert.equal(bk.insertados.encuesta_terminada, 0, 'el evento medido ya existe: el backfill no lo duplica');
});

test('ACABADO: quien terminó todos sus procesos no figura como inactivo aunque lleve semanas sin entrar', async () => {
  const e = await escenario();
  const hace = d => new Date(Date.now() - d * 86400000).toISOString();
  // Dora: registrada, con un único proceso (p2) terminado hace 30 días y sin actividad desde entonces.
  e.db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, creado, actualizado, pin_hash, pin_sal) VALUES ('e-dora','c1','tokdora0123456789012','Dora Vega',?,?,?,?,'h','s')").run(G, S, hace(40), hace(30));
  revisar(e.db, 'e-dora', 'p2');
  [['b1', ck('a', 'b'), 'x'], ['b2', ck('c'), ''], ['b3', ck('d'), '']].forEach(([pq, c, t]) =>
    e.db.prepare('INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, checklist, actualizado) VALUES (?,?,?,?,?,?)').run('e-dora', 'p2', pq, t, c, hace(30)));
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  const dora = f.usuarios.find(u => u.usuario === 'Dora Vega'), carla = f.usuarios.find(u => u.usuario === 'Carla Díaz'), beto = f.usuarios.find(u => u.usuario === 'Beto Rojas');
  assert.equal(dora.pct_avance_usuario, 100); assert.equal(dora.inactivo, 'ACABADO', 'terminó todo: no es inactiva');
  assert.equal(carla.inactivo, 'SÍ', 'sin avance y sin entrar sigue siendo inactiva'); assert.equal(beto.inactivo, 'NO', 'con procesos pendientes pero activo');
  const s = f.secciones[0];
  assert.equal(s.inactivos, f.usuarios.filter(u => u.inactivo === 'SÍ').length, 'Inactivos de Secciones cuenta solo los SÍ');
  assert.equal(f.usuarios.filter(u => u.inactivo === 'ACABADO').length, s.usuarios_terminados, 'ACABADO cuadra con «Usuarios con todos sus procesos terminados»');
});

test('procesos del usuario: lo que marcó «ya no se hace» no cuenta; lo que respondió sin revisión sí (misma regla de participación que cobertura)', async () => {
  const e = await escenario();   // Beto: p0 terminado, p1 a medias (revisión vigente en ambos)
  let f = await calcularFunnel(e.env, camp, BLOQUES);
  let b = f.usuarios.find(u => u.usuario === 'Beto Rojas');
  assert.deepEqual([b.total, b.terminados, b.pct_avance_usuario], [2, 1, 50]);
  // Beto marca p1 como «ya no se hace»: sale de su lista y ya puede llegar a 100 % y a «terminado».
  e.db.prepare("UPDATE revisiones SET estado='no_existe' WHERE encuestado_id='e-beto' AND proceso_id='p1'").run();
  f = await calcularFunnel(e.env, camp, BLOQUES);
  b = f.usuarios.find(u => u.usuario === 'Beto Rojas');
  assert.deepEqual([b.total, b.terminados, b.pct_avance_usuario], [1, 1, 100]);
  assert.equal(f.secciones[0].usuarios_terminados, 1, 'Beto ya cuenta como usuario con todos sus procesos terminados');
  // Responde p2 sin haberlo confirmado: es trabajo suyo, entra a su lista (el proceso iniciado de Gerencia tiene un usuario iniciado).
  resp(e.db, 'e-beto', 'p2', 'b1', ck('a'), 'respuesta sin revision');
  f = await calcularFunnel(e.env, camp, BLOQUES);
  b = f.usuarios.find(u => u.usuario === 'Beto Rojas');
  assert.deepEqual([b.total, b.iniciados, b.terminados], [2, 2, 1]);
});

test('Última actividad es solo de usuarios: el ingreso de un gerente no la mueve', async () => {
  const e = await escenario();
  const antes = (await calcularFunnel(e.env, camp, BLOQUES)).resumen[0].ultima_actividad;
  const r = await e.admin('POST', '/a/persona/perfil', { campana_id: 'c1', encuestado_id: 'e-carla', perfil: 'gerente' });
  assert.equal((await e.llamar('GET', '/c/campana', null, { 'x-client-code': r.clave })).status, 200);
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.equal(f.resumen[0].ultima_actividad, antes, 'el ingreso del gerente no cuenta como actividad de llenado');
  assert.equal(f.secciones[0].ultima_actividad, antes);
});

test('días calendario en hora de Lima: la actividad de ayer 23:00 vista hoy 01:00 es de 1 día', () => {
  // 23:00 Lima del 10-nov = 04:00 UTC del 11-nov; 01:00 Lima del 11-nov = 06:00 UTC.
  assert.equal(diasCalendario('2026-11-11T04:00:00.000Z', '2026-11-11T06:00:00.000Z'), 1, 'no son 0 días aunque pasaron solo 2 horas');
  assert.equal(diasCalendario('2026-11-11T06:00:00.000Z', '2026-11-11T20:00:00.000Z'), 0, 'mismo día calendario');
  assert.equal(diasCalendario('2026-11-05T15:00:00.000Z', '2026-11-12T14:00:00.000Z'), 7, 'siete días calendario aunque no hayan pasado 168 horas');
  assert.equal(diasCalendario('2026-11-13T00:00:00.000Z', '2026-11-12T00:00:00.000Z'), 0, 'una fecha futura no da negativos');
});

test('gerencia: avance oficial = procesos terminados / procesos vigentes; estado y última actividad', async () => {
  const e = await escenario();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.deepEqual(f.resumen.map(r => r.gerencia), [G, 'Total'], 'Resumen: una fila por gerencia y el Total al final');
  const rt = f.resumen[1], gt = fila(f, 'Total');
  assert.deepEqual([rt.procesos_vigentes, rt.procesos_terminados, rt.avance_pct, rt.estado, rt.personas_registradas], [gt.procesos_vigentes, gt.procesos_terminados, gt.avance_pct, gt.estado, 1], 'el Total de Resumen sale del mismo cálculo que el de Gerencia');
  assert.equal(f.resumen[0].avance_pct, 33.3);          // oficial: 1 terminado de 3 procesos vigentes
  assert.deepEqual([f.resumen[0].procesos_iniciados, f.resumen[0].procesos_avanzados, f.resumen[0].procesos_terminados], [2, 1, 1]);
  assert.equal(f.resumen[0].estado, 'En levantamiento');
  assert.match(f.resumen[0].ultima_actividad, /^\d{4}-\d{2}-\d{2}$/);
  e.db.prepare("DELETE FROM respuestas WHERE encuestado_id='e-beto' AND proceso_id='p1'").run();
  resp(e.db, 'e-beto', 'p1', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p1', 'b2', ck('c')); resp(e.db, 'e-beto', 'p1', 'b3', ck('d'));
  const g2 = (await calcularFunnel(e.env, camp, BLOQUES)).resumen[0];
  assert.equal(g2.avance_pct, 66.7); assert.equal(g2.procesos_avanzados, 2); assert.equal(g2.estado, 'En levantamiento', 'falta p2: el avance oficial no llega a 100 %');
  resp(e.db, 'e-beto', 'p2', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p2', 'b2', ck('c')); resp(e.db, 'e-beto', 'p2', 'b3', ck('d'));
  const g3 = (await calcularFunnel(e.env, camp, BLOQUES)).resumen[0];
  assert.equal(g3.avance_pct, 100); assert.equal(g3.estado, 'Lista para validar');
  e.db.prepare("UPDATE procesos SET validacion='validado'").run();
  assert.equal((await calcularFunnel(e.env, camp, BLOQUES)).resumen[0].estado, 'Validada');
});

test('usuarios y secciones: % de avance del usuario, SÍ/NO e inactividad de 7 días o más', async () => {
  const e = await escenario();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  const b = f.usuarios.find(u => u.usuario === 'Beto Rojas'), c = f.usuarios.find(u => u.usuario === 'Carla Díaz');
  assert.deepEqual([b.seleccionados, b.nuevos, b.total, b.iniciados, b.avanzados, b.terminados], [2, 0, 2, 2, 1, 1]);
  assert.equal(b.pct_avance_usuario, 50, 'terminados ÷ total de procesos (seleccionados + nuevos)');
  assert.equal(b.registrado, 'SÍ');
  assert.match(b.fecha_alta, /^\d{4}-\d{2}-\d{2}$/); assert.ok(!('fecha_registro' in b), 'la columna se llama Fecha de alta');
  assert.ok(['f_abrio', 'f_acceso_creado', 'f_primera_respuesta', 'pct_iniciados', 'origen_abrio'].every(k => !(k in b)), 'sin fechas de apertura ni acceso, % por etapa ni columnas de origen');
  assert.equal(b.encuesta_terminada, 'NO'); assert.equal(b.inactivo, 'NO');
  assert.deepEqual([c.total, c.iniciados, c.terminados], [0, 0, 0]); assert.equal(c.pct_avance_usuario, '', 'sin procesos seleccionados no hay porcentaje');
  assert.equal(c.inactivo, 'SÍ'); assert.equal(c.registrado, 'NO', 'las personas sin acceso también salen, marcadas como no registradas');
  assert.equal(f.secciones.length, 1);
  assert.deepEqual([f.secciones[0].usuarios_registrados, f.secciones[0].usuarios_terminados, f.secciones[0].inactivos], [1, 0, 1]);
  assert.equal(f.secciones[0].usuarios_cargados, f.usuarios.length, 'las filas de Usuarios cuadran con «Usuarios cargados»');
  assert.equal(f.usuarios.filter(u => u.registrado === 'SÍ').length, f.secciones[0].usuarios_registrados, 'Registrado = SÍ cuadra con «Usuarios registrados»');
  assert.match(f.corte, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); assert.ok(!('evolucion' in f), 'el reporte ya no trae Evolución');
  assert.ok(f.usuarios.every(u => !('correo' in u) && !('token' in u)), 'sin correos ni tokens');
});

test('GET /a/embudo/funnel: solo administración; el cliente y el gerente no tienen la ruta', async () => {
  const e = await escenario();
  e.db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, creado) VALUES ('e-otro','c1','tokenotro0123456789','Otro Compras','Compras','Pagos','2026-11-01T10:00:00.000Z')").run();
  const admin = await e.admin('GET', '/a/embudo/funnel?campana_id=c1');
  assert.equal(admin.status, 200); assert.ok(admin.usuarios.some(u => u.gerencia === 'Compras') && admin.usuarios.some(u => u.gerencia === G));
  assert.equal((await e.llamar('GET', '/a/embudo/funnel?campana_id=c1')).status, 401, 'sin código de administrador no entra');
  assert.equal((await e.llamar('GET', '/a/embudo/funnel?campana_id=c1', null, { 'x-client-code': CLAVE_GERENTE })).status, 401, 'la clave del gerente no sirve');
  assert.equal((await e.llamar('GET', '/c/funnel', null, { 'x-client-code': CLAVE_GERENTE })).status, 404, 'el panel del cliente ya no trae el funnel');
  assert.equal((await e.admin('GET', '/a/embudo/funnel?campana_id=no-existe')).status, 404);
});
