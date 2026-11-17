// Firma electrónica propia de contratos (Gómez Legal).
// Flujo: el asesor pulsa "Enviar a firma" en el panel -> el cliente recibe un correo con un enlace -> abre la página
// de firma, lee el contrato, pide un código de un solo uso, lo escribe y pulsa "Acepto" -> el sistema guarda la
// evidencia (fecha, IP, código validado, huella SHA-256 del PDF), deja el contrato firmado y su constancia en la
// carpeta del cliente en SharePoint y le manda la copia por correo.
//
// Variables en Render (todas opcionales):
//   FIRMA_URL_BASE      página de firma (por defecto https://gomezlegal.netlify.app/firmar.html)
//   FIRMA_VIGENCIA_DIAS días que vale el enlace (por defecto 7)
//   FIRMA_SECRETO       texto cualquiera que se mezcla al guardar el código (más seguridad)
//   FIRMA_AVISO_EQUIPO  correos del equipo que reciben el aviso "cliente X firmó" (separados por coma)
//   INALAMBRIA_API_KEY  llave de Inalambria Express con permiso de ENVÍO (activa el SMS: enlace, código y copia)
//   FIRMA_SMS_PRUEBA    celular que recibe los SMS mientras está el modo prueba (si no hay, en prueba no sale SMS)
// Modo prueba propio: mientras FIRMA_ENVIO_REAL no sea "si", los correos van a FIRMA_CORREO_PRUEBA (o al buzón remitente)
// con el aviso [PRUEBA], y los SMS solo a FIRMA_SMS_PRUEBA. No depende de MAIL_ENVIO_REAL (correo de cita DIAN).

const crypto = require('crypto');
const sp = require('./sharepoint');
const { REMITENTE } = require('./correo_cita');
// Modo real de la FIRMA (independiente del correo de cita DIAN): en Render FIRMA_ENVIO_REAL=si.
// Mientras no esté, correos y SMS de firma van solo a FIRMA_CORREO_PRUEBA / FIRMA_SMS_PRUEBA.
const ES_REAL = () => String(process.env.FIRMA_ENVIO_REAL || '').toLowerCase() === 'si';
const DESTINOS_PRUEBA = () => String(process.env.FIRMA_CORREO_PRUEBA || REMITENTE()).split(',').map((x) => x.trim()).filter(Boolean);

const URL_FIRMA = () => process.env.FIRMA_URL_BASE || 'https://gomezlegal.netlify.app/firmar.html';
const VIGENCIA_DIAS = () => Number(process.env.FIRMA_VIGENCIA_DIAS) > 0 ? Number(process.env.FIRMA_VIGENCIA_DIAS) : 7;
const VIGENCIA_CODIGO_MIN = 10;
const ESPERA_CODIGO_S = 30;
const MAX_ENVIOS_CODIGO = 5;
const MAX_INTENTOS = 5;
const INALAMBRIA_URL = 'https://api.inalambria.express/v1/messages/send';

const TABLA = 'firmas_contrato';
const soloDigitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function mascaraCorreo(c) {
  const [u, d] = String(c || '').split('@');
  if (!d) return '';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}
function mascaraCel(c) {
  const d = String(c || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d.slice(0, 3) + '****' + d.slice(-3) : '';
}
const sinTildes = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
// Celular colombiano en formato internacional (+57 3XXXXXXXXX). Otro formato = sin SMS.
function celularE164(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('57')) d = d.slice(2);
  return /^3\d{9}$/.test(d) ? '+57' + d : null;
}
// A qué número sale el SMS: en real al cliente; en prueba solo a FIRMA_SMS_PRUEBA (si no hay, no sale SMS).
function destinoSms(celReal) {
  if (!process.env.INALAMBRIA_API_KEY) return null;
  return ES_REAL() ? celularE164(celReal) : celularE164(process.env.FIRMA_SMS_PRUEBA);
}
// Envío por Inalambria Express (modo síncrono: responde si salió o no; límite 30 envíos/minuto).
async function enviarSms(numero, texto) {
  // Sin prefijo [PRUEBA]: en modo prueba el SMS ya solo llega al celular de prueba, y el filtro antifraude lo penaliza.
  const contenido = sinTildes(texto);
  const r = await fetch(INALAMBRIA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.INALAMBRIA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: contenido, recipients: [numero], async: false }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const cod = (j.data && j.data.errorCode) || j.code || ('HTTP ' + r.status);
    const det = j.data && j.data.details ? ' Sugerencias: ' + JSON.stringify(j.data.details).slice(0, 400) : '';
    throw new Error(`SMS no enviado (${cod})${j.detail || j.message ? ': ' + (j.detail || j.message) : ''}${det}`);
  }
  return j.consumptionId || j.jobId || null;
}
function mascaraCedula(c) {
  const d = soloDigitos(c);
  return d.length >= 5 ? '*'.repeat(d.length - 3) + d.slice(-3) : '';
}
const fechaCO = (d) => new Date(d).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'medium', timeZone: 'America/Bogota' }) + ' (hora de Colombia)';
function ipDe(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || (req.socket && req.socket.remoteAddress) || '';
}
function hashCodigo(token, codigo) {
  return sha256(Buffer.from(`${token}:${codigo}:${process.env.FIRMA_SECRETO || ''}`));
}
function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- PDF sencillo (sin dependencias)
// Hoja A4, Helvetica. Sirve para la constancia de firma. Texto en WinAnsi (tildes y ñ funcionan).
function limpiarPdf(t) {
  return String(t == null ? '' : t)
    .replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?');
}
const pdfEsc = (t) => limpiarPdf(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n\t]+/g, ' ');
function envolver(texto, tam, ancho) {
  const max = Math.max(10, Math.floor(ancho / (tam * 0.52)));
  const palabras = limpiarPdf(texto).split(/\s+/).filter(Boolean);
  const lineas = [];
  let l = '';
  for (let p of palabras) {
    while (p.length > max) { // palabras largas (huellas, correos)
      if (l) { lineas.push(l); l = ''; }
      lineas.push(p.slice(0, max)); p = p.slice(max);
    }
    if ((l + ' ' + p).trim().length > max) { lineas.push(l); l = p; } else { l = (l + ' ' + p).trim(); }
  }
  if (l) lineas.push(l);
  return lineas.length ? lineas : [''];
}
function pdfConstancia({ titulo, subtitulo, filas, declaracion, pie }) {
  const W = 595, H = 842, MX = 50;
  const paginas = [];
  let ops = [], y = H - 60;
  const nueva = () => { if (ops.length) paginas.push(ops.join('\n')); ops = []; y = H - 60; };
  const texto = (s, x, yy, tam, negrita, gris) => {
    ops.push(`${gris ? '0.35 0.42 0.4 rg' : '0.06 0.14 0.12 rg'} BT /${negrita ? 'F2' : 'F1'} ${tam} Tf ${x} ${yy} Td (${pdfEsc(s)}) Tj ET`);
  };
  // Cabecera verde
  ops.push('0.059 0.227 0.192 rg 0 ' + (H - 110) + ' ' + W + ' 110 re f');
  ops.push(`1 1 1 rg BT /F1 9 Tf ${MX} ${H - 38} Td (${pdfEsc('GOMEZ LEGAL ABOGADOS')}) Tj ET`);
  ops.push(`1 1 1 rg BT /F2 20 Tf ${MX} ${H - 66} Td (${pdfEsc(titulo)}) Tj ET`);
  ops.push(`0.85 0.93 0.9 rg BT /F1 10 Tf ${MX} ${H - 88} Td (${pdfEsc(subtitulo || '')}) Tj ET`);
  y = H - 145;
  for (const [k, v] of filas) {
    const tv = String(v).length > 56 && !/\s/.test(String(v)) ? 8 : 10; // huellas largas: letra más chica para que quepan en una línea
    const lv = envolver(v, tv, W - 2 * MX - 170);
    if (y - lv.length * 14 < 90) { nueva(); }
    texto(k, MX, y, 9, false, true);
    lv.forEach((ln, i) => texto(ln, MX + 170, y - i * 14, tv, true, false));
    y -= Math.max(1, lv.length) * 14 + 8;
    ops.push(`0.88 0.93 0.91 RG 0.5 w ${MX} ${y + 9} m ${W - MX} ${y + 9} l S`);
  }
  y -= 12;
  for (const ln of envolver(declaracion, 10, W - 2 * MX)) {
    if (y < 90) { nueva(); }
    texto(ln, MX, y, 10, false, false); y -= 14;
  }
  texto(pie || '', MX, 50, 8, false, true);
  nueva();
  // Armado del archivo PDF
  const objs = [];
  const add = (c) => { objs.push(c); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(null); // Pages (se completa abajo)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const idsPag = [];
  for (const cont of paginas) {
    const idC = add({ stream: cont });
    const idP = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idC} 0 R >>`);
    idsPag.push(idP);
  }
  objs[1] = `<< /Type /Pages /Kids [${idsPag.map((i) => i + ' 0 R').join(' ')}] /Count ${idsPag.length} >>`;
  const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offs = [];
  let pos = partes[0].length;
  objs.forEach((o, i) => {
    offs.push(pos);
    let b;
    if (o && o.stream != null) {
      const s = Buffer.from(o.stream, 'latin1');
      b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${s.length} >>\nstream\n`, 'latin1'), s, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    }
    partes.push(b); pos += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`].concat(offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n')).join('');
  partes.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(partes);
}

// Constancia a partir de lo guardado (la misma siempre que se pida de nuevo).
function construirConstancia(f) {
  const medio = f.canal_codigo === 'sms'
    ? `Código de un solo uso enviado por SMS al celular ${mascaraCel(f.codigo_destino || f.celular)}`
    : `Código de un solo uso enviado al correo ${mascaraCorreo(f.correo)}`;
  return pdfConstancia({
    titulo: 'CONSTANCIA DE FIRMA ELECTRONICA', subtitulo: 'Gómez Legal Abogados S.A.S.',
    filas: [
      ['Identificador de la firma', f.id], ['Documento firmado', f.archivo_nombre], ['Huella SHA-256 del documento', f.pdf_sha256],
      ['Firmante', f.nombre], ['Documento de identidad', f.cedula], ['Correo electrónico', f.correo || '-'], ['Celular', f.celular || '-'],
      ['Medio de validación', medio],
      ['Contrato enviado el', fechaCO(f.enviado_en)], ['Contrato visto el', f.visto_en ? fechaCO(f.visto_en) : '-'],
      ['Aceptado y firmado el', fechaCO(f.firmado_en)], ['Dirección IP', f.firma_ip || '-'], ['Navegador', f.firma_agente || '-'],
    ],
    declaracion: 'El firmante manifestó su aceptación del contenido íntegro del documento identificado con la huella SHA-256 indicada, mediante la validación de un código de un solo uso enviado al medio de contacto registrado, en los términos de la Ley 527 de 1999 y el Decreto 2364 de 2012. Cualquier modificación posterior del documento cambia su huella y es detectable. Esta constancia se emite automáticamente y acompaña al contrato firmado.',
    pie: 'Constancia generada automáticamente por Gómez Legal Abogados.',
  });
}

// ---------------------------------------------------------------- Correos
const PIE_CORREO = 'Gómez Legal Abogados · Este mensaje es automático.';
function marco(titulo, cuerpo) {
  return `<div style="background:#f2f6f4;padding:24px 10px;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(15,58,49,.12)">
 <div style="background-color:#0f3a31;background-image:linear-gradient(135deg,#0f3a31,#1f6a5b);padding:24px 30px;color:#ffffff">
  <div style="font-size:12px;letter-spacing:.3em;opacity:.8">GÓMEZ LEGAL ABOGADOS</div>
  <div style="font-size:24px;font-weight:700;margin-top:8px">${esc(titulo)}</div>
 </div>
 <div style="padding:26px 30px;color:#10241f;font-size:15px;line-height:1.55">${cuerpo}</div>
 <div style="padding:14px 30px;background:#f7faf9;color:#6a7b76;font-size:12px">${PIE_CORREO}</div>
</div></div>`;
}
const boton = (href, texto) => `<p style="text-align:center;margin:26px 0"><a href="${esc(href)}" style="background:#1f6a5b;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 30px;border-radius:10px;display:inline-block">${esc(texto)}</a></p>`;

// En modo prueba el correo no sale al cliente: llega a la lista de prueba, avisando a quién habría llegado.
function destinoCorreo(realA) {
  if (ES_REAL()) return { para: [realA], prefijo: '', aviso: '' };
  return { para: DESTINOS_PRUEBA(), prefijo: '[PRUEBA] ', aviso: `<p style="background:#fff6e0;border:1px solid #f0c36d;border-radius:8px;padding:8px 12px;font-size:13px;color:#7a5c10">MODO PRUEBA: este correo habría llegado a <b>${esc(realA)}</b>.</p>` };
}
async function correoFirma(f, enlace) {
  const d = destinoCorreo(f.correo);
  const html = marco('Tu contrato está listo para firmar', `${d.aviso}
   <p style="margin:0 0 12px">Hola, <b>${esc(f.nombre)}</b>:</p>
   <p style="margin:0 0 12px">Gómez Legal Abogados preparó tu <b>contrato de prestación de servicios</b> con la información que nos entregaste. Revísalo con calma y fírmalo en línea en pocos minutos, sin papeles ni desplazamientos.</p>
   ${boton(enlace, 'Revisar y firmar mi contrato')}
   <p style="margin:0 0 8px;font-size:13px;color:#4a5b56">Para firmar te pediremos un <b>código de un solo uso</b> que te enviaremos por mensaje de texto a tu celular o a este correo, como prefieras. El enlace es personal y vence el <b>${esc(fechaCO(f.vence_en))}</b>.</p>
   <p style="margin:0;font-size:13px;color:#4a5b56">Si no esperabas este mensaje, ignóralo: sin tu código nadie puede firmar.</p>`);
  await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: d.para, asunto: `${d.prefijo}Tu contrato con Gómez Legal está listo para firmar`, html, adjuntos: [] });
}
async function correoCodigo(f, codigo) {
  const d = destinoCorreo(f.correo);
  const html = marco('Tu código de firma', `${d.aviso}
   <p style="margin:0 0 12px">Hola, <b>${esc(f.nombre)}</b>. Este es tu código para firmar el contrato:</p>
   <p style="text-align:center;font-size:36px;letter-spacing:.35em;font-weight:800;color:#0f3a31;margin:18px 0">${esc(codigo)}</p>
   <p style="margin:0;font-size:13px;color:#4a5b56">Vale ${VIGENCIA_CODIGO_MIN} minutos. No lo compartas con nadie: Gómez Legal nunca te lo pedirá por llamada o mensaje.</p>`);
  await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: d.para, asunto: `${d.prefijo}Tu código de firma: ${codigo}`, html, adjuntos: [] });
}
async function correoCopia(f, adjuntos) {
  const d = destinoCorreo(f.correo);
  const html = marco('Contrato firmado', `${d.aviso}
   <p style="margin:0 0 12px">Hola, <b>${esc(f.nombre)}</b>:</p>
   <p style="margin:0 0 12px">Recibimos tu aceptación el <b>${esc(fechaCO(f.firmado_en))}</b>. Adjuntamos la <b>copia de tu contrato firmado</b> y la <b>constancia de firma electrónica</b>. Guárdalas.</p>
   <p style="margin:0;font-size:13px;color:#4a5b56">Tu asesor continuará con el siguiente paso de tu trámite.</p>`);
  await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: d.para, asunto: `${d.prefijo}Tu contrato firmado - Gómez Legal`, html, adjuntos });
}

// Aviso al equipo cada vez que un cliente firma (sin adjuntos: con los enlaces a SharePoint y al panel).
async function correoEquipo(f, links) {
  const lista = String(process.env.FIRMA_AVISO_EQUIPO || REMITENTE()).split(/[,;]/).map((x) => (x.match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0]).filter(Boolean);
  const para = ES_REAL() ? lista : DESTINOS_PRUEBA();
  const fila = (k, v) => v ? `<tr><td style="padding:9px 14px;color:#5b6b66;font-size:13px;border-bottom:1px solid #e6efec;width:38%">${esc(k)}</td><td style="padding:9px 14px;font-size:14px;font-weight:600;color:#10241f;border-bottom:1px solid #e6efec">${esc(v)}</td></tr>` : '';
  const medio = f.canal_codigo === 'sms' ? 'Código por SMS al celular ' + mascaraCel(f.celular) : 'Código al correo ' + mascaraCorreo(f.correo);
  const botones = [
    links.contrato ? boton(links.contrato, 'Ver contrato firmado') : '',
    links.carpeta ? `<p style="text-align:center;margin:-10px 0 18px"><a href="${esc(links.carpeta)}" style="color:#1f6a5b;font-weight:600">📁 Abrir la carpeta del cliente</a></p>` : '',
    `<p style="text-align:center;margin:0 0 6px"><a href="https://gomezlegal.netlify.app" style="color:#1f6a5b;font-weight:600">Ir al panel (Casos)</a></p>`,
  ].join('');
  const html = marco('✍️ ' + (f.nombre || 'Cliente') + ' firmó su contrato', `${ES_REAL() ? '' : '<p style="background:#fff6e0;border:1px solid #f0c36d;border-radius:8px;padding:8px 12px;font-size:13px;color:#7a5c10">MODO PRUEBA: este aviso habría llegado al equipo.</p>'}
   <p style="margin:0 0 14px">Buenas noticias, equipo: <b>${esc(f.nombre)}</b> aceptó y firmó electrónicamente su contrato. Ya puede pasar a <b>Cliente</b> y seguir con el trámite.</p>
   <table style="width:100%;border-collapse:collapse;background:#f8fbfa;border-radius:10px;overflow:hidden;margin:0 0 20px">
     ${fila('Cliente', f.nombre)}${fila('Documento', f.cedula)}${fila('Placa', f.placa)}${fila('Contrato', f.archivo_nombre)}
     ${fila('Firmado el', fechaCO(f.firmado_en))}${fila('Validación', medio)}${fila('Enviado a firma por', f.enviado_por)}
   </table>
   ${botones}
   <p style="margin:14px 0 0;font-size:12.5px;color:#6a7b76">El contrato firmado y la constancia de firma quedaron en la carpeta del cliente en SharePoint.${links.contrato ? '' : ' (No se pudo obtener el enlace directo: búscalo en la carpeta.)'}</p>`);
  await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: para, asunto: `${ES_REAL() ? '' : '[PRUEBA] '}✍️ ${f.nombre || 'Cliente'} firmó su contrato`, html, adjuntos: [] });
}

// ---------------------------------------------------------------- Rutas
module.exports = function registrarFirma(app, { sbServicio, exigirEquipo }) {
  const estadoEfectivo = (f) => (['enviado', 'visto'].includes(f.estado) && new Date(f.vence_en) <= new Date()) ? 'vencido' : f.estado;

  async function cargar(token) {
    if (!/^[A-Za-z0-9_-]{20,60}$/.test(String(token || ''))) return null;
    const sb = sbServicio();
    const { data } = await sb.from(TABLA).select('*').eq('token', token).maybeSingle();
    return data ? { sb, f: data } : null;
  }
  const noEncontrado = (res) => res.status(404).json({ error: 'Este enlace no existe. Pide a tu asesor uno nuevo.' });

  // ---- Panel (equipo): enviar contrato a firma
  // Envía el contrato del caso a firma (lo usan el botón del panel y el envío automático de Daniela).
  // Devuelve { status, body } como respondería la ruta.
  const falla = (status, body) => ({ status, body });
  async function enviarAFirmaInterno(sb, { casoId, correo, celular, archivoId, reenviar, enviadoPor, auto }) {
      if (!sp.configurado()) return falla(503, { error: 'SharePoint no está configurado en el servidor.' });
      if (!casoId) return falla(400, { error: 'Falta el caso.' });
      const { data: caso } = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('id', casoId).maybeSingle();
      if (!caso) return falla(404, { error: 'No encontré el caso.' });
      const ced = soloDigitos(caso.numero_identificacion);
      if (!ced) return falla(400, { error: 'El caso no tiene número de identificación.' });
      // Lo que manda el panel manda (si el asesor deja el correo vacío, no se usa el del caso)
      const mail0 = String(correo !== undefined ? correo : (caso.correo || caso.email || caso.correo_electronico || '')).trim().toLowerCase();
      const mail = EMAIL_OK.test(mail0) ? mail0 : null;
      const cel = soloDigitos(celular !== undefined ? celular : caso.telefono);
      const smsA = destinoSms(cel);
      if (!mail && !smsA) {
        const sinSms = !process.env.INALAMBRIA_API_KEY ? ' (el SMS no está configurado en el servidor)' : !celularE164(cel) ? ' (el celular no es un celular colombiano válido)' : ' (en modo prueba falta FIRMA_SMS_PRUEBA)';
        return falla(400, { error: 'Falta un correo válido o un celular para enviarle el contrato' + sinSms + '.', faltaCorreo: true });
      }

      const { data: previas } = await sb.from(TABLA).select('id,estado,vence_en,firmado_en').eq('caso_id', String(casoId));
      const firmada = (previas || []).find((p) => p.estado === 'firmado');
      if (firmada && !reenviar) return falla(409, { error: 'Este contrato ya fue firmado.', yaFirmado: true, firmado_en: firmada.firmado_en });
      const vigente = (previas || []).find((p) => ['enviado', 'visto'].includes(p.estado) && new Date(p.vence_en) > new Date());
      if (vigente && !reenviar) return falla(409, { error: 'Ya hay un contrato enviado a firma y vigente.', yaEnviado: true });

      // Contrato en PDF en la carpeta del cliente
      const lista = await sp.listarDocumentosPorCedula(ced);
      if (!lista.encontrada) return falla(400, { error: 'No encontré la carpeta del cliente en SharePoint (cédula ' + ced + ').' });
      const contratos = lista.archivos.filter((a) => a.tipo === 'Contrato' && !/FIRMAD|CONSTANCIA/i.test(a.nombre));
      let pdfs = contratos.filter((a) => /\.pdf$/i.test(a.nombre));
      if (archivoId) pdfs = pdfs.filter((a) => a.id === archivoId);
      if (!pdfs.length) {
        if (contratos.some((a) => /\.docx?$/i.test(a.nombre))) return falla(400, { error: 'El contrato de este cliente está en Word, no en PDF. Pide que se genere en PDF (OCR_CONTRATO_FORMATO=pdf).' });
        return falla(400, { error: 'No hay un contrato generado en la carpeta del cliente.' });
      }
      const finales = pdfs.filter((a) => !/^BORRADOR/i.test(a.nombre));
      // En automático se toma el contrato más reciente (versión _vN más nueva).
      if (auto && finales.length > 1) finales.sort((x, y) => String(y.modificado || '').localeCompare(String(x.modificado || '')));
      if (!finales.length) return falla(400, { error: 'El contrato está como BORRADOR: hay datos por revisar. Corrígelos y vuelve a generarlo.' });
      if (finales.length > 1 && !archivoId && !auto) return falla(409, { error: 'Hay más de un contrato en la carpeta. Elige cuál enviar.', opciones: finales.map((a) => ({ id: a.id, nombre: a.nombre, modificado: a.modificado })) });
      const archivo = finales[0];
      const { buffer } = await sp.descargarArchivo(archivo.id);
      if (!buffer.length || buffer.slice(0, 4).toString() !== '%PDF') return falla(400, { error: 'El archivo del contrato no es un PDF válido.' });

      // Se anulan los envíos anteriores vigentes (solo en reenvío) y se crea el nuevo
      if (reenviar) await sb.from(TABLA).update({ estado: 'cancelado' }).eq('caso_id', String(casoId)).in('estado', ['enviado', 'visto']);
      const token = crypto.randomBytes(24).toString('base64url');
      const vence = new Date(Date.now() + VIGENCIA_DIAS() * 86400000).toISOString();
      const fila = {
        token, caso_id: String(casoId), cedula: ced, nombre: String(caso.nombre_cliente || '').trim(), correo: mail, celular: cel,
        placa: caso.placa || null, archivo_id: archivo.id, archivo_nombre: archivo.nombre, pdf_sha256: sha256(buffer),
        estado: 'enviado', vence_en: vence, enviado_por: enviadoPor, enviado_en: new Date().toISOString(),
      };
      const { data: ins, error } = await sb.from(TABLA).insert(fila).select('*').maybeSingle();
      if (error || !ins) throw new Error('No pude guardar la solicitud de firma: ' + (error && error.message));
      // Invitación por los canales disponibles: correo y/o SMS con el enlace
      const enlace = `${URL_FIRMA()}?t=${token}`;
      const enviados = [], fallas = [];
      if (mail) {
        try { await correoFirma(ins, enlace); enviados.push('correo ' + mascaraCorreo(mail)); } catch (e) { fallas.push('correo: ' + (e.message || e)); }
      }
      // El SMS con enlace lo puede marcar el antifraude de Inalambria (y suspender la cuenta): solo se usa si el
      // cliente NO tiene correo. El código de verificación sí sale por SMS siempre (no lleva enlace).
      if (smsA && !mail) {
        const primer = String(ins.nombre || '').split(/\s+/)[0] || '';
        try { await enviarSms(smsA, `Gomez Legal Abogados: hola ${primer}, tu contrato de servicios ya esta disponible para revision. Consultalo en ${enlace}`); enviados.push('SMS ' + mascaraCel(cel)); } catch (e) { fallas.push('SMS: ' + (e.message || e)); }
      }
      if (!enviados.length) {
        await sb.from(TABLA).update({ estado: 'error', mensaje: fallas.join(' | ').slice(0, 300) }).eq('id', ins.id);
        throw new Error('No se pudo enviar el contrato al cliente: ' + fallas.join(' | '));
      }
      await sb.from(TABLA).update({ canal_invitacion: enviados.join(' + '), mensaje: fallas.length ? fallas.join(' | ').slice(0, 300) : null }).eq('id', ins.id);
      await sb.from('panel_historial').insert({ caso_id: casoId, campo: 'contrato_firma', valor_anterior: null, valor_nuevo: `Contrato enviado a firma por ${enviados.join(' y ')}${ES_REAL() ? '' : ' (MODO PRUEBA)'}`, usuario_email: enviadoPor }).then(() => {}, () => {});
      console.log(`[firma] ${enviadoPor} envió a firma el contrato de ${ced} (${archivo.nombre}) por ${enviados.join(' + ')}${ES_REAL() ? '' : ' [PRUEBA]'}`);
      return { status: 200, body: { ok: true, firmaId: ins.id, enviadoA: enviados.join(' y '), avisos: fallas, vence_en: vence, prueba: !ES_REAL() } };
  }

  // ---- Aviso al cliente por WhatsApp (solo en modo real: en prueba el correo no le llega a él)
  async function avisarWhatsApp(sb, firmaId) {
    if (!ES_REAL()) return false;
    const { data: f } = await sb.from(TABLA).select('*').eq('id', firmaId).maybeSingle();
    if (!f) return false;
    const primer = String(f.nombre || '').split(/\s+/)[0] || '';
    const por = f.correo ? `a su correo ${mascaraCorreo(f.correo)}` : 'por mensaje de texto (SMS) a su celular';
    const texto = `¡Hola${primer ? ', ' + primer : ''}! Ya le enviamos su contrato de servicios ${por} para que lo firme.\n\n` +
      'Para firmarlo: abra el enlace "Revisar y firmar mi contrato", léalo con calma y pida su código de verificación; puede elegir recibirlo por SMS a su celular o a su correo. Escríbalo, marque "Acepto" y listo, son un par de minutos.\n\n' +
      '¿Me confirma si le llegó?';
    try { return await require('./wasapi').avisarCliente(sb, f.celular, texto, { contrato_enviado_firma: true }); }
    catch (e) { console.error('firma: aviso WhatsApp:', e.message); return false; }
  }

  app.post('/api/firma/enviar', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const { casoId, correo, celular, archivoId, reenviar } = req.body || {};
    try {
      const r = await enviarAFirmaInterno(ctx.sb, { casoId, correo, celular, archivoId, reenviar, enviadoPor: ctx.email });
      if (r.status === 200) avisarWhatsApp(ctx.sb, r.body.firmaId).catch(() => {});
      res.status(r.status).json(r.body);
    } catch (err) {
      console.error('firma/enviar:', err);
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ---- Panel (equipo): estado de las firmas (última por caso)
  app.get('/api/firma/estado', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    try {
      const ids = String(req.query.casoIds || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9-]{8,60}$/.test(x)).slice(0, 300);
      if (!ids.length) return res.json({ firmas: {} });
      const { data } = await ctx.sb.from(TABLA).select('id,caso_id,estado,enviado_en,visto_en,firmado_en,vence_en,correo,celular,canal_invitacion,canal_codigo,enviado_por,mensaje').in('caso_id', ids).order('enviado_en', { ascending: false });
      const salida = {};
      for (const f of data || []) if (!salida[f.caso_id]) salida[f.caso_id] = { ...f, estado: estadoEfectivo(f), correo: mascaraCorreo(f.correo), celular: mascaraCel(f.celular) };
      res.json({ firmas: salida });
    } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
  });

  // ---- Panel (equipo): cancelar un envío
  app.post('/api/firma/cancelar', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const { id } = req.body || {};
    const { data } = await ctx.sb.from(TABLA).update({ estado: 'cancelado' }).eq('id', id).in('estado', ['enviado', 'visto']).select('id');
    res.json({ ok: !!(data && data.length) });
  });

  // ---- Cliente (público, con su enlace personal): datos de la solicitud
  app.get('/api/firma/:token/info', async (req, res) => {
    try {
      const c = await cargar(req.params.token); if (!c) return noEncontrado(res);
      const { sb, f } = c;
      let est = estadoEfectivo(f);
      if (est === 'enviado') { await sb.from(TABLA).update({ estado: 'visto', visto_en: new Date().toISOString() }).eq('id', f.id).eq('estado', 'enviado'); est = 'visto'; }
      const canales = [];
      if (destinoSms(f.celular)) canales.push({ id: 'sms', destino: mascaraCel(f.celular) });
      if (f.correo) canales.push({ id: 'correo', destino: mascaraCorreo(f.correo) });
      res.json({ estado: est, nombre: f.nombre, cedula: mascaraCedula(f.cedula), correo: mascaraCorreo(f.correo), canales, vence_en: f.vence_en, firmado_en: f.firmado_en || null });
    } catch (err) { console.error('firma/info:', err); res.status(500).json({ error: 'No se pudo cargar la solicitud.' }); }
  });

  // ---- Cliente: el PDF del contrato (se verifica que no haya cambiado desde que se envió)
  app.get('/api/firma/:token/pdf', async (req, res) => {
    try {
      const c = await cargar(req.params.token); if (!c) return noEncontrado(res);
      const { f } = c;
      const est = estadoEfectivo(f);
      if (['cancelado', 'vencido', 'error'].includes(est)) return res.status(410).json({ error: 'Este enlace ya no está vigente.' });
      const { buffer } = await sp.descargarArchivo(f.archivo_id);
      if (sha256(buffer) !== f.pdf_sha256) return res.status(409).json({ error: 'El contrato cambió después de enviarlo. Pide a tu asesor uno nuevo.' });
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Contrato.pdf"', 'Cache-Control': 'no-store' });
      res.send(buffer);
    } catch (err) { console.error('firma/pdf:', err); res.status(500).json({ error: 'No se pudo abrir el contrato.' }); }
  });

  // ---- Cliente: constancia de firma (solo cuando ya firmó)
  app.get('/api/firma/:token/constancia', async (req, res) => {
    try {
      const c = await cargar(req.params.token); if (!c) return noEncontrado(res);
      if (c.f.estado !== 'firmado') return res.status(409).json({ error: 'El contrato aún no está firmado.' });
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Constancia_de_firma.pdf"', 'Cache-Control': 'no-store' });
      res.send(construirConstancia(c.f));
    } catch (err) { console.error('firma/constancia:', err); res.status(500).json({ error: 'No se pudo generar la constancia.' }); }
  });

  // ---- Cliente: pedir el código de un solo uso
  app.post('/api/firma/:token/codigo', async (req, res) => {
    try {
      const c = await cargar(req.params.token); if (!c) return noEncontrado(res);
      const { sb, f } = c;
      const est = estadoEfectivo(f);
      if (est === 'firmado') return res.status(409).json({ error: 'Este contrato ya fue firmado.' });
      if (est !== 'enviado' && est !== 'visto') return res.status(410).json({ error: 'Este enlace ya no está vigente. Pide a tu asesor uno nuevo.' });
      if ((f.envios_codigo || 0) >= MAX_ENVIOS_CODIGO) return res.status(429).json({ error: 'Pediste demasiados códigos. Escribe a tu asesor para recibir un enlace nuevo.' });
      if (f.codigo_enviado_en && Date.now() - new Date(f.codigo_enviado_en).getTime() < ESPERA_CODIGO_S * 1000) {
        return res.status(429).json({ error: `Espera ${ESPERA_CODIGO_S} segundos antes de pedir otro código.` });
      }
      const smsA = destinoSms(f.celular);
      let canal = String((req.body || {}).canal || '').toLowerCase();
      if (canal !== 'sms' && canal !== 'correo') canal = smsA ? 'sms' : 'correo';
      if (canal === 'sms' && !smsA) return res.status(400).json({ error: 'No es posible enviarte el código por SMS. Elige recibirlo por correo.' });
      if (canal === 'correo' && !f.correo) return res.status(400).json({ error: 'No tenemos tu correo. Elige recibir el código por SMS.' });
      const codigo = String(crypto.randomInt(100000, 1000000));
      let smsId = null;
      try {
        if (canal === 'sms') smsId = await enviarSms(smsA, `Gomez Legal Abogados: tu codigo de verificacion es ${codigo}. Vence en ${VIGENCIA_CODIGO_MIN} minutos. No lo compartas.`);
        else await correoCodigo(f, codigo);
      } catch (e) {
        console.error('firma/codigo envío:', e);
        const otro = canal === 'sms' ? (f.correo ? ' Prueba recibirlo por correo.' : '') : (smsA ? ' Prueba recibirlo por SMS.' : '');
        return res.status(502).json({ error: 'No pudimos enviar el código.' + otro });
      }
      await sb.from(TABLA).update({
        codigo_hash: hashCodigo(f.token, codigo), codigo_expira: new Date(Date.now() + VIGENCIA_CODIGO_MIN * 60000).toISOString(),
        codigo_enviado_en: new Date().toISOString(), envios_codigo: (f.envios_codigo || 0) + 1, intentos: 0,
        canal_codigo: canal, codigo_destino: canal === 'sms' ? soloDigitos(f.celular).slice(-10) : f.correo, sms_id: smsId,
      }).eq('id', f.id);
      res.json({ ok: true, canal, destino: canal === 'sms' ? mascaraCel(f.celular) : mascaraCorreo(f.correo), minutos: VIGENCIA_CODIGO_MIN });
    } catch (err) { console.error('firma/codigo:', err); res.status(500).json({ error: 'No se pudo enviar el código. Intenta de nuevo.' }); }
  });

  // ---- Cliente: aceptar y firmar
  app.post('/api/firma/:token/aceptar', async (req, res) => {
    try {
      const c = await cargar(req.params.token); if (!c) return noEncontrado(res);
      const { sb, f } = c;
      const est = estadoEfectivo(f);
      if (est === 'firmado') return res.status(409).json({ error: 'Este contrato ya fue firmado.', yaFirmado: true });
      if (est !== 'enviado' && est !== 'visto') return res.status(410).json({ error: 'Este enlace ya no está vigente. Pide a tu asesor uno nuevo.' });
      const { codigo, acepto } = req.body || {};
      if (acepto !== true) return res.status(400).json({ error: 'Marca la casilla de aceptación para firmar.' });
      if (!f.codigo_hash || !f.codigo_expira) return res.status(400).json({ error: 'Primero pide tu código.' });
      if (new Date(f.codigo_expira) <= new Date()) return res.status(400).json({ error: 'Tu código venció. Pide uno nuevo.' });
      if ((f.intentos || 0) >= MAX_INTENTOS) return res.status(429).json({ error: 'Demasiados intentos. Pide un código nuevo.' });
      const limpio = soloDigitos(codigo);
      if (!iguales(hashCodigo(f.token, limpio), f.codigo_hash)) {
        const usados = (f.intentos || 0) + 1;
        await sb.from(TABLA).update({ intentos: usados }).eq('id', f.id);
        return res.status(400).json({ error: 'El código no es correcto.', quedan: Math.max(0, MAX_INTENTOS - usados) });
      }
      // El PDF no debe haber cambiado desde el envío
      const { buffer } = await sp.descargarArchivo(f.archivo_id);
      if (sha256(buffer) !== f.pdf_sha256) return res.status(409).json({ error: 'El contrato cambió después de enviarlo. Pide a tu asesor uno nuevo.' });

      const ahora = new Date().toISOString();
      const ip = ipDe(req).slice(0, 80);
      const agente = String(req.headers['user-agent'] || '').slice(0, 300);
      // Reserva atómica: solo una firma, aunque pulsen dos veces
      const { data: tomado } = await sb.from(TABLA).update({ estado: 'firmado', firmado_en: ahora, firma_ip: ip, firma_agente: agente, codigo_hash: null }).eq('id', f.id).in('estado', ['enviado', 'visto']).select('id');
      if (!tomado || !tomado.length) return res.status(409).json({ error: 'Este contrato ya fue firmado.', yaFirmado: true });
      const firmada = { ...f, estado: 'firmado', firmado_en: ahora, firma_ip: ip, firma_agente: agente };

      const constancia = construirConstancia(firmada);
      const marca = String(f.placa || '').replace(/[^A-Za-z0-9]/g, '');
      const pie = marca ? ' ' + marca : '';
      const adj = [
        { nombre: `Contrato firmado${pie}.pdf`, buffer, mime: 'application/pdf' },
        { nombre: `Contrato constancia de firma${pie}.pdf`, buffer: constancia, mime: 'application/pdf' },
      ];

      let guardado = false, correoOk = false;
      const links = { contrato: null, carpeta: null };
      const aviso = [];
      try {
        const k1 = 'cf_' + f.id.slice(0, 8), k2 = 'cc_' + f.id.slice(0, 8);
        sp.TIPOS_DOC[k1] = `Contrato firmado${pie}`; sp.TIPOS_DOC[k2] = `Contrato constancia de firma${pie}`;
        const s1 = await sp.subirDocumento({ cedula: f.cedula, nombre: f.nombre, tipo: k1, nombreArchivo: 'x.pdf', buffer, esCliente: false });
        links.contrato = (s1 && (s1.linkArchivo || s1.webUrl)) || null;
        links.carpeta = (s1 && s1.linkCarpeta) || null;
        await sp.subirDocumento({ cedula: f.cedula, nombre: f.nombre, tipo: k2, nombreArchivo: 'x.pdf', buffer: constancia, esCliente: false });
        guardado = true;
        await sb.from(TABLA).update({ link_firmado: links.contrato }).eq('id', f.id);
      } catch (e) { console.error('firma: no se pudo guardar en SharePoint:', e); aviso.push('No se pudo guardar en SharePoint: ' + String(e.message || e).slice(0, 150)); }
      if (f.correo) {
        try { await correoCopia(firmada, adj); correoOk = true; } catch (e) { console.error('firma: no se pudo enviar la copia:', e); aviso.push('No se pudo enviar la copia por correo: ' + String(e.message || e).slice(0, 150)); }
      }
      let smsOk = false;
      const smsA = destinoSms(f.celular);
      if (smsA) {
        const txt = f.correo ? 'Gomez Legal Abogados: tu contrato quedo aceptado. Te enviamos la copia y la constancia a tu correo.'
          : `Gomez Legal Abogados: tu contrato quedo aceptado. Tu copia y la constancia estan en ${URL_FIRMA()}?t=${f.token}`;
        try { await enviarSms(smsA, txt); smsOk = true; } catch (e) { aviso.push('No se pudo enviar el SMS de confirmación: ' + String(e.message || e).slice(0, 150)); }
      }
      if (ES_REAL()) {
        const primer = String(f.nombre || '').split(/\s+/)[0] || '';
        const txt = `¡Listo${primer ? ', ' + primer : ''}! Recibimos su contrato firmado, muchas gracias. ${f.correo ? 'Le enviamos la copia y la constancia de firma a su correo.' : 'Su copia y la constancia quedaron en el mismo enlace del SMS.'} Seguimos avanzando con su proceso.`;
        require('./wasapi').avisarCliente(sb, f.celular, txt, { contrato_firmado: true }).catch((e) => console.error('firma: aviso WhatsApp firmado:', e.message));
      }
      try { await correoEquipo(firmada, links); } catch (e) { console.error('firma: no se pudo avisar al equipo:', e); aviso.push('No se pudo enviar el aviso al equipo: ' + String(e.message || e).slice(0, 120)); }
      await sb.from(TABLA).update({ mensaje: aviso.length ? aviso.join(' | ') : null, copia_enviada: correoOk, guardado_sharepoint: guardado }).eq('id', f.id);
      if (f.caso_id) await sb.from('panel_historial').insert({ caso_id: f.caso_id, campo: 'contrato_firma', valor_anterior: 'Enviado a firma', valor_nuevo: `Contrato FIRMADO por el cliente (IP ${ip})${guardado ? '' : ' - falta guardarlo en SharePoint'}`, usuario_email: 'cliente (firma electrónica)' }).then(() => {}, () => {});
      console.log(`[firma] firmado ${f.cedula} (${f.archivo_nombre}) sp=${guardado} correo=${correoOk}`);
      res.json({ ok: true, firmado_en: ahora, copiaPorCorreo: correoOk, copiaPorSms: smsOk });
    } catch (err) { console.error('firma/aceptar:', err); res.status(500).json({ error: 'No se pudo completar la firma. Intenta de nuevo.' }); }
  });

  // ---- Envío AUTOMÁTICO a firma de los contratos que pidió Daniela por WhatsApp.
  // Contrato limpio -> se envía a firma y se avisa al cliente por WhatsApp. BORRADOR, faltan documentos o error ->
  // correo al equipo para revisarlo (y el asesor lo envía desde el panel). Se apaga con FIRMA_AUTO=no.
  async function correoRevisar(r, motivo) {
    const lista = String(process.env.FIRMA_AVISO_EQUIPO || REMITENTE()).split(/[,;]/).map((x) => (x.match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0]).filter(Boolean);
    const para = ES_REAL() ? lista : DESTINOS_PRUEBA();
    const enlaces = [r.link_contrato ? boton(r.link_contrato, 'Ver contrato') : '', r.link_carpeta ? `<p style="text-align:center;margin:-10px 0 18px"><a href="${esc(r.link_carpeta)}" style="color:#1f6a5b;font-weight:600">📁 Abrir la carpeta del cliente</a></p>` : ''].join('');
    const html = marco('⚠️ Contrato por revisar: ' + (r.nombre_cliente || 'cliente'), `<p style="margin:0 0 12px">Daniela pidió por WhatsApp el contrato de <b>${esc(r.nombre_cliente || '')}</b> (documento ${esc(r.cedula || '')}), pero <b>no se envió a firma automáticamente</b>:</p>
     <p style="margin:0 0 16px;background:#fff6e0;border:1px solid #f0c36d;border-radius:8px;padding:10px 12px">${esc(motivo)}</p>
     ${enlaces}<p style="margin:0;font-size:13px;color:#4a5b56">Revísalo, corrígelo si hace falta y envíalo a firma desde el panel (Casos → Firma del contrato).</p>`);
    await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: para, asunto: `${ES_REAL() ? '' : '[PRUEBA] '}⚠️ Contrato por revisar: ${r.nombre_cliente || 'cliente'}`, html, adjuntos: [] });
  }
  let avisoColumnas = false;
  async function revisarAutomaticos() {
    const sb = sbServicio();
    const { data, error } = await sb.from('solicitudes_contrato').select('*').eq('auto_firma', true).is('firma_auto_en', null)
      .in('estado', ['listo', 'falta_documentos', 'error']).order('creado_en', { ascending: true }).limit(5);
    if (error) { if (!avisoColumnas) { avisoColumnas = true; console.log('[firma-auto] desactivado hasta correr el SQL nuevo:', error.message); } return; }
    for (const r of data || []) {
      const { data: tomado } = await sb.from('solicitudes_contrato').update({ firma_auto_en: new Date().toISOString() }).eq('id', r.id).is('firma_auto_en', null).select('id');
      if (!tomado || !tomado.length) continue;
      let resultado;
      try {
        const borrador = (r.archivos || []).some((a) => /^BORRADOR/i.test(a)) || /BORRADOR/i.test(String(r.mensaje || ''));
        if (r.estado !== 'listo') { resultado = (r.estado === 'falta_documentos' ? 'Faltan documentos: ' : 'Error: ') + (r.mensaje || ''); await correoRevisar(r, resultado); }
        else if (borrador) { resultado = 'Salió como BORRADOR (hay datos por revisar). ' + (r.mensaje || ''); await correoRevisar(r, resultado); }
        else {
          const env = await enviarAFirmaInterno(sb, { casoId: r.caso_id, enviadoPor: 'Daniela (automático)', auto: true });
          if (env.status === 200) {
            const wa = await avisarWhatsApp(sb, env.body.firmaId);
            resultado = 'Enviado a firma por ' + env.body.enviadoA + (wa ? ' + aviso por WhatsApp' : '');
          } else if (env.body && (env.body.yaEnviado || env.body.yaFirmado)) {
            resultado = env.body.error;
          } else { resultado = 'No se pudo enviar: ' + ((env.body && env.body.error) || env.status); await correoRevisar(r, resultado); }
        }
      } catch (e) {
        resultado = 'Error: ' + String(e.message || e).slice(0, 200);
        try { await correoRevisar(r, resultado); } catch (_) {}
      }
      console.log(`[firma-auto] ${r.nombre_cliente} (${r.cedula}): ${resultado}`);
      await sb.from('solicitudes_contrato').update({ firma_auto_resultado: String(resultado).slice(0, 300) }).eq('id', r.id);
    }
  }
  if (String(process.env.FIRMA_AUTO || '').toLowerCase() !== 'no') {
    setInterval(() => revisarAutomaticos().catch((e) => console.error('[firma-auto]', e.message)), 60 * 1000).unref();
  }
  registrarFirma.revisarAutomaticos = revisarAutomaticos; // para pruebas
};

module.exports.pdfConstancia = pdfConstancia;
