// Lógica compartida de la atención de Daniela (Wasapi y Chattigo):
// prompt, lectura de PDF/imagen, contrato JSON y validación del traspaso.
// El envío y el webhook siguen en cada canal.
const fs = require('fs');
const path = require('path');

const BASE_PROMPT = fs.readFileSync(path.join(__dirname, 'prompt_primer_contacto.txt'), 'utf8');
const FRASE_TRASPASO = 'Voy a pasar su caso a un consultor del equipo para que continúe con usted por este chat. No tendrá que repetir nada.';

const REGLAS_EXTRA = `
MEMORIA Y ARCHIVOS (muy importante)
- Recibes la conversación completa y la ficha del cliente ya recopilada. NUNCA vuelvas a preguntar un dato que ya está en la ficha o que el cliente ya dijo; confírmalo solo si es dudoso.
- Si el cliente envía un PDF o una imagen, léelo: extrae nombre, marca, modelo, fecha, valor, IVA, etc. y llena la ficha. Agradece y pregunta solo lo que falte.
- Si manda un archivo que no puedes leer, dile que lo revisará un consultor y sigue con la siguiente pregunta pendiente.
- La guía de conocimiento puede traer precios, honorarios o tarifas: IGNÓRALOS. Los únicos valores que puedes decir son los de la ETAPA 3 del prompt (según origen), y solo en esa etapa.
- Suena como un abogado cercano asesorando, no como un formulario.
- Si el cliente manda varios mensajes seguidos, respóndelos juntos en un solo mensaje corto.
FORMATO: texto plano. NUNCA uses asteriscos, negritas, guiones de lista ni Markdown; WhatsApp los muestra mal.
SALIDA: responde SOLO un JSON válido, sin texto fuera de él:
{"respuesta":"texto para el cliente, plano (puede tener 2 o 3 mensajes cortos separados por una línea en blanco)","perfil":{"nombre":null,"marca_modelo":null,"tipo_vehiculo":null,"compro_nuevo":null,"primer_dueno":null,"fecha_compra":null,"titular_factura":null,"tiene_certificado_upme":null,"ciudad":null,"saldos_dian":null,"origen":null,"iva_factura":null,"valor_sin_iva":null,"interesado":null,"precio_informado":null,"acepta_avanzar":null,"documentos_recibidos":[],"objeciones":null,"notas":null},"datos_archivo":"resumen breve de lo leído en el archivo o null","traspasar":false,"motivo_traspaso":null,"causa_escalamiento":null}
En "perfil" pon solo lo que sepas (conserva lo anterior). "documentos_recibidos" lista los que ya llegaron y leíste: "factura", "rut", "cedula". "acepta_avanzar":true solo cuando el cliente dijo claramente que sí quiere avanzar. "traspasar":true con "motivo_traspaso":"completo" y "respuesta":"" SOLO cuando tengas la ficha completa, acepta_avanzar=true y documentos factura, rut y cedula recibidos (el sistema pide el momento y entrega al agente). Si es un caso de ESCALA DE INMEDIATO A HUMANO usa "motivo_traspaso":"escalamiento" y "causa_escalamiento" con exactamente una de: empresa, dos_propietarios, apoderado, rut_42_48, leasing, iva_19, error_certificado, cuenta_digital, inadmision, plazo_critico, cliente_molesto, pide_contrato, pide_estado, pide_llamada. Sin una de esas causas no se acepta el traspaso. Mientras falte algo, NO traspases: sigue con la etapa que corresponda.`;

const CAMPOS_CLAVE = ['nombre', 'marca_modelo', 'tipo_vehiculo', 'compro_nuevo', 'fecha_compra', 'titular_factura', 'tiene_certificado_upme', 'ciudad', 'saldos_dian', 'origen'];
const CAUSAS_ESCALA = ['empresa', 'dos_propietarios', 'apoderado', 'rut_42_48', 'leasing', 'iva_19', 'error_certificado', 'cuenta_digital', 'inadmision', 'plazo_critico', 'cliente_molesto', 'pide_contrato', 'pide_estado', 'pide_llamada'];

const PREGUNTA_FALTA = {
  acepta_avanzar: 'Para dejar todo listo, ¿avanzamos con su caso?',
  saldos_dian: 'Una última consulta para validar su beneficio: ¿tiene saldos pendientes por pagar ante la DIAN?',
  origen: '¿Cómo llegó con nosotros? ¿Fue por SURA, por EPM, Grupo Confamilia u otro medio?',
  doc_factura: '¿Me puede enviar la factura de compra en PDF o imagen?',
  doc_rut: '¿Me puede enviar su RUT actualizado, de menos de 30 días?',
  doc_cedula: '¿Me envía también una copia de su cédula por ambas caras?',
};

// WhatsApp muestra los asteriscos tal cual si no cierran bien: dejamos texto plano.
function limpiarTexto(t) {
  return String(t || '').replace(/[*`~]/g, '').replace(/(^|\s)_+([^_\n]+)_+(?=\s|[.,;:!?]|$)/g, '$1$2').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-•]\s+/gm, '').replace(/[ \t]+\n/g, '\n').trim();
}

// Dirigirse al cliente solo por su primer nombre: se quita el apellido de cualquier texto.
function soloPrimerNombre(texto, nombreCompleto) {
  const toks = String(nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2 || !texto) return texto;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?<![\\p{L}])' + esc(toks[0]) + '(?:\\s+(?:' + toks.slice(1).map(esc).join('|') + '))+(?![\\p{L}])', 'giu');
  return String(texto).replace(re, toks[0]);
}

function sistemaDe(perfil, conocimiento) {
  return BASE_PROMPT + '\n' + REGLAS_EXTRA +
    '\n\nFICHA ACTUAL DEL CLIENTE (JSON): ' + JSON.stringify(perfil || {}) +
    (perfil && perfil.nombre ? '\nNOMBRE DE PILA PARA DIRIGIRTE: ' + String(perfil.nombre).trim().split(/\s+/)[0] + '. Nunca uses el apellido al hablar con el cliente.' : '') +
    (conocimiento ? '\n\nGUÍA DE CONOCIMIENTO (úsala para resolver dudas; no la copies tal cual ni menciones precios):\n' + String(conocimiento).slice(0, 14000) : '');
}

async function llamarClaude(sistema, mensajes, modelo) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelo || 'claude-sonnet-4-5', max_tokens: 3000, system: sistema, messages: mensajes }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'IA ' + r.status);
  return (j.content || []).map((b) => b.text || '').join('').trim();
}

function parsearJSON(t) {
  const m = String(t || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* se intenta rescatar abajo */ } }
  // JSON cortado o mal formado: se rescata al menos el texto para el cliente.
  const r = String(t || '').match(/"respuesta"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (r) { try { return { respuesta: JSON.parse('"' + r[1] + '"') }; } catch (_) { return { respuesta: r[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') }; } }
  return null;
}

function mensajesParaClaude(historial, bloquesNuevos, textoNuevo) {
  const out = [];
  const push = (role, content) => {
    const ult = out[out.length - 1];
    if (ult && ult.role === role && typeof ult.content === 'string' && typeof content === 'string') ult.content += '\n' + content;
    else out.push({ role, content });
  };
  for (const m of historial.slice(-40)) push(m.rol === 'cliente' ? 'user' : 'assistant', m.texto);
  const nuevo = [];
  for (const b of bloquesNuevos) nuevo.push(b);
  nuevo.push({ type: 'text', text: textoNuevo || '(el cliente envió un archivo)' });
  if (out.length && out[out.length - 1].role === 'user') {
    const u = out.pop();
    out.push({ role: 'user', content: [{ type: 'text', text: u.content }, ...nuevo] });
  } else out.push({ role: 'user', content: nuevo });
  if (out[0].role !== 'user') out.unshift({ role: 'user', content: '(inicio de la conversación)' });
  return out;
}

function bloqueArchivo(buf, tipo, nombre) {
  const b64 = buf.toString('base64');
  if (/pdf/i.test(tipo) || /\.pdf$/i.test(nombre || '')) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  if (/^image\/(jpeg|png|gif|webp)$/i.test(tipo)) return { type: 'image', source: { type: 'base64', media_type: tipo.toLowerCase(), data: b64 } };
  return null;
}

// Intenta obtener un enlace. Si no está en los nombres habituales, recorre el objeto.
function buscarURL(o, prof = 0) {
  if (!o || prof > 4) return null;
  if (typeof o === 'string') return /^https?:\/\/\S+$/.test(o) ? o : null;
  if (typeof o === 'object') {
    for (const k of ['media_url', 'url', 'link', 'file_url', 'attachment_url', 'download_url', 'path']) {
      const u = buscarURL(o[k], prof + 1); if (u) return u;
    }
    for (const v of Object.values(o)) { const u = buscarURL(v, prof + 1); if (u) return u; }
  }
  return null;
}

async function bajarArchivo(url, authHeader) {
  let r = authHeader ? await fetch(url, { headers: { Authorization: authHeader } }) : null;
  if (!r || !r.ok) r = await fetch(url);
  if (!r.ok) throw new Error('descarga ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('archivo muy grande');
  return { buf, tipo: (r.headers.get('content-type') || '').split(';')[0] };
}

// Convierte la salida de Claude en texto, ficha y partes, y solo acepta el
// traspaso si la ficha está completa o si la causa de escalamiento es válida.
function interpretarSalida({ bruto, perfilPrevio, prefijo }) {
  const j = parsearJSON(bruto);
  let respuesta = j && typeof j.respuesta === 'string' ? limpiarTexto(j.respuesta) : '';
  if (!respuesta) {
    // Nunca enviar JSON ni etiquetas al cliente.
    respuesta = j ? '' : limpiarTexto(String(bruto || '').replace(/[<{][\s\S]*$/, ''));
  }
  // Nunca enviar basura (por ejemplo la palabra "json" de un bloque de código vacío).
  if (!j || !j.respuesta) {
    if (/^\s*(json|```)?\s*$/i.test(respuesta) || respuesta.length < 8) {
      console.log(prefijo + ': respuesta de la IA no utilizable, se pide reenviar. Bruto:', String(bruto).slice(0, 300));
      respuesta = 'Disculpe, no alcancé a leer bien su mensaje o archivo. ¿Me lo puede enviar de nuevo, por favor?';
    }
  }
  const perfil = Object.assign({}, perfilPrevio || {});
  if (j && j.perfil) {
    for (const [k, v] of Object.entries(j.perfil)) {
      if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && v !== '') perfil[k] = v;
    }
  }
  if (perfil.nombre) respuesta = soloPrimerNombre(respuesta, perfil.nombre);

  let estado = 'bot';
  let partes = respuesta ? respuesta.split(/\n\s*\n/).filter((x) => x.trim()) : [];
  // Nunca se pierde texto: si hay más de 5 partes, las últimas se unen en una sola.
  if (partes.length > 5) partes = partes.slice(0, 4).concat([partes.slice(4).join('\n')]);
  if (j && j.traspasar) {
    const falta = CAMPOS_CLAVE.filter((k) => !perfil[k]);
    const docs = (Array.isArray(perfil.documentos_recibidos) ? perfil.documentos_recibidos : []).join(' ').toLowerCase();
    if (!perfil.acepta_avanzar) falta.push('acepta_avanzar');
    if (!/factura/.test(docs)) falta.push('doc_factura');
    if (!/rut/.test(docs)) falta.push('doc_rut');
    if (!/c[eé]dula|cedula/.test(docs)) falta.push('doc_cedula');
    const escala = j.motivo_traspaso === 'escalamiento' && CAUSAS_ESCALA.includes(j.causa_escalamiento);
    if (!escala && falta.length) {
      // Aún no está completa la ficha: no se entrega al agente, se sigue perfilando.
      if (!partes.length) partes = [PREGUNTA_FALTA[falta[0]] || ('Para dejar todo listo, ¿me confirma su ' + falta[0].replace(/_/g, ' ') + '?')];
    } else {
      estado = 'humano';
      const n = perfil.nombre ? ', ' + String(perfil.nombre).split(' ')[0] : '';
      partes = escala ? [FRASE_TRASPASO] : ['Muchas gracias por toda la información' + n + '. Permítame un momento mientras organizo su caso.', FRASE_TRASPASO];
      respuesta = partes.join('\n\n');
    }
  }
  return { j, respuesta, perfil, partes, estado };
}

module.exports = {
  BASE_PROMPT,
  FRASE_TRASPASO,
  REGLAS_EXTRA,
  CAMPOS_CLAVE,
  CAUSAS_ESCALA,
  limpiarTexto,
  soloPrimerNombre,
  sistemaDe,
  llamarClaude,
  parsearJSON,
  mensajesParaClaude,
  bloqueArchivo,
  buscarURL,
  bajarArchivo,
  interpretarSalida,
};
