// Atención por Chattigo con Claude (Chattigo → este servidor → Claude → Chattigo).
// Mismo criterio que wasapi.js: memoria, ficha, lectura de PDF/imagen, contrato
// JSON y validación del traspaso viven en atencion_comun.js. Aquí solo entra
// el webhook de API Bot y sale la respuesta por POST /outbound.
//
// Documentación usada: https://development.chattigo.com/es/docs/api-bot/
// Confirmado ahí:
//   - Chattigo hace POST al HTTPS que entregue el cliente, con un JSON
//     { id, idChat, did, msisdn, idUser, type, channel, channelProvider,
//       content, name, idCampaign, isAttachment, attachment, message }.
//     Hay que responder 200.
//   - type entrante: "text" (el ejemplo viene como "Text"), "media" y
//     "transfer" (el agente cerró y devuelve el chat al bot).
//   - POST /login { username, password } → { access_token }. Dura 8 horas.
//   - POST /outbound con Authorization: Bearer <JWT> envía la respuesta.
//     type: text, media, transfer, group, internal, close, timeout.
//   - Traspaso: mono-campaña = type "transfer" sin idCampaign; multi-campaña
//     = idCampaign + type "transfer"; campaña-grupo = idCampaign + type
//     "group" y content = código del grupo.
//   - attachment: { mediaUrl, mimeType, fileName }.
//   - type "internal" queda en el chat y no se envía al cliente.
//
// NO está en esa página (no se inventa un host): la URL base. El producto
// distinto "Bot-Chattigo ISV" documenta https://api.chattigo.com/login, pero
// ese host respondió 404 y sus rutas son /webhooks/inbound y
// PATCH /webhooks/outbound, no POST /outbound. Por eso CHATTIGO_API_BASE es
// obligatorio y lo tiene que dar el administrador de Chattigo.
//
// Supuestos, todos apagables o visibles en el log:
//   - Se reenvían id, idChat, did, msisdn, channel y channelProvider del
//     último mensaje entrante. idCampaign sale del mensaje o, si no viene,
//     de CHATTIGO_ID_CAMPANA. CHATTIGO_OMITIR_ID=true manda id null.
//   - La comparación de type es sin importar mayúsculas.
//   - chatType "OUTBOUND" (aparece en otros ejemplos de la misma página) no
//     se trata como mensaje del cliente, para no contestarnos a nosotros mismos.
//   - idUser distinto de 0 NO corta a Daniela salvo CHATTIGO_IDUSER_ES_AGENTE=true.
//   - Un type que no esté en la doc se registra entero y, si trae texto, se
//     responde. Para tratarlo como toma humana: CHATTIGO_TIPOS_TOMA_HUMANO.
//   - CHATTIGO_REANUDAR_TRAS_AGENTE no viene activo: un type=transfer entrante
//     no vuelve a poner el chat en manos de Daniela (igual que Wasapi, que
//     no retoma después de un humano).
//   - Tope de 3000 caracteres, tomado del webhook de canales externos
//     (otra página), no de API Bot. CHATTIGO_MAX_CONTENIDO lo cambia.
//   - mediaUrl se descarga con el JWT y, si falla, sin autenticación.
//   - Si el JSON llega envuelto en un arreglo o en "data"/"messages", se
//     acepta y se deja en el log; la doc muestra el objeto en la raíz.
//
// Variables en Render: CHATTIGO_API_BASE, CHATTIGO_USUARIO, CHATTIGO_CLAVE,
// CHATTIGO_WEBHOOK_TOKEN, ANTHROPIC_API_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Para la cola: CHATTIGO_ID_CAMPANA y, si es un
// grupo, CHATTIGO_GRUPO. Opcionales: CHATTIGO_MODELO, CHATTIGO_ESPERA_MS,
// CHATTIGO_PAUSA_MS, CHATTIGO_NOMBRE_BOT, CHATTIGO_CANAL,
// CHATTIGO_CHANNEL_PROVIDER, CHATTIGO_ID_NODO, CHATTIGO_NOMBRE_NODO,
// CHATTIGO_BOT_PROVIDER, CHATTIGO_MAX_CONTENIDO, CHATTIGO_OMITIR_ID,
// CHATTIGO_CONTENIDO_TRASPASO, CHATTIGO_IDUSER_ES_AGENTE,
// CHATTIGO_TIPOS_TOMA_HUMANO, CHATTIGO_REANUDAR_TRAS_AGENTE.
const {
  FRASE_TRASPASO, sistemaDe, llamarClaude, mensajesParaClaude, bloqueArchivo,
  buscarURL, bajarArchivo, interpretarSalida, soloPrimerNombre,
} = require('./atencion_comun');

const TABLA = 'chattigo_conversaciones';
const pendientes = new Map(); // did|msisdn -> { timer, items }
const vistos = new Set();
let tokenCache = null;
let tokenPendiente = null;

function esperaMs() { return parseInt(process.env.CHATTIGO_ESPERA_MS || '6000', 10); }
function pausaMs() { return parseInt(process.env.CHATTIGO_PAUSA_MS || '1200', 10); }
function nombreBot() { return process.env.CHATTIGO_NOMBRE_BOT || 'Daniela'; }
function maxContenido() {
  const n = parseInt(process.env.CHATTIGO_MAX_CONTENIDO || '3000', 10);
  return Number.isFinite(n) ? n : 3000;
}
function reanudarTrasAgente() { return String(process.env.CHATTIGO_REANUDAR_TRAS_AGENTE || '').toLowerCase() === 'true'; }
function idUserEsAgente(m) {
  if (String(process.env.CHATTIGO_IDUSER_ES_AGENTE || '').toLowerCase() !== 'true') return false;
  const n = Number(m && m.idUser);
  return Number.isFinite(n) && n > 0;
}
function tiposTomaHumano() {
  return String(process.env.CHATTIGO_TIPOS_TOMA_HUMANO || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function tipoDe(m) { return String((m && m.type) || '').trim().toLowerCase(); }
function claveDe(m) { return String(m.did || '') + '|' + String(m.msisdn || ''); }
function idFila(m) { return 'chattigo:' + String(m.did || '') + ':' + String(m.msisdn || ''); }

function apiBase() {
  const b = String(process.env.CHATTIGO_API_BASE || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('Falta CHATTIGO_API_BASE. API Bot documenta POST /login y POST /outbound sin host; hay que confirmar la URL base con Chattigo.');
  return b;
}

async function tokenAcceso() {
  if (tokenCache && tokenCache.exp > Date.now() + 60 * 1000) return tokenCache.valor;
  if (!process.env.CHATTIGO_USUARIO || !process.env.CHATTIGO_CLAVE) {
    throw new Error('Faltan CHATTIGO_USUARIO y CHATTIGO_CLAVE (usuario de API Bot que entrega Chattigo, no la clave del tablero).');
  }
  if (tokenPendiente) return tokenPendiente;
  tokenPendiente = (async () => {
    const r = await fetch(apiBase() + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: process.env.CHATTIGO_USUARIO, password: process.env.CHATTIGO_CLAVE }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Chattigo login ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    // La documentación dice que el JWT dura 8 horas. Se renueva un poco antes.
    tokenCache = { valor: j.access_token, exp: Date.now() + 7 * 60 * 60 * 1000 };
    return tokenCache.valor;
  })();
  try { return await tokenPendiente; } finally { tokenPendiente = null; }
}

async function postOutbound(body) {
  const enviar = async (reintento) => {
    const tok = await tokenAcceso();
    const r = await fetch(apiBase() + '/outbound', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 401 && !reintento) { tokenCache = null; return enviar(true); }
    if (!r.ok) throw new Error('Chattigo envío ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 300));
  };
  return enviar(false);
}

function numeroOTexto(v) {
  const s = String(v).trim();
  if (/^\d+$/.test(s) && s.length < 16) return Number(s);
  return s;
}

function cuerpoMensaje(meta) {
  const body = {
    id: String(process.env.CHATTIGO_OMITIR_ID || '').toLowerCase() === 'true' ? null : (meta.id != null ? meta.id : null),
    idChat: meta.idChat != null ? meta.idChat : 0,
    did: String(meta.did || ''),
    msisdn: String(meta.msisdn || ''),
    idUser: 0,
    channel: meta.channel || process.env.CHATTIGO_CANAL || 'WHATSAPP',
    content: '',
    name: nombreBot(),
    botName: nombreBot(),
    isAttachment: false,
    attachment: null,
    message: null,
  };
  if (meta.channelProvider) body.channelProvider = meta.channelProvider;
  const campana = meta.idCampaign != null && meta.idCampaign !== '' ? meta.idCampaign : process.env.CHATTIGO_ID_CAMPANA;
  if (campana != null && String(campana).trim() !== '') body.idCampaign = numeroOTexto(campana);
  if (process.env.CHATTIGO_ID_NODO) body.idNode = numeroOTexto(process.env.CHATTIGO_ID_NODO);
  if (process.env.CHATTIGO_NOMBRE_NODO) body.nameNode = process.env.CHATTIGO_NOMBRE_NODO;
  if (process.env.CHATTIGO_BOT_PROVIDER) body.botProvider = process.env.CHATTIGO_BOT_PROVIDER;
  return body;
}

function trocearContenido(texto, max) {
  const t = String(texto || '').trim();
  if (!t) return [];
  if (!max || max < 1 || t.length <= max) return [t];
  const out = [];
  let rest = t;
  while (rest.length > max) {
    let corte = rest.lastIndexOf(' ', max);
    if (corte < Math.floor(max * 0.5)) corte = max;
    out.push(rest.slice(0, corte).trim());
    rest = rest.slice(corte).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function enviarTexto(meta, texto) {
  for (const trozo of trocearContenido(texto, maxContenido())) {
    const body = cuerpoMensaje(meta);
    body.type = 'text';
    body.content = trozo;
    await postOutbound(body);
  }
}

function resumenFicha(perfil, motivo, causa) {
  const p = perfil || {};
  const docs = Array.isArray(p.documentos_recibidos) ? p.documentos_recibidos.join(', ') : '';
  return [
    'Traspaso de Daniela.',
    'Motivo: ' + (motivo || 'completo') + (causa ? ' (' + causa + ')' : ''),
    'Nombre: ' + (p.nombre || ''),
    'Vehículo: ' + [p.marca_modelo, p.tipo_vehiculo].filter(Boolean).join(' / '),
    'Compró nuevo: ' + (p.compro_nuevo == null ? '' : p.compro_nuevo),
    'Primer dueño: ' + (p.primer_dueno == null ? '' : p.primer_dueno),
    'Fecha de compra: ' + (p.fecha_compra || ''),
    'Titular de la factura: ' + (p.titular_factura || ''),
    'Certificado UPME: ' + (p.tiene_certificado_upme || ''),
    'Ciudad: ' + (p.ciudad || ''),
    'Saldos DIAN: ' + (p.saldos_dian || ''),
    'Origen: ' + (p.origen || ''),
    'IVA factura: ' + (p.iva_factura || ''),
    'Valor sin IVA: ' + (p.valor_sin_iva || ''),
    'Documentos: ' + docs,
    'Objeciones: ' + (p.objeciones || ''),
    'Notas: ' + (p.notas || ''),
  ].join('\n').slice(0, maxContenido() > 0 ? maxContenido() : 3000);
}

async function enviarInterno(meta, texto) {
  const body = cuerpoMensaje(meta);
  body.type = 'internal';
  body.content = texto;
  await postOutbound(body);
}

async function enviarTraspaso(meta, motivo, causa) {
  const body = cuerpoMensaje(meta);
  const grupo = String(process.env.CHATTIGO_GRUPO || '').trim();
  const campEnv = String(process.env.CHATTIGO_ID_CAMPANA || '').trim();
  const nota = process.env.CHATTIGO_CONTENIDO_TRASPASO != null
    ? String(process.env.CHATTIGO_CONTENIDO_TRASPASO)
    : ((motivo || 'completo') + (causa ? ':' + causa : ''));
  if (grupo) {
    // Documentado: campaña-grupo usa type "group" y content = código del grupo.
    body.type = 'group';
    body.content = grupo;
    const camp = campEnv || (meta.idCampaign != null && meta.idCampaign !== '' ? String(meta.idCampaign) : '');
    if (!camp) console.log('chattigo: traspaso type=group sin idCampaign. La documentación de API Bot lo pide.');
    else body.idCampaign = numeroOTexto(camp);
  } else if (campEnv) {
    body.type = 'transfer';
    body.content = nota;
    body.idCampaign = numeroOTexto(campEnv);
  } else {
    // Documentado: mono-campaña no envía idCampaign.
    body.type = 'transfer';
    body.content = nota;
    delete body.idCampaign;
    console.log('chattigo: traspaso mono-campaña (type=transfer sin idCampaign). Para la cola Beneficio tributario Autos Sura hay que definir CHATTIGO_ID_CAMPANA o CHATTIGO_GRUPO.');
  }
  await postOutbound(body);
}

const TIPOS_MEDIA = new Set(['media', 'image', 'document', 'sticker', 'file']);
const TIPOS_AV = new Set(['audio', 'video', 'voice', 'ptt']);
const TIPOS_CONOCIDOS = new Set(['text', 'texto', 'media', 'image', 'document', 'sticker', 'file', 'audio', 'video', 'voice', 'ptt', 'order', 'flow', 'interactive', 'transfer']);

function textoClienteDe(m) {
  const partes = [];
  if (typeof m.content === 'string' && m.content.trim()) partes.push(m.content.trim());
  else if (m.content != null && typeof m.content !== 'object') partes.push(String(m.content));
  if (m.interactiveChoiceId && !partes.join('\n').includes(String(m.interactiveChoiceId))) partes.push(String(m.interactiveChoiceId));
  if (m.order && typeof m.order === 'object') {
    if (m.order.text) partes.push(String(m.order.text));
    const n = Array.isArray(m.order.product_items) ? m.order.product_items.length : (m.order.totalItems || 0);
    partes.push('[El cliente envió un carrito' + (n ? ' (' + n + ' productos)' : '') + ']');
  }
  if (m.referredProduct && typeof m.referredProduct === 'object' && m.referredProduct.name) {
    partes.push('[Consulta por el producto: ' + m.referredProduct.name + ']');
  }
  if (m.flow) partes.push('[El cliente completó un formulario de WhatsApp]');
  if (typeof m.message === 'string' && m.message.trim()) partes.push(m.message.trim());
  return partes.join('\n').trim();
}

function datosAdjunto(m) {
  const a = m.attachment;
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const url = a.mediaUrl || a.media_url || a.url || null;
    if (url) return { url, mime: a.mimeType || a.mime_type || '', nombre: a.fileName || a.filename || a.name || '' };
  }
  if (Array.isArray(a) && a.length) {
    const primero = datosAdjunto({ attachment: a[0] });
    if (primero) return primero;
  }
  // La doc de API Bot nombra mediaUrl. Si el payload real usa otro campo, se busca un https y se deja el raw en el log.
  const u = buscarURL(a) || (m.isAttachment || TIPOS_MEDIA.has(tipoDe(m)) ? buscarURL(m) : null);
  if (!u) return null;
  return { url: u, mime: (a && a.mimeType) || '', nombre: (a && (a.fileName || a.filename)) || '' };
}

function tipoLegible(buf, mime, nombre) {
  const m = String(mime || '').toLowerCase();
  if (/pdf/.test(m) || /\.pdf$/i.test(nombre || '') || buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (/^image\/(jpeg|png|gif|webp)$/.test(m)) return m;
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 6).toString() === 'GIF87a' || buf.slice(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return m;
}

async function bajarDeChattigo(url) {
  // La doc no dice si mediaUrl exige el JWT. Se intenta con Bearer y después sin él.
  let header = null;
  if (process.env.CHATTIGO_USUARIO && process.env.CHATTIGO_CLAVE && process.env.CHATTIGO_API_BASE) {
    try { header = 'Bearer ' + await tokenAcceso(); } catch (e) { console.error('chattigo token para archivo:', e.message); }
  }
  return bajarArchivo(url, header);
}

function metaDe(items) {
  const ult = items[items.length - 1] || {};
  return {
    id: ult.id != null ? ult.id : null,
    idChat: ult.idChat != null ? ult.idChat : (ult.id_chat != null ? ult.id_chat : 0),
    did: ult.did,
    msisdn: ult.msisdn,
    idCampaign: ult.idCampaign != null ? ult.idCampaign : ult.campaignId,
    channel: ult.channel || process.env.CHATTIGO_CANAL || 'WHATSAPP',
    channelProvider: ult.channelProvider || process.env.CHATTIGO_CHANNEL_PROVIDER || '',
    name: ult.name || '',
  };
}

function filaGuardar(conv, m, extra) {
  const meta = m || {};
  const campana = meta.idCampaign != null ? meta.idCampaign : (meta.campaignId != null ? meta.campaignId : conv.id_campana);
  return {
    id: conv.id || idFila(meta),
    did: meta.did != null ? String(meta.did) : (conv.did || null),
    msisdn: meta.msisdn != null ? String(meta.msisdn) : (conv.msisdn || null),
    id_chat: (meta.idChat != null ? meta.idChat : conv.id_chat) != null ? String(meta.idChat != null ? meta.idChat : conv.id_chat) : null,
    id_campana: campana != null && campana !== '' ? String(campana) : null,
    canal: meta.channel || conv.canal || null,
    proveedor_canal: meta.channelProvider || conv.proveedor_canal || null,
    nombre: meta.name || conv.nombre || null,
    mensajes: extra.mensajes,
    perfil: extra.perfil != null ? extra.perfil : (conv.perfil || {}),
    estado: extra.estado,
    motivo_traspaso: Object.prototype.hasOwnProperty.call(extra, 'motivo_traspaso') ? extra.motivo_traspaso : (conv.motivo_traspaso || null),
    ultimo_payload_archivo: Object.prototype.hasOwnProperty.call(extra, 'ultimo_payload_archivo') ? extra.ultimo_payload_archivo : (conv.ultimo_payload_archivo || null),
    actualizado_en: extra.actualizado_en || new Date().toISOString(),
  };
}

async function estaEnHumano(id, deps) {
  try {
    const { data } = await deps.sbServicio().from(TABLA).select('estado').eq('id', id).maybeSingle();
    return !!data && data.estado === 'humano';
  } catch (_) { return false; }
}

async function tomarHumano(m, deps) {
  if (!m || !m.msisdn) { console.log('chattigo: toma humana sin msisdn', JSON.stringify(m || {}).slice(0, 1500)); return; }
  const p = pendientes.get(claveDe(m));
  if (p) { clearTimeout(p.timer); pendientes.delete(claveDe(m)); }
  try {
    const sb = deps.sbServicio();
    const { data: fila } = await sb.from(TABLA).select('*').eq('id', idFila(m)).maybeSingle();
    const conv = fila || { id: idFila(m), mensajes: [], perfil: {}, estado: 'bot' };
    const hist = Array.isArray(conv.mensajes) ? conv.mensajes : [];
    const texto = textoClienteDe(m);
    if (texto) hist.push({ rol: 'agente', texto: String(texto), ts: new Date().toISOString() });
    await sb.from(TABLA).upsert(filaGuardar(conv, m, {
      mensajes: hist.slice(-200), perfil: conv.perfil || {}, estado: 'humano', motivo_traspaso: 'agente_intervino',
    }), { onConflict: 'id' });
    console.log('chattigo: un humano tomó el chat', idFila(m));
  } catch (e) { console.error('chattigo tomarHumano:', e); }
}

async function avisoTransfer(m, deps) {
  // Documentado: type transfer entrante = el agente cerró y hay que seguir el flujo.
  if (!m || !m.msisdn) { console.log('chattigo: transfer entrante sin msisdn', JSON.stringify(m || {}).slice(0, 1500)); return; }
  const p = pendientes.get(claveDe(m));
  if (p) { clearTimeout(p.timer); pendientes.delete(claveDe(m)); }
  try {
    const sb = deps.sbServicio();
    const { data: fila } = await sb.from(TABLA).select('*').eq('id', idFila(m)).maybeSingle();
    const conv = fila || { id: idFila(m), mensajes: [], perfil: {}, estado: 'bot' };
    const hist = Array.isArray(conv.mensajes) ? conv.mensajes : [];
    hist.push({ rol: 'sistema', texto: 'Chattigo envió type=transfer: el agente cerró y devolvió el chat al bot.', ts: new Date().toISOString() });
    let estado = conv.estado || 'bot';
    if (estado === 'humano' && reanudarTrasAgente()) estado = 'bot';
    else if (estado === 'humano') console.log('chattigo: type=transfer con el chat en humano. CHATTIGO_REANUDAR_TRAS_AGENTE no está activo; Daniela sigue en silencio.');
    await sb.from(TABLA).upsert(filaGuardar(conv, m, {
      mensajes: hist.slice(-200), perfil: conv.perfil || {}, estado, motivo_traspaso: conv.motivo_traspaso || null,
    }), { onConflict: 'id' });
  } catch (e) { console.error('chattigo transfer entrante:', e); }
}

async function procesar(clave, deps) {
  const p = pendientes.get(clave);
  if (!p) return;
  pendientes.delete(clave);
  const meta = metaDe(p.items);
  const id = idFila(meta);
  const sb = deps.sbServicio();
  try {
    const { data: fila } = await sb.from(TABLA).select('*').eq('id', id).maybeSingle();
    const conv = fila || { id, mensajes: [], perfil: {}, estado: 'bot' };
    const historial = Array.isArray(conv.mensajes) ? conv.mensajes : [];
    const ahora = new Date().toISOString();
    const textos = []; const bloques = []; const archivos = [];
    for (const d of p.items) {
      const tipo = tipoDe(d);
      if (tipo && !TIPOS_CONOCIDOS.has(tipo)) console.log('chattigo: type no documentado "' + tipo + '". Payload:', JSON.stringify(d).slice(0, 2000));
      if (!TIPOS_AV.has(tipo)) {
        const dicho = textoClienteDe(d);
        if (dicho) textos.push(dicho);
      }
      if (TIPOS_AV.has(tipo)) {
        textos.push('[El cliente envió un ' + tipo + ' que no se puede escuchar; pídele amablemente que lo escriba]');
        continue;
      }
      if (d.isAttachment === true || d.isAttachment === 'true' || TIPOS_MEDIA.has(tipo)) {
        const adj = datosAdjunto(d);
        const nombre = (adj && adj.nombre) || tipo || 'archivo';
        archivos.push(nombre);
        let leido = false;
        if (adj && adj.url) {
          try {
            const f = await bajarDeChattigo(adj.url);
            const tipoArch = tipoLegible(f.buf, adj.mime || f.tipo, adj.nombre);
            if (/^audio\/|^video\//.test(tipoArch)) {
              textos.push('[El cliente envió un archivo de audio o video que no se puede escuchar; pídele amablemente que lo escriba]');
              leido = true;
            } else {
              const b = bloqueArchivo(f.buf, tipoArch, adj.nombre);
              if (b) { bloques.push(b); leido = true; }
            }
          } catch (e) { console.error('chattigo archivo:', e.message); }
        }
        if (!leido) {
          textos.push('[El cliente envió un archivo (' + nombre + ') que no pude abrir]');
          conv.ultimo_payload_archivo = d;
          console.log('chattigo archivo sin URL o ilegible:', JSON.stringify(d).slice(0, 2000));
        }
      }
    }
    const textoCliente = textos.join('\n').trim();
    historial.push({ rol: 'cliente', texto: textoCliente || '[archivo]', ts: ahora, archivos });

    if (conv.estado === 'humano') {
      await sb.from(TABLA).upsert(filaGuardar(conv, meta, {
        mensajes: historial.slice(-200), perfil: conv.perfil || {}, estado: 'humano',
        motivo_traspaso: conv.motivo_traspaso || null, ultimo_payload_archivo: conv.ultimo_payload_archivo || null, actualizado_en: ahora,
      }), { onConflict: 'id' });
      return;
    }

    let conocimiento = '';
    try { conocimiento = await deps.obtenerConocimientoTexto(textoCliente); } catch (_) {}
    const sistema = sistemaDe(conv.perfil, conocimiento);
    const histLimpio = historial.slice(0, -1).map((m) => (m.rol === 'cliente' ? m : Object.assign({}, m, { texto: soloPrimerNombre(m.texto, (conv.perfil || {}).nombre) })));
    const msgsIA = mensajesParaClaude(histLimpio, bloques, textoCliente);
    const bruto = await llamarClaude(sistema, msgsIA, process.env.CHATTIGO_MODELO || process.env.WASAPI_MODELO || process.env.CHAT_ANALISIS_MODELO || 'claude-sonnet-4-5');
    const { j, perfil, partes, estado } = interpretarSalida({ bruto, perfilPrevio: conv.perfil, prefijo: 'chattigo' });
    if (j && j.datos_archivo) historial[historial.length - 1].texto += '\n[Lectura del archivo: ' + j.datos_archivo + ']';

    if ((partes.length || estado === 'humano') && await estaEnHumano(id, deps)) {
      console.log('chattigo: un humano tomó el chat durante la respuesta, se descarta');
      return;
    }
    if (partes.length) {
      for (const parte of partes) {
        if (await estaEnHumano(id, deps)) { console.log('chattigo: humano intervino, se corta el envío'); return; }
        if (parte.trim()) { await enviarTexto(meta, parte.trim()); if (pausaMs() > 0) await new Promise((r) => setTimeout(r, pausaMs())); }
      }
      historial.push({ rol: 'daniela', texto: partes.join('\n\n'), ts: new Date().toISOString() });
    }
    if (estado === 'humano') {
      if (await estaEnHumano(id, deps)) { console.log('chattigo: humano intervino, no se traspasa'); return; }
      // type internal está documentado: no sale al cliente y queda en el chat del agente.
      try { await enviarInterno(meta, resumenFicha(perfil, j && j.motivo_traspaso, j && j.causa_escalamiento)); }
      catch (e) { console.error('chattigo nota interna:', e.message); }
      await enviarTraspaso(meta, j && j.motivo_traspaso, j && j.causa_escalamiento);
    }
    await sb.from(TABLA).upsert(filaGuardar(conv, meta, {
      mensajes: historial.slice(-200), perfil, estado,
      motivo_traspaso: j && j.motivo_traspaso ? j.motivo_traspaso : null,
      ultimo_payload_archivo: conv.ultimo_payload_archivo || null,
    }), { onConflict: 'id' });
  } catch (e) {
    console.error('chattigo procesar:', e);
  }
}

function envolver(body) {
  if (Array.isArray(body)) {
    console.log('chattigo: el webhook llegó como arreglo; la documentación muestra un objeto. Se procesa cada elemento.');
    return body.filter((x) => x && typeof x === 'object');
  }
  if (!body || typeof body !== 'object') return [];
  const raizCliente = body.msisdn || body.did || body.type || body.content;
  if (!raizCliente) {
    const lista = Array.isArray(body.messages) ? body.messages : (Array.isArray(body.data) ? body.data : null);
    if (lista) {
      console.log('chattigo: el cuerpo no trae el mensaje en la raíz; se usa messages/data. Payload:', JSON.stringify(body).slice(0, 2000));
      return lista.filter((x) => x && typeof x === 'object');
    }
    if (body.data && typeof body.data === 'object') {
      console.log('chattigo: el cuerpo no trae el mensaje en la raíz; se usa body.data. Payload:', JSON.stringify(body).slice(0, 2000));
      return [body.data];
    }
  }
  return [body];
}

function yaVisto(m) {
  if (m.id == null || m.id === '') return false;
  const id = String(m.id);
  if (vistos.has(id)) return true;
  vistos.add(id);
  if (vistos.size > 5000) vistos.clear();
  return false;
}

module.exports = function montarChattigo(app, deps) {
  app.post('/api/chattigo/webhook', (req, res) => {
    res.status(200).json({ ok: true });
    try {
      const tokenOk = !process.env.CHATTIGO_WEBHOOK_TOKEN || req.query.token === process.env.CHATTIGO_WEBHOOK_TOKEN;
      if (!tokenOk) { console.log('chattigo: token de webhook inválido'); return; }
      const body = req.body;
      console.log('chattigo webhook', JSON.stringify(body).slice(0, 2000));
      for (const m of envolver(body)) {
        if (yaVisto(m)) continue;
        const tipo = tipoDe(m);
        const chatType = String(m.chatType || '').toUpperCase();
        // Supuesto: chatType OUTBOUND (ejemplos de la misma doc, no del webhook base) es eco o mensaje de agente.
        if (chatType === 'OUTBOUND') {
          console.log('chattigo: chatType OUTBOUND ignorado como mensaje de cliente. idUser=' + m.idUser + ' type=' + tipo);
          if (idUserEsAgente(m) || tiposTomaHumano().includes(tipo)) tomarHumano(m, deps);
          continue;
        }
        if (tipo === 'transfer') { avisoTransfer(m, deps); continue; }
        if (idUserEsAgente(m) || (tipo && tiposTomaHumano().includes(tipo))) { tomarHumano(m, deps); continue; }
        if (!m.msisdn) { console.log('chattigo: mensaje sin msisdn, no se puede agrupar', JSON.stringify(m).slice(0, 1500)); continue; }
        const clave = claveDe(m);
        const p = pendientes.get(clave) || { items: [], timer: null };
        p.items.push(m);
        clearTimeout(p.timer);
        p.timer = setTimeout(() => procesar(clave, deps), esperaMs());
        pendientes.set(clave, p);
      }
    } catch (e) { console.error('chattigo webhook:', e); }
  });

  app.get('/api/chattigo/salud', (req, res) => res.json({
    ok: true,
    api_base_configurada: !!process.env.CHATTIGO_API_BASE,
    api_base: process.env.CHATTIGO_API_BASE || null,
    usuario_configurado: !!process.env.CHATTIGO_USUARIO,
    clave_configurada: !!process.env.CHATTIGO_CLAVE,
    token_webhook: !!process.env.CHATTIGO_WEBHOOK_TOKEN,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    id_campana: process.env.CHATTIGO_ID_CAMPANA || null,
    grupo: process.env.CHATTIGO_GRUPO || null,
    iduser_es_agente: String(process.env.CHATTIGO_IDUSER_ES_AGENTE || '').toLowerCase() === 'true',
    reanudar_tras_agente: reanudarTrasAgente(),
    documentacion: 'https://development.chattigo.com/es/docs/api-bot/',
    rutas: { login: 'POST {CHATTIGO_API_BASE}/login', outbound: 'POST {CHATTIGO_API_BASE}/outbound' },
  }));
};
