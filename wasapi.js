// Atención por WhatsApp con Claude (Wasapi → este servidor → Claude → Wasapi).
// Wasapi avisa con el webhook `receive_message`; aquí se guarda la conversación
// completa (memoria), Claude lee texto/PDF/imagen y responde por la API de Wasapi.
// Variables en Render: WASAPI_API_KEY, WASAPI_WEBHOOK_TOKEN, ANTHROPIC_API_KEY,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Opcional: WASAPI_MODELO, WASAPI_ESPERA_MS.
const fs = require('fs');
const path = require('path');

const API = 'https://api-ws.wasapi.io/api/v1';
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, 'prompt_primer_contacto.txt'), 'utf8');
const FRASE_TRASPASO = 'Voy a pasar su caso a un consultor del equipo para que continúe con usted por este chat. No tendrá que repetir nada.';

const REGLAS_EXTRA = `
MEMORIA Y ARCHIVOS (muy importante)
- Recibes la conversación completa y la ficha del cliente ya recopilada. NUNCA vuelvas a preguntar un dato que ya está en la ficha o que el cliente ya dijo; confírmalo solo si es dudoso.
- Si el cliente envía un PDF o una imagen, léelo: extrae nombre, marca, modelo, fecha, valor, IVA, etc. y llena la ficha. Agradece y pregunta solo lo que falte.
- Si manda un archivo que no puedes leer, dile que lo revisará un consultor y sigue con la siguiente pregunta pendiente.
- La guía de conocimiento puede traer precios, honorarios o tarifas: IGNÓRALOS. Los únicos valores que puedes decir son los de la ETAPA 3 del prompt (según origen), y solo en esa etapa.
- Suena como un abogado cercano asesorando, no como un formulario.
- NOTAS DE VOZ: SÍ puedes escucharlas. Te llegan transcritas como "[Nota de voz del cliente, transcrita]: ...". Respóndelas con naturalidad como cualquier mensaje. NUNCA digas que no puedes escuchar audios ni le pidas que escriba en vez de mandar audios.
- Si el cliente manda varios mensajes seguidos, respóndelos juntos en un solo mensaje corto.
FORMATO: texto plano. NUNCA uses asteriscos, negritas, guiones de lista ni Markdown; WhatsApp los muestra mal.
SALIDA: responde SOLO un JSON válido, sin texto fuera de él:
{"respuesta":"texto para el cliente, plano (puede tener 2 o 3 mensajes cortos separados por una línea en blanco)","perfil":{"nombre":null,"nombre_completo":null,"cedula":null,"correo":null,"marca_modelo":null,"tipo_vehiculo":null,"compro_nuevo":null,"primer_dueno":null,"fecha_compra":null,"titular_factura":null,"tiene_certificado_upme":null,"ciudad":null,"saldos_dian":null,"origen":null,"iva_factura":null,"valor_sin_iva":null,"interesado":null,"precio_informado":null,"proceso_explicado":null,"acepta_avanzar":null,"medios_pago_informados":null,"pago_upme":null,"documentos_recibidos":[],"bancaria_despues":null,"pago_honorarios_recibido":null,"pago_despues":null,"objeciones":null,"notas":null},"datos_archivo":"resumen breve de lo leído en el archivo o null","archivos_tipos":[],"traspasar":false,"motivo_traspaso":null,"causa_escalamiento":null}
En "perfil" pon solo lo que sepas (conserva lo anterior). "documentos_recibidos" lista los que ya llegaron y leíste: "factura", "rut", "cedula", "certificacion_bancaria". "precio_informado":true cuando ya le explicaste los honorarios (con el valor si es EPM, Confamilia o Referix; si es SURA u otro canal, que el consultor le confirma el valor). "proceso_explicado":true cuando ya le explicaste las etapas del proceso. "bancaria_despues":true solo si el cliente dice que la certificación bancaria la envía después. "nombre_completo" y "cedula" (solo números; si la factura es de una empresa, el NIT sin el dígito de verificación) salen de la cédula, el RUT o la factura. "correo": el correo del cliente para enviarle el contrato. "archivos_tipos": un tipo por cada archivo que llegó en ESTE mensaje, en el mismo orden: "factura", "rut", "cedula", "certificacion_bancaria", "certificado_upme", "soporte_pago" u "otro" (vacío si no llegó ningún archivo). "pago_honorarios_recibido":true cuando el cliente envía el comprobante del pago de honorarios o confirma que ya pagó. "pago_despues":true solo si dice que paga más adelante. "contrato_enviado_firma" y "contrato_firmado" los pone el sistema: no los cambies. "medios_pago_informados":true cuando ya le diste la cuenta y la llave para pagar los honorarios. "pago_upme":"gomez_legal" si quiere que nosotros hagamos el pago de la UPME (+$15.000) o "cliente" si lo paga él con el usuario y clave que le entregamos. "acepta_avanzar":true solo cuando el cliente dijo claramente que sí quiere avanzar. "traspasar":true con "motivo_traspaso":"completo" y "respuesta":"" SOLO cuando tengas la ficha completa, honorarios y proceso explicados, acepta_avanzar=true, documentos factura, rut, cedula y certificacion_bancaria recibidos (o bancaria_despues=true) y el pago de honorarios recibido (o pago_despues=true) (el sistema pide el momento y entrega al agente). Si es un caso de ESCALA DE INMEDIATO A HUMANO usa "motivo_traspaso":"escalamiento" y "causa_escalamiento" con exactamente una de: empresa, dos_propietarios, apoderado, rut_42_48, leasing, iva_19, error_certificado, cuenta_digital, inadmision, plazo_critico, cliente_molesto, pide_contrato, pide_estado, pide_llamada, sura_en_proceso. Sin una de esas causas no se acepta el traspaso. Mientras falte algo, NO traspases: sigue con la etapa que corresponda.`;
const CAMPOS_CLAVE = ['nombre', 'marca_modelo', 'tipo_vehiculo', 'compro_nuevo', 'fecha_compra', 'titular_factura', 'tiene_certificado_upme', 'ciudad', 'saldos_dian', 'origen'];

const pendientes = new Map(); // wa_id -> { timer, items, from_id }
const vistos = new Set();     // wam_id ya procesados (dedupe en memoria)

// WhatsApp muestra los asteriscos tal cual si no cierran bien: dejamos texto plano.
const { sincronizarTodo } = require('./wasapi_caso');
function extDeTipo(t) { return ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[String(t || '').toLowerCase()] || ''; }
// Los campos que empiezan por "_" son internos (id del caso, archivos pendientes): la IA no los ve.
function fichaVisible(p) { const o = {}; for (const [k, v] of Object.entries(p || {})) if (!k.startsWith('_')) o[k] = v; return o; }
function limpiarTexto(t) {
  return String(t || '').replace(/[*`~]/g, '').replace(/(^|\s)_+([^_\n]+)_+(?=\s|[.,;:!?]|$)/g, '$1$2').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-•]\s+/gm, '').replace(/[ \t]+\n/g, '\n').trim();
}
function esperaMs() { return parseInt(process.env.WASAPI_ESPERA_MS || '6000', 10); }

async function enviarTexto(waId, fromId, texto) {
  const r = await fetch(API + '/whatsapp-messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WASAPI_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ message: texto, wa_id: waId, from_id: fromId }),
  });
  if (!r.ok) throw new Error('Wasapi envío ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}

// Intenta obtener el archivo adjunto. La documentación pública de Wasapi no
// publica un campo con la URL; probamos los nombres habituales y, si no hay,
// dejamos el payload guardado (raw) para ajustarlo.
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
async function urlDeArchivo(d) {
  const directa = buscarURL(d);
  if (directa) return directa;
  // Plan B: pedir el detalle del mensaje a Wasapi y buscar ahí un enlace.
  for (const id of [d.wam_id, d.id]) {
    if (!id) continue;
    try {
      const r = await fetch(API + '/whatsapp-messages/detail/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + process.env.WASAPI_API_KEY, Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      console.log('wasapi detalle', id, r.status, JSON.stringify(j).slice(0, 600));
      d.__detalle = j;
      const u = buscarURL(j); if (u) return u;
    } catch (e) { console.error('wasapi detalle:', e.message); }
  }
  return null;
}
async function bajarArchivo(url) {
  let r = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.WASAPI_API_KEY } });
  if (!r.ok) r = await fetch(url);
  if (!r.ok) throw new Error('descarga ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('archivo muy grande');
  return { buf, tipo: (r.headers.get('content-type') || '').split(';')[0] };
}
function bloqueArchivo(buf, tipo, nombre) {
  const b64 = buf.toString('base64');
  if (/pdf/i.test(tipo) || /\.pdf$/i.test(nombre || '')) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  if (/^image\/(jpeg|png|gif|webp)$/i.test(tipo)) return { type: 'image', source: { type: 'base64', media_type: tipo.toLowerCase(), data: b64 } };
  return null;
}

// ---- 27/11/2026: NOTAS DE VOZ ----
// Escuchar: la nota de voz del cliente se transcribe a texto (ElevenLabs Scribe o OpenAI) y Daniela la responde normal.
// Variables en Render (basta UNA): ELEVENLABS_API_KEY  u  OPENAI_API_KEY.
async function transcribirAudio(buf, mime) {
  const tipo = mime && /^audio\//i.test(mime) ? mime : 'audio/ogg';
  const ext = (/mpeg|mp3/i.test(tipo) && 'mp3') || (/mp4|m4a|aac/i.test(tipo) && 'm4a') || (/wav/i.test(tipo) && 'wav') || 'ogg';
  const errores = [];
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const fd = new FormData();
      fd.append('model_id', process.env.ELEVENLABS_STT_MODELO || 'scribe_v1');
      fd.append('language_code', 'spa');
      fd.append('file', new Blob([buf], { type: tipo }), 'nota.' + ext);
      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.text) return String(j.text).trim();
      errores.push('ElevenLabs ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    } catch (e) { errores.push('ElevenLabs ' + e.message); }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const fd = new FormData();
      fd.append('model', process.env.OPENAI_STT_MODELO || 'whisper-1');
      fd.append('language', 'es');
      fd.append('file', new Blob([buf], { type: tipo }), 'nota.' + ext);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.text) return String(j.text).trim();
      errores.push('OpenAI ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    } catch (e) { errores.push('OpenAI ' + e.message); }
  }
  if (!errores.length) errores.push('falta ELEVENLABS_API_KEY u OPENAI_API_KEY en Render');
  throw new Error(errores.join(' | '));
}
const sttActivo = () => !!(process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY);

// Enviar audio (bienvenida de redes). Wasapi recibe el enlace público del archivo.
// El archivo va en la carpeta "audios" del repositorio (bienvenida_redes.mp3/.ogg/.m4a) o en AUDIO_REDES_URL.
const DIR_AUDIOS = path.join(__dirname, 'audios');
// El audio puede estar en la carpeta "audios" o suelto junto a server.js (más fácil de subir a GitHub).
function rutaAudio(n) { for (const d of [DIR_AUDIOS, __dirname]) { const r = path.join(d, n); if (fs.existsSync(r)) return r; } return null; }
function archivoAudioRedes() {
  for (const n of ['bienvenida_redes.ogg', 'bienvenida_redes.mp3', 'bienvenida_redes.m4a', 'bienvenida_redes.aac']) if (rutaAudio(n)) return n;
  return null;
}
function urlAudioRedes() {
  if (process.env.AUDIO_REDES_URL) return process.env.AUDIO_REDES_URL;
  const n = archivoAudioRedes(); const base = (process.env.SERVIDOR_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  return n && base ? base + '/audios/' + n : null;
}
const ultimosAudios = [];
async function enviarAudio(waId, fromId, url) {
  const H = { Authorization: 'Bearer ' + process.env.WASAPI_API_KEY, Accept: 'application/json' };
  const intentos = [
    () => fetch(API + '/whatsapp-messages/attachment', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ wa_id: waId, from_id: fromId, file: 'audio', filePath: url, caption: '' }) }),
    () => fetch(API + '/whatsapp-messages/attachment', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ wa_id: waId, from_id: fromId, type: 'audio', url, file_url: url }) }),
    async () => {
      const f = await bajarArchivo(url); const fd = new FormData();
      fd.append('wa_id', waId); fd.append('from_id', String(fromId)); fd.append('caption', '');
      fd.append('file', new Blob([f.buf], { type: f.tipo || 'audio/mpeg' }), url.split('/').pop() || 'audio.mp3');
      return fetch(API + '/whatsapp-messages/attachment', { method: 'POST', headers: H, body: fd });
    },
  ];
  const log = [];
  for (let i = 0; i < intentos.length; i++) {
    try {
      const r = await intentos[i](); const t = (await r.text().catch(() => '')).slice(0, 300);
      log.push({ intento: i + 1, status: r.status, respuesta: t });
      if (r.ok && !/"success"\s*:\s*false|error/i.test(t)) { ultimosAudios.push({ ts: new Date().toISOString(), ok: true, log }); if (ultimosAudios.length > 10) ultimosAudios.shift(); return { ok: true, intento: i + 1, log }; }
    } catch (e) { log.push({ intento: i + 1, error: e.message }); }
  }
  ultimosAudios.push({ ts: new Date().toISOString(), ok: false, log }); if (ultimosAudios.length > 10) ultimosAudios.shift();
  console.error('wasapi audio: no se pudo enviar', JSON.stringify(log).slice(0, 1200));
  return { ok: false, log };
}
// Cliente que llega por el link de redes de Daniela (/instagram, /danielagomez)
const esDeRedes = (t) => /instagram|redes de daniela|tiktok de daniela|facebook de daniela/i.test(String(t || ''));

async function llamarClaude(sistema, mensajes) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.WASAPI_MODELO || process.env.CHAT_ANALISIS_MODELO || 'claude-sonnet-4-5', max_tokens: 3000, system: sistema, messages: mensajes }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'IA ' + r.status);
  return (j.content || []).map((b) => b.text || '').join('').trim();
}
// ---- Tarifa UPME: misma fórmula de la calculadora oficial (app.upme.gov.co/Calculadora/Calculator.js,
// Resolución UPME 135 de 2025). UVT configurable en Render: UPME_UVT (por defecto 52.374, año 2026).
function parseMonto(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let t = String(v || '').replace(/[^\d.,]/g, '');
  if (!t) return null;
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');          // 123.800.000,00
  else if (/\.\d{1,2}$/.test(t) && (t.match(/\./g) || []).length === 1) t = t.replace(/,/g, ''); // 123800000.00
  else t = t.replace(/[.,]/g, '');                                                   // 123.800.000
  const n = Number(t);
  return isFinite(n) && n > 0 ? n : null;
}
// 24/11/2026: el valor sin IVA puede traer VARIOS vehículos ("$95.000.000 / $60.000.000 / $45.000.000" o "3 carros: 95M, 60M y 45M").
// Antes se pegaban todos los dígitos en un solo número gigante y la tarifa salía al tope (275 UVT ≈ $14,4 millones). Error grave.
// Ahora se separan los montos y se SUMAN: la UPME cobra UN solo pago por el registro (un proyecto con todos los vehículos),
// liquidado sobre el valor total.
function montosSinIva(v) {
  if (typeof v === 'number') return isFinite(v) && v > 0 ? [v] : [];
  const txt = String(v || '');
  const piezas = txt.match(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{4,}(?:[.,]\d{1,2})?/g) || [];
  const out = [];
  for (const p of piezas) {
    let n = parseMonto(p);
    if (!n) continue;
    // "95 millones" / "95M" / "95 mill"
    if (n < 1000) continue;
    out.push(n);
  }
  // Cifras escritas en millones ("95 millones", "60M")
  if (!out.length) {
    const mill = txt.match(/(\d+(?:[.,]\d+)?)\s*(?:millones|mill?\.?|m\b)/gi) || [];
    for (const m of mill) { const n = Number(m.replace(/[^\d.,]/g, '').replace(',', '.')) * 1e6; if (n > 0) out.push(n); }
  }
  return out;
}
const GESTION_PAGO_UPME = () => Number(process.env.UPME_GESTION_PAGO) || 15000;
function tarifaUpme(valorSinIva) {
  const UVT = Number(process.env.UPME_UVT) || 52374;
  const montos = montosSinIva(valorSinIva).filter((n) => n >= 1000000);
  const precio = montos.reduce((x, y) => x + y, 0);
  // Ningún vehículo vale más de $1.500 millones: si el total es absurdo, NO se cotiza (mejor preguntar al equipo que dar una cifra errada).
  if (!precio || precio < 1000000 || montos.some((n) => n > 1500000000)) return null;
  const nVeh = montos.length;
  const uvtEq = Math.round(precio * 100 / UVT) / 100;
  let total;
  if (uvtEq < 275) total = 1.2;
  else if (uvtEq < 826) total = 3.4;
  else if (uvtEq < 1652) total = 6.7;
  else if (uvtEq < 3305) total = 13.4;
  else total = Math.min(13.4 + Math.round((uvtEq - 3305) * (0.405 * 0.005) * 100) / 100, 275);
  const pesos = Math.round(total * UVT);
  const fmt = (n, d = 0) => n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
  return { pesos, uvt: Math.round(total * 100) / 100, uvtProyecto: uvtEq, valor: precio, uvtValor: UVT,
    vehiculos: nVeh,
    texto: `$${fmt(pesos)} en total, UN SOLO PAGO a la UPME (${fmt(Math.round(total * 100) / 100, 2)} UVT; ${nVeh > 1 ? `sus ${nVeh} vehículos se registran juntos en un solo proyecto y sus valores sin IVA suman $${fmt(precio)}` : `su carro sin IVA, $${fmt(precio)}`}, equivale a ${fmt(uvtEq, 2)} UVT; UVT 2026 = $${fmt(UVT)}). NUNCA multipliques esta tarifa por el número de vehículos: es un solo registro y un solo pago. Si el cliente prefiere que nosotros hagamos el pago de la UPME, el total sería $${fmt(pesos + GESTION_PAGO_UPME())} (tarifa + $${fmt(GESTION_PAGO_UPME())} por la gestión del pago)` };
}

function parsearJSON(t) {
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* se intenta rescatar abajo */ } }
  // JSON cortado o mal formado: se rescata al menos el texto para el cliente.
  const r = t.match(/"respuesta"\s*:\s*"((?:[^"\\]|\\.)*)"/);
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

// Dirigirse al cliente solo por su primer nombre: se quita el apellido de cualquier texto.
function soloPrimerNombre(texto, nombreCompleto) {
  const toks = String(nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2 || !texto) return texto;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?<![\\p{L}])' + esc(toks[0]) + '(?:\\s+(?:' + toks.slice(1).map(esc).join('|') + '))+(?![\\p{L}])', 'giu');
  return String(texto).replace(re, toks[0]);
}

async function procesar(waId, deps) {
  const p = pendientes.get(waId);
  if (!p) return;
  pendientes.delete(waId);
  const sb = deps.sbServicio();
  try {
    const { data: fila } = await sb.from('wasapi_conversaciones').select('*').eq('wa_id', waId).maybeSingle();
    const conv = fila || { wa_id: waId, mensajes: [], perfil: {}, estado: 'bot' };
    const historial = Array.isArray(conv.mensajes) ? conv.mensajes : [];
    const ahora = new Date().toISOString();

    const textos = []; const bloques = []; const archivos = []; const adjuntos = [];
    for (const d of p.items) {
      if (d.message) textos.push(d.message);
      else if (d.caption) textos.push(d.caption);
      if (['image', 'document', 'sticker'].includes(d.message_type)) {
        archivos.push(d.filename || d.message_type);
        const url = await urlDeArchivo(d);
        let leido = false;
        if (url) {
          try { const f = await bajarArchivo(url); const b = bloqueArchivo(f.buf, f.tipo, d.filename); if (b) { bloques.push(b); leido = true; adjuntos.push(d.message_type === 'sticker' ? { sticker: true } : { url, buf: f.buf, nombre: d.filename || ('archivo.' + (extDeTipo(f.tipo) || 'bin')), mime: f.tipo }); } } catch (e) { console.error('wasapi archivo:', e.message); }
        }
        if (!leido) {
          textos.push('[El cliente envió un archivo (' + (d.filename || d.message_type) + ') que no pude abrir]');
          conv.ultimo_payload_archivo = d; console.log('wasapi archivo sin URL:', JSON.stringify(d).slice(0, 1500)); // para ajustar la lectura de adjuntos
        }
      } else if (['audio', 'voice', 'ptt'].includes(d.message_type)) {
        // Nota de voz: se transcribe y Daniela la responde como si fuera texto.
        let dicho = '';
        try {
          const url = await urlDeArchivo(d);
          if (url) { const f = await bajarArchivo(url); dicho = await transcribirAudio(f.buf, f.tipo); }
          else { conv.ultimo_payload_archivo = d; console.log('wasapi audio sin URL:', JSON.stringify(d).slice(0, 1500)); }
        } catch (e) { console.error('wasapi transcripción:', e.message); }
        if (dicho) { textos.push('[Nota de voz del cliente, transcrita]: ' + dicho); archivos.push('nota de voz'); }
        else textos.push('[El cliente envió una nota de voz que no se alcanzó a escuchar bien; pídele con amabilidad que la repita o la escriba, sin decir que no puedes escuchar audios]');
      } else if (d.message_type === 'video') {
        textos.push('[El cliente envió un video; dile con amabilidad que un consultor lo revisa y sigue con la siguiente pregunta pendiente]');
      }
    }
    const textoCliente = textos.join('\n').trim();
    historial.push({ rol: 'cliente', texto: textoCliente || '[archivo]', ts: ahora, archivos });

    // Si un humano ya tomó el caso, solo registramos.
    if (conv.estado === 'humano') {
      await sb.from('wasapi_conversaciones').upsert({ wa_id: waId, mensajes: historial.slice(-200), perfil: conv.perfil || {}, estado: 'humano', actualizado_en: ahora, from_id: p.from_id, ultimo_payload_archivo: conv.ultimo_payload_archivo || null }, { onConflict: 'wa_id' });
      return;
    }

    let conocimiento = '';
    try { conocimiento = await deps.obtenerConocimientoTexto(textoCliente); } catch (_) {}
    // 26/11/2026: SOLO el cliente que viene de atención al cliente de SURA es "cliente que ya viene de otro canal"
    // (bienvenida especial y traspaso al consultor). ReferiX, EPM, Confamilia, Instagram y cualquier otro origen
    // son CLIENTES NUEVOS: bienvenida normal y Daniela los atiende de principio a fin.
    const primerCliente = String((historial.find((m) => m.rol === 'cliente') || {}).texto || '');
    const viaSura = /sura/i.test(String((conv.perfil || {}).origen || '')) || /(atenci[oó]n al cliente de sura|vengo de sura|\bsura\b)/i.test(primerCliente);
    const notaOrigen = viaSura
      ? '\nORIGEN DE ESTE CLIENTE: viene de atención al cliente de SURA (aplica la sección de clientes que vienen de SURA).'
      : '\nORIGEN DE ESTE CLIENTE: NO viene de SURA' + (/referix|epm|fepep|familia|instagram|daniela g/i.test(primerCliente) ? ' (llegó por ' + (primerCliente.match(/referix|epm|fepep|confamilia|familia|instagram/i) || ['otro canal'])[0] + ')' : '') +
        '. Es un CLIENTE NUEVO: NO uses la bienvenida de SURA ni digas que "no tiene que empezar de cero" o que "ya hizo algo en otro canal". Usa el primer mensaje normal, perfílalo y atiéndelo tú misma de principio a fin; NO lo traspases al consultor salvo las causas de escalamiento.';
    const sistema = BASE_PROMPT + '\n' + REGLAS_EXTRA + notaOrigen +
      '\n\nFICHA ACTUAL DEL CLIENTE (JSON): ' + JSON.stringify(fichaVisible(conv.perfil)) +
      (tarifaUpme((conv.perfil || {}).valor_sin_iva) ? '\nTARIFA UPME DE ESTE CLIENTE (calculadora oficial de la UPME, Resolución 135 de 2025, con el valor sin IVA de su factura): ' + tarifaUpme(conv.perfil.valor_sin_iva).texto + '. Úsala tal cual cuando hables de la tarifa de la UPME.' : '') +
      (conv.perfil && conv.perfil.nombre ? '\nNOMBRE DE PILA PARA DIRIGIRTE: ' + String(conv.perfil.nombre).trim().split(/\s+/)[0] + '. Nunca uses el apellido al hablar con el cliente.' : '') +
      (conocimiento ? '\n\nGUÍA DE CONOCIMIENTO (úsala para resolver dudas; no la copies tal cual ni menciones precios):\n' + String(conocimiento).slice(0, 14000) : '');

    const histLimpio = historial.slice(0, -1).map((m) => (m.rol === 'cliente' ? m : Object.assign({}, m, { texto: soloPrimerNombre(m.texto, (conv.perfil || {}).nombre) })));
    const msgsIA = mensajesParaClaude(histLimpio, bloques, textoCliente);
    const bruto = await llamarClaude(sistema, msgsIA);
    let j = parsearJSON(bruto);
    let respuesta = j && typeof j.respuesta === 'string' ? limpiarTexto(j.respuesta) : '';
    if (!respuesta) {
      // Nunca enviar JSON ni etiquetas al cliente.
      respuesta = j ? '' : limpiarTexto(bruto.replace(/[<{][\s\S]*$/, ''));
    }
    // Nunca enviar basura (por ejemplo la palabra "json" de un bloque de código vacío).
    // (Si la IA pidió traspaso con respuesta vacía no es un error: lo resuelve el bloque de traspaso de abajo.)
    if (!j || (!j.respuesta && !j.traspasar)) { if (/^\s*(json|```)?\s*$/i.test(respuesta) || respuesta.length < 8) { console.log('wasapi: respuesta de la IA no utilizable, se pide reenviar. Bruto:', String(bruto).slice(0, 300)); respuesta = 'Disculpe, no alcancé a leer bien su mensaje o archivo. ¿Me lo puede enviar de nuevo, por favor?'; } }
    const perfil = Object.assign({}, conv.perfil || {});
    if (j && j.perfil) for (const [k, v] of Object.entries(j.perfil)) if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && v !== '') perfil[k] = v;
    if (perfil.nombre) respuesta = soloPrimerNombre(respuesta, perfil.nombre);
    const tUpme = tarifaUpme(perfil.valor_sin_iva);
    if (tUpme) { perfil.tarifa_upme_cop = tUpme.pesos; perfil.tarifa_upme_uvt = tUpme.uvt; }
    if (j && j.datos_archivo) historial[historial.length - 1].texto += '\n[Lectura del archivo: ' + j.datos_archivo + ']';

    // CLIENTE DE SURA: no se le interroga. Si Claude hace preguntas de perfilamiento (compra, etapa, certificado,
    // documentos...), se descartan y el chat pasa de inmediato a un consultor.
    const esSura = /sura/i.test(String(perfil.origen || '')) || historial.some((m) => m.rol === 'cliente' && /(atenci[oó]n al cliente de sura|vengo de sura)/i.test(String(m.texto || '')));
    if (esSura && !(j && j.traspasar) && /(ya compr|en qu[eé] etapa|qu[eé] etapa|certificado|marca|modelo|fecha de compra|ciudad|saldos|documentos?|factura|\brut\b|c[eé]dula)/i.test(respuesta)) {
      console.log('wasapi: cliente SURA, pregunta de perfilamiento descartada y traspaso inmediato. Era:', respuesta.slice(0, 200));
      j = Object.assign({}, j || {}, { traspasar: true, motivo_traspaso: 'escalamiento', causa_escalamiento: 'sura_en_proceso' });
      respuesta = '';
    }
    // Cliente que NO viene de SURA (ReferiX, EPM, Confamilia, Instagram, directo…): es cliente nuevo.
    // Nunca la bienvenida de "ya viene de otro canal" ni el traspaso "sura_en_proceso".
    if (!esSura) {
      if (j && j.causa_escalamiento === 'sura_en_proceso') { console.log('wasapi: sura_en_proceso descartado (no viene de SURA)'); j = Object.assign({}, j, { traspasar: false, motivo_traspaso: null, causa_escalamiento: null }); }
      if (/empezar de cero|repetir lo que ya hizo|en el otro canal|ya hizo en otro canal/i.test(respuesta)) {
        console.log('wasapi: bienvenida de SURA corregida para cliente nuevo. Era:', respuesta.slice(0, 200));
        respuesta = respuesta.split(/\n\s*\n/).filter((x) => !/empezar de cero|repetir lo que ya hizo|en el otro canal|ya hizo en otro canal/i.test(x)).join('\n\n');
        if (!/gusto de hablar|su nombre/i.test(respuesta)) respuesta = (respuesta ? respuesta + '\n\n' : '') + 'Con mucho gusto le ayudo a recuperar el IVA que pagó por su vehículo. ¿Con quién tengo el gusto de hablar?';
      }
    }
    let estado = 'bot';
    let partes = respuesta ? respuesta.split(/\n\s*\n/).filter((x) => x.trim()) : [];
    // Nunca se pierde texto: si hay más de 5 partes, las últimas se unen en una sola.
    if (partes.length > 3) partes = partes.slice(0, 2).concat([partes.slice(2).join('\n\n')]);
    if (j && j.traspasar) {
      // false o 'no' son respuestas válidas (p. ej. no tiene certificado UPME): solo falta lo vacío.
      const falta = CAMPOS_CLAVE.filter((k) => perfil[k] === null || perfil[k] === undefined || perfil[k] === '');
      const docs = (Array.isArray(perfil.documentos_recibidos) ? perfil.documentos_recibidos : []).join(' ').toLowerCase();
      // Proceso COMPLETO antes de entregar: honorarios, proceso, sí del cliente y el 100 % de los documentos.
      if (!perfil.precio_informado) falta.push('precio_informado');
      if (!perfil.proceso_explicado) falta.push('proceso_explicado');
      if (!perfil.acepta_avanzar) falta.push('acepta_avanzar');
      // Pagos: siempre los medios de pago de honorarios; y, si necesita certificado UPME, cómo quiere pagar la UPME.
      const yaTieneUpme = perfil.tiene_certificado_upme === true || /^s[ií]/i.test(String(perfil.tiene_certificado_upme || ''));
      if (perfil.acepta_avanzar && !perfil.medios_pago_informados) falta.push('medios_pago');
      if (perfil.acepta_avanzar && !yaTieneUpme && !perfil.pago_upme) falta.push('pago_upme');
      if (!/factura/.test(docs)) falta.push('doc_factura');
      if (!/rut/.test(docs)) falta.push('doc_rut');
      if (!/c[eé]dula|cedula/.test(docs)) falta.push('doc_cedula');
      if (!/bancaria/.test(docs) && !perfil.bancaria_despues) falta.push('doc_bancaria');
      if (perfil.acepta_avanzar && !perfil.pago_honorarios_recibido && !perfil.pago_despues) falta.push('pago_honorarios');
      const CAUSAS = ['empresa','dos_propietarios','apoderado','rut_42_48','leasing','iva_19','error_certificado','cuenta_digital','inadmision','plazo_critico','cliente_molesto','pide_contrato','pide_estado','pide_llamada','sura_en_proceso'];
      // Solo estas cortan la conversación al instante. Las demás (empresa, IVA 19, dos propietarios...) se MARCAN
      // como alerta para el consultor y Daniela sigue recogiendo datos y documentos; se entrega al final con todo.
      const INMEDIATAS = ['pide_llamada', 'cliente_molesto', 'sura_en_proceso', 'pide_contrato', 'pide_estado', 'plazo_critico'];
      const escalaPedida = j.motivo_traspaso === 'escalamiento' && CAUSAS.includes(j.causa_escalamiento);
      if (escalaPedida) {
        perfil.alertas = Array.from(new Set([...(Array.isArray(perfil.alertas) ? perfil.alertas : []), j.causa_escalamiento]));
        perfil.causa_escalamiento = j.causa_escalamiento;
        console.log('wasapi: escalamiento pedido por la IA:', j.causa_escalamiento, '| faltan:', falta.join(','));
      }
      const escala = escalaPedida && INMEDIATAS.includes(j.causa_escalamiento);
      if (!escala && falta.length) {
        // Si la IA ya se estaba despidiendo para entregar el caso, se descarta ese texto y se pide lo siguiente.
        if (partes.some((x) => /(consultor|asesor|un momento|pasar su caso|organizo su caso|del equipo)/i.test(x))) partes = [];
        // Aún no está completa la ficha: no se entrega al agente, se sigue perfilando.
        if (!partes.length) partes = [({ nombre: '¿Con quién tengo el gusto de hablar?', marca_modelo: '¿Qué marca y modelo es su vehículo?', tipo_vehiculo: '¿Su vehículo es eléctrico, híbrido o híbrido enchufable?', compro_nuevo: '¿Lo compró nuevo y usted fue el primer dueño?', fecha_compra: '¿En qué fecha lo compró, más o menos?', titular_factura: '¿La factura quedó a su nombre, a nombre de dos personas o de una empresa?', tiene_certificado_upme: '¿Ya tiene el certificado de la UPME o todavía no?', ciudad: '¿En qué ciudad vive?', medios_pago: 'Los honorarios los puede pagar por consignación o transferencia a la cuenta de ahorros Bancolombia 43600005898, a nombre de GOMEZ LEGAL ABOGADOS, NIT 901964467-0, o por la llave @gomezlegalabogad. ¿Le queda claro?', pago_upme: 'Para la UPME, ¿prefiere que nosotros hagamos el pago por usted (con un costo adicional de $15.000) o que le entreguemos su usuario y clave para que usted pague directo en la UPME?', precio_informado: 'Ahora le cuento cómo funcionan nuestros honorarios. ¿Le parece?', proceso_explicado: '¿Le explico paso a paso cómo es el proceso para recuperar su IVA?', doc_bancaria: 'Por último, ¿me envía una certificación bancaria de una cuenta a su nombre? No sirven bancos digitales como Nu o Lulo.', acepta_avanzar: 'Para dejar todo listo, ¿avanzamos con su caso?', saldos_dian: 'Una última consulta para validar su beneficio: ¿tiene saldos pendientes por pagar ante la DIAN?', origen: '¿Cómo llegó con nosotros? ¿Fue por SURA, por EPM, Grupo Confamilia, Referix u otro medio?', doc_factura: '¿Me puede enviar la factura de compra en PDF o imagen?', doc_rut: '¿Me puede enviar su RUT actualizado, de menos de 30 días?', doc_cedula: '¿Me envía también una copia de su cédula por ambas caras?', pago_honorarios: 'Mientras tanto ya estamos avanzando con su contrato: le llegará por SMS y/o correo electrónico para firmarlo. ¿Ya pudo hacer el pago de los honorarios? Si es así, me comparte el comprobante por aquí.' })[falta[0]] || ('Para dejar todo listo, ¿me confirma su ' + falta[0].replace(/_/g, ' ') + '?')];
      } else {
        estado = 'humano';
        const n = perfil.nombre ? ', ' + String(perfil.nombre).split(' ')[0] : '';
        partes = escala ? [FRASE_TRASPASO] : ['Muchas gracias por toda la información' + n + '. Permítame un momento mientras organizo su caso.', FRASE_TRASPASO];
        respuesta = partes.join('\n\n');
      }
    }

    if (partes.length && await estaEnHumano(waId, deps)) {
      // Una persona tomó el chat mientras Claude pensaba: no se envía nada.
      console.log('wasapi: un humano tomó el chat durante la respuesta, se descarta');
      return;
    }
    // 27/11/2026: cliente que llega por el link de redes de Daniela → nota de voz de bienvenida (una sola vez).
    if (partes.length && !(perfil && perfil._audio_redes) && esDeRedes(historial.filter((m) => m.rol === 'cliente').slice(0, 2).map((m) => m.texto).join(' '))) {
      const urlA = urlAudioRedes();
      if (urlA) {
        try {
          const ra = await enviarAudio(waId, p.from_id, urlA);
          if (ra.ok) { perfil._audio_redes = new Date().toISOString(); historial.push({ rol: 'daniela', texto: '[Nota de voz de bienvenida de la Dra. Daniela Gómez]', ts: new Date().toISOString(), sistema: true }); await new Promise((r) => setTimeout(r, 2500)); }
        } catch (e) { console.error('wasapi audio redes:', e.message); }
      } else console.log('wasapi: cliente de redes, pero no hay audio configurado (carpeta audios/ o AUDIO_REDES_URL)');
    }
    if (partes.length) {
      for (const parte of partes) { if (await estaEnHumano(waId, deps)) { console.log('wasapi: humano intervino, se corta el envío'); return; } if (parte.trim()) { await enviarTexto(waId, p.from_id, parte.trim()); await new Promise((r) => setTimeout(r, 1200)); } }
      historial.push({ rol: 'daniela', texto: partes.join('\n\n'), ts: new Date().toISOString() });
    }
    await sb.from('wasapi_conversaciones').upsert({
      wa_id: waId, mensajes: historial.slice(-200), perfil, estado,
      motivo_traspaso: j && j.motivo_traspaso ? j.motivo_traspaso : null,
      actualizado_en: new Date().toISOString(), from_id: p.from_id,
      ultimo_payload_archivo: conv.ultimo_payload_archivo || null,
    }, { onConflict: 'wa_id' });

    // Igual que el asistente: crea o actualiza el caso, sube cada documento con su tipo y, si ya está todo, pide el contrato.
    if (process.env.WASAPI_CREAR_CASOS !== 'no') {
      const tipos = j && Array.isArray(j.archivos_tipos) ? j.archivos_tipos : [];
      adjuntos.forEach((a, i) => { a.tipo = String(tipos[i] || 'otro').toLowerCase(); });
      const antes = JSON.stringify(perfil);
      await sincronizarTodo({ perfil, waId, archivos: adjuntos.filter((a) => !a.sticker), sb, bajarArchivo });
      if (JSON.stringify(perfil) !== antes) await sb.from('wasapi_conversaciones').update({ perfil }).eq('wa_id', waId);
    }
  } catch (e) {
    console.error('wasapi procesar:', e);
  }
}

const ORIGENES_AUTO = ['api', 'bot', 'chatbot', 'flow', 'flujo', 'automation', 'automatico', 'campaign', 'campana', 'template', 'broadcast', 'system', 'sistema', 'webhook', 'integration', 'transfer', 'transferencia', 'assignment', 'asignacion', 'routing', 'auto', 'automatic', 'automatica', 'queue', 'cola', 'rule', 'regla'];
const ultimosOrigenes = [];
const esOrigenHumano = (o) => !!o && !ORIGENES_AUTO.includes(String(o).toLowerCase());
// Si el mensaje trae señales de que ya hay un agente asignado, no se toma el chat.
function traeAgente(d) {
  for (const [k, v] of Object.entries(d || {})) {
    if (/(^|_)(agent|agente|assigned|asignado|operator|user_id|attended_by)(_|$)/i.test(k) && v && typeof v !== 'object') return k + '=' + v;
    if (/(agent|assigned|asignad)/i.test(k) && v && typeof v === 'object' && (v.id || v.name || v.email)) return k;
  }
  return null;
}
async function estaEnHumano(waId, deps) {
  try { const { data } = await deps.sbServicio().from('wasapi_conversaciones').select('estado').eq('wa_id', waId).maybeSingle(); return !!data && data.estado === 'humano'; } catch (_) { return false; }
}

async function tomarHumano(waId, d, deps) {
  const p = pendientes.get(waId);
  if (p) { clearTimeout(p.timer); pendientes.delete(waId); }
  try {
    const sb = deps.sbServicio();
    const { data: fila } = await sb.from('wasapi_conversaciones').select('*').eq('wa_id', waId).maybeSingle();
    const conv = fila || { wa_id: waId, mensajes: [], perfil: {} };
    const hist = Array.isArray(conv.mensajes) ? conv.mensajes : [];
    if (d.message) hist.push({ rol: 'agente', texto: String(d.message), ts: new Date().toISOString() });
    await sb.from('wasapi_conversaciones').upsert({
      wa_id: waId, from_id: d.from_id || conv.from_id || null, mensajes: hist.slice(-200), perfil: conv.perfil || {},
      estado: 'humano', motivo_traspaso: 'agente_intervino', actualizado_en: new Date().toISOString(),
    }, { onConflict: 'wa_id' });
  } catch (e) { console.error('wasapi tomarHumano:', e); }
}

// Un solo procesamiento a la vez por cliente: si escribe (o manda un archivo) mientras Daniela está respondiendo,
// esos mensajes esperan a que termine y se responden juntos, ya con la conversación actualizada.
const enCurso = new Map();
function programar(waId, deps) {
  const previo = enCurso.get(waId) || Promise.resolve();
  const siguiente = previo.then(() => procesar(waId, deps)).catch((e) => console.error('wasapi cola:', e))
    .finally(() => { if (enCurso.get(waId) === siguiente) enCurso.delete(waId); });
  enCurso.set(waId, siguiente);
}

// Mensaje del sistema al cliente por WhatsApp (contrato enviado a firma, contrato firmado...). Se busca la
// conversación por los últimos 10 dígitos del celular; queda en el historial para que Daniela sepa qué se le dijo.
async function avisarCliente(sb, telefono, texto, marcas) {
  const cel = String(telefono || '').replace(/\D/g, '').slice(-10);
  if (cel.length !== 10 || !process.env.WASAPI_API_KEY) return false;
  const { data } = await sb.from('wasapi_conversaciones').select('*').like('wa_id', '%' + cel).not('from_id', 'is', null).order('actualizado_en', { ascending: false }).limit(1);
  const conv = data && data[0];
  if (!conv || !conv.from_id) return false;
  const partes = String(texto).split(/\n\s*\n/).filter((x) => x.trim());
  for (const parte of partes) { await enviarTexto(conv.wa_id, conv.from_id, parte.trim()); await new Promise((r) => setTimeout(r, 1200)); }
  const hist = Array.isArray(conv.mensajes) ? conv.mensajes : [];
  hist.push({ rol: 'daniela', texto: partes.join('\n\n'), ts: new Date().toISOString(), sistema: true });
  await sb.from('wasapi_conversaciones').update({ mensajes: hist.slice(-200), perfil: Object.assign({}, conv.perfil || {}, marcas || {}) }).eq('wa_id', conv.wa_id);
  return true;
}

module.exports = function montarWasapi(app, deps) {
  app.post('/api/wasapi/webhook', (req, res) => {
    res.status(200).json({ ok: true }); // Wasapi solo espera 4 s
    try {
      const tokenOk = !process.env.WASAPI_WEBHOOK_TOKEN || req.query.token === process.env.WASAPI_WEBHOOK_TOKEN;
      if (!tokenOk) return;
      const { event, data } = req.body || {};
      // Si una PERSONA escribe desde la plataforma/app, el bot se retira de esa conversación.
      if (event === 'send_message' && data && data.wa_id && data.type === 'out') {
        console.log('wasapi send_message origin=' + data.origin + ' sender_id=' + data.sender_id);
        ultimosOrigenes.push({ origin: data.origin, sender_id: data.sender_id, ts: new Date().toISOString() }); if (ultimosOrigenes.length > 20) ultimosOrigenes.shift();
        // Avisos del sistema (p. ej. 'Conversación transferida automáticamente') no son una persona escribiendo.
        const esAviso = /transferid|asignad|reasignad|conversaci[oó]n (iniciada|cerrada)/i.test(String(data.message || ''));
        if (esAviso) { console.log('wasapi: aviso del sistema ignorado'); return; }
        if (esOrigenHumano(data.origin)) tomarHumano(String(data.wa_id), data, deps);
        return;
      }
      if (event !== 'receive_message' || !data || data.type !== 'in' || !data.wa_id) return;
      if (data.wam_id) { if (vistos.has(data.wam_id)) return; vistos.add(data.wam_id); if (vistos.size > 5000) vistos.clear(); }
      const waId = String(data.wa_id);
      const p = pendientes.get(waId) || { items: [], from_id: data.from_id, timer: null };
      p.items.push(data); p.from_id = data.from_id;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => programar(waId, deps), esperaMs());
      pendientes.set(waId, p);
    } catch (e) { console.error('wasapi webhook:', e); }
  });

  // Archivos de audio públicos (Wasapi los descarga para enviarlos por WhatsApp)
  app.get('/audios/:f', (req, res) => {
    const f = path.basename(req.params.f || '');
    const ruta = /\.(ogg|mp3|m4a|aac)$/i.test(f) ? rutaAudio(f) : null;
    if (!ruta) return res.status(404).end();
    res.type(({ ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac' })[f.split('.').pop().toLowerCase()]);
    res.sendFile(ruta);
  });
  // Prueba: /api/wasapi/prueba-audio?tel=3001234567&token=<WASAPI_WEBHOOK_TOKEN> → envía el audio de bienvenida a ese número
  app.get('/api/wasapi/prueba-audio', async (req, res) => {
    if (process.env.WASAPI_WEBHOOK_TOKEN && req.query.token !== process.env.WASAPI_WEBHOOK_TOKEN) return res.status(403).json({ error: 'token' });
    const cel = String(req.query.tel || '').replace(/\D/g, '').slice(-10);
    const url = urlAudioRedes();
    if (!url) return res.json({ ok: false, error: 'No hay audio: suba audios/bienvenida_redes.mp3 al repositorio o ponga AUDIO_REDES_URL' });
    const sb = deps.sbServicio();
    const { data } = await sb.from('wasapi_conversaciones').select('wa_id,from_id').like('wa_id', '%' + cel).not('from_id', 'is', null).order('actualizado_en', { ascending: false }).limit(1);
    const c = data && data[0];
    if (!c) return res.json({ ok: false, error: 'Ese número no ha escrito al WhatsApp de Daniela (primero escríbale desde ese celular).' });
    res.json(Object.assign({ url }, await enviarAudio(c.wa_id, c.from_id, url)));
  });

  app.get('/api/wasapi/salud', (req, res) => res.json({
    ok: true,
    escucha_notas_de_voz: sttActivo() ? (process.env.ELEVENLABS_API_KEY ? 'ElevenLabs' : 'OpenAI') : 'NO (falta ELEVENLABS_API_KEY u OPENAI_API_KEY)',
    audio_bienvenida_redes: urlAudioRedes() || 'NO configurado',
    ultimos_audios_enviados: ultimosAudios,
    wasapi_api_key: !!process.env.WASAPI_API_KEY,
    token_webhook: !!process.env.WASAPI_WEBHOOK_TOKEN,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    ultimos_origenes_enviados: ultimosOrigenes,
  }));
};

module.exports.avisarCliente = avisarCliente;
module.exports.ia = { llamarClaude, parsearJSON, limpiarTexto, tarifaUpme };
