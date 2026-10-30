// Pregunta estructurada «¿El proceso gestiona información altamente confidencial?». No es de texto libre: la persona marca Sí o No,
// dice cuál y señala dónde se almacena. Se guarda en respuestas.datos (JSON). Funciones puras, sin base ni red.
import { txt } from './comun.js';

export const ID_BLOQUE_CONFIDENCIAL = 'bconf';
export const PUNTO_CONFIDENCIAL = 'confidencial';
export const UBICACIONES = [
  ['correo', 'Correo electrónico'],
  ['sharepoint', 'SharePoint / Teams'],
  ['onedrive', 'OneDrive'],
  ['sistema_tdp', 'Sistema o aplicación de Toyota del Perú'],
  ['carpeta_local', 'Carpeta local (no OneDrive)'],
  ['fisico', 'Medio físico (documentos impresos, expedientes, etc.)'],
  ['tercero', 'Plataforma o sistema de un tercero / proveedor'],
  ['otro', 'Otro']
];
const ETIQUETA = Object.fromEntries(UBICACIONES);

// Deja la respuesta en su forma canónica. Solo con «Sí» tienen sentido «cuál», las ubicaciones y el detalle de «Otro»:
// al pasar a «No» (o a no responder) se descartan, para que no queden datos que contradigan la respuesta.
export function limpiarDatos(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const confidencial = r.confidencial === 'si' ? 'si' : r.confidencial === 'no' ? 'no' : '';
  if (confidencial !== 'si') return { confidencial, cual: '', ubicaciones: [], otro: '' };
  const ubicaciones = [...new Set((Array.isArray(r.ubicaciones) ? r.ubicaciones : []).map(x => String(x)).filter(x => ETIQUETA[x]))];
  return { confidencial, cual: txt(r.cual, 500), ubicaciones, otro: ubicaciones.includes('otro') ? txt(r.otro, 300) : '' };
}

// ¿Está completa para dar por cubierto el punto? «No» basta; «Sí» pide cuál, al menos una ubicación y, si marcó «Otro», su detalle.
export function evaluar(datos) {
  const d = limpiarDatos(datos), faltan = [];
  if (!d.confidencial) faltan.push('Indica si el proceso gestiona información altamente confidencial');
  else if (d.confidencial === 'si') {
    if (!d.cual) faltan.push('Indica cuál es la información');
    if (!d.ubicaciones.length) faltan.push('Marca dónde se almacena');
    else if (d.ubicaciones.includes('otro') && !d.otro) faltan.push('Detalla el otro lugar de almacenamiento');
  }
  return { completo: !faltan.length, faltan };
}

// Resumen legible de lo respondido (lo que ve la persona y lo que lee la IA). Vacío si todavía no respondió.
export function resumenTexto(datos) {
  const d = limpiarDatos(datos);
  if (!d.confidencial) return '';
  if (d.confidencial === 'no') return 'No gestiona información altamente confidencial.';
  const donde = d.ubicaciones.map(u => (u === 'otro' && d.otro ? 'Otro: ' + d.otro : ETIQUETA[u])).join(', ');
  return 'Gestiona información altamente confidencial' + (d.cual ? ': ' + d.cual : '') + '.' + (donde ? ' Se almacena en: ' + donde + '.' : '');
}

// ---------------------------------------------------------------- respuesta por voz o por archivo
// La persona puede contestar hablando o subiendo un archivo: la IA lee lo dicho y PROPONE las opciones; la persona las revisa y las
// confirma antes de que se guarden. Política de cero alucinación: solo se marca lo que se dice de forma explícita.
export const ESQUEMA_IA = {
  type: 'object',
  properties: {
    relevante: { type: 'boolean' }, motivo: { type: 'string' },
    confidencial: { type: 'string', enum: ['si', 'no', ''] },
    cual: { type: 'string' },
    ubicaciones: { type: 'array', items: { type: 'string', enum: UBICACIONES.map(u => u[0]) } },
    otro: { type: 'string' }
  },
  required: ['relevante', 'motivo', 'confidencial', 'cual', 'ubicaciones', 'otro'],
  additionalProperties: false
};
export const PROMPT_IA = `Recibes lo que una persona dijo con su voz (transcripción) o un archivo (imagen, PDF o Word) para responder esta pregunta de un relevamiento de procesos:
«¿El proceso gestiona actualmente información Altamente Confidencial (nómina de colaboradores, expedientes de personal, contratos estratégicos, presupuestos, rundown, lista de precios, datos personales, información de proyectos no divulgados, entre otros)? Si es así, ¿cuál y dónde se encuentra almacenada?»
Marca las opciones SOLO con lo que se dice de forma explícita; política de cero alucinación:
- "confidencial": "si" solo si afirma claramente que el proceso gestiona información altamente confidencial; "no" solo si afirma claramente que no; en cualquier otro caso "" (no lo infieras por el tipo de proceso).
- "cual": qué información es, con las palabras de la persona (máximo 30 palabras). Nunca copies datos personales concretos (nombres, DNI, teléfonos, correos, montos): usa categorías ("nómina", "expedientes de personal"). Vacío si no la nombra o si dijo "no".
- "ubicaciones": ids EXACTOS de esta lista, solo los lugares que menciona: ${UBICACIONES.map(([id, et]) => `${id} = ${et}`).join('; ')}. Correspondencias: Outlook o correo → correo; SharePoint o Teams → sharepoint; SAP, DMS o un sistema propio de Toyota del Perú → sistema_tdp; papel, impresos o archivadores → fisico; el portal o sistema de un proveedor → tercero. Vacío si dijo "no" o no menciona dónde.
- "otro": si menciona un lugar que no está en la lista, inclúyelo en "ubicaciones" como "otro" y descríbelo aquí (máximo 20 palabras); si no, vacío.
Si el contenido no responde a esta pregunta, "relevante" es false, lo demás queda vacío y en "motivo" dices en una frase qué se ve o se escucha.`;

// Salida de la IA → respuesta lista para mostrar: limpia, con lo que aún falta.
export function desdeSalidaIA(s) {
  const salida = s && typeof s === 'object' ? s : {};
  const datos = salida.relevante ? limpiarDatos(salida) : limpiarDatos({});
  return { datos, motivo: salida.relevante ? '' : txt(salida.motivo, 300), ...evaluar(datos) };
}
