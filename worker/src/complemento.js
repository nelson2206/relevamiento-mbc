// Cómo se suma información nueva a lo que un punto ya tiene: se complementa, nunca se sobrescribe.
// Compara dos textos y dice si lo nuevo ya estaba (duplicado), amplía lo vigente, lo complementa o lo contradice.
// Es una heurística barata y determinista (sin IA): una alerta es una pista para que el administrador decida, no un veredicto.
import { normal } from './comun.js';

export const MAX_TEXTO = 1500;
const NEGACION = new Set(['no', 'sin', 'nunca', 'ningun', 'ninguna', 'ninguno', 'tampoco', 'jamas']);

const limpio = t => normal(t).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const palabras = t => limpio(t).split(' ').filter(Boolean);
const claves = t => new Set(palabras(t).filter(w => w.length >= 4 && !/^\d+$/.test(w)));
const numeros = t => new Set((String(t || '').match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(',', '.')));
const negado = t => palabras(t).some(w => NEGACION.has(w));

// 'nuevo' (no había nada) | 'duplicado' (lo nuevo ya está) | 'amplia' (lo nuevo contiene lo vigente y agrega) | 'contradice' | 'complementa'
export function comparar(vigente, nuevo) {
  const a = limpio(vigente), b = limpio(nuevo);
  if (!a) return 'nuevo';
  const niega = negado(vigente) !== negado(nuevo);   // «no usa X» contiene «usa X», pero dice lo contrario
  if (!b || (!niega && a.includes(b))) return 'duplicado';
  if (!niega && b.includes(a)) return 'amplia';
  const ka = claves(vigente), kb = claves(nuevo);
  const comunes = [...ka].filter(w => kb.has(w)).length, menor = Math.min(ka.size, kb.size);
  const solape = menor ? comunes / menor : 0;
  if (solape >= 0.25) {
    const na = numeros(vigente), nb = numeros(nuevo);
    const cifras = na.size && nb.size && ([...nb].some(n => !na.has(n)) || [...na].some(n => !nb.has(n)));
    if (niega || cifras) return 'contradice';
  }
  if (solape >= 0.8) return 'duplicado';
  return 'complementa';
}

// Texto resultante de sumar `nuevo` a `vigente`. `contradice` no se une solo: lo decide la persona (ver `forzar` en la aprobación).
export function complementar(vigente, nuevo) {
  const v = String(vigente || '').trim(), n = String(nuevo || '').trim();
  const rel = comparar(v, n);
  if (rel === 'nuevo') return { relacion: rel, texto: n };
  if (rel === 'duplicado') return { relacion: rel, texto: v };
  if (rel === 'amplia') return { relacion: rel, texto: n };
  return { relacion: rel, texto: v + '\n' + n };
}

const GRAVEDAD = { nuevo: 0, complementa: 1, amplia: 1, duplicado: 2, contradice: 3 };

// Alerta de un borrador frente a lo vigente y a los otros borradores del mismo punto. Devuelve { alerta, con } (con: contra qué choca).
export function alertaDe(vigente, nuevo, otros) {
  let peor = comparar(vigente, nuevo), con = peor === 'nuevo' ? '' : 'lo ya registrado';
  (otros || []).forEach(o => {
    const r = comparar(o.texto, nuevo);
    if (GRAVEDAD[r] > GRAVEDAD[peor] && r !== 'amplia') { peor = r; con = o.documento || 'otro documento'; }
  });
  return { alerta: peor, con };
}

// ---- Un campo de la matriz con dos aportes automáticos: lo que dicen los documentos (precarga) y lo que armó la IA (encuestas + documentos).
// matriz_ia[campo] guarda cada aporte por separado ({estado, en, pre, ia}); la matriz muestra los dos juntos. Así, cada fuente puede
// actualizar SU parte sin borrar la de la otra. Sin partes guardadas (datos anteriores) se deduce del estado: 'precarga' = documentos, otro = IA.
export function partesDe(valor, marca) {
  const v = String(valor || '').trim();
  if (!marca) return { pre: '', ia: '' };
  if (typeof marca.pre === 'string' || typeof marca.ia === 'string') return { pre: marca.pre || '', ia: marca.ia || '' };
  return marca.estado === 'precarga' ? { pre: v, ia: '' } : { pre: '', ia: v };
}
// El texto del campo: los documentos primero y la IA después; si uno ya contiene al otro no se repite.
export function componer(pre, ia) {
  return complementar(String(pre || '').trim(), String(ia || '').trim()).texto.trim();
}
