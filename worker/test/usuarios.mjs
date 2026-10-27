// Prueba de usuarios desde la consola: crear y editar con varias secciones, cuentas sin procesos, carga por Excel con perfil, claves para la descarga,
// equipo visible para Supervisor y Gerente, catálogo del Supervisor y estado de la gerencia en la consola.
//   node test/usuarios.mjs      → contra http://127.0.0.1:8787 (npm run dev); crea campañas temporales y las borra
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787', ORIGEN = arg('--origen') || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE'); process.exit(2); }
const http = async (m, r, c, cab) => { const x = await fetch(API + r, { method: m, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: c ? JSON.stringify(c) : undefined }); return Object.assign({ status: x.status }, await x.json().catch(() => ({}))); };
const admin = (m, r, c) => http(m, r, c, { 'x-admin-code': ADMIN });
const como = k => (m, r, c) => http(m, r, c, { 'x-client-code': k });
let fallas = 0, n = 0;
const ok = (c, t, extra) => { n++; if (c) console.log('  ok   ' + t); else { fallas++; console.log('  FALLA ' + t + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); } };

const suf = Date.now().toString(36), creadas = [];
let contador = 0;
async function campana(etiqueta, procesos, esqueleto) {
  const nombre = etiqueta + ' ' + suf, id = (await admin('POST', '/a/campana', { nombre, cliente: 'C' })).id; creadas.push([id, nombre]);
  await admin('POST', '/a/campana/cliente', { campana_id: id, accion: 'definir', codigo: 'Acceso' + suf + (++contador) + 'x9' });
  const ids = {};
  if (esqueleto) await admin('POST', '/a/importar', { campana_id: id, modo: 'agregar', estructura: esqueleto });
  for (const [k, g, s, nom] of procesos) ids[k] = (await admin('POST', '/a/proceso', { campana_id: id, gerencia: g, seccion: s, proceso: nom, descripcion: 'd' })).id;
  return { id, ids, nombre };
}
const detalle = async c => admin('GET', '/a/campana?id=' + c.id);
const asignadosDe = async (c, eid) => (await detalle(c)).asignaciones.filter(a => a.encuestado_id === eid && a.origen === 'consultor').map(a => a.proceso_id).sort();
const responderTodo = async (token, pid) => { const ses = await http('GET', '/r/sesion?k=' + token); for (const b of ses.bloques) for (const x of b.puntos) await http('POST', '/r/punto', { k: token, proceso_id: pid, pregunta: b.id, punto: x[0], estado: 'cubierto' }); };

try {
  const PROCS = [['a1', 'G', 'S1', 'Proceso A1'], ['a2', 'G', 'S1', 'Proceso A2'], ['b1', 'G', 'S2', 'Proceso B1'], ['c1', 'G', 'S3', 'Proceso C1'], ['d1', 'H', 'S9', 'Proceso D1']];
  const C1 = await campana('Usuarios', PROCS, [{ area: 'Area X', gerencia: 'G', seccion: 'S1' }, { area: 'Area X', gerencia: 'G', seccion: 'S2' }, { area: 'Area X', gerencia: 'G', seccion: 'S3' }]);
  const usuario = c => admin('POST', '/a/usuario', Object.assign({ campana_id: C1.id }, c));

  console.log('Crear usuarios desde la consola');
  ok((await http('POST', '/a/usuario', { campana_id: C1.id, nombre: 'Sin permiso', gerencia: 'G', seccion: 'S1' })).status === 401, 'sin código de administración no se crea nada');
  ok((await usuario({ nombre: 'Ab', gerencia: 'G', seccion: 'S1' })).status === 400, 'nombre muy corto → 400');
  ok((await usuario({ nombre: 'Persona Uno', correo: 'mal', gerencia: 'G', seccion: 'S1' })).status === 400, 'correo inválido → 400');
  ok((await usuario({ nombre: 'Persona Uno', gerencia: 'G', seccion: '' })).status === 400, 'sin sección principal → 400');
  ok((await usuario({ nombre: 'Persona Uno', gerencia: 'G', seccion: 'S1', perfil: 'jefe' })).status === 400, 'perfil desconocido → 400');
  ok((await admin('POST', '/a/usuario', { campana_id: 'no-existe', nombre: 'Persona Uno', gerencia: 'G', seccion: 'S1' })).status === 404, 'campaña inexistente → 404');

  const r1 = await usuario({ nombre: 'Rosa Responsable', correo: 'Rosa@Empresa.com', rol: 'Analista', gerencia: 'G', seccion: 'S1', secciones: [{ g: 'G', s: 'S1' }, { g: 'g', s: 's2' }] });
  ok(r1.ok && r1.creada && r1.perfil === 'responsable' && !r1.clave, 'crea un Responsable sin clave', r1);
  ok(r1.asignados === 3, 'recibe todos los procesos de las 2 secciones elegidas (S1: 2 y S2: 1)', r1.asignados);
  ok(JSON.stringify(await asignadosDe(C1, r1.id)) === JSON.stringify([C1.ids.a1, C1.ids.a2, C1.ids.b1].sort()), 'las asignaciones son exactamente los procesos de esas secciones');
  const dup = await usuario({ nombre: 'Otra Persona', correo: 'rosa@empresa.com', gerencia: 'G', seccion: 'S1' });
  ok(dup.status === 409, 'no se repite un correo dentro de la campaña (sin distinguir mayúsculas)');

  console.log('Cuentas de Supervisor y Gerente, con o sin procesos');
  const sup = await usuario({ nombre: 'Sandra Supervisora', correo: 'sandra@empresa.com', gerencia: 'G', seccion: 'S1', perfil: 'supervisor', secciones: [{ g: 'G', s: 'S2' }] });
  ok(sup.ok && sup.clave && sup.perfil === 'supervisor', 'crea un Supervisor y entrega su clave', sup);
  const alcSup = (await admin('GET', '/a/campana/trazabilidad?id=' + C1.id)).supervisores.find(s => s.nombre === 'Sandra Supervisora').alcance;
  ok(alcSup.secciones.length === 2 && alcSup.secciones.some(x => x.s === 'S1') && alcSup.secciones.some(x => x.s === 'S2'), 'su alcance son sus secciones (la principal y la adicional)', alcSup);
  ok((await como(sup.clave)('GET', '/c/flujo')).ok, 'puede entrar al panel con esa clave');
  const vacia = await usuario({ nombre: 'Vera Sinprocesos', correo: 'vera@empresa.com', gerencia: 'G', seccion: 'Seccion Nueva', perfil: 'supervisor' });
  ok(vacia.ok && vacia.clave, 'se puede crear un Supervisor de una sección que aún no tiene procesos ni existía', vacia);
  ok((await detalle(C1)).estructura.some(f => f.gerencia === 'G' && f.seccion === 'Seccion Nueva' && f.area === 'Area X'), 'la sección nueva se agrega al esqueleto con el área de su gerencia');
  const fv = await como(vacia.clave)('GET', '/c/flujo');
  ok(fv.ok && fv.procesos.length === 0 && fv.perfil === 'supervisor', 'entra y ve su lista vacía (sin procesos todavía)', fv.error);
  const ger = await usuario({ nombre: 'Gabriel Gerente', correo: 'gabriel@empresa.com', gerencia: 'G', seccion: 'S1', perfil: 'gerente' });
  ok(ger.ok && ger.clave, 'crea un Gerente', ger);
  const gerVacio = await usuario({ nombre: 'Gloria Nueva', correo: 'gloria@empresa.com', gerencia: 'Gerencia Nueva', seccion: 'Sec N', perfil: 'gerente' });
  ok(gerVacio.ok && gerVacio.clave, 'se puede crear un Gerente de una gerencia que aún no existe', gerVacio);

  console.log('Editar un usuario');
  const ver = await detalle(C1), tokenAntes = ver.encuestados.find(e => e.id === r1.id).token;
  const ed = await usuario({ id: r1.id, nombre: 'Rosa R. Responsable', correo: 'rosa.nueva@empresa.com', rol: 'Jefa', gerencia: 'G', seccion: 'S2', secciones: [{ g: 'G', s: 'S3' }] });
  ok(ed.ok && !ed.creada, 'edita sus datos personales y su sección principal', ed);
  const despues = (await detalle(C1)).encuestados.find(e => e.id === r1.id);
  ok(despues.nombre === 'Rosa R. Responsable' && despues.correo === 'rosa.nueva@empresa.com' && despues.seccion === 'S2' && despues.rol === 'Jefa', 'los cambios quedan guardados');
  ok(despues.token === tokenAntes, 'conserva su enlace personal');
  ok((await asignadosDe(C1, r1.id)).includes(C1.ids.c1) && (await asignadosDe(C1, r1.id)).length === 4, 'al darle una sección más recibe sus procesos y conserva los anteriores');
  ok((await usuario({ id: 'no-existe', nombre: 'Xxx Yyy', gerencia: 'G', seccion: 'S1' })).status === 404, 'editar a una persona inexistente → 404');
  const promo = await usuario({ id: r1.id, nombre: 'Rosa R. Responsable', correo: 'rosa.nueva@empresa.com', gerencia: 'G', seccion: 'S2', perfil: 'supervisor' });
  ok(promo.ok && promo.clave, 'se le puede dar el perfil de Supervisor al editarla (recibe clave)');
  const quitar = await usuario({ id: r1.id, nombre: 'Rosa R. Responsable', correo: 'rosa.nueva@empresa.com', gerencia: 'G', seccion: 'S2', perfil: 'responsable' });
  ok(quitar.ok && (await como(promo.clave)('GET', '/c/flujo')).status === 401, 'volver a Responsable cierra su acceso al panel');

  console.log('Claves para la descarga de enlaces personales');
  const cl = await admin('POST', '/a/personas/claves', { campana_id: C1.id, encuestado_ids: [sup.id, ger.id, r1.id, 'no-existe'] });
  ok(cl.ok && cl.claves.length === 2 && cl.claves.every(c => c.clave && c.clave.length >= 8), 'entrega una clave nueva por cada Supervisor o Gerente activo (no por Responsables)', cl.claves && cl.claves.length);
  ok((await como(sup.clave)('GET', '/c/flujo')).status === 401, 'la clave anterior deja de servir');
  ok((await como(cl.claves.find(c => c.perfil === 'supervisor').clave)('GET', '/c/flujo')).ok, 'la clave nueva sí entra');
  ok(!JSON.stringify(await admin('GET', '/a/campana?id=' + C1.id)).includes(cl.claves[0].clave), 'la clave no queda en ninguna consulta posterior');
  ok((await http('POST', '/a/personas/claves', { campana_id: C1.id, encuestado_ids: [sup.id] })).status === 401, 'sin código de administración no se generan claves');
  const supClave = cl.claves.find(c => c.perfil === 'supervisor').clave, gerClave = cl.claves.find(c => c.perfil === 'gerente').clave;

  console.log('Editar a un usuario no borra lo que tomó o creó por su cuenta');
  const apiSup = como(supClave);
  const tomo = await apiSup('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [C1.ids.d1], forzar: true });
  const creo = await apiSup('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: 'H', seccion: 'S9', proceso: 'Creado por la supervisora', forzar: true });
  ok(tomo.ok && creo.ok, 'la Supervisora toma un proceso de otra gerencia y crea otro', [tomo.error, creo.error]);
  const ids = async () => (await apiSup('GET', '/c/flujo')).procesos.map(p => p.id).sort();
  const antesEdicion = await ids();
  ok(antesEdicion.includes(C1.ids.d1) && antesEdicion.includes(creo.id), 'los dos están en su lista', antesEdicion.length);
  const edSup = await usuario({ id: sup.id, nombre: 'Sandra Supervisora', correo: 'sandra@empresa.com', gerencia: 'G', seccion: 'S1', perfil: 'supervisor', secciones: [{ g: 'G', s: 'S2' }] });
  ok(edSup.ok, 'MBC la edita desde la consola sin cambiar nada', edSup);
  ok(JSON.stringify(await ids()) === JSON.stringify(antesEdicion), 'su lista queda exactamente igual (no pierde lo que tomó ni lo que creó)', await ids());
  await usuario({ id: sup.id, nombre: 'Sandra S. Editada', correo: 'sandra@empresa.com', rol: 'Jefa', gerencia: 'G', seccion: 'S1', perfil: 'supervisor', secciones: [{ g: 'G', s: 'S2' }] });
  ok(JSON.stringify(await ids()) === JSON.stringify(antesEdicion), 'tampoco al cambiarle el nombre o el cargo');
  const quitaSec = await usuario({ id: sup.id, nombre: 'Sandra S. Editada', correo: 'sandra@empresa.com', gerencia: 'G', seccion: 'S1', perfil: 'supervisor', secciones: [] });
  const trasQuitar = await ids();
  ok(quitaSec.ok && !trasQuitar.includes(C1.ids.b1) && trasQuitar.includes(C1.ids.d1) && trasQuitar.includes(creo.id), 'sí cambia lo que el formulario controla (una sección desmarcada se quita) y conserva lo demás');
  const aGer = await admin('POST', '/a/persona/perfil', { campana_id: C1.id, encuestado_id: sup.id, perfil: 'gerente', regenerar: true });
  ok(aGer.ok && aGer.clave && (await como(aGer.clave)('GET', '/c/flujo')).procesos.some(p => p.id === creo.id && p.agregado), 'al cambiarla de perfil a Gerente conserva el proceso que creó');
  ok((await como(aGer.clave)('GET', '/c/flujo')).procesos.some(p => p.id === C1.ids.d1), 'y el que tomó');

  console.log('Carga por Excel: perfil y una fila por sección');
  const C2 = await campana('Carga', PROCS, [{ area: 'A', gerencia: 'G', seccion: 'S1' }, { area: 'A', gerencia: 'G', seccion: 'S2' }, { area: 'A', gerencia: 'G', seccion: 'S3' }]);
  const imp = await admin('POST', '/a/importar', { campana_id: C2.id, modo: 'agregar', encuestados: [
    { nombre: 'Marta Multiseccion', correo: 'marta@x.com', gerencia: 'G', seccion: 'S1' }, { nombre: 'Marta Multiseccion', correo: 'MARTA@x.com', gerencia: 'g', seccion: 's2' }, { nombre: 'Marta Multiseccion', correo: 'marta@x.com', gerencia: 'G', seccion: 'S2' },
    { nombre: 'Sergio Super', correo: 'sergio@x.com', gerencia: 'G', seccion: 'S1', perfil: 'Supervisor' }, { nombre: 'Sergio Super', correo: 'sergio@x.com', gerencia: 'G', seccion: 'S3' },
    { nombre: 'Gina Gerente', correo: 'gina@x.com', gerencia: 'G', seccion: 'S1', perfil: 'gerente' },
    { nombre: 'Sin Correo Uno', gerencia: 'G', seccion: 'S1' }, { nombre: 'Sin Correo Dos', gerencia: 'G', seccion: 'S1' }] });
  const det2 = await detalle(C2);
  ok(imp.ok && imp.encuestados === 5, 'crea 5 personas (las filas repetidas por correo son la misma persona)', imp.encuestados);
  const marta = det2.encuestados.find(e => e.nombre === 'Marta Multiseccion');
  ok(det2.encuestados.filter(e => e.nombre === 'Marta Multiseccion').length === 1 && marta.seccion === 'S1', 'su sección principal es la de la primera fila');
  ok(JSON.stringify(await asignadosDe(C2, marta.id)) === JSON.stringify([C2.ids.b1]), 'las filas siguientes le dan todos los procesos de esa otra sección (S2)', await asignadosDe(C2, marta.id));
  ok(imp.claves.length === 2 && imp.claves.some(c => c.perfil === 'supervisor' && c.nombre === 'Sergio Super') && imp.claves.some(c => c.perfil === 'gerente'), 'devuelve una clave por cada Supervisor y Gerente creado', imp.claves);
  ok(det2.encuestados.filter(e => e.nombre.startsWith('Sin Correo')).length === 2, 'las filas sin correo siguen siendo personas distintas');
  const sergio = (await admin('GET', '/a/campana/trazabilidad?id=' + C2.id)).supervisores.find(s => s.nombre === 'Sergio Super');
  ok(sergio.perfil === 'supervisor' && sergio.alcance.secciones.some(x => x.s === 'S1') && sergio.alcance.secciones.some(x => x.s === 'S3'), 'el alcance del Supervisor cubre todas las secciones de sus filas', sergio.alcance);
  const imp2 = await admin('POST', '/a/importar', { campana_id: C2.id, modo: 'agregar', encuestados: [{ nombre: 'Sergio Super', correo: 'sergio@x.com', gerencia: 'G', seccion: 'S1', perfil: 'supervisor' }] });
  ok(imp2.ok && imp2.claves.length === 0 && imp2.encuestados_actualizados === 1, 'volver a cargar a la misma persona no le cambia la clave ni la duplica', imp2.claves);
  const imp3 = await admin('POST', '/a/importar', { campana_id: C2.id, modo: 'agregar', encuestados: [{ nombre: 'Perfil Raro', correo: 'raro@x.com', gerencia: 'G', seccion: 'S1', perfil: 'jefazo' }] });
  ok(imp3.ok && imp3.claves.length === 0, 'un perfil desconocido en el Excel se ignora (queda Responsable)');

  console.log('Equipo visible: Gerente y Supervisor');
  const C3 = await campana('Equipo', [['a1', 'G', 'S1', 'Proceso A1'], ['a2', 'G', 'S1', 'Proceso A2'], ['b1', 'G', 'S2', 'Proceso B1'], ['d1', 'H', 'S9', 'Proceso D1']]);
  const alta = c => admin('POST', '/a/usuario', Object.assign({ campana_id: C3.id }, c));
  const gG = await alta({ nombre: 'Gerente Equipo', correo: 'ge@x.com', gerencia: 'G', seccion: 'S1', perfil: 'gerente' });
  const sS1 = await alta({ nombre: 'Supervisor S1', correo: 's1@x.com', gerencia: 'G', seccion: 'S1', perfil: 'supervisor' });
  const sS2 = await alta({ nombre: 'Supervisor S2', correo: 's2@x.com', gerencia: 'G', seccion: 'S2', perfil: 'supervisor' });
  const rA = await alta({ nombre: 'Resp en S1', correo: 'ra@x.com', gerencia: 'G', seccion: 'S1', secciones: [{ g: 'G', s: 'S1' }] });
  const rB = await alta({ nombre: 'Resp en S2', correo: 'rb@x.com', gerencia: 'G', seccion: 'S2', secciones: [{ g: 'G', s: 'S2' }] });
  const rD = await alta({ nombre: 'Resp otra gerencia', correo: 'rd@x.com', gerencia: 'H', seccion: 'S9', secciones: [{ g: 'H', s: 'S9' }] });
  const tokens = Object.fromEntries((await detalle(C3)).encuestados.map(e => [e.nombre, e.token]));
  await responderTodo(tokens['Resp en S1'], C3.ids.a1);   // un proceso de S1 completo
  const apiG = como(gG.clave), apiS1 = como(sS1.clave), apiS2 = como(sS2.clave);
  const fG = await apiG('GET', '/c/flujo'), fS1 = await apiS1('GET', '/c/flujo'), fS2 = await apiS2('GET', '/c/flujo');
  ok(fG.equipo.supervisores.map(s => s.nombre).sort().join() === 'Supervisor S1,Supervisor S2', 'el Gerente ve a los Supervisores de su gerencia', fG.equipo.supervisores.map(s => s.nombre));
  const nombresG = fG.equipo.responsables.map(r => r.nombre);
  ok(nombresG.includes('Resp en S1') && nombresG.includes('Resp en S2') && !nombresG.includes('Resp otra gerencia'), 'y a los responsables de toda su gerencia (no a los de otra)', nombresG);
  ok(fS1.equipo.supervisores.length === 0, 'el Supervisor no ve a otros Supervisores');
  ok(fS1.equipo.responsables.map(r => r.nombre).join() === 'Resp en S1', 'el Supervisor ve solo a los responsables de su sección', fS1.equipo.responsables.map(r => r.nombre));
  ok(fS2.equipo.responsables.map(r => r.nombre).join() === 'Resp en S2', 'cada Supervisor ve a los suyos', fS2.equipo.responsables.map(r => r.nombre));
  const rResp = fG.equipo.responsables.find(r => r.nombre === 'Resp en S1');
  ok(rResp.procesos === 2 && rResp.completos === 1 && rResp.total > 0 && rResp.puntos > 0 && rResp.puntos < rResp.total, 'el avance de cada responsable se calcula (1 de 2 procesos completos)', rResp);
  const sup1 = fG.equipo.supervisores.find(s => s.nombre === 'Supervisor S1');
  ok(sup1.procesos === 2 && sup1.respondidos === 1 && sup1.pasos === 0 && sup1.terminado === false && sup1.responsables === 1, 'el avance de cada Supervisor muestra procesos, respondidos y pasos', sup1);

  console.log('El Supervisor no ve el paso 4');
  ok(!('4' in fS1.compuertas) && fS1.perfil === 'supervisor', 'su respuesta no trae la compuerta del paso 4');
  ok(fS1.procesos.every(p => !('validacion' in p) && !('validado_en' in p)), 'ni la validación de MBC de cada proceso');
  ok('4' in fG.compuertas && fG.procesos.every(p => 'validacion' in p), 'el Gerente sí recibe ambas');
  ok((await apiS1('POST', '/c/flujo/confirmar', { paso: 4, confirmar_final: true })).status === 403, 'y el servidor le rechaza la validación final');
  await apiS1('POST', '/c/flujo/confirmar', { paso: 1 });
  ok((await apiS1('POST', '/c/flujo/confirmar', { paso: 2 })).ok, 'confirma el paso 2');
  await responderTodo(tokens['Resp en S1'], C3.ids.a2);
  ok((await apiS1('POST', '/c/flujo/confirmar', { paso: 3 })).ok, 'confirma el paso 3');
  const fS1b = await apiS1('GET', '/c/flujo');
  ok(fS1b.terminado === true, 'al confirmar el paso 3 su parte queda terminada');
  ok((await apiG('GET', '/c/flujo')).equipo.supervisores.find(s => s.nombre === 'Supervisor S1').terminado === true, 'y el Gerente lo ve como terminado');

  console.log('El Supervisor crea y toma procesos libremente');
  const cat = await apiS1('GET', '/c/flujo/catalogo');
  ok(cat.ok && cat.procesos.map(p => p.proceso).sort().join() === 'Proceso B1,Proceso D1', 'el catálogo ofrece procesos de otras secciones y de otras gerencias', cat.procesos && cat.procesos.map(p => p.proceso));
  ok((await apiS1('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [C3.ids.b1] })).status === 409, 'con pasos ya confirmados, incorporar pide confirmación antes de reiniciarlos');
  ok((await apiS1('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [C3.ids.b1], forzar: true })).ok, 'con confirmación puede tomar un proceso de otra sección');
  ok((await apiS1('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [C3.ids.d1] })).ok, 'y uno de otra gerencia');
  const mios = (await apiS1('GET', '/c/flujo')).procesos.map(p => p.proceso).sort().join();
  ok(mios === 'Proceso A1,Proceso A2,Proceso B1,Proceso D1', 'empieza con los de su sección y suma los que tomó', mios);
  const crea = (g, sec, nom) => apiS1('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: g, seccion: sec, proceso: nom, forzar: true });
  const enOtraSec = await crea('G', 'S2', 'Creado en otra sección');
  ok(enOtraSec.ok, 'puede crear un proceso en otra sección de su gerencia', enOtraSec);
  const enOtraGer = await crea('h', 's9', 'Creado en otra gerencia');
  ok(enOtraGer.ok, 'y en una sección de otra gerencia (sin importar mayúsculas)', enOtraGer);
  const f3 = await apiS1('GET', '/c/flujo');
  ok(f3.procesos.some(p => p.id === enOtraGer.id && p.agregado) && f3.procesos.some(p => p.id === enOtraSec.id), 'lo creado le aparece en su lista (no desaparece por estar fuera de su sección)');
  const detalle3 = await detalle(C3);
  ok(detalle3.procesos.find(p => p.id === enOtraGer.id).gerencia === 'H' && detalle3.procesos.find(p => p.id === enOtraGer.id).fuente === 'gerente', 'queda en el inventario de esa gerencia con su escritura correcta');
  ok((await crea('G', 'Seccion Inventada', 'No debe crearse')).status === 400, 'una sección que no existe en la campaña se rechaza');
  ok((await crea('h', 's9', 'creado en otra gerencia')).status === 409, 'no repite un proceso que ya existe en esa sección');
  ok(!(await apiS2('GET', '/c/flujo')).procesos.some(p => p.id === enOtraGer.id), 'lo que toma o crea un Supervisor no se lo pasa a los demás');
  const catG = await apiG('GET', '/c/flujo/catalogo');
  ok(catG.procesos.some(p => p.proceso === 'Proceso D1'), 'el Gerente conserva el catálogo completo');

  console.log('Supervisor de una sección que aún no tiene procesos');
  const apiV = como(vacia.clave);
  const catV = await apiV('GET', '/c/flujo/catalogo');
  ok(catV.ok && catV.total > 0, 've el catálogo para elegir procesos', catV.total);
  ok((await apiV('GET', '/c/flujo')).secciones.some(x => x.seccion === 'Seccion Nueva'), 'su sección vacía figura entre las secciones donde puede crear');
  const primero = await apiV('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: 'G', seccion: 'Seccion Nueva', proceso: 'Su primer proceso' });
  ok(primero.ok, 'puede crear el primer proceso de su sección vacía', primero);
  ok((await apiV('GET', '/c/flujo')).procesos.map(p => p.proceso).join() === 'Su primer proceso', 'y lo ve en su lista');

  console.log('Consola: estado de la gerencia con Supervisores y Gerente');
  const admInicial = await admin('GET', '/a/campana/flujo?id=' + C3.id);
  ok(admInicial.gerencias.G && admInicial.gerencias.G.gerentes.join() === 'Gerente Equipo', 'solo los Gerentes cuentan para la gerencia (el Supervisor se muestra aparte)', admInicial.gerencias.G);
  ok(admInicial.supervisores.some(s => s.nombre === 'Supervisor S1' && s.perfil === 'supervisor'), 'los Supervisores siguen listados, con su perfil');
  const psG = (await apiG('GET', '/c/flujo')).procesos.map(p => p.id);
  await apiG('POST', '/c/flujo/confirmar', { paso: 1 });
  for (const pid of psG) await admin('POST', '/a/asignar', { encuestado_id: (await detalle(C3)).encuestados.find(e => e.nombre === 'Resp en S1').id, agregar: [pid] });
  await apiG('POST', '/c/flujo/confirmar', { paso: 2 });
  for (const pid of psG) await responderTodo(tokens['Resp en S1'], pid);
  await apiG('POST', '/c/flujo/confirmar', { paso: 3 });
  for (const pid of psG) await admin('POST', '/a/matriz', { proceso_id: pid, validacion: 'validado', validado_por: 'MBC' });
  const fin = await apiG('POST', '/c/flujo/confirmar', { paso: 4, confirmar_final: true });
  ok(fin.ok, 'el Gerente da la validación final', fin);
  const admFinal = await admin('GET', '/a/campana/flujo?id=' + C3.id);
  ok(admFinal.gerencias.G.estado === 'aprobada', 'la consola marca la gerencia como aprobada aunque haya Supervisores', admFinal.gerencias.G);
} finally {
  for (const [id, nombre] of creadas) await admin('POST', '/a/borrar-campana', { campana_id: id, confirmar: nombre });
}
console.log('\n' + (n - fallas) + ' de ' + n + ' comprobaciones correctas' + (fallas ? ' · ' + fallas + ' con falla' : ''));
process.exit(fallas ? 1 : 0);
