// Reconstrucción (backfill) desde datos anteriores: idempotente, todo marcado reconstruido=1 y sin pisar lo medido.
//   node --test test/unit/embudo-backfill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { entorno, sembrar, eventos, G, S } from './embudo-ayuda.mjs';

function datosAntiguos(db) {
  db.prepare("UPDATE supervisores SET ultimo='2026-11-05T09:00:00.000Z', encuestado_id='e-beto' WHERE id='s-ger'").run();
  db.prepare("INSERT INTO acciones (id, campana_id, actor_tipo, actor_id, actor_nombre, accion, detalle, creado) VALUES ('a1','c1','supervisor','s-ger','Gerente Legal','correo_generado','{\"personas\":2}','2026-11-03T15:00:00.000Z')").run();
  db.prepare("INSERT INTO acciones (id, campana_id, actor_tipo, actor_id, actor_nombre, accion, detalle, creado) VALUES ('a2','c1','cliente','','Administrador del cliente','enlace_copiado','{\"personas\":1}','2026-11-04T15:00:00.000Z')").run();
  db.prepare("INSERT INTO acciones (id, campana_id, actor_tipo, actor_id, actor_nombre, accion, detalle, creado) VALUES ('a3','c1','mbc','','MBC','supervisor_clave_nueva','{\"supervisor_id\":\"s-ger\"}','2026-11-02T15:00:00.000Z')").run();
  db.prepare("INSERT INTO delegaciones (id, campana_id, encuestado_id, proceso_id, actor_tipo, actor_id, actor_nombre, creado) VALUES ('d1','c1','e-beto','p0','supervisor','s-ger','Gerente Legal','2026-11-03T16:00:00.000Z')").run();
  db.prepare("INSERT INTO delegaciones (id, campana_id, encuestado_id, proceso_id, actor_tipo, actor_id, actor_nombre, creado) VALUES ('d2','c1','e-beto','p1','supervisor','s-ger','Gerente Legal','2026-11-03T16:01:00.000Z')").run();
  // Beto (precargado) fijó su PIN y respondió; Carla nunca entró; Ana se registró sola.
  db.prepare("UPDATE encuestados SET pin_hash='h', pin_sal='s', ultimo_acceso='2026-11-06T10:00:00.000Z' WHERE id='e-beto'").run();
  db.prepare("INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, actualizado) VALUES ('e-beto','p0','b1','algo','2026-11-04T12:00:00.000Z')").run();
  db.prepare("INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, actualizado) VALUES ('e-beto','p0','b2','mas','2026-11-05T12:00:00.000Z')").run();
  db.prepare("INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, actualizado) VALUES ('e-beto','p1','b1','   ','2026-11-05T12:00:00.000Z')").run();
  db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, origen, creado, pin_hash, pin_sal, ultimo_acceso) VALUES ('e-ana','c1','tokenana01234567890','Ana Salazar',?,?,'abierto','2026-11-02T08:00:00.000Z','h','s','2026-11-07T08:00:00.000Z')").run(G, S);
  db.prepare("UPDATE procesos SET validacion='validado', validado_por='Analista MBC', validado_en='2026-11-08T10:00:00.000Z' WHERE id='p2'").run();
  db.prepare("INSERT INTO flujo_pasos (campana_id, supervisor_id, paso, confirmado_en) VALUES ('c1','s-ger',1,'2026-11-06T10:00:00.000Z')").run();
}
const porTipo = db => Object.fromEntries(db.prepare("SELECT tipo, COUNT(*) AS n FROM eventos GROUP BY tipo").all().map(x => [x.tipo, x.n]));

test('el backfill reconstruye los eventos desde los datos y todo queda reconstruido=1', async () => {
  const e = entorno(); await sembrar(e.db); datosAntiguos(e.db);
  const r = await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.reconstruido, 1);
  const t = porTipo(e.db);
  assert.equal(t.acceso_gerente_generado, 2, 'primera clave + regenerada');
  assert.equal(t.gerente_abrio, 1); assert.equal(t.gerente_entro, 1);
  assert.equal(t.procesos_delegados, 1, 'las dos delegaciones de Beto del mismo gerente se agrupan');
  assert.equal(t.enlace_compartido, 2);
  assert.equal(t.acceso_creado, 2);
  assert.equal(t.persona_identificada, 2);
  assert.equal(t.primera_respuesta, 1, 'solo respuestas con contenido: p0 sí, p1 (vacía) no');
  assert.equal(t.proceso_validado, 1); assert.equal(t.flujo_paso_confirmado, 1);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM eventos WHERE reconstruido=0').get().n, 0);
  assert.ok(Object.keys(r.insertados).length >= 9);
  assert.equal(r.insertados.procesos_delegados, 1);

  const dele = eventos(e.db, 'procesos_delegados')[0];
  assert.equal(dele.creado, '2026-11-03T16:00:00.000Z'); assert.equal(JSON.parse(dele.detalle).procesos, 2); assert.equal(dele.actor_tipo, 'gerente');
  const pr = eventos(e.db, 'primera_respuesta')[0];
  assert.equal(pr.creado, '2026-11-04T12:00:00.000Z'); assert.equal(pr.persona_id, 'e-beto');
  const ac = eventos(e.db, 'acceso_creado');
  assert.equal(ac.find(x => x.persona_id === 'e-ana').creado, '2026-11-02T08:00:00.000Z', 'registro abierto: su fecha de creación');
  const beto = ac.find(x => x.persona_id === 'e-beto');
  assert.equal(beto.creado, '2026-11-04T12:00:00.000Z', 'precargado: primer rastro (cota)');
  assert.equal(JSON.parse(beto.detalle).aprox, 'cota');
  assert.equal(eventos(e.db, 'gerente_abrio')[0].creado, '2026-11-03T15:00:00.000Z', 'primera acción del supervisor');
  eventos(e.db).forEach(x => assert.equal(JSON.parse(x.detalle).reconstruido, true));
});

test('repetir el backfill no duplica nada', async () => {
  const e = entorno(); await sembrar(e.db); datosAntiguos(e.db);
  await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  const antes = JSON.stringify(eventos(e.db).map(x => [x.tipo, x.clave, x.creado]));
  const r2 = await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  assert.equal(r2.status, 200);
  assert.equal(Object.values(r2.insertados).reduce((a, b) => a + b, 0), 0);
  assert.equal(JSON.stringify(eventos(e.db).map(x => [x.tipo, x.clave, x.creado])), antes);
});

test('lo reconstruido solo cubre lo anterior al primer evento medido del mismo tipo', async () => {
  const e = entorno(); await sembrar(e.db); datosAntiguos(e.db);
  // Una delegación medida (posterior al despliegue) y otra delegación más nueva en la tabla: el backfill no la vuelve a contar.
  e.db.prepare("INSERT INTO eventos (id, campana_id, tipo, actor_tipo, persona_id, reconstruido, detalle, creado) VALUES ('m1','c1','procesos_delegados','gerente','e-carla',0,'{}','2026-11-10T10:00:00.000Z')").run();
  e.db.prepare("INSERT INTO delegaciones (id, campana_id, encuestado_id, proceso_id, actor_tipo, actor_id, actor_nombre, creado) VALUES ('d3','c1','e-carla','p2','supervisor','s-ger','Gerente Legal','2026-11-10T10:00:00.000Z')").run();
  await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  const del = eventos(e.db, 'procesos_delegados');
  assert.equal(del.length, 2);
  assert.equal(del.filter(x => x.reconstruido === 0).length, 1);
  assert.equal(del.filter(x => x.persona_id === 'e-carla').length, 1, 'Carla solo tiene el evento medido');
});

test('el evento medido se guarda milisegundos después de su fila: el backfill no la vuelve a contar', async () => {
  const e = entorno(); await sembrar(e.db);
  const beto = await e.llamar('POST', '/r/identificar', { c: 'abcdefghij', id: 'e-beto', pin: '4821' });
  assert.equal(beto.status, 200);
  await e.gerente('/c/enlaces', { encuestado_ids: ['e-beto'], para: 'correo' });
  await e.gerente('/c/asignar', { encuestado_id: 'e-beto', agregar: ['p0'] });
  const antes = eventos(e.db).length;
  const r = await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  assert.equal(r.insertados.procesos_delegados, 0); assert.equal(r.insertados.enlace_compartido, 0); assert.equal(r.insertados.persona_identificada, 0);
  assert.equal(r.insertados.acceso_creado, 0, 'misma clave que el medido: no se duplica');
  assert.equal(eventos(e.db).filter(x => x.reconstruido === 1).length, eventos(e.db).length - antes);
  ['procesos_delegados', 'enlace_compartido', 'persona_identificada', 'acceso_creado'].forEach(t => assert.equal(eventos(e.db, t).length, 1, t));
});

test('la extracción rotula lo reconstruido y la apertura inferida', async () => {
  const e = entorno(); await sembrar(e.db); datosAntiguos(e.db);
  await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  const filas = (await e.admin('GET', '/a/embudo/export?campana_id=c1&conjunto=personas')).personas.filas;
  const b = filas.find(f => f.persona_id === 'e-beto');
  assert.equal(b.f_abrio_origen, 'inferido'); assert.equal(b.f_acceso_creado_origen, 'reconstruido');
  assert.equal(b.f_primera_respuesta, '2026-11-04T12:00:00.000Z'); assert.equal(b.f_delegado, '2026-11-03T16:00:00.000Z');
  assert.equal(b.f_acceso_generado, '2026-11-01T10:00:00.000Z', 'el gerente vinculado a su ficha');
  assert.equal(b.perfil, 'gerente');
  const ev = (await e.admin('GET', '/a/embudo/export?campana_id=c1&conjunto=eventos')).eventos.filas;
  assert.ok(ev.length > 8); ev.forEach(x => assert.equal(x.reconstruido, 1));
});

test('borrar la campaña borra también sus eventos', async () => {
  const e = entorno(); await sembrar(e.db); datosAntiguos(e.db);
  await e.admin('POST', '/a/embudo/backfill', { campana_id: 'c1' });
  assert.ok(eventos(e.db).length > 0);
  const r = await e.admin('POST', '/a/borrar-campana', { campana_id: 'c1', confirmar: 'PRUEBA' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM eventos').get().n, 0);
});
