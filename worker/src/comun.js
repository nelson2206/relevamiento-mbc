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

// PIN de 4 dígitos del colaborador: se guarda solo su huella (PBKDF2 con sal propia), nunca el PIN. Con solo 10.000 combinaciones
// lo que protege es el bloqueo por intentos, no el costo del hash: 10.000 vueltas bastan y caben en los 10 ms de CPU del plan gratuito.
export const pinValido = p => /^\d{4}$/.test(String(p == null ? '' : p));
const aHex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
export const salNueva = () => aHex(crypto.getRandomValues(new Uint8Array(16)));
export async function hashPin(pin, sal) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(sal), iterations: 10000 }, base, 256);
  return aHex(bits);
}
export async function verificarPin(pin, sal, hash) {
  if (!pinValido(pin) || !sal || !hash) return false;
  return igualSeguro(await hashPin(pin, sal), hash);
}

// Comparación en tiempo constante: el tiempo de respuesta no delata cuántos caracteres acertó.
export function igualSeguro(a, b) {
  const te = new TextEncoder();
  const x = te.encode(a || ''), y = te.encode(b || '');
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] || 0) ^ (y[i] || 0);
  return dif === 0;
}
