// Atención por WhatsApp con Claude (Wasapi → este servidor → Claude → Wasapi).
// Wasapi avisa con el webhook `receive_message`; aquí se guarda la conversación
// completa (memoria), Claude lee texto/PDF/imagen y responde por la API de Wasapi.
// El prompt, la lectura de archivos y la validación del traspaso están en
// atencion_comun.js (Chattigo usa los mismos). El webhook y el envío siguen aquí.
// Variables en Render: WASAPI_API_KEY, WASAPI_WEBHOOK_TOKEN, ANTHROPIC_API_KEY,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Opcional: WASAPI_MODELO, WASAPI_ESPERA_MS.
const {
  sistemaDe, llamarClaude, mensajesParaClaude, bloqueArchivo, buscarURL, bajarArchivo, interpretarSalida, soloPrimerNombre,
} = require('./atencion_comun');

const API = 'https://api-ws.wasapi.io/api/v1';

const pendientes = new Map(); // wa_id -> { timer, items, from_id }
const vistos = new Set();     // wam_id ya procesados (dedupe en memoria)

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
async function bajarDeWasapi(url) {
  // Igual que antes: primero con la llave de Wasapi y, si falla, sin ella.
  return bajarArchivo(url, 'Bearer ' + process.env.WASAPI_API_KEY);
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

    const textos = []; const bloques = []; const archivos = [];
    for (const d of p.items) {
      if (d.message) textos.push(d.message);
      else if (d.caption) textos.push(d.caption);
      if (['image', 'document', 'sticker'].includes(d.message_type)) {
        archivos.push(d.filename || d.message_type);
        const url = await urlDeArchivo(d);
        let leido = false;
        if (url) {
          try { const f = await bajarDeWasapi(url); const b = bloqueArchivo(f.buf, f.tipo, d.filename); if (b) { bloques.push(b); leido = true; } } catch (e) { console.error('wasapi archivo:', e.message); }
        }
        if (!leido) {
          textos.push('[El cliente envió un archivo (' + (d.filename || d.message_type) + ') que no pude abrir]');
          conv.ultimo_payload_archivo = d; console.log('wasapi archivo sin URL:', JSON.stringify(d).slice(0, 1500)); // para ajustar la lectura de adjuntos
        }
      } else if (['audio', 'video'].includes(d.message_type)) {
        textos.push('[El cliente envió un ' + d.message_type + ' que no se puede escuchar; pídele amablemente que lo escriba]');
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
    const sistema = sistemaDe(conv.perfil, conocimiento);

    const histLimpio = historial.slice(0, -1).map((m) => (m.rol === 'cliente' ? m : Object.assign({}, m, { texto: soloPrimerNombre(m.texto, (conv.perfil || {}).nombre) })));
    const msgsIA = mensajesParaClaude(histLimpio, bloques, textoCliente);
    const bruto = await llamarClaude(sistema, msgsIA, process.env.WASAPI_MODELO || process.env.CHAT_ANALISIS_MODELO || 'claude-sonnet-4-5');
    const { j, perfil, partes, estado } = interpretarSalida({ bruto, perfilPrevio: conv.perfil, prefijo: 'wasapi' });
    if (j && j.datos_archivo) historial[historial.length - 1].texto += '\n[Lectura del archivo: ' + j.datos_archivo + ']';

    if (partes.length && await estaEnHumano(waId, deps)) {
      // Una persona tomó el chat mientras Claude pensaba: no se envía nada.
      console.log('wasapi: un humano tomó el chat durante la respuesta, se descarta');
      return;
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
      p.timer = setTimeout(() => procesar(waId, deps), esperaMs());
      pendientes.set(waId, p);
    } catch (e) { console.error('wasapi webhook:', e); }
  });

  app.get('/api/wasapi/salud', (req, res) => res.json({
    ok: true,
    wasapi_api_key: !!process.env.WASAPI_API_KEY,
    token_webhook: !!process.env.WASAPI_WEBHOOK_TOKEN,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    ultimos_origenes_enviados: ultimosOrigenes,
  }));
};
