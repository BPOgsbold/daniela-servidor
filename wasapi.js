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
- Si el cliente manda varios mensajes seguidos, respóndelos juntos en un solo mensaje corto.
SALIDA: responde SOLO un JSON válido, sin texto fuera de él:
{"respuesta":"texto para el cliente, plano, 1 a 3 frases","perfil":{"nombre":null,"marca_modelo":null,"tipo_vehiculo":null,"compro_nuevo":null,"primer_dueno":null,"fecha_compra":null,"titular_factura":null,"tiene_certificado_upme":null,"ciudad":null,"origen":null,"iva_factura":null,"valor_sin_iva":null,"documentos_recibidos":[],"notas":null},"datos_archivo":"resumen breve de lo leído en el archivo o null","traspasar":false,"motivo_traspaso":null}
En "perfil" pon solo lo que sepas (conserva lo anterior). "traspasar":true cuando aplique TRASPASA A HUMANO o el cliente quiera avanzar; en ese caso "respuesta" debe ser exactamente: ${FRASE_TRASPASO}`;

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
function urlDeArchivo(d) {
  for (const k of ['media_url', 'url', 'link', 'file_url', 'attachment_url']) {
    if (typeof d[k] === 'string' && /^https?:\/\//.test(d[k])) return d[k];
  }
  if (typeof d.data === 'string' && /^https?:\/\//.test(d.data)) return d.data;
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

async function llamarClaude(sistema, mensajes) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.WASAPI_MODELO || process.env.CHAT_ANALISIS_MODELO || 'claude-sonnet-4-5', max_tokens: 900, system: sistema, messages: mensajes }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'IA ' + r.status);
  return (j.content || []).map((b) => b.text || '').join('').trim();
}
function parsearJSON(t) {
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
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
        const url = urlDeArchivo(d);
        let leido = false;
        if (url) {
          try { const f = await bajarArchivo(url); const b = bloqueArchivo(f.buf, f.tipo, d.filename); if (b) { bloques.push(b); leido = true; } } catch (e) { console.error('wasapi archivo:', e.message); }
        }
        if (!leido) {
          textos.push('[El cliente envió un archivo (' + (d.filename || d.message_type) + ') que no pude abrir]');
          conv.ultimo_payload_archivo = d; // para ajustar la lectura de adjuntos
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
    const sistema = BASE_PROMPT + '\n' + REGLAS_EXTRA +
      '\n\nFICHA ACTUAL DEL CLIENTE (JSON): ' + JSON.stringify(conv.perfil || {}) +
      (conocimiento ? '\n\nGUÍA DE CONOCIMIENTO (úsala para resolver dudas; no la copies tal cual ni menciones precios):\n' + String(conocimiento).slice(0, 14000) : '');

    const msgsIA = mensajesParaClaude(historial.slice(0, -1), bloques, textoCliente);
    const bruto = await llamarClaude(sistema, msgsIA);
    const j = parsearJSON(bruto);
    let respuesta = j && typeof j.respuesta === 'string' ? j.respuesta.trim() : '';
    if (!respuesta) {
      // Nunca enviar JSON ni etiquetas al cliente.
      respuesta = j ? '' : bruto.replace(/[<{][\s\S]*$/, '').trim();
    }
    const perfil = Object.assign({}, conv.perfil || {});
    if (j && j.perfil) for (const [k, v] of Object.entries(j.perfil)) if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && v !== '') perfil[k] = v;
    if (j && j.datos_archivo) historial[historial.length - 1].texto += '\n[Lectura del archivo: ' + j.datos_archivo + ']';

    let estado = 'bot';
    if (j && j.traspasar) { estado = 'humano'; respuesta = FRASE_TRASPASO; }

    if (respuesta) {
      for (const parte of respuesta.split(/\n\s*\n/).slice(0, 3)) { if (parte.trim()) { await enviarTexto(waId, p.from_id, parte.trim()); await new Promise((r) => setTimeout(r, 1200)); } }
      historial.push({ rol: 'daniela', texto: respuesta, ts: new Date().toISOString() });
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

module.exports = function montarWasapi(app, deps) {
  app.post('/api/wasapi/webhook', (req, res) => {
    res.status(200).json({ ok: true }); // Wasapi solo espera 4 s
    try {
      const tokenOk = !process.env.WASAPI_WEBHOOK_TOKEN || req.query.token === process.env.WASAPI_WEBHOOK_TOKEN;
      if (!tokenOk) return;
      const { event, data } = req.body || {};
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
  }));
};
