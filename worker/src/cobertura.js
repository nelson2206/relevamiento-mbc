// Cobertura de los procesos: cuándo un proceso cuenta como respondido. Es la misma regla que usa la consola
// (cobertura() en admin.html), llevada al servidor para que el flujo del Supervisor decida los bloqueos aquí
// y no en el navegador. Función pura: recibe filas ya leídas de D1 y no toca la base.
//
// Regla «ácida» (2026-11-16): solo cuenta lo que hizo la persona responsable, no lo que preparó el equipo.
// En curso: alguien escribió o marcó algo (texto, sistemas, confidencialidad o un punto cubierto). Validar una información
// previa (confirmar una precarga o un campo de la matriz) suma el punto, pero por sí sola NO pone el proceso en curso.
// Marcar el proceso como «lo hago» en su lista tampoco basta.
// Respondido: una persona dejó listos todos los puntos, o entre todas las personas los cubren. Un punto precargado por el
// equipo solo cuenta si una persona lo confirmó vigente. No vigente: solo hay marcas de «ya no se hace». Sin cobertura: el resto.
// `preguntas` = preguntas distintas con respuesta (base de «iniciado» ≥1 y «avanzado» ≥2 en la trazabilidad).

const PREG_ANTES = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];   // formato anterior (6 preguntas)

function leerJson(s, porDefecto) {
  try { const o = JSON.parse(s || ''); return o == null ? porDefecto : o; } catch (e) { return porDefecto; }
}
const puntoListo = (ck, id) => { const x = ck && ck[id]; return !!x && (x.estado === 'cubierto' || x.estado === 'no_aplica'); };
const confirmado = (ck, id) => !!(ck && ck._vigentes && ck._vigentes[id]);   // la persona confirmó vigente la precarga de ese punto
const tieneContenido = r => !!(String(r.texto || '').trim() || (r.sistemas && r.sistemas !== '[]'));
// «Pregunta respondida» (proceso iniciado o avanzado, en el área y en la persona): texto, sistemas, respuesta estructurada de confidencialidad o un punto «cubierto».
// NO cuenta la sola confirmación de que la descripción precargada sigue vigente (`_vigentes`): confirmar no es responder.
export const preguntaRespondida = r => !!(String(r.texto || '').trim() || (r.sistemas && r.sistemas !== '[]') || /"confidencial":"(si|no)"/.test(r.datos || '') || /"estado":"cubierto"/.test(r.checklist || ''));
// «Con respuesta»: lo anterior o una confirmación de la descripción vigente. Es lo que pone un proceso «en curso».
export const tieneRespuesta = r => !!(preguntaRespondida(r) || /"_vigentes":\{"/.test(r.checklist || ''));

// bloques: BLOQUES del Worker · revisiones: {encuestado_id, proceso_id, estado}
// respuestas: {encuestado_id, proceso_id, pregunta, texto, sistemas, checklist, datos}
// validados: {proceso_id, punto} campos de la matriz que una persona validó desde la encuesta (puntosValidados)
// La precarga del equipo ya no entra en la regla: sin confirmación de una persona no es avance.
export function crearCobertura({ bloques, revisiones, respuestas, validados = [] }) {
  const puntos = bloques.flatMap(b => b.puntos.map(p => p[0]));
  const total = puntos.length, validos = new Set(puntos);
  const rev = {}, todas = {}, participa = {}, val = {}, preguntas = {};
  revisiones.forEach(r => { (rev[r.proceso_id] = rev[r.proceso_id] || []).push(r); });
  respuestas.forEach(r => {
    const fila = { pregunta: r.pregunta, ck: leerJson(r.checklist, {}), contenido: tieneContenido(r) };
    const t = todas[r.proceso_id] = todas[r.proceso_id] || {};
    (t[r.encuestado_id] = t[r.encuestado_id] || []).push(fila);
    if (tieneRespuesta(r)) (participa[r.proceso_id] = participa[r.proceso_id] || {})[r.encuestado_id] = 1;
    if (preguntaRespondida(r)) (preguntas[r.proceso_id] = preguntas[r.proceso_id] || new Set()).add(r.pregunta);   // preguntas distintas con respuesta, entre todas las personas
  });
  validados.forEach(x => { if (validos.has(x.punto)) (val[x.proceso_id] = val[x.proceso_id] || {})[x.punto] = 1; });

  function avancePersona(pid, eid) {
    const filas = (todas[pid] || {})[eid] || [], por = {};
    filas.forEach(f => { por[f.pregunta] = f; });
    if (PREG_ANTES.every(q => por[q] && por[q].contenido)) return { listos: total, total, completo: true };   // formato anterior
    const v = val[pid] || {};
    let listos = 0;
    bloques.forEach(b => {
      const ck = (por[b.id] || {}).ck || {};
      b.puntos.forEach(pt => { if (v[pt[0]] || puntoListo(ck, pt[0]) || confirmado(ck, pt[0])) listos++; });
    });
    return { listos, total, completo: total > 0 && listos === total };
  }

  // Puntos cubiertos entre todas las personas, sin repetir: marcados por ellas, precarga que confirmaron o campos que validaron.
  function puntosUnidos(pid) {
    const cub = new Set(Object.keys(val[pid] || {}));
    Object.values(todas[pid] || {}).forEach(filas => filas.forEach(f => {
      validos.forEach(k => { if (puntoListo(f.ck, k) || confirmado(f.ck, k)) cub.add(k); });
    }));
    return cub.size;
  }

  // cobertura(pid): estado del proceso entre todas las personas · cobertura.persona(pid, eid): avance de una persona en ese proceso
  const cobertura = function (pid) {
    const revs = rev[pid] || [], personas = new Set(Object.keys(participa[pid] || {}));
    const activo = personas.size > 0 || Object.keys(val[pid] || {}).length > 0;
    let completos = [...personas].filter(eid => avancePersona(pid, eid).completo).length;
    const unidos = puntosUnidos(pid);
    if (!completos && activo && total > 0 && unidos === total) completos = 1;
    const noExiste = revs.filter(r => r.estado === 'no_existe').length;
    const tomado = revs.some(r => r.estado === 'vigente' || r.estado === 'cambio');   // alguien dice que lo hace: no sale del denominador aunque otro diga «ya no se hace»
    const escribio = (preguntas[pid] || new Set()).size > 0;   // al menos una pregunta respondida por alguien: validar o confirmar no basta
    const estado = completos ? 'respondido' : escribio ? 'en_curso' : noExiste && !tomado ? 'no_vigente' : 'sin_cobertura';
    return { estado, personas: personas.size, completos, puntos: Math.min(unidos, total), total, preguntas: (preguntas[pid] || new Set()).size };
  };
  cobertura.persona = avancePersona;
  return cobertura;
}
