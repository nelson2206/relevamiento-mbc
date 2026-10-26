// Usuarios y perfiles de una campaña. Cada persona es Responsable, Supervisor (su sección) o Gerente (su gerencia, con la validación final).
// Aquí vive la gestión de las cuentas de Supervisor y Gerente: las crea el cliente (gestionarSupervisores) o el equipo MBC desde la consola (rutaPersonaPerfil).
import { HttpError, ahora, uid, txt, normal, mismaArea, igualSeguro, tokenNuevo } from './comun.js';
import { claveArea, registrarAccion } from './ambito.js';
import { leerEstructura, asegurarEstructura } from './estructura.js';

// ---------------------------------------------------------------- panel del cliente: administrador del cliente y Supervisores
export const sha256Hex = async x => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))].map(n => n.toString(16).padStart(2, '0')).join('');

export const hashClaveSup = k => sha256Hex('voz-sup:' + k);   // la clave del Supervisor no se guarda: solo su huella

export const generarClave = () => { for (;;) { const k = tokenNuevo().slice(0, 12); if (/[A-Za-z]/.test(k) && /\d/.test(k)) return k; } };

export async function listaSupervisores(env, campId) {
  const r = (await env.DB.prepare('SELECT id, nombre, correo, activo, alcance, creado, ultimo, perfil, encuestado_id FROM supervisores WHERE campana_id=? ORDER BY nombre').bind(campId).all()).results;
  return r.map(x => { let al = {}; try { al = JSON.parse(x.alcance) || {}; } catch (e) { al = {}; } return { ...x, alcance: al }; });
}

// ---- Supervisores (los crea y administra el administrador del cliente)
export async function validarClaveNueva(env, camp, k, ignorarSupId) {
  if (k.length < 8 || k.length > 40) throw new HttpError(400, 'La clave debe tener de 8 a 40 caracteres.');
  if (!/^[A-Za-z0-9._\-!@#$%&*+=]+$/.test(k)) throw new HttpError(400, 'La clave solo puede llevar letras, números y estos signos: . _ - ! @ # $ % & * + =');
  if (!/[A-Za-z]/.test(k) || !/\d/.test(k)) throw new HttpError(400, 'La clave debe combinar letras y números.');
  const sin = x => normal(x).replace(/[^a-z0-9]/g, ''), n = sin(k);
  if (/^(.)\1+$/.test(n) || /(password|contrasena|123456|qwerty|abcdef)/.test(n)) throw new HttpError(400, 'Esa clave es demasiado fácil de adivinar: elige otra.');
  if ((sin(camp.cliente).length > 3 && n.includes(sin(camp.cliente))) || (sin(camp.nombre).length > 3 && n.includes(sin(camp.nombre)))) throw new HttpError(400, 'La clave no debe contener el nombre del cliente ni de la campaña.');
  if (igualSeguro(k, (env.ADMIN_CODE || '').trim())) throw new HttpError(400, 'Esa clave no se puede usar.');
  if (await env.DB.prepare('SELECT id FROM campanas WHERE codigo_cliente=?').bind(k).first()) throw new HttpError(409, 'Esa clave ya está en uso: elige otra.');
  const otro = await env.DB.prepare('SELECT id FROM supervisores WHERE clave_hash=?').bind(await hashClaveSup(k)).first();
  if (otro && otro.id !== ignorarSupId) throw new HttpError(409, 'Esa clave ya está en uso: elige otra.');
}

export async function alcanceValido(env, camp, a) {
  a = a || {};
  if (a.todo) return { todo: true, gerencias: [], secciones: [], procesos: [] };
  const filas = (await env.DB.prepare('SELECT id, gerencia, seccion FROM procesos WHERE campana_id=?').bind(camp.id).all()).results;
  const conEstructura = filas.concat(await leerEstructura(env, camp.id));   // gerencias y secciones del esqueleto, aunque aún no tengan procesos
  const gers = [], secs = [], procs = [], ok = new Set(filas.map(p => p.id));
  (Array.isArray(a.gerencias) ? a.gerencias : []).forEach(g => { const f = conEstructura.find(p => mismaArea(p.gerencia, g)); if (f && !gers.includes(f.gerencia)) gers.push(f.gerencia); });
  (Array.isArray(a.secciones) ? a.secciones : []).forEach(x => {
    const f = conEstructura.find(p => mismaArea(p.gerencia, x && x.g) && mismaArea(p.seccion, x && x.s));
    if (f && !secs.some(y => claveArea(y.g, y.s) === claveArea(f.gerencia, f.seccion))) secs.push({ g: f.gerencia, s: f.seccion });
  });
  (Array.isArray(a.procesos) ? a.procesos : []).forEach(id => { id = txt(id, 60); if (ok.has(id) && !procs.includes(id)) procs.push(id); });
  if (!gers.length && !secs.length && !procs.length) throw new HttpError(400, 'Define al menos una gerencia, sección o proceso, o marca el acceso total.');
  return { todo: false, gerencias: gers, secciones: secs.slice(0, 200), procesos: procs.slice(0, 2000) };
}

export async function gestionarSupervisores(env, camp, actor, b) {
  const accion = String(b.accion || '');
  if (!['crear', 'editar', 'activar', 'desactivar', 'clave'].includes(accion)) throw new HttpError(400, 'Acción inválida');
  const nombre = txt(b.nombre, 150), correo = txt(b.correo, 150).toLowerCase();
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new HttpError(400, 'El correo no es válido.');
  if (accion === 'crear') {
    if (nombre.length < 3) throw new HttpError(400, 'Escribe el nombre del supervisor.');
    const alcance = await alcanceValido(env, camp, b.alcance);
    const clave = txt(b.clave, 60) || generarClave();
    await validarClaveNueva(env, camp, clave, '');
    const id = uid();
    await env.DB.prepare('INSERT INTO supervisores (id, campana_id, nombre, correo, clave_hash, activo, alcance, creado) VALUES (?,?,?,?,?,1,?,?)')
      .bind(id, camp.id, nombre, correo, await hashClaveSup(clave), JSON.stringify(alcance), ahora()).run();
    await registrarAccion(env, camp.id, actor, 'supervisor_creado', { supervisor: nombre, supervisor_id: id });
    return { ok: true, id, clave, supervisores: await listaSupervisores(env, camp.id) };
  }
  const sup = await env.DB.prepare('SELECT * FROM supervisores WHERE id=? AND campana_id=?').bind(txt(b.id, 60), camp.id).first();
  if (!sup) throw new HttpError(404, 'Supervisor no encontrado');
  let clave = '';
  if (accion === 'editar') {
    const n2 = b.nombre === undefined ? sup.nombre : nombre;
    if (n2.length < 3) throw new HttpError(400, 'Escribe el nombre del supervisor.');
    const alcance = b.alcance === undefined ? sup.alcance : JSON.stringify(await alcanceValido(env, camp, b.alcance));
    await env.DB.prepare('UPDATE supervisores SET nombre=?, correo=?, alcance=? WHERE id=?').bind(n2, b.correo === undefined ? sup.correo : correo, alcance, sup.id).run();
    await registrarAccion(env, camp.id, actor, 'supervisor_editado', { supervisor: n2, supervisor_id: sup.id });
  } else if (accion === 'activar' || accion === 'desactivar') {
    await env.DB.prepare('UPDATE supervisores SET activo=? WHERE id=?').bind(accion === 'activar' ? 1 : 0, sup.id).run();
    await registrarAccion(env, camp.id, actor, accion === 'activar' ? 'supervisor_activado' : 'supervisor_desactivado', { supervisor: sup.nombre, supervisor_id: sup.id });
  } else {
    clave = txt(b.clave, 60) || generarClave();
    await validarClaveNueva(env, camp, clave, sup.id);
    await env.DB.prepare('UPDATE supervisores SET clave_hash=? WHERE id=?').bind(await hashClaveSup(clave), sup.id).run();
    await registrarAccion(env, camp.id, actor, 'supervisor_clave_nueva', { supervisor: sup.nombre, supervisor_id: sup.id });
  }
  return { ok: true, id: sup.id, clave, supervisores: await listaSupervisores(env, camp.id) };
}


// ---------------------------------------------------------------- perfil de una persona (lo asigna el consultor)
// Responsable (sus procesos), Supervisor (su sección; llega hasta el avance, sin validación final) o Gerente (su gerencia; da la validación final).
const PERFILES = ['responsable', 'supervisor', 'gerente'];
const ACTOR_MBC = { rol: 'consultor', sup: null, nombre: 'Equipo consultor' };

// Gerencias y secciones que la campaña ya conoce: las de sus procesos y las del esqueleto.
async function conocidas(env, campId) {
  const filas = (await env.DB.prepare('SELECT DISTINCT gerencia, seccion FROM procesos WHERE campana_id=?').bind(campId).all()).results;
  return filas.concat(await leerEstructura(env, campId));
}

// Alcance por nombres: sirve para una cuenta sin procesos todavía (la sección o la gerencia puede estar vacía o ser nueva). Los nombres toman la
// escritura que ya tenga la campaña; lo que no exista se agrega al esqueleto (si la campaña lo usa) para que aparezca en el mapa.
export async function alcancePorNombres(env, camp, a) {
  a = a || {};
  const conoc = await conocidas(env, camp.id);
  const canonG = g => { const f = conoc.find(x => mismaArea(x.gerencia, g)); return f ? f.gerencia : txt(g, 150); };
  const gers = [], secs = [], procs = [];
  (Array.isArray(a.gerencias) ? a.gerencias : []).forEach(g => { const c = canonG(g); if (c && !gers.some(x => mismaArea(x, c))) gers.push(c); });
  (Array.isArray(a.secciones) ? a.secciones : []).forEach(x => {
    const g = canonG(x && x.g), f = conoc.find(y => mismaArea(y.gerencia, g) && mismaArea(y.seccion, x && x.s)), sec = f ? f.seccion : txt(x && x.s, 150);
    if (g && sec && !secs.some(y => claveArea(y.g, y.s) === claveArea(g, sec))) secs.push({ g, s: sec });
  });
  const ids = [...new Set((Array.isArray(a.procesos) ? a.procesos : []).map(x => txt(x, 60)).filter(Boolean))].slice(0, 2000);
  if (ids.length) {
    const ok = new Set((await env.DB.prepare('SELECT id FROM procesos WHERE campana_id=?').bind(camp.id).all()).results.map(p => p.id));
    ids.forEach(id => { if (ok.has(id)) procs.push(id); });
  }
  if (!gers.length && !secs.length && !procs.length) throw new HttpError(400, 'Indica la gerencia o la sección que le corresponde.');
  for (const x of secs) await asegurarEstructura(env, camp.id, x.g, x.s);
  return { todo: false, gerencias: gers, secciones: secs, procesos: procs };
}

// Da, cambia o quita el perfil de una persona. op: {secciones, gerencias, procesos} amplían su alcance; regenerar pide una clave nueva;
// recalcular rehace el alcance aunque el perfil no cambie. Devuelve {perfil, supervisor_id, clave}: la clave solo viene al crear la cuenta o renovarla.
export async function aplicarPerfil(env, camp, enc, perfil, op) {
  op = op || {};
  const sup = await env.DB.prepare('SELECT * FROM supervisores WHERE campana_id=? AND encuestado_id=?').bind(camp.id, enc.id).first();
  if (perfil === 'responsable') {
    if (sup && sup.activo) {
      await env.DB.prepare('UPDATE supervisores SET activo=0 WHERE id=?').bind(sup.id).run();
      await registrarAccion(env, camp.id, ACTOR_MBC, 'perfil_quitado', { persona: enc.nombre, supervisor_id: sup.id });
    }
    return { perfil, supervisor_id: sup ? sup.id : '', clave: '' };
  }
  const pedido = perfil === 'gerente'
    ? { gerencias: [enc.gerencia, ...(op.gerencias || [])], secciones: op.secciones || [], procesos: op.procesos || [] }
    : { secciones: [{ g: enc.gerencia, s: enc.seccion }, ...(op.secciones || [])], procesos: op.procesos || [] };
  const alcance = await alcancePorNombres(env, camp, pedido);
  let clave = '', id;
  if (sup) {
    id = sup.id;
    const cambia = sup.perfil !== perfil || !sup.activo || !!op.recalcular;
    if (op.regenerar) { clave = generarClave(); await validarClaveNueva(env, camp, clave, sup.id); }
    const valores = [perfil, cambia ? JSON.stringify(alcance) : sup.alcance, enc.nombre, enc.correo || sup.correo];
    if (clave) valores.push(await hashClaveSup(clave));
    valores.push(sup.id);
    await env.DB.prepare('UPDATE supervisores SET perfil=?, alcance=?, activo=1, nombre=?, correo=?' + (clave ? ', clave_hash=?' : '') + ' WHERE id=?').bind(...valores).run();
  } else {
    id = uid(); clave = generarClave();
    await validarClaveNueva(env, camp, clave, '');
    await env.DB.prepare('INSERT INTO supervisores (id, campana_id, nombre, correo, clave_hash, activo, alcance, creado, perfil, encuestado_id) VALUES (?,?,?,?,?,1,?,?,?,?)')
      .bind(id, camp.id, enc.nombre, enc.correo || '', await hashClaveSup(clave), JSON.stringify(alcance), ahora(), perfil, enc.id).run();
  }
  await registrarAccion(env, camp.id, ACTOR_MBC, 'perfil_asignado', { persona: enc.nombre, perfil, supervisor_id: id });
  return { perfil, supervisor_id: id, clave };
}

export async function rutaPersonaPerfil(env, b) {
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(txt(b.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const perfil = String(b.perfil || '');
  if (!PERFILES.includes(perfil)) throw new HttpError(400, 'Perfil inválido');
  const enc = await env.DB.prepare('SELECT id, nombre, correo, gerencia, seccion FROM encuestados WHERE id=? AND campana_id=?').bind(txt(b.encuestado_id, 60), camp.id).first();
  if (!enc) throw new HttpError(404, 'Persona no encontrada');
  const r = await aplicarPerfil(env, camp, enc, perfil, { regenerar: !!b.regenerar });
  return Object.assign({ ok: true }, r, { supervisores: await listaSupervisores(env, camp.id) });
}

// ---------------------------------------------------------------- asignar secciones y procesos completos a una persona
// Cada sección da todos sus procesos vigentes; procesos suelta ids puntuales. Es la misma asignación «del equipo» de siempre (origen consultor).
export async function asignarSeccionesYProcesos(env, campId, encId, secciones, procesos) {
  const filas = (await env.DB.prepare('SELECT id, gerencia, seccion, fuera_alcance FROM procesos WHERE campana_id=?').bind(campId).all()).results;
  const ids = new Set();
  (secciones || []).forEach(x => filas.forEach(p => { if (!p.fuera_alcance && mismaArea(p.gerencia, x.g) && mismaArea(p.seccion, x.s)) ids.add(p.id); }));
  const sueltos = new Set((procesos || []).map(x => txt(x, 60)));
  filas.forEach(p => { if (!p.fuera_alcance && sueltos.has(p.id)) ids.add(p.id); });
  const t = ahora(), st = [];
  ids.forEach(pid => {
    st.push(env.DB.prepare("DELETE FROM asignaciones WHERE encuestado_id=? AND proceso_id=? AND origen='excluido'").bind(encId, pid));
    st.push(env.DB.prepare('INSERT OR IGNORE INTO asignaciones (encuestado_id, proceso_id, creado, origen) VALUES (?,?,?,?)').bind(encId, pid, t, 'consultor'));
    st.push(env.DB.prepare("UPDATE asignaciones SET origen='consultor' WHERE encuestado_id=? AND proceso_id=? AND origen IN ('inventario','encuestado')").bind(encId, pid));
  });
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return ids.size;
}

// ---------------------------------------------------------------- crear o editar un usuario desde la consola
// Datos personales, perfil, y las secciones y procesos que recibe (todos los procesos de cada sección a la vez). Un Supervisor o Gerente
// puede crearse sin procesos: su alcance sale de los nombres de su sección o gerencia.
export async function rutaUsuario(env, b) {
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(txt(b.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const perfil = String(b.perfil || 'responsable');
  if (!PERFILES.includes(perfil)) throw new HttpError(400, 'Perfil inválido');
  const nombre = txt(b.nombre, 150), correo = txt(b.correo, 150).toLowerCase(), rol = txt(b.rol, 60);
  if (nombre.length < 3) throw new HttpError(400, 'Escribe el nombre completo.');
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new HttpError(400, 'El correo no es válido.');
  const conoc = await conocidas(env, camp.id);
  const canonG = g => { const f = conoc.find(x => mismaArea(x.gerencia, g)); return f ? f.gerencia : txt(g, 150); };
  const canonS = (g, sec) => { const f = conoc.find(x => mismaArea(x.gerencia, g) && mismaArea(x.seccion, sec)); return f ? f.seccion : txt(sec, 150); };
  const gerencia = canonG(b.gerencia), seccion = canonS(gerencia, b.seccion);
  if (!gerencia || !seccion) throw new HttpError(400, 'Indica la gerencia y la sección principal.');
  const secciones = (Array.isArray(b.secciones) ? b.secciones : []).slice(0, 200).map(x => ({ g: canonG(x && x.g), s: canonS(canonG(x && x.g), x && x.s) })).filter(x => x.g && x.s);
  const procesos = Array.isArray(b.procesos) ? b.procesos.slice(0, 3000) : [];

  if (correo) {
    const otra = await env.DB.prepare("SELECT id FROM encuestados WHERE campana_id=? AND lower(correo)=? AND id<>?").bind(camp.id, correo, txt(b.id, 60)).first();
    if (otra) throw new HttpError(409, 'Ya hay una persona con ese correo en la campaña.');
  }
  let id = txt(b.id, 60), creada = false;
  if (id) {
    const ya = await env.DB.prepare('SELECT id FROM encuestados WHERE id=? AND campana_id=?').bind(id, camp.id).first();
    if (!ya) throw new HttpError(404, 'Persona no encontrada');
    await env.DB.prepare('UPDATE encuestados SET nombre=?, correo=?, rol=?, gerencia=?, seccion=? WHERE id=?').bind(nombre, correo, rol, gerencia, seccion, id).run();
  } else {
    id = uid(); creada = true;
    await env.DB.prepare('INSERT INTO encuestados (id, campana_id, token, nombre, correo, gerencia, seccion, rol, creado) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, camp.id, tokenNuevo(), nombre, correo, gerencia, seccion, rol, ahora()).run();
  }
  for (const x of [{ g: gerencia, s: seccion }, ...secciones]) await asegurarEstructura(env, camp.id, x.g, x.s);
  const asignados = await asignarSeccionesYProcesos(env, camp.id, id, secciones, procesos);
  const enc = { id, nombre, correo, gerencia, seccion };
  const r = await aplicarPerfil(env, camp, enc, perfil, { secciones, procesos, regenerar: !!b.regenerar, recalcular: true });
  await registrarAccion(env, camp.id, ACTOR_MBC, creada ? 'usuario_creado' : 'usuario_editado', { persona: nombre, perfil, secciones: secciones.length, asignados });
  return Object.assign({ ok: true, id, creada, asignados }, r, { supervisores: await listaSupervisores(env, camp.id) });
}

// ---------------------------------------------------------------- claves para la descarga de enlaces personales
// La clave de un Supervisor o Gerente no se puede leer después de creada (solo se guarda su huella): para entregarla de nuevo se genera una nueva
// y la anterior deja de servir. Devuelve una por cada persona de la lista que tenga ese perfil activo.
export async function rutaClavesPerfiles(env, b) {
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(txt(b.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const ids = [...new Set((Array.isArray(b.encuestado_ids) ? b.encuestado_ids : []).map(x => txt(x, 60)).filter(Boolean))].slice(0, 300);
  const claves = [];
  for (const eid of ids) {
    const sup = await env.DB.prepare("SELECT * FROM supervisores WHERE campana_id=? AND encuestado_id=? AND activo=1 AND perfil IN ('supervisor','gerente')").bind(camp.id, eid).first();
    if (!sup) continue;
    const clave = generarClave();
    await validarClaveNueva(env, camp, clave, sup.id);
    await env.DB.prepare('UPDATE supervisores SET clave_hash=? WHERE id=?').bind(await hashClaveSup(clave), sup.id).run();
    claves.push({ encuestado_id: eid, nombre: sup.nombre, perfil: sup.perfil, clave });
  }
  if (claves.length) await registrarAccion(env, camp.id, ACTOR_MBC, 'claves_regeneradas', { personas: claves.length, motivo: 'descarga de enlaces personales' });
  return { ok: true, claves };
}
