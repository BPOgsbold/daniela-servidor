// Copiloto de Daniela dentro de Chattigo (cola "Beneficio tributario Autos Sura").
// Chattigo no tiene API para nosotros: la extensión de Chrome lee el chat abierto en la pantalla del agente y lo manda
// aquí. Daniela devuelve el SIGUIENTE mensaje sugerido (el agente lo revisa y lo envía él mismo) y, por detrás, crea o
// actualiza el caso, sube los documentos con su tipo y pide el contrato, igual que en WhatsApp.
// La guía de atención está en prompt_chattigo.md (base de conocimiento de Chattigo).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sincronizarTodo } = require('./wasapi_caso');
const { llamarClaude, parsearJSON, limpiarTexto, tarifaUpme } = require('./wasapi').ia;

const GUIA = fs.readFileSync(path.join(__dirname, 'prompt_chattigo.md'), 'utf8');
const CIERRE = () => String(process.env.CHATTIGO_CIERRE || 'Lina Marcela Bedoya,Lina Margod Betancur').split(',').map((x) => x.trim()).filter(Boolean);
const digitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');
const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const SALIDA = `
FORMA DE TRABAJO EN ESTA HERRAMIENTA (manda sobre la guía cuando hablen de lo mismo)
- Eres el copiloto de un agente humano de Chattigo. Tú NO envías nada: redactas el SIGUIENTE mensaje que el agente le va a enviar al cliente, como Daniela de Gómez Legal Abogados en representación de SURA. El agente lo revisa y lo envía.
- Lee TODA la conversación. Si el último mensaje es del agente y el cliente no ha respondido, sugiere un seguimiento corto o deja "respuesta" vacía si no hace falta escribir.
- Mensajes cortos, una sola pregunta, de usted, sin listas ni negritas, sin marcadores tipo [nombre].
- QUIÉN ENVIÓ QUÉ: en la conversación, CLIENTE es el cliente y AGENTE somos nosotros (Gómez Legal / Daniela). Las imágenes o archivos que envía el AGENTE (capturas de la UPME, instrucciones, ejemplos) son material de apoyo NUESTRO: nunca digas que el cliente los compartió y nunca tomes de ellos nombres, cédulas, celulares ni datos del cliente. Solo los "ARCHIVO NUEVO" son documentos enviados por el cliente.
- SALUDO: si en la conversación de HOY el AGENTE ya saludó o se presentó, NO vuelvas a saludar ni a presentarte ("Buenos días", "Soy Daniela de…"): ve directo al punto, llamando al cliente por su nombre.
- TONO: atiende el caso y da tranquilidad. Reconoce lo que el cliente dijo o envió, dile que lo estamos revisando, que su trámite sigue en curso y que lo acompañamos en todo el proceso. Nada de textos largos ni de repetir lo que ya se le explicó.
- No menciones por iniciativa propia que eres asistente virtual, bot o inteligencia artificial: firma y habla como Daniela, del equipo de Gómez Legal Abogados.
- Si el cliente pregunta directamente si habla con una persona o con un bot: NO afirmes ser una persona y no lo niegues. Responde SOLO: "Permítanos un momento, por favor, estamos revisando su caso." (puedes anteponer el nombre del cliente) y pon accion = "preguntar_grupo" con nota_equipo: "El cliente preguntó si habla con un bot. Que la operación tome este chat." Así la operación sigue la conversación.
- Lo que el AGENTE ya le envió (instrucciones, usuario y clave de la UPME, pasos de pago) es nuestro: si el cliente dice que no le sale lo que le indicamos, no le repitas las instrucciones; tranquilízalo y pregunta al equipo con el detalle de lo que el cliente ve.
- En "nota_equipo" escribe directo la pregunta (sin saludos ni firmas ni marcadores como [nombre bot]); incluye nombre y celular del cliente solo si salen de la conversación del CLIENTE o de la ficha.
- Si el chat no es del beneficio tributario (cita médica, técnico-mecánica, arrendamiento), accion = "no_atender".
- Si algo requiere aprobación del equipo o no está en la guía, accion = "preguntar_grupo", escribe en "nota_equipo" la pregunta para el grupo de Teams "GLA Novedades atención" y en "respuesta" un mensaje que no afirme nada sobre ese punto.
- Revisa TODO el historial (también lo que se habló antes de transferencias) y todo lo leído en los documentos (ficha y notas) antes de decidir: no vuelvas a pedir algo que el cliente ya envió.
- Si el expediente está completo y en orden según la guía (factura, RUT vigente y cédula completos, sin nada que no cuadre), accion = "transferir_cierre", "respuesta" vacía (se transfiere sin avisar al cliente) y llena "resumen_cierre". No uses "preguntar_grupo" solo para que alguien revise documentos que tú ya puedes leer.
- Si el cliente pide hablar con alguien: "respuesta" = "Un asesor del equipo se comunicará con usted." y accion = "preguntar_grupo" con la nota para el grupo.
- Si un archivo no se puede leer, usa la respuesta fija de la guía y accion = "preguntar_grupo".

RESPONDE SOLO con un JSON válido (sin texto alrededor):
{"respuesta":"mensaje sugerido para el cliente o vacío","accion":"responder|preguntar_grupo|transferir_cierre|no_atender","nota_equipo":"texto para el grupo de Teams o null","alertas":["empresa","dos_propietarios","rut_vencido","iva_19","leasing","otro..."],"faltan":["lo que falta del expediente"],"archivos_tipos":[],"datos_archivos":"resumen breve de lo leído en los archivos nuevos o null","resumen_cierre":"solo si accion = transferir_cierre: resumen consolidado para la asesora de cierre (nombre completo, cédula/NIT, vehículo, fecha de factura, valor sin IVA, IVA, titular de la factura, RUT vigente sí/no, documentos recibidos, servicio que quiere, alertas) o null","perfil":{"nombre":null,"nombre_completo":null,"cedula":null,"correo":null,"marca_modelo":null,"tipo_vehiculo":null,"fecha_compra":null,"titular_factura":null,"tiene_certificado_upme":null,"ciudad":null,"valor_sin_iva":null,"interesado":null,"precio_informado":null,"acepta_avanzar":null,"medios_pago_informados":null,"documentos_recibidos":[],"pago_honorarios_recibido":null,"dos_propietarios":null,"notas":null}}
En "perfil" pon solo lo que sepas (se conserva lo anterior). "cedula": solo números (si la factura es de empresa, el NIT sin dígito de verificación). "fecha_compra" en formato AAAA-MM-DD si la sabes. "archivos_tipos": un tipo por cada ARCHIVO NUEVO adjunto en este mensaje, en el mismo orden: "factura", "rut", "cedula", "certificacion_bancaria", "certificado_upme", "soporte_pago" u "otro".`;

// Modo autónomo: Daniela envía ella misma (PC dedicado con la extensión v2.3).
const SALIDA_AUTO = `
MODO AUTÓNOMO (manda sobre lo anterior cuando hablen de lo mismo)
- En este chat NO hay un agente revisando: lo que pongas en "respuesta" se le envía tal cual al cliente por WhatsApp, como Daniela de Gómez Legal Abogados en representación de SURA.
- Responde solo lo que sabes por la guía y la ficha. Ante cualquier duda, accion = "preguntar_grupo": en "respuesta" un mensaje breve de espera (por ejemplo, que lo está validando con el equipo y le confirma en breve) y en "nota_equipo" la pregunta concreta para el grupo, con el dato que hace falta.
- Nunca prometas montos, fechas ni resultados que no estén en la guía. Nunca pidas datos de tarjetas ni claves (solo la clave de apertura del RUT o la factura si viene protegida).
- Si el último mensaje del cliente es solo un agradecimiento o un "ok" y no hay nada pendiente de tu parte, deja "respuesta" vacía.
- Si llega una nota de voz, pídele con amabilidad que por favor te lo escriba.`;

// Aviso al grupo de Teams "GLA Novedades atención" (flujo de Workflows "cuando se reciba una solicitud de webhook").
async function avisarTeams({ titulo, texto, nombre, telefono }) {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) return false;
  const lineas = [nombre && ('Cliente: ' + nombre), telefono && ('Celular: +' + digitos(telefono)), texto].filter(Boolean);
  const tarjeta = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
    body: [{ type: 'TextBlock', text: titulo, weight: 'Bolder', size: 'Medium', wrap: true },
      ...lineas.map((l) => ({ type: 'TextBlock', text: String(l).slice(0, 1500), wrap: true }))] };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: tarjeta }] }) });
    if (!r.ok) console.error('Teams webhook:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('Teams webhook:', e.message); return false; }
}
const autoActivo = () => process.env.CHATTIGO_AUTONOMO !== '0';

// Estado REAL del trámite en el panel (el mismo que ve el cliente en "Mi trámite"), para no inventar ni contradecir.
async function estadoReal(sb, tel) {
  if (!tel || tel.length !== 10) return null;
  try {
    const { armarTramite } = require('./portal');
    const { data: casos } = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('telefono', tel).limit(10);
    if (!casos || !casos.length) return null;
    const caso = casos.slice().sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
    let cli = null;
    const { data: c1 } = await sb.from('BD_Cliente_GLA').select('*').eq('caso_id', caso.id).limit(1);
    cli = (c1 || [])[0] || null;
    if (!cli && caso.numero_identificacion) {
      const { data: c2 } = await sb.from('BD_Cliente_GLA').select('*').eq('numero_identificacion', caso.numero_identificacion).limit(1);
      cli = (c2 || [])[0] || null;
    }
    const t = armarTramite(caso, cli, []);
    const pasos = (t.pasos || []).filter((x) => x.estado !== 'pendiente' || x.estado === 'actual').map((x) =>
      `- ${x.titulo}: ${x.estado === 'hecho' ? 'HECHO' : x.estado === 'actual' ? 'EN CURSO (etapa actual)' : x.estado === 'omitido' ? 'no aplica' : 'pendiente'}${x.fecha ? ' (' + String(x.fecha).slice(0, 10) + ')' : ''}${(x.datos || []).length ? ' · ' + x.datos.map((d) => d[0] + ': ' + d[1]).join(', ') : ''}${x.estado === 'actual' && x.usted ? ' · Lo que le toca al cliente: ' + x.usted : ''}`);
    return `ESTADO REAL DEL TRÁMITE EN NUESTRO PANEL (fuente oficial; Gómez Legal hace la UPME y la DIAN POR el cliente, el cliente no radica nada por su cuenta salvo que el panel diga que ya tenía el certificado):
Cliente: ${caso.nombre_cliente || ''} · Estado comercial: ${caso.estado_pipeline || ''} · Vehículo: ${caso.vehiculo || (cli && cli.vehiculo) || ''}${cli ? ' · Ya es CLIENTE activo (contrato y pago confirmados; su expediente de documentos ya está completo, no le pidas factura, RUT ni cédula salvo que el equipo lo indique)' : ''}
${pasos.join('\n')}
Usa este estado para explicarle en qué va su trámite. Si el cliente dice que la plataforma de la UPME le muestra algo distinto o tiene dudas sobre lo que ve allí, explícale con calma la etapa en la que va según este estado y, si hace falta, pregunta al equipo.`;
  } catch (e) { console.error('chattigo estadoReal:', e.message); return null; }
}

// PDF con clave (casi siempre la cédula del cliente): se abre en el servidor y se le pasa a la IA el TEXTO.
let pdfjs = null;
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } catch (_) { pdfjs = null; }
const tieneClave = (buf) => buf.includes('/Encrypt');
async function abrirConClave(buf, claves) {
  if (!pdfjs) return { ok: false, motivo: 'falta la librería pdfjs-dist en el servidor' };
  for (const password of claves) {
    try {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), password, isEvalSupported: false, verbosity: 0 }).promise;
      let texto = '';
      for (let i = 1; i <= Math.min(doc.numPages, 6); i++) { const c = await (await doc.getPage(i)).getTextContent(); texto += c.items.map((x) => x.str).join(' ') + '\n'; }
      return { ok: true, texto: texto.replace(/[ \t]+/g, ' ').trim().slice(0, 12000) };
    } catch (e) { if (!/password/i.test(String(e && (e.name + e.message)))) return { ok: false, motivo: 'no se pudo leer el PDF' }; }
  }
  return { ok: false, motivo: 'la clave no es la cédula conocida' };
}
async function cedulaDelPanel(sb, tel) {
  if (!tel || tel.length !== 10) return [];
  try { const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('numero_identificacion').eq('telefono', tel).limit(5); return (data || []).map((r) => digitos(r.numero_identificacion)).filter(Boolean); } catch (_) { return []; }
}

function fichaVisible(p) { const o = {}; for (const [k, v] of Object.entries(p || {})) if (!k.startsWith('_')) o[k] = v; return o; }

function transcripcion(mensajes) {
  return (mensajes || []).slice(-80).map((m) => {
    const quien = m.rol === 'cliente' ? 'CLIENTE' : m.rol === 'agente' ? 'AGENTE' : 'SISTEMA';
    return `${quien}${m.hora ? ' (' + m.hora + ')' : ''}: ${String(m.texto || '').trim() || (m.archivo ? '[envió un archivo: ' + m.archivo + ']' : '')}`;
  }).join('\n');
}

async function siguienteCierre(sb) {
  const lista = CIERRE();
  try {
    const { data } = await sb.from('wasapi_conversaciones').select('perfil').eq('wa_id', '__chattigo_turno__').maybeSingle();
    const n = Number(((data || {}).perfil || {}).n) || 0;
    await sb.from('wasapi_conversaciones').upsert({ wa_id: '__chattigo_turno__', perfil: { n: n + 1 }, estado: 'sistema', actualizado_en: new Date().toISOString() }, { onConflict: 'wa_id' });
    return lista[n % lista.length];
  } catch (_) { return lista[0]; }
}

module.exports = function montarChattigo(app, { sbServicio }) {
  const tokenOk = (req) => !process.env.CHATTIGO_TOKEN || req.get('x-copiloto-token') === process.env.CHATTIGO_TOKEN;
  app.get('/api/chattigo/salud', (req, res) => res.json({ ok: true, guia: GUIA.length, cierre: CIERRE(), teams: !!process.env.TEAMS_WEBHOOK_URL, autonomo: autoActivo() }));
  // Interruptor general del modo autónomo: en Render, CHATTIGO_AUTONOMO=0 lo apaga en todos los PC.
  app.get('/api/chattigo/config', (req, res) => res.json({ autonomo: autoActivo(), teams: !!process.env.TEAMS_WEBHOOK_URL }));
  // Avisos de la extensión (sesión cerrada, transferencia fallida, límites) al grupo de Teams.
  app.post('/api/chattigo/aviso', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const { tipo, texto, nombre, telefono, ensayo } = req.body || {};
    if (ensayo) return res.json({ ok: true, ensayo: true });
    const titulos = { sesion: '⚠️ Daniela (Chattigo): sesión cerrada', transferencia_fallida: '➡️ Daniela (Chattigo): transferir a mano', limite: '⏸️ Daniela (Chattigo): chat pausado' };
    const ok = await avisarTeams({ titulo: titulos[tipo] || '🔔 Daniela (Chattigo)', texto: String(texto || '').slice(0, 1500), nombre, telefono });
    res.json({ ok });
  });

  app.post('/api/chattigo/sugerir', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const { telefono, nombre, mensajes, archivos, asesor, pedido, modo, ensayo } = req.body || {};
    const autonomo = modo === 'autonomo';
    if (autonomo && !autoActivo()) return res.status(423).json({ error: 'Modo autónomo apagado en el servidor.' });
    if (!Array.isArray(mensajes) || !mensajes.length) return res.status(400).json({ error: 'No llegó la conversación.' });
    // Nuestras propias líneas de Chattigo nunca son el celular de un cliente.
    const PROPIOS = String(process.env.CHATTIGO_DIDS || '3152757888').split(',').map((x) => digitos(x).slice(-10));
    let tel = digitos(telefono).slice(-10);
    if (PROPIOS.includes(tel)) tel = '';
    const clave = 'chattigo-' + (tel.length === 10 ? '57' + tel : 'n-' + crypto.createHash('sha1').update(String(nombre || '')).digest('hex').slice(0, 12));
    const sb = sbServicio();
    try {
      const { data: fila } = await sb.from('wasapi_conversaciones').select('*').eq('wa_id', clave).maybeSingle();
      const perfil = Object.assign({ origen: 'SURA' }, (fila && fila.perfil) || {});
      if (nombre && !/^\+?\d[\d\s]+$/.test(nombre) && !perfil.nombre) perfil.nombre = String(nombre).trim();
      const leidos = new Set(perfil._leidos || []);
      perfil._tipos = perfil._tipos || {};

      // Archivos: se decodifican; solo los NUEVOS van a la IA (los demás ya se leyeron antes).
      const todos = (Array.isArray(archivos) ? archivos : []).slice(-8).map((a) => {
        const buf = Buffer.from(String(a.base64 || ''), 'base64');
        const hash = a.hash || crypto.createHash('sha1').update(buf).digest('hex');
        return { buf, hash, nombre: a.nombre || 'archivo', mime: String(a.mime || '').toLowerCase() };
      }).filter((a) => a.buf.length > 0 && a.buf.length < 20 * 1024 * 1024);
      const nuevos = todos.filter((a) => !leidos.has(a.hash) && MIMES.includes(a.mime)).slice(0, 4);
      // Claves posibles para PDF protegidos: cédula de la ficha, del caso en el panel y números que escribió el cliente.
      const claves = Array.from(new Set([digitos(perfil.cedula), ...(await cedulaDelPanel(sb, tel)),
        ...mensajes.filter((m) => m.rol === 'cliente').flatMap((m) => String(m.texto || '').replace(/[.\s]/g, '').match(/\d{6,11}/g) || []),
        '1', ''].filter((x) => x !== undefined && x !== null && (x === '' || String(x).length))));
      const bloques = [], sinAbrir = new Set();
      for (let i = 0; i < nuevos.length; i++) {
        const a = nuevos[i];
        if (a.mime === 'application/pdf' && tieneClave(a.buf)) {
          const r = await abrirConClave(a.buf, claves);
          if (r.ok && r.texto.length > 40) bloques.push({ type: 'text', text: `ARCHIVO NUEVO ${i + 1} (lo envió el CLIENTE): ${a.nombre} — PDF con clave, abierto con la cédula. TEXTO DEL DOCUMENTO:\n${r.texto}` });
          else { sinAbrir.add(a.hash); bloques.push({ type: 'text', text: `ARCHIVO NUEVO ${i + 1} (lo envió el CLIENTE): ${a.nombre} — PDF protegido con clave que no se pudo abrir (${r.ok ? 'es una imagen escaneada' : r.motivo}). Clasifícalo por su nombre y la conversación; no le pidas otra vez el documento al cliente: el equipo lo abre con la cédula.` }); }
          continue;
        }
        bloques.push({ type: 'text', text: `ARCHIVO NUEVO ${i + 1} (lo envió el CLIENTE): ${a.nombre}` });
        bloques.push(a.mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.buf.toString('base64') } }
          : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.buf.toString('base64') } });
      }

      const real = await estadoReal(sb, tel);
      const t = tarifaUpme(perfil.valor_sin_iva);
      const sistema = GUIA + '\n' + SALIDA + (autonomo ? '\n' + SALIDA_AUTO : '') +
        '\n\nFICHA ACTUAL DEL CLIENTE (JSON): ' + JSON.stringify(fichaVisible(perfil)) +
        (real ? '\n\n' + real : '') +
        (t ? '\nTARIFA UPME DE ESTE CLIENTE (calculadora oficial UPME): ' + t.texto + '. Úsala tal cual si hablas de la tarifa de la UPME.' : '');
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
      const texto = 'HOY ES ' + hoy + ' (hora de Colombia).\nCONVERSACIÓN EN CHATTIGO (la más reciente al final; las horas vienen como AAAA-MM-DD HH:MM):\n' + transcripcion(mensajes) +
        (pedido ? '\n\nINDICACIÓN DEL AGENTE PARA ESTA RESPUESTA: ' + String(pedido).slice(0, 500) : '') +
        (autonomo ? '\n\nRedacta el siguiente mensaje de Daniela (se enviará tal cual) y responde con el JSON.' : '\n\nRedacta el siguiente mensaje del agente y responde con el JSON.');
      let bruto;
      try { bruto = await llamarClaude(sistema, [{ role: 'user', content: [...bloques, { type: 'text', text: texto }] }]); }
      catch (e) {
        // Si un archivo daña la consulta (PDF raro, imagen dañada), se responde igual sin los archivos.
        if (!bloques.some((b) => b.type !== 'text')) throw e;
        console.error('chattigo: archivo rechazado por la IA, se reintenta sin archivos:', e.message);
        nuevos.forEach((a) => sinAbrir.add(a.hash));
        const soloTexto = bloques.filter((b) => b.type === 'text').map((b) => ({ type: 'text', text: b.text + (/TEXTO DEL DOCUMENTO/.test(b.text) ? '' : ' (no se pudo leer este archivo)') }));
        bruto = await llamarClaude(sistema, [{ role: 'user', content: [...soloTexto, { type: 'text', text: texto }] }]);
      }
      const j = parsearJSON(bruto) || {};

      // Ficha: se conserva lo anterior y se suma lo nuevo.
      if (j.perfil) for (const [k, v] of Object.entries(j.perfil)) if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) perfil[k] = v;
      const tipos = Array.isArray(j.archivos_tipos) ? j.archivos_tipos : [];
      nuevos.forEach((a, i) => { perfil._tipos[a.hash] = String(tipos[i] || 'otro').toLowerCase(); if (!sinAbrir.has(a.hash)) leidos.add(a.hash); });
      perfil._leidos = Array.from(leidos).slice(-60);
      if (j.datos_archivos) perfil.notas = String((perfil.notas ? perfil.notas + ' | ' : '') + j.datos_archivos).slice(-1500);
      if (Array.isArray(j.alertas) && j.alertas.length) perfil.alertas = Array.from(new Set([...(perfil.alertas || []), ...j.alertas.map(String)]));

      let accion = ['responder', 'preguntar_grupo', 'transferir_cierre', 'no_atender'].includes(j.accion) ? j.accion : 'responder';
      let transferirA = null;
      if (accion === 'transferir_cierre') transferirA = perfil._cierre_asignado || (perfil._cierre_asignado = await siguienteCierre(sb));

      // Igual que WhatsApp: caso, documentos con su tipo y contrato automático (solo si se conoce el celular).
      if (tel.length === 10) {
        const conTipo = todos.map((a) => ({ ...a, tipo: perfil._tipos[a.hash] })).filter((a) => a.tipo);
        await sincronizarTodo({ perfil, waId: '57' + tel, archivos: conTipo, sb, bajarArchivo: null,
          opciones: { sinContrato: !!ensayo, canal: 'Chattigo', asesor: 'Daniela (Chattigo' + (asesor ? ' · ' + String(asesor).slice(0, 40) : '') + ')', prefijo: 'ct', origen: 'chattigo' } });
      }
      await sb.from('wasapi_conversaciones').upsert({ wa_id: clave, perfil, estado: 'copiloto', from_id: null, actualizado_en: new Date().toISOString(),
        mensajes: (mensajes || []).slice(-60).map((m) => ({ rol: m.rol === 'cliente' ? 'cliente' : 'agente', texto: String(m.texto || '').slice(0, 2000), hora: m.hora || null })) }, { onConflict: 'wa_id' });

      // Modo autónomo: el equipo se entera por Teams (preguntas, cierres y chats que no son del beneficio).
      if (autonomo && !ensayo) {
        const base = { nombre: perfil.nombre_completo || perfil.nombre || nombre, telefono: tel.length === 10 ? '57' + tel : telefono };
        if (accion === 'preguntar_grupo') await avisarTeams({ ...base, titulo: '❓ Daniela (Chattigo) necesita al equipo', texto: (j.nota_equipo || 'Revisar el chat.') + '\nCuando tengan la respuesta, escríbanla en el chat de Chattigo; Daniela retoma después.' });
        else if (accion === 'no_atender') await avisarTeams({ ...base, titulo: '⛔ Chat que no es del beneficio tributario', texto: 'Daniela no lo atiende. Revísenlo y gestiónenlo a mano en Chattigo.' });
      }

      if (accion === 'transferir_cierre' && !ensayo && !perfil._aviso_cierre) {
        const ok = await avisarTeams({ nombre: perfil.nombre_completo || perfil.nombre || nombre, telefono: tel.length === 10 ? '57' + tel : telefono,
          titulo: '✅ Expediente completo → transferir a ' + transferirA,
          texto: (j.resumen_cierre || [perfil.marca_modelo && 'Vehículo: ' + perfil.marca_modelo, perfil.cedula && 'Cédula/NIT: ' + perfil.cedula].filter(Boolean).join(' · ')) +
            (Array.isArray(j.alertas) && j.alertas.length ? '\nAlertas: ' + j.alertas.join(', ') : '') + (autonomo ? '' : '\n(Transferencia hecha por el agente desde Chattigo.)') });
        if (ok) { perfil._aviso_cierre = new Date().toISOString(); await sb.from('wasapi_conversaciones').update({ perfil }).eq('wa_id', clave); }
      }

      let caso = null;
      if (perfil._caso_id) {
        const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('id,nombre_cliente,estado_pipeline').eq('id', perfil._caso_id).maybeSingle();
        caso = data || null;
      }
      res.json({
        respuesta: limpiarTexto(String(j.respuesta || '')),
        accion, transferir_a: transferirA, nota_equipo: j.nota_equipo || null, resumen_cierre: j.resumen_cierre || null, aviso_cierre: !!perfil._aviso_cierre,
        alertas: perfil.alertas || [], faltan: Array.isArray(j.faltan) ? j.faltan : [],
        caso, documentos: perfil._docs || [], contrato_pedido: !!perfil._contrato_pedido,
        sin_telefono: tel.length !== 10, archivos_leidos: nuevos.length,
      });
    } catch (e) {
      console.error('chattigo/sugerir:', e);
      res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
  });
};
