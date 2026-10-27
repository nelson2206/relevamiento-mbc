// Utilidades compartidas por el Worker: errores HTTP, identificadores, fechas, texto y registro de eventos.
// Salen de index.js para que los módulos nuevos (flujo, cobertura) no dependan del archivo principal.

export class HttpError extends Error {
  constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; }   // extra: campos que el cliente recibe junto al error
}

export const ahora = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

// Minúsculas, sin tildes y sin espacios repetidos: "Importación" y "importacion" son lo mismo.
export const normal = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Gerencia y sección se comparan sin mayúsculas ni tildes: "Control interno" y "Control Interno" son la misma área.
export const mismaArea = (a, b) => normal(a) === normal(b);

// Registro estructurado para Workers Logs. Solo datos operativos: nunca tokens completos, nombres,
// correos ni texto de respuestas.
export function log(evento, datos) {
  try { console.log(JSON.stringify(Object.assign({ evento }, datos || {}))); } catch (e) { /* el registro nunca rompe la respuesta */ }
}
export const mascara = k => (k ? String(k).slice(0, 4) + '…' : '');

export function tokenNuevo() {
  // 20 caracteres sin ambiguos (sin 0/O, 1/l/I): se puede dictar por teléfono si hace falta.
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b, x => abc[x % abc.length]).join('');
}

// Comparación en tiempo constante: el tiempo de respuesta no delata cuántos caracteres acertó.
export function igualSeguro(a, b) {
  const te = new TextEncoder();
  const x = te.encode(a || ''), y = te.encode(b || '');
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] || 0) ^ (y[i] || 0);
  return dif === 0;
}
