// Copiloto de Daniela dentro de Chattigo (cola "Beneficio tributario Autos Sura").
// Chattigo no tiene API para nosotros: la extensión de Chrome lee el chat abierto en la pantalla del agente y lo manda
// aquí. Daniela devuelve el SIGUIENTE mensaje sugerido (el agente lo revisa y lo envía él mismo) y, por detrás, crea o
// actualiza el caso, sube los documentos con su tipo y pide el contrato, igual que en WhatsApp.
// La guía de atención está en prompt_chattigo.md (base de conocimiento de Chattigo).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express_urlencoded = require('express').urlencoded({ extended: false, limit: '50kb' });
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
- EXPERIENCIA DEL CLIENTE: responde exactamente lo que el cliente preguntó, primero la respuesta y luego el siguiente paso. Usa cifras concretas cuando las tengas (honorarios de la guía, tarifa UPME de la calculadora oficial, etapa del trámite). Nunca dejes una pregunta del cliente sin responder ni la cambies por otra pregunta. Si prometes confirmar algo, escala de inmediato con "preguntar_grupo".
- Mensajes cortos, una sola pregunta, de usted, sin listas ni negritas, sin marcadores tipo [nombre].
- QUIÉN ENVIÓ QUÉ: en la conversación, CLIENTE es el cliente y AGENTE somos nosotros (Gómez Legal / Daniela). Las imágenes o archivos que envía el AGENTE (capturas de la UPME, instrucciones, ejemplos) son material de apoyo NUESTRO: nunca digas que el cliente los compartió y nunca tomes de ellos nombres, cédulas, celulares ni datos del cliente. Solo los "ARCHIVO NUEVO" son documentos enviados por el cliente.
- BIENVENIDA OFICIAL: el primer mensaje al cliente es SIEMPRE la bienvenida oficial de Gómez Legal ("¡Hola! Soy Daniela Gómez de Gómez Legal Abogados en alianza con SURA…" + la lista de documentos), que el sistema envía automáticamente. NUNCA uses otro saludo de presentación ni el saludo de ejemplo de la guía. Si el chat todavía no tiene ningún mensaje nuestro, no la redactes tú: deja "respuesta" vacía y el sistema la envía.
- BENEFICIO (dilo siempre así): la DIAN le devuelve el 100 % del IVA que pagó al comprar el vehículo, que equivale al 5 % del valor del vehículo (los eléctricos e híbridos pagan IVA del 5 %). Si conoces el valor sin IVA, puedes dar la cifra: devolución estimada = 5 % del valor sin IVA. Además, si declara renta, puede deducir hasta el 50 % del valor del vehículo, repartido hasta en 15 años. NUNCA digas "la devolución del 5 % del IVA": es incorrecto y confunde al cliente.
- SALUDO: si en la conversación de HOY el AGENTE ya saludó o se presentó, NO vuelvas a saludar ni a presentarte ("Buenos días", "Soy Daniela de…"): ve directo al punto, llamando al cliente por su nombre.
- TONO: atiende el caso y da tranquilidad. Reconoce lo que el cliente dijo o envió, dile que lo estamos revisando, que su trámite sigue en curso y que lo acompañamos en todo el proceso. Nada de textos largos ni de repetir lo que ya se le explicó.
- No menciones por iniciativa propia que eres asistente virtual, bot o inteligencia artificial: firma y habla como Daniela, del equipo de Gómez Legal Abogados.
- Si el cliente pregunta directamente si habla con una persona o con un bot: NO afirmes ser una persona y no lo niegues. Responde SOLO: "Permítanos un momento, por favor, estamos revisando su caso." (puedes anteponer el nombre del cliente) y pon accion = "preguntar_grupo" con nota_equipo: "El cliente preguntó si habla con un bot. Que la operación tome este chat." Así la operación sigue la conversación.
- Lo que el AGENTE ya le envió (instrucciones, usuario y clave de la UPME, pasos de pago) es nuestro: si el cliente dice que no le sale lo que le indicamos, no le repitas las instrucciones; tranquilízalo y pregunta al equipo con el detalle de lo que el cliente ve.
- En "nota_equipo" escribe directo la pregunta (sin saludos ni firmas ni marcadores como [nombre bot]); incluye nombre y celular del cliente solo si salen de la conversación del CLIENTE o de la ficha.
- Si el chat no es del beneficio tributario (cita médica, técnico-mecánica, arrendamiento), accion = "no_atender".
- Si algo requiere aprobación del equipo o no está en la guía, accion = "preguntar_grupo", escribe en "nota_equipo" la pregunta para el grupo de Teams "GLA Novedades atención" y en "respuesta" un mensaje que no afirme nada sobre ese punto.
- PAGO SIN ESPERAS: en cuanto los documentos estén en orden y el cliente quiera avanzar, en ESE MISMO mensaje pide la certificación bancaria (vigencia inferior a 30 días, cuenta a su nombre, no bancos digitales como Nu o Lulo) Y compártele de una vez los datos de pago de los honorarios, tal cual la sección 6 de la guía: cuenta de ahorros Bancolombia 43600005898, a nombre de GOMEZ LEGAL ABOGADOS, NIT 901964467-0, o la llave @gomezlegalabogad. Recuérdale el valor de los honorarios que ya se le informó y pídele que envíe el soporte de pago por este mismo chat para iniciar de inmediato ante la UPME. Nunca digas "cuando nos envíe X le enviaremos los datos de pago". Si ya se le dieron (medios_pago_informados = true), no los repitas completos: recuérdale amablemente el pago y el soporte. Marca "medios_pago_informados": true en el perfil cuando los compartas.
- Si factura, RUT vigente y cédula están completos y cuadran, NO preguntes al grupo si puedes proceder: procede (datos de pago + certificación bancaria + transferir_cierre). Con accion "preguntar_grupo", "respuesta" NUNCA va vacía: siempre un mensaje breve de acompañamiento para el cliente.
- Revisa TODO el historial (también lo que se habló antes de transferencias) y todo lo leído en los documentos (ficha y notas) antes de decidir: no vuelvas a pedir algo que el cliente ya envió.
- Si el expediente está completo y en orden según la guía (factura, RUT vigente y cédula completos, sin nada que no cuadre), accion = "transferir_cierre" y llena "resumen_cierre". "respuesta" vacía, salvo que el cliente haya hecho una pregunta pendiente: en ese caso respóndela en una frase y dile que un asesor del equipo continúa con su proceso. No uses "preguntar_grupo" solo para que alguien revise documentos que tú ya puedes leer.
- Si el cliente pide hablar con alguien: "respuesta" = "Un asesor del equipo se comunicará con usted." y accion = "preguntar_grupo" con la nota para el grupo.
- Si un archivo no se puede leer, usa la respuesta fija de la guía y accion = "preguntar_grupo".

RESPONDE SOLO con un JSON válido (sin texto alrededor):
{"respuesta":"mensaje sugerido para el cliente o vacío","accion":"responder|preguntar_grupo|transferir_cierre|no_atender","nota_equipo":"texto para el grupo de Teams o null","alertas":["empresa","dos_propietarios","rut_vencido","iva_19","leasing","otro..."],"faltan":["lo que falta del expediente"],"archivos_tipos":[],"datos_archivos":"resumen breve de lo leído en los archivos nuevos o null","encargo_cumplido":"solo si hay TAREA ENCARGADA de tipo seguimiento: true si lo que se buscaba ya se cumplió (el cliente respondió, envió lo pedido o pagó), si no false","resumen_cierre":"solo si accion = transferir_cierre: resumen consolidado para la asesora de cierre (nombre completo, cédula/NIT, vehículo, fecha de factura, valor sin IVA, IVA, titular de la factura, RUT vigente sí/no, documentos recibidos, servicio que quiere, alertas) o null","perfil":{"nombre":null,"nombre_completo":null,"cedula":null,"correo":null,"marca_modelo":null,"tipo_vehiculo":null,"fecha_compra":null,"titular_factura":null,"tiene_certificado_upme":null,"ciudad":null,"valor_sin_iva":null,"interesado":null,"precio_informado":null,"acepta_avanzar":null,"medios_pago_informados":null,"documentos_recibidos":[],"pago_honorarios_recibido":null,"dos_propietarios":null,"notas":null}}
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
async function avisarTeams({ titulo, texto, nombre, telefono, boton, grupo }) {
  // grupo 'recepcion' → GLA_GTR_Notificación_Casos_Nuevos (TEAMS_WEBHOOK_RECEPCION); el resto → GLA Novedades atención.
  const url = (grupo === 'recepcion' && process.env.TEAMS_WEBHOOK_RECEPCION) || process.env.TEAMS_WEBHOOK_URL;
  if (!url) return false;
  const lineas = [nombre && ('Cliente: ' + nombre), telefono && ('Celular: +' + digitos(telefono)), texto].filter(Boolean);
  const tarjeta = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
    body: [{ type: 'TextBlock', text: titulo, weight: 'Bolder', size: 'Medium', wrap: true },
      ...lineas.map((l) => ({ type: 'TextBlock', text: String(l).slice(0, 1500), wrap: true }))],
    ...(boton ? { actions: [{ type: 'Action.OpenUrl', title: boton.titulo, url: boton.url }] } : {}) };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: tarjeta }] }) });
    if (!r.ok) console.error('Teams webhook:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('Teams webhook:', e.message); return false; }
}
// ---------- Preguntas al equipo con respuesta (botón "Responder a Daniela" en la tarjeta de Teams)
const SECRETO_P = () => process.env.PORTAL_SECRETO || process.env.FIRMA_SECRETO || crypto.createHash('sha256').update(String(process.env.SUPABASE_SERVICE_ROLE_KEY || 'gla')).digest('hex');
const firmaP = (id) => crypto.createHmac('sha256', SECRETO_P()).update('pregunta:' + id).digest('base64url').slice(0, 32);
const URL_SERVIDOR = () => String(process.env.SERVIDOR_URL || 'https://daniela-servidor.onrender.com').replace(/\/$/, '');
const escH = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function instruccionesPendientes(sb, clave) {
  try {
    const { data } = await sb.from('chattigo_preguntas').select('id,pregunta,respuesta,respondido_por').eq('clave', clave).not('respondido_en', 'is', null).is('aplicado_en', null).order('respondido_en', { ascending: true }).limit(5);
    return data || [];
  } catch (_) { return []; }
}
async function aprendizajes(sb) {
  try {
    const { data } = await sb.from('chattigo_preguntas').select('pregunta,respuesta').not('respondido_en', 'is', null).order('respondido_en', { ascending: false }).limit(25);
    return (data || []).filter((r) => r.respuesta);
  } catch (_) { return []; }
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

const BIENVENIDA_OFICIAL = `¡Hola! Soy Daniela Gómez de Gómez Legal Abogados en alianza con SURA. Gracias por escribirnos.

¿En qué consiste el beneficio?
La Ley 1715 de 2014 da incentivos tributarios a quienes compran vehículos eléctricos o híbridos, porque usan la energía de forma más eficiente. Si su vehículo cumple los requisitos, puede acceder a:

✅ Devolución del 100% del IVA que pagó al comprar el vehículo.
✅ Si declara renta, puede deducir hasta el 50 % del valor del vehículo, repartido hasta en 15 años.

¿Cómo funciona el trámite?
1️⃣ Revisamos sus documentos y le confirmamos si su vehículo aplica.
2️⃣ Pedimos ante la UPME el certificado que reconoce el beneficio.
3️⃣ Con ese certificado, radicamos la solicitud de devolución ante la DIAN.
4️⃣ La DIAN estudia la solicitud y, si la aprueba, consigna el valor en su cuenta bancaria.

Nosotros hacemos todo el trámite y le contamos cómo va en cada etapa. Los tiempos dependen de cada entidad.

Para empezar, por favor envíenos por este medio (foto clara o PDF):

📄 Cédula del propietario, por ambos lados.
📄 RUT actualizado.
📄 Factura electrónica de compra del vehículo.
📄 Certificación bancaria de una cuenta a nombre del propietario, con fecha de expedición no mayor a 30 días.

Y cuéntenos:
🚗 Marca, modelo y fecha de compra.
👥 Si el vehículo está a nombre de más de una persona, o si tiene más de un vehículo eléctrico o híbrido.

Al enviarnos sus documentos, nos autoriza a tratar sus datos personales solo para gestionar este trámite, conforme a la Ley 1581 de 2012 y a nuestra política de tratamiento de datos, que podrá consultar en www.gomezlegalabogados.co`;

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
    const titulos = { recepcion_fallida: '⚠️ Recepción: no se pudo transferir un caso', status_recepcion: '📊 Recepción Chattigo: transferencias de la última hora', sin_respuesta: '📵 Cliente sin respuesta tras 2 seguimientos', recordatorio: '⏰ Daniela sigue esperando respuesta del equipo', transferido: '➡️ Daniela transfirió un caso', sesion: '⚠️ Daniela (Chattigo): sesión cerrada', transferencia_fallida: '➡️ Daniela (Chattigo): transferir a mano', limite: '⏸️ Daniela (Chattigo): chat pausado' };
    const ok = await avisarTeams({ titulo: titulos[tipo] || '🔔 Daniela (Chattigo)', texto: String(texto || '').slice(0, 1500), nombre, telefono,
      grupo: /^(status_recepcion|recepcion_)/.test(String(tipo)) ? 'recepcion' : null });
    res.json({ ok });
  });

  // Página para responder la pregunta de Daniela (se abre desde el botón de la tarjeta de Teams).
  const paginaP = (cuerpo) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Responder a Daniela</title>
<style>body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f6f4ee;color:#1c2430}.c{max-width:640px;margin:24px auto;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(11,31,58,.15);overflow:hidden}
.h{background:linear-gradient(135deg,#0b1f3a,#1c3a63);color:#e9dfbf;padding:16px 20px;font-weight:700}.b{padding:18px 20px}.q{background:#fff7e0;border-left:4px solid #d9a400;border-radius:6px;padding:10px 12px;white-space:pre-wrap;margin:8px 0 14px}
textarea,input{width:100%;box-sizing:border-box;border:1px solid #cfc6ad;border-radius:8px;padding:10px;font-size:15px;font-family:inherit}textarea{min-height:130px}label{font-weight:600;display:block;margin:10px 0 4px}
button{margin-top:14px;background:#1f5c4d;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-weight:700;font-size:15px;cursor:pointer}.ok{background:#e3f4ea;color:#17663b;padding:12px;border-radius:8px}.m{color:#6a7b76;font-size:13px}</style></head><body><div class="c"><div class="h">DANIELA · PREGUNTA PARA EL EQUIPO</div><div class="b">${cuerpo}</div></div></body></html>`;
  app.get('/api/chattigo/responder/:id', async (req, res) => {
    const id = String(req.params.id);
    if (req.query.t !== firmaP(id)) return res.status(403).send(paginaP('Enlace no válido.'));
    const { data: p } = await sbServicio().from('chattigo_preguntas').select('*').eq('id', id).maybeSingle();
    if (!p) return res.status(404).send(paginaP('No encontré esta pregunta.'));
    res.send(paginaP(`<div><b>${escH(p.nombre || '')}</b> ${p.telefono ? '· +' + escH(p.telefono) : ''}</div><div class="q">${escH(p.pregunta)}</div>
${p.respondido_en ? `<div class="ok">Ya respondida por ${escH(p.respondido_por || 'el equipo')}: <br>${escH(p.respuesta)}</div><p class="m">Si quiere corregirla, escriba la nueva indicación y guárdela.</p>` : ''}
<form method="post"><label>¿Qué debe hacer o responder Daniela?</label><textarea name="respuesta" required placeholder="Ej.: Dile que el pago ya está registrado y que la UPME está estudiando su solicitud; no tiene que hacer nada en la plataforma.">${escH(p.respondido_en ? '' : '')}</textarea>
<label>Su nombre</label><input name="por" required placeholder="Ej.: Daniela Vera"><button>Enviar a Daniela</button>
<p class="m">Daniela le escribe al cliente aplicando esta indicación en la próxima revisión del chat, y la usa como guía para casos parecidos.</p></form>`));
  });
  app.post('/api/chattigo/responder/:id', express_urlencoded, async (req, res) => {
    const id = String(req.params.id);
    if (req.query.t !== firmaP(id)) return res.status(403).send(paginaP('Enlace no válido.'));
    const respuesta = String((req.body || {}).respuesta || '').trim().slice(0, 2000);
    const por = String((req.body || {}).por || '').trim().slice(0, 80);
    if (!respuesta) return res.status(400).send(paginaP('Escriba la respuesta.'));
    await sbServicio().from('chattigo_preguntas').update({ respuesta, respondido_por: por || null, respondido_en: new Date().toISOString(), aplicado_en: null }).eq('id', id);
    res.send(paginaP('<div class="ok">✅ ¡Gracias! Daniela aplicará esta indicación con el cliente en la próxima revisión del chat.</div>'));
  });
  // ---------- Encargos: el equipo le pide a Daniela que haga algo con un cliente (enlace fijo anclado en Teams)
  const firmaE = () => crypto.createHmac('sha256', SECRETO_P()).update('encargos').digest('base64url').slice(0, 24);
  // Publica en Teams la tarjeta con el botón "Encargar a Daniela" (se ancla en el grupo). Lo dispara el panel 🤖 de la extensión.
  app.post('/api/chattigo/encargos/anclar', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const ok = await avisarTeams({ titulo: '📌 Encargos para Daniela (Chattigo)', boton: { titulo: '📝 Encargar a Daniela', url: `${URL_SERVIDOR()}/api/chattigo/encargo?t=${firmaE()}` },
      texto: 'Anclen este mensaje. Toquen el botón para pedirle a Daniela que le escriba a un cliente o le haga seguimiento (por ejemplo, recordarle el soporte de pago cada 4 horas). Ella lo hace en su próxima revisión y avisa aquí el resultado.' });
    res.json({ ok });
  });
  const formEncargo = (lista, aviso) => paginaP(`${aviso || ''}<form method="post">
<label>Celular del cliente</label><input name="telefono" required placeholder="Ej.: 3012759428">
<label>¿Qué debe hacer Daniela?</label><textarea name="instruccion" required placeholder="Ej.: Escríbele que su certificado UPME ya salió y que seguimos con la cita en la DIAN.&#10;Ej.: Recuérdale enviar el soporte de pago de los honorarios."></textarea>
<label>¿Cuándo?</label><select name="tipo" style="width:100%;padding:10px;border:1px solid #cfc6ad;border-radius:8px;font-size:15px">
<option value="una_vez">Una sola vez, ahora</option><option value="seguimiento">Seguimiento: repetir hasta que el cliente cumpla</option></select>
<label>Si es seguimiento: cada cuántas horas y durante cuántos días</label>
<div style="display:flex;gap:8px"><input name="cada_horas" type="number" min="2" max="72" value="4"><input name="dias" type="number" min="1" max="10" value="2"></div>
<label>Su nombre</label><input name="por" required placeholder="Ej.: Daniela Vera"><button onclick="setTimeout(()=>{this.disabled=true;this.textContent='Enviando…'},0)">Encargar a Daniela</button>
<p class="m">Daniela lo hace en la próxima revisión (horario de atención). El chat debe estar en la bandeja de Daniela en Chattigo; si no, ella avisa en Teams para que se lo transfieran. Solo puede escribir si el cliente escribió en las últimas 24 h (regla de WhatsApp).</p></form>
<h3 style="margin-top:22px">Últimos encargos</h3>${(lista || []).map((e) => `<div class="m" style="border-bottom:1px dashed #e1dac5;padding:6px 0"><b>${escH(e.estado)}</b> · +${escH(e.telefono)} · ${escH(String(e.instruccion).slice(0, 90))} · ${escH(e.creado_por || '')}${e.resultado ? '<br>→ ' + escH(String(e.resultado).slice(0, 160)) : ''}</div>`).join('') || '<p class="m">Aún no hay encargos.</p>'}`);
  const ultimosEnc = async () => { const { data } = await sbServicio().from('chattigo_encargos').select('*').order('creado_en', { ascending: false }).limit(15); return data || []; };
  app.get('/api/chattigo/encargo', async (req, res) => {
    if (req.query.t !== firmaE()) return res.status(403).send(paginaP('Enlace no válido.'));
    res.send(formEncargo(await ultimosEnc()));
  });
  app.post('/api/chattigo/encargo', express_urlencoded, async (req, res) => {
    if (req.query.t !== firmaE()) return res.status(403).send(paginaP('Enlace no válido.'));
    const b = req.body || {};
    const tel = digitos(b.telefono).slice(-10);
    const instruccion = String(b.instruccion || '').trim().slice(0, 1500);
    if (tel.length !== 10 || !instruccion) return res.status(400).send(formEncargo(await ultimosEnc(), '<div class="q">Revise el celular (10 dígitos) y la instrucción.</div>'));
    const seg = b.tipo === 'seguimiento';
    const cada = Math.min(72, Math.max(2, Number(b.cada_horas) || 4));
    const dias = Math.min(10, Math.max(1, Number(b.dias) || 2));
    const sb = sbServicio();
    // Doble clic / reenvío del formulario: si ya hay un encargo pendiente igual para ese celular, no se crea otro.
    const { data: igual } = await sb.from('chattigo_encargos').select('id').eq('telefono', '57' + tel).eq('estado', 'pendiente').eq('instruccion', instruccion).limit(1);
    if (igual && igual.length) return res.send(formEncargo(await ultimosEnc(), '<div class="ok">Ese encargo ya estaba registrado: Daniela lo hace en la próxima revisión.</div>'));
    const { data: conv } = await sb.from('wasapi_conversaciones').select('perfil').eq('wa_id', 'chattigo-57' + tel).maybeSingle();
    const nombre = conv && conv.perfil ? (conv.perfil.nombre_completo || conv.perfil.nombre || null) : null;
    await sb.from('chattigo_encargos').insert({ telefono: '57' + tel, nombre, instruccion, tipo: seg ? 'seguimiento' : 'una_vez', cada_horas: seg ? cada : null,
      hasta: seg ? new Date(Date.now() + dias * 864e5).toISOString() : null, creado_por: String(b.por || '').slice(0, 80) || null });
    await avisarTeams({ titulo: '📝 Encargo para Daniela', nombre, telefono: '57' + tel, texto: instruccion + (seg ? `\n(Seguimiento cada ${cada} h durante ${dias} día(s))` : '') + (b.por ? '\nPedido por: ' + b.por : '') });
    res.send(formEncargo(await ultimosEnc(), '<div class="ok">✅ Encargo recibido. Daniela lo hace en la próxima revisión y avisa en Teams.</div>'));
  });
  // La extensión pide los encargos que ya tocan para los chats de su bandeja.
  app.post('/api/chattigo/encargos/pendientes', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const tels = new Set((Array.isArray((req.body || {}).telefonos) ? req.body.telefonos : []).map((t) => '57' + digitos(t).slice(-10)));
    const sb = sbServicio();
    const { data } = await sb.from('chattigo_encargos').select('*').eq('estado', 'pendiente').lte('proximo_en', new Date().toISOString()).order('proximo_en', { ascending: true }).limit(30);
    const listos = [];
    for (const e of data || []) {
      if (e.hasta && new Date(e.hasta) < new Date()) {
        await sb.from('chattigo_encargos').update({ estado: 'hecho', hecho_en: new Date().toISOString(), resultado: (e.resultado || '') + ' · Terminó el plazo del seguimiento.' }).eq('id', e.id);
        await avisarTeams({ titulo: '⌛ Terminó el seguimiento de Daniela', nombre: e.nombre, telefono: e.telefono, texto: e.instruccion + '\nEl cliente no cumplió en el plazo: revísenlo.' });
        continue;
      }
      if (tels.has(e.telefono)) listos.push({ id: e.id, telefono: e.telefono, instruccion: e.instruccion, tipo: e.tipo, veces: e.veces });
      else if (!e.avisado_bandeja && Date.now() - new Date(e.proximo_en).getTime() > 5 * 60e3) {
        await sb.from('chattigo_encargos').update({ avisado_bandeja: true }).eq('id', e.id);
        await avisarTeams({ titulo: '📥 Daniela necesita el chat para el encargo', nombre: e.nombre, telefono: e.telefono, texto: 'No tengo este chat en mi bandeja de Chattigo. Transfiéranmelo y lo hago: ' + e.instruccion });
      }
    }
    res.json({ encargos: listos.slice(0, 5) });
  });
  app.post('/api/chattigo/encargos/:id/resultado', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const { ok, texto, cumplido, reintentar_min } = req.body || {};
    const sb = sbServicio();
    const { data: e } = await sb.from('chattigo_encargos').select('*').eq('id', req.params.id).maybeSingle();
    if (!e) return res.status(404).json({ error: 'No existe.' });
    const veces = (e.veces || 0) + 1;
    let cambios = { veces, resultado: String(texto || '').slice(0, 500) };
    if (reintentar_min) cambios = { proximo_en: new Date(Date.now() + Number(reintentar_min) * 60e3).toISOString(), resultado: cambios.resultado };
    else if (!ok) cambios = { ...cambios, estado: 'fallido', hecho_en: new Date().toISOString() };
    else if (e.tipo === 'seguimiento' && !cumplido) cambios.proximo_en = new Date(Date.now() + (e.cada_horas || 4) * 3600e3).toISOString();
    else cambios = { ...cambios, estado: 'hecho', hecho_en: new Date().toISOString() };
    await sb.from('chattigo_encargos').update(cambios).eq('id', e.id);
    if (!reintentar_min && (cambios.estado || veces === 1)) {
      const t = cambios.estado === 'fallido' ? '⚠️ Daniela no pudo hacer el encargo' : cambios.estado === 'hecho' ? '✅ Encargo cumplido por Daniela' : '🔁 Daniela hizo el primer seguimiento';
      await avisarTeams({ titulo: t, nombre: e.nombre, telefono: e.telefono, texto: e.instruccion + '\n→ ' + (texto || '') + (cambios.proximo_en && !cambios.estado ? '\nPróximo recordatorio: en ' + (e.cada_horas || 4) + ' h.' : '') });
    }
    res.json({ ok: true });
  });

  // La extensión pregunta si un chat pausado ya tiene respuesta del equipo.
  app.post('/api/chattigo/pendientes', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const tel = digitos((req.body || {}).telefono).slice(-10);
    if (tel.length !== 10) return res.json({ respondida: false });
    const lista = await instruccionesPendientes(sbServicio(), 'chattigo-57' + tel);
    res.json({ respondida: lista.length > 0, cuantas: lista.length });
  });

  app.post('/api/chattigo/sugerir', async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const { telefono, nombre, mensajes, archivos, asesor, pedido, modo, ensayo, encargo, pendiente } = req.body || {};
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
      const instrucciones = await instruccionesPendientes(sb, clave);
      const aprend = await aprendizajes(sb);
      if (!perfil.valor_sin_iva && tel.length === 10) { // la tarifa UPME sale del valor sin IVA del caso en el panel
        try { const { data: cv } = await sb.from('Perfilamiento_y_ventas_GLA').select('valor_sin_iva').eq('telefono', tel).not('valor_sin_iva', 'is', null).limit(1); if (cv && cv[0]) perfil.valor_sin_iva = cv[0].valor_sin_iva; } catch (_) {}
      }
      const t = tarifaUpme(perfil.valor_sin_iva);
      const sistema = GUIA + '\n' + SALIDA + (autonomo ? '\n' + SALIDA_AUTO : '') +
        '\n\nFICHA ACTUAL DEL CLIENTE (JSON): ' + JSON.stringify(fichaVisible(perfil)) +
        (real ? '\n\n' + real : '') +
        (aprend.length ? '\n\nRESPUESTAS RECIENTES DEL EQUIPO A PREGUNTAS DE DANIELA (están aprobadas; úsalas como guía si el caso es igual, sin inventar más allá):\n' + aprend.map((a) => '- P: ' + String(a.pregunta).slice(0, 300) + '\n  R: ' + String(a.respuesta).slice(0, 400)).join('\n') : '') +
        (encargo && encargo.instruccion ? '\n\nTAREA ENCARGADA POR EL EQUIPO PARA ESTE CLIENTE (' + (encargo.tipo === 'seguimiento' ? 'SEGUIMIENTO n.º ' + ((Number(encargo.veces) || 0) + 1) + ': si lo que se busca ya se cumplió según la conversación, deja "respuesta" vacía y pon "encargo_cumplido": true; si no, escribe un recordatorio amable y breve, distinto a los anteriores' : 'hazla AHORA') + '; escríbele al cliente con tus palabras, sin decir que alguien te lo pidió; accion "responder" salvo que la tarea diga transferir o preguntar):\n' + String(encargo.instruccion).slice(0, 1500) : '') +
        (pendiente === 'promesa' ? '\n\nSITUACIÓN: el último mensaje NUESTRO le dijo al cliente que íbamos a validar y le confirmábamos, y no se cumplió. El cliente sigue esperando la respuesta a su última pregunta. AHORA: si la guía, la ficha, la tarifa UPME, el estado real o las respuestas recientes del equipo te permiten responder, respóndele YA con la respuesta concreta (cifras exactas y siguiente paso), sin volver a decir que estás validando. Si de verdad no puedes, accion "preguntar_grupo" con la pregunta exacta del cliente en "nota_equipo" y en "respuesta" un mensaje breve y cálido diciendo que ya lo escalamos con el área encargada y le confirmamos hoy mismo.' : '') +
        (pendiente === 'seguimiento' ? '\n\nSITUACIÓN: SEGUIMIENTO COMERCIAL. El cliente no responde hace 4 horas o más a nuestro último mensaje. Escribe UN mensaje de seguimiento con enfoque comercial, no un "¿pudo revisar?" básico: recuérdale el beneficio concreto que está dejando en espera (la devolución del 100 % del IVA que pagó por su vehículo, que equivale al 5 % de su valor, con la cifra estimada si conoces el valor sin IVA, más la deducción en renta), crea un motivo para avanzar hoy (los tiempos de la UPME y la DIAN corren desde que radicamos, cada día de espera retrasa su devolución) y cierra con UNA acción fácil y concreta (enviar el documento que falta, hacer el pago con los datos ya compartidos, firmar el contrato o confirmar que avanzamos). Breve, cálido, sin presionar de forma agresiva y distinto a los mensajes anteriores. Si la conversación ya quedó cerrada, el cliente dijo que no le interesa o no hay nada pendiente de su parte, deja "respuesta" vacía.' : '') +
        (instrucciones.length ? '\n\nINSTRUCCIÓN DEL EQUIPO PARA ESTE CLIENTE (respuesta a tu pregunta; APLÍCALA AHORA en tu mensaje, con tus palabras, sin decir que preguntaste a nadie; accion "responder" salvo que la instrucción diga otra cosa):\n' + instrucciones.map((i) => '- Pregunta: ' + i.pregunta + '\n  Indicación' + (i.respondido_por ? ' de ' + i.respondido_por : '') + ': ' + i.respuesta).join('\n') : '') +
        (t ? '\nTARIFA UPME DE ESTE CLIENTE (calculadora oficial UPME): ' + t.texto + '. Úsala tal cual si hablas de la tarifa de la UPME.' : '');
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
      const texto = 'HOY ES ' + hoy + ' (hora de Colombia).\nCONVERSACIÓN EN CHATTIGO (la más reciente al final; las horas vienen como AAAA-MM-DD HH:MM):\n' + transcripcion(mensajes) +
        (pedido ? '\n\nINDICACIÓN DEL AGENTE PARA ESTA RESPUESTA: ' + String(pedido).slice(0, 500) : '') +
        (autonomo ? '\n\nRedacta el siguiente mensaje de Daniela (se enviará tal cual) y responde con el JSON.' : '\n\nRedacta el siguiente mensaje del agente y responde con el JSON.');
      // Copiloto: si el chat no tiene ningún mensaje nuestro, la sugerencia es la bienvenida oficial (sin IA).
      if (!autonomo && !(mensajes || []).some((m) => m.rol === 'agente' && !/te damos la bienvenida a la linea|te estamos transfiriendo|elige la opcion|agenda aqui/.test(String(m.texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) && !archivos?.length) {
        return res.json({ respuesta: BIENVENIDA_OFICIAL, accion: 'responder', transferir_a: null, nota_equipo: null, alertas: [], faltan: ['factura', 'rut', 'cedula', 'certificacion_bancaria'], caso: null, documentos: [], contrato_pedido: false, sin_telefono: tel.length !== 10, archivos_leidos: 0 });
      }
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
      // Regla fija: expediente completo (factura + RUT + cédula, RUT no vencido) => pasa a cierre y se avisa en Teams.
      const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const docs = new Set([...Object.values(perfil._tipos || {}), ...(perfil._docs || []), ...(Array.isArray(perfil.documentos_recibidos) ? perfil.documentos_recibidos : [])].map(norm));
      const tiene = (k) => [...docs].some((d) => d.includes(k));
      const completo = tiene('factura') && tiene('rut') && (tiene('cedula') || tiene('nit'));
      const alertasAhora = (perfil.alertas || []).map(norm);
      const BLOQUEAN = ['rut_vencido', 'dos_propietarios', 'leasing', 'iva_19', 'empresa'];
      const notaPrevia = accion === 'preguntar_grupo' ? j.nota_equipo : null;
      if (completo && ['responder', 'preguntar_grupo'].includes(accion) && !alertasAhora.some((a) => BLOQUEAN.some((b) => a.includes(b)))) {
        accion = 'transferir_cierre';
        j.nota_equipo = null;
        if (!j.resumen_cierre) j.resumen_cierre = [perfil.nombre_completo || perfil.nombre, perfil.cedula && 'Cédula/NIT: ' + perfil.cedula, perfil.marca_modelo && 'Vehículo: ' + perfil.marca_modelo,
          perfil.fecha_compra && 'Compra: ' + perfil.fecha_compra, perfil.valor_sin_iva && 'Valor sin IVA: ' + perfil.valor_sin_iva, 'Documentos: ' + [...docs].filter((d) => /factura|rut|cedula|bancaria|upme|pago/.test(d)).join(', '),
          perfil._contrato_pedido ? 'Contrato ya enviado a firma' : null].filter(Boolean).join(' · ');
        if (notaPrevia) j.resumen_cierre += '\nNota de Daniela: ' + notaPrevia;
      }
      // Al pasar a cierre, el cliente nunca queda sin mensaje: certificación bancaria + datos de pago (si aún no se dieron).
      if (accion === 'transferir_cierre' && !String(j.respuesta || '').trim() && !perfil.pago_honorarios_recibido) {
        const nom = String(perfil.nombre || '').split(' ')[0];
        const falta = !tiene('bancaria');
        const pago = perfil.medios_pago_informados
          ? 'Le recordamos que, apenas realice el pago de los honorarios, nos comparta el soporte por este chat para iniciar de inmediato ante la UPME.'
          : 'Los honorarios los puede pagar por consignación o transferencia a la cuenta de ahorros Bancolombia 43600005898, a nombre de GOMEZ LEGAL ABOGADOS, NIT 901964467-0, o por la llave @gomezlegalabogad. Apenas nos envíe el soporte de pago por este chat, iniciamos de inmediato las gestiones ante la UPME.';
        j.respuesta = `${nom ? nom + ', r' : 'R'}evisamos sus documentos y todo está en orden. ` + (falta ? 'Para avanzar, por favor compártanos su certificación bancaria con vigencia menor a 30 días, de una cuenta a su nombre. ' : '') + pago + ' Un asesor de nuestro equipo continúa acompañándole en su proceso.';
        perfil.medios_pago_informados = true;
      }
      let transferirA = null;
      // Si el equipo indicó a quién transferir, se respeta; si no, se alterna entre las asesoras de cierre.
      const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const textoInstr = nrm(instrucciones.map((i) => i.respuesta).join(' '));
      if (instrucciones.length && /transfer/.test(textoInstr)) accion = 'transferir_cierre';
      const indicada = CIERRE().find((n) => textoInstr.includes(nrm(n)) || textoInstr.includes(nrm(n.split(' ').slice(0, 3).join(' '))));
      if (accion === 'transferir_cierre') transferirA = indicada || perfil._cierre_asignado || (perfil._cierre_asignado = await siguienteCierre(sb));
      if (indicada) perfil._cierre_asignado = indicada;

      // Igual que WhatsApp: caso, documentos con su tipo y contrato automático (solo si se conoce el celular).
      if (tel.length === 10) {
        const conTipo = todos.map((a) => ({ ...a, tipo: perfil._tipos[a.hash] })).filter((a) => a.tipo);
        await sincronizarTodo({ perfil, waId: '57' + tel, archivos: conTipo, sb, bajarArchivo: null,
          opciones: { sinContrato: !!ensayo, canal: 'Chattigo', asesor: 'Daniela (Chattigo' + (asesor ? ' · ' + String(asesor).slice(0, 40) : '') + ')', prefijo: 'ct', origen: 'chattigo' } });
      }
      await sb.from('wasapi_conversaciones').upsert({ wa_id: clave, perfil, estado: 'copiloto', from_id: null, actualizado_en: new Date().toISOString(),
        mensajes: (mensajes || []).slice(-60).map((m) => ({ rol: m.rol === 'cliente' ? 'cliente' : 'agente', texto: String(m.texto || '').slice(0, 2000), hora: m.hora || null })) }, { onConflict: 'wa_id' });

      if (instrucciones.length && !ensayo && (String(j.respuesta || '').trim() || accion !== 'responder')) {
        await sb.from('chattigo_preguntas').update({ aplicado_en: new Date().toISOString() }).in('id', instrucciones.map((i) => i.id)).then(() => {}, () => {});
      }
      // Modo autónomo: el equipo se entera por Teams (preguntas, cierres y chats que no son del beneficio).
      if (autonomo && !ensayo) {
        const base = { nombre: perfil.nombre_completo || perfil.nombre || nombre, telefono: tel.length === 10 ? '57' + tel : telefono };
        if (false) await avisarTeams({ ...base, titulo: '❓ Daniela (Chattigo) necesita al equipo', texto: (j.nota_equipo || 'Revisar el chat.') + '\nCuando tengan la respuesta, escríbanla en el chat de Chattigo; Daniela retoma después.' });
        else if (accion === 'no_atender') await avisarTeams({ ...base, titulo: '⛔ Chat que no es del beneficio tributario', texto: 'Daniela no lo atiende. Revísenlo y gestiónenlo a mano en Chattigo.' });
      }

      if (accion === 'preguntar_grupo' && !ensayo && j.nota_equipo) {
        const firma = crypto.createHash('sha1').update(String(j.nota_equipo).toLowerCase().replace(/\W+/g, '').slice(0, 200)).digest('hex').slice(0, 12);
        perfil._preguntas = Array.isArray(perfil._preguntas) ? perfil._preguntas : [];
        if (!perfil._preguntas.includes(firma)) {
          let boton = null;
          try {
            const { data: fp } = await sb.from('chattigo_preguntas').insert({ clave, telefono: tel.length === 10 ? '57' + tel : null, nombre: perfil.nombre_completo || perfil.nombre || nombre || null, pregunta: String(j.nota_equipo).slice(0, 2000) }).select('id').single();
            if (fp) boton = { titulo: '✍️ Responder a Daniela', url: `${URL_SERVIDOR()}/api/chattigo/responder/${fp.id}?t=${firmaP(fp.id)}` };
          } catch (e) { console.error('chattigo_preguntas:', e.message); }
          const ok = await avisarTeams({ nombre: perfil.nombre_completo || perfil.nombre || nombre, telefono: tel.length === 10 ? '57' + tel : telefono, boton,
            titulo: '❓ Daniela (Chattigo) necesita al equipo',
            texto: j.nota_equipo + (boton ? '\nToquen "Responder a Daniela" y escriban qué debe hacer: ella se lo aplica al cliente.' : '\nRespondan escribiendo en el chat de Chattigo.') });
          if (ok) { perfil._preguntas = [...perfil._preguntas, firma].slice(-20); await sb.from('wasapi_conversaciones').update({ perfil }).eq('wa_id', clave); }
        }
      }
      if (accion === 'transferir_cierre' && !ensayo && !autonomo && !perfil._aviso_cierre) {
        const ok = await avisarTeams({ nombre: perfil.nombre_completo || perfil.nombre || nombre, telefono: tel.length === 10 ? '57' + tel : telefono,
          titulo: '✅ Expediente completo → transferir a ' + transferirA,
          texto: (j.resumen_cierre || [perfil.marca_modelo && 'Vehículo: ' + perfil.marca_modelo, perfil.cedula && 'Cédula/NIT: ' + perfil.cedula].filter(Boolean).join(' · ')) +
            (Array.isArray(j.alertas) && j.alertas.length ? '\nAlertas: ' + j.alertas.join(', ') : '') + (autonomo ? '' : '\nEl agente la transfiere desde Chattigo.') });
        if (ok) { perfil._aviso_cierre = new Date().toISOString(); await sb.from('wasapi_conversaciones').update({ perfil }).eq('wa_id', clave); }
      }

      let caso = null;
      if (perfil._caso_id) {
        const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('id,nombre_cliente,estado_pipeline').eq('id', perfil._caso_id).maybeSingle();
        caso = data || null;
      }
      res.json({
        respuesta: limpiarTexto(String(j.respuesta || '')),
        accion, transferir_a: transferirA, nota_equipo: j.nota_equipo || null, encargo_cumplido: j.encargo_cumplido === true, resumen_cierre: j.resumen_cierre || null, aviso_cierre: !!perfil._aviso_cierre,
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
