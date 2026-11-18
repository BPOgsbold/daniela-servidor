// Portal del cliente "Mi trámite" (sitio aparte en Netlify). El cliente entra con su cédula + un código de un solo uso
// (correo o SMS) y ve el avance de su trámite: contrato, UPME y DIAN, con fechas, datos clave y las evidencias de cada
// etapa (solo soportes de etapas, contrato firmado y su constancia; nunca documentos internos).
// El acceso lo activa el equipo desde el panel (Seguimiento Cliente → "Portal del cliente").
//
// Variables en Render (opcionales):
//   PORTAL_URL      dirección del portal (por defecto https://gomezlegal-clientes.netlify.app)
//   PORTAL_SECRETO  texto cualquiera para firmar las sesiones (si no hay, usa FIRMA_SECRETO)

const crypto = require('crypto');
const sp = require('./sharepoint');
const { REMITENTE } = require('./correo_cita');
const firma = require('./firma');

const TABLA = 'portal_accesos';
const URL_PORTAL = () => (process.env.PORTAL_URL || 'https://gomezlegal-clientes.netlify.app').replace(/\/$/, '');
const SECRETO = () => process.env.PORTAL_SECRETO || process.env.FIRMA_SECRETO || crypto.createHash('sha256').update(String(process.env.SUPABASE_SERVICE_ROLE_KEY || 'gla')).digest('hex');
const HORAS_SESION = 12;
const VIGENCIA_CODIGO_MIN = 10;
const ESPERA_CODIGO_S = 30;
const MAX_ENVIOS_DIA = 8;
const MAX_INTENTOS = 5;
const BUCKET_SOPORTES = 'soportes-cliente';
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const dig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const ced = (v) => dig(v).replace(/^0+/, '');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hashCodigo = (cedula, codigo) => crypto.createHmac('sha256', SECRETO()).update(cedula + ':' + codigo).digest('hex');
function mascaraCorreo(c) { const [u, d] = String(c || '').split('@'); return u && d ? u.slice(0, 2) + '***@' + d : ''; }
function mascaraCel(c) { const d = dig(c).slice(-10); return d.length === 10 ? d.slice(0, 3) + ' *** **' + d.slice(-2) : ''; }

// ---------- Sesión firmada (sin tabla): base64url(json).firma
function crearToken(cedula) {
  const cuerpo = Buffer.from(JSON.stringify({ c: cedula, e: Date.now() + HORAS_SESION * 3600e3 })).toString('base64url');
  return cuerpo + '.' + crypto.createHmac('sha256', SECRETO()).update(cuerpo).digest('base64url');
}
function leerToken(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const [cuerpo, f] = t.split('.');
  if (!cuerpo || !f) return null;
  const esperado = crypto.createHmac('sha256', SECRETO()).update(cuerpo).digest('base64url');
  if (f.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(esperado))) return null;
  try { const j = JSON.parse(Buffer.from(cuerpo, 'base64url').toString()); return j.e > Date.now() ? j.c : null; } catch (_) { return null; }
}

// ---------- Las etapas como las ve el cliente (mismo orden que Seguimiento Cliente en el panel)
const ETAPAS = [
  { campo: 'fecha_pendiente_registro_upme', fase: 'upme', titulo: 'Registro en la UPME', soporte: 'soporte_registro_upme',
    texto: 'Creamos su usuario en la plataforma de la UPME y registramos su vehículo con los datos exactos de la factura y el RUT.',
    usted: 'No tiene que hacer nada: nosotros lo hacemos por usted.' },
  { campo: 'fecha_pendiente_pago_upme', fase: 'upme', titulo: 'Pago de la tarifa UPME', soporte: 'soporte_pago_upme',
    texto: 'Al registrar el caso, la UPME genera el cobro de su tarifa. Se paga para que la entidad estudie la solicitud.',
    usted: 'Si eligió pagarla usted mismo, hágalo con el usuario y la clave que le entregamos.' },
  { campo: 'fecha_pendiente_certificado_upme', fase: 'upme', titulo: 'Certificado solicitado', soporte: 'soporte_certificado_solicitado',
    texto: 'Radicamos la solicitud del Certificado de Incentivos Tributarios. La UPME la revisa (puede tardar hasta 30 días hábiles).',
    usted: 'Solo esperar. Le avisamos apenas la UPME responda.' },
  { campo: 'fecha_certificado_upme_emitido', fase: 'upme', titulo: 'Certificado UPME emitido', soporte: 'soporte_certificado_emitido',
    texto: 'La UPME expidió el certificado que confirma que su vehículo cumple la Ley 1715. Con él se pide la devolución del IVA a la DIAN.',
    usted: 'Nada por ahora: revisamos cada dato del certificado antes de seguir.' },
  { campo: 'fecha_pendiente_cita_dian', fase: 'dian', titulo: 'Preparando la solicitud DIAN', soporte: null,
    texto: 'Armamos el paquete para la DIAN: formulario 010, solicitud, relación de facturas, certificación bancaria y certificado UPME.',
    usted: 'Es posible que le pidamos firmar algunos documentos o enviar la certificación bancaria actualizada.' },
  { campo: 'fecha_agendado_dian', fase: 'dian', titulo: 'Cita con la DIAN agendada', soporte: 'soporte_agendado_dian',
    texto: 'Agendamos la cita con la seccional de la DIAN que le corresponde según su RUT.',
    usted: 'Nosotros la atendemos. Si necesitamos algo de usted, le escribimos por WhatsApp.' },
  { campo: 'fecha_radicado_dian', fase: 'dian', titulo: 'Solicitud radicada en la DIAN', soporte: 'soporte_radicado_dian',
    texto: 'Radicamos la solicitud de devolución. Desde aquí la DIAN tiene 50 días hábiles para resolver.',
    usted: 'Solo esperar. Si la DIAN pide algún ajuste, nosotros lo atendemos.' },
  { campo: 'fecha_desembolso', fase: 'dian', titulo: 'Devolución consignada', soporte: null,
    texto: 'La DIAN consignó la devolución del IVA en su cuenta bancaria. ¡Proceso terminado!',
    usted: 'Confírmenos que recibió el dinero y cuéntenos cómo le pareció nuestro servicio.' },
];
const yaTeniaCertificado = (c) => String(c.tiene_certificado_upme || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith('si tiene');

async function buscarPorCedula(sb, tabla, cedula, columnas = '*') {
  const { data } = await sb.from(tabla).select(columnas).ilike('numero_identificacion', '%' + cedula + '%').limit(50);
  return (data || []).filter((r) => ced(r.numero_identificacion) === cedula);
}

function armarTramite(caso, cli, firmas) {
  const ahora = new Date().toISOString();
  const pasos = [];
  const f = (firmas || []).filter((x) => !caso || !x.caso_id || String(x.caso_id) === String(caso.id))
    .sort((a, b) => String(b.enviado_en || '').localeCompare(String(a.enviado_en || '')))[0];
  // 1. Inicio
  pasos.push({ id: 'inicio', fase: 'inicio', titulo: 'Recibimos su caso', estado: 'hecho', fecha: (caso && (caso.created_at || caso.creado_en)) || (cli && cli.creado_en) || null,
    texto: 'Revisamos su factura y sus documentos y confirmamos que su vehículo puede acceder al beneficio.', usted: '' });
  // 2. Contrato
  const firmado = f && f.estado === 'firmado';
  const enFirma = f && ['enviado', 'visto'].includes(f.estado) && new Date(f.vence_en) > new Date();
  pasos.push({ id: 'contrato', fase: 'inicio', titulo: 'Contrato firmado', estado: firmado || cli ? 'hecho' : 'actual', fecha: firmado ? f.firmado_en : null,
    texto: firmado ? 'Firmó electrónicamente su contrato de servicios. Aquí tiene la copia y la constancia de firma.' : 'Su contrato de servicios con Gómez Legal Abogados.',
    usted: firmado || cli ? '' : enFirma ? 'Revise su correo (o SMS): ahí está el botón "Revisar y firmar mi contrato".' : 'Le enviaremos el contrato por correo y/o SMS para que lo firme desde su celular.',
    evidencias: firmado ? [{ id: 'c:' + f.id, nombre: 'Contrato firmado', tipo: 'pdf' }, { id: 'k:' + f.id, nombre: 'Constancia de firma', tipo: 'pdf' }] : [] });
  // 3. Pago y activación
  pasos.push({ id: 'activo', fase: 'inicio', titulo: 'Trámite en marcha', estado: cli ? 'hecho' : 'pendiente', fecha: cli ? cli.creado_en : null,
    texto: 'Con su contrato y su pago confirmados, su caso pasa a nuestro equipo de trámites.', usted: cli ? '' : 'Si ya pagó los honorarios, envíenos el comprobante por WhatsApp.' });
  // 4..11. UPME y DIAN
  let actualMarcado = !cli; // sin cliente activo, la etapa actual es una de las anteriores
  ETAPAS.forEach((e, i) => {
    let estado = 'pendiente';
    const fecha = cli ? cli[e.campo] : null;
    if (cli && yaTeniaCertificado(cli) && i < 3 && !fecha) estado = 'omitido';
    else if (fecha) estado = 'hecho';
    else if (!actualMarcado) { estado = 'actual'; actualMarcado = true; }
    const datos = [];
    if (cli && i === 3 && cli.resultado_certificado_upme) datos.push(['Resultado', cli.resultado_certificado_upme]);
    if (cli && i === 3 && cli.codigo_registro_upme) datos.push(['Código UPME', cli.codigo_registro_upme]);
    if (cli && i === 5 && cli.fecha_cita_dian) datos.push(['Fecha de la cita', cli.fecha_cita_dian]);
    if (cli && i === 6 && cli.numero_radicado_dian) datos.push(['N.º de radicado', cli.numero_radicado_dian]);
    const evidencias = cli && e.soporte && cli[e.soporte] ? [{ id: 's:' + cli.id + ':' + e.soporte, nombre: 'Soporte · ' + e.titulo, tipo: /\.pdf$/i.test(cli[e.soporte]) ? 'pdf' : 'img' }] : [];
    pasos.push({ id: e.campo, fase: e.fase, titulo: e.titulo, estado, fecha: fecha || null, texto: estado === 'omitido' ? 'Usted ya tenía el certificado de la UPME: esta etapa no fue necesaria.' : e.texto, usted: estado === 'actual' ? e.usted : '', datos, evidencias });
  });
  if (!actualMarcado && !pasos.some((p) => p.estado === 'actual')) {
    const primera = pasos.find((p) => p.estado !== 'hecho' && p.estado !== 'omitido');
    if (primera) primera.estado = 'actual';
  }
  const validos = pasos.filter((p) => p.estado !== 'omitido');
  const hechos = validos.filter((p) => p.estado === 'hecho').length;
  const valor = Number(caso && caso.valor_sin_iva) || 0;
  return {
    id: String((cli && cli.id) || (caso && caso.id)),
    vehiculo: (caso && caso.vehiculo) || '', placa: (cli && cli.placa) || (caso && caso.placa) || '',
    ciudad: (cli && cli.ciudad) || (caso && caso.ciudad) || '',
    servicio: (caso && caso.servicio_contratado) || '',
    devolucion_estimada: valor > 1000000 ? Math.round(valor * 0.05) : null,
    avance: Math.round((hechos / validos.length) * 100), completado: validos.every((p) => p.estado === 'hecho'),
    actual: (pasos.find((p) => p.estado === 'actual') || {}).id || null,
    actualizado: ahora, pasos,
  };
}

module.exports = function montarPortal(app, { sbServicio, exigirEquipo }) {
  const correo = async (para, asunto, html) => sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: [para], asunto, html, adjuntos: [] });
  const marco = (titulo, cuerpo) => `<div style="background:#eef3f1;padding:28px 12px;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(16,36,31,.08)">
    <div style="background:linear-gradient(135deg,#123d33,#1f6a5b);padding:22px 28px;color:#fff"><div style="font-size:12px;letter-spacing:.12em;opacity:.8">GÓMEZ LEGAL ABOGADOS</div><div style="font-size:22px;font-weight:700;margin-top:6px">${esc(titulo)}</div></div>
    <div style="padding:26px 28px;color:#10241f;font-size:15px;line-height:1.55">${cuerpo}</div>
    <div style="padding:14px 28px;background:#f6f9f8;color:#6a7b76;font-size:12px">Este mensaje es automático. Si no lo esperaba, ignórelo.</div></div></div>`;

  // ---- Paso 1: el cliente escribe su cédula -> canales disponibles (enmascarados)
  app.post('/api/portal/inicio', async (req, res) => {
    const c = ced((req.body || {}).cedula);
    if (c.length < 5) return res.status(400).json({ error: 'Escriba su número de cédula o NIT, sin puntos.' });
    const { data: a } = await sbServicio().from(TABLA).select('*').eq('cedula', c).maybeSingle();
    if (!a || !a.activo) return res.status(404).json({ error: 'Todavía no tiene acceso al portal. Escríbanos por WhatsApp y se lo activamos.' });
    const canales = [];
    if (a.correo) canales.push({ canal: 'correo', destino: mascaraCorreo(a.correo) });
    if (a.celular && process.env.INALAMBRIA_API_KEY) canales.push({ canal: 'sms', destino: mascaraCel(a.celular) });
    if (!canales.length) return res.status(400).json({ error: 'Su acceso no tiene un correo ni un celular para enviarle el código. Escríbanos por WhatsApp.' });
    res.json({ nombre: String(a.nombre || '').split(/\s+/)[0], canales });
  });

  // ---- Paso 2: enviar el código
  app.post('/api/portal/codigo', async (req, res) => {
    const c = ced((req.body || {}).cedula); const canal = (req.body || {}).canal === 'sms' ? 'sms' : 'correo';
    const sb = sbServicio();
    const { data: a } = await sb.from(TABLA).select('*').eq('cedula', c).maybeSingle();
    if (!a || !a.activo) return res.status(404).json({ error: 'No encontramos un acceso activo con ese documento.' });
    if (a.codigo_enviado_en && Date.now() - new Date(a.codigo_enviado_en).getTime() < ESPERA_CODIGO_S * 1000) return res.status(429).json({ error: `Espere ${ESPERA_CODIGO_S} segundos para pedir otro código.` });
    const hoy = new Date().toISOString().slice(0, 10);
    const envios = a.envios_fecha === hoy ? (a.envios_dia || 0) : 0;
    if (envios >= MAX_ENVIOS_DIA) return res.status(429).json({ error: 'Pidió demasiados códigos hoy. Intente mañana o escríbanos por WhatsApp.' });
    const codigo = String(crypto.randomInt(100000, 1000000));
    try {
      if (canal === 'sms') {
        if (!a.celular) throw new Error('No tenemos su celular.');
        await firma.enviarSms('+57' + dig(a.celular).slice(-10), `Gomez Legal Abogados: su codigo para ver su tramite es ${codigo}. Vence en ${VIGENCIA_CODIGO_MIN} minutos.`);
      } else {
        if (!a.correo) throw new Error('No tenemos su correo.');
        await correo(a.correo, `Su código de acceso: ${codigo}`, marco('Su código para ver su trámite', `<p style="margin:0 0 12px">Hola${a.nombre ? ', <b>' + esc(String(a.nombre).split(/\s+/)[0]) + '</b>' : ''}. Use este código para entrar a <b>Mi trámite</b>:</p>
          <p style="text-align:center;font-size:36px;letter-spacing:.35em;font-weight:800;color:#123d33;margin:18px 0">${codigo}</p>
          <p style="margin:0;font-size:13px;color:#4a5b56">Vale ${VIGENCIA_CODIGO_MIN} minutos. No lo comparta con nadie.</p>`));
      }
    } catch (e) {
      console.error('portal/codigo:', e.message);
      return res.status(502).json({ error: canal === 'sms' ? 'No pudimos enviar el SMS. Pruebe con el correo.' : 'No pudimos enviar el correo. Intente de nuevo en un momento.' });
    }
    await sb.from(TABLA).update({ codigo_hash: hashCodigo(c, codigo), codigo_expira: new Date(Date.now() + VIGENCIA_CODIGO_MIN * 60e3).toISOString(), codigo_enviado_en: new Date().toISOString(), intentos: 0, envios_fecha: hoy, envios_dia: envios + 1 }).eq('cedula', c);
    res.json({ ok: true, destino: canal === 'sms' ? mascaraCel(a.celular) : mascaraCorreo(a.correo) });
  });

  // ---- Paso 3: validar el código -> sesión
  app.post('/api/portal/entrar', async (req, res) => {
    const c = ced((req.body || {}).cedula); const codigo = dig((req.body || {}).codigo);
    const sb = sbServicio();
    const { data: a } = await sb.from(TABLA).select('*').eq('cedula', c).maybeSingle();
    if (!a || !a.activo || !a.codigo_hash) return res.status(400).json({ error: 'Primero pida su código.' });
    if (new Date(a.codigo_expira) <= new Date()) return res.status(400).json({ error: 'El código venció. Pida uno nuevo.' });
    if ((a.intentos || 0) >= MAX_INTENTOS) return res.status(429).json({ error: 'Demasiados intentos. Pida un código nuevo.' });
    const ok = crypto.timingSafeEqual(Buffer.from(hashCodigo(c, codigo)), Buffer.from(a.codigo_hash));
    if (!ok) { await sb.from(TABLA).update({ intentos: (a.intentos || 0) + 1 }).eq('cedula', c); return res.status(400).json({ error: 'El código no es correcto.', quedan: MAX_INTENTOS - (a.intentos || 0) - 1 }); }
    await sb.from(TABLA).update({ codigo_hash: null, intentos: 0, ultimo_ingreso: new Date().toISOString(), ingresos: (a.ingresos || 0) + 1 }).eq('cedula', c);
    res.json({ token: crearToken(c), horas: HORAS_SESION });
  });

  // ---- Mi trámite
  app.get('/api/portal/mi-tramite', async (req, res) => {
    const c = leerToken(req); if (!c) return res.status(401).json({ error: 'Su sesión terminó. Vuelva a entrar.' });
    try {
      const sb = sbServicio();
      const { data: a } = await sb.from(TABLA).select('nombre,activo').eq('cedula', c).maybeSingle();
      if (!a || !a.activo) return res.status(401).json({ error: 'Su acceso fue desactivado.' });
      const casos = (await buscarPorCedula(sb, 'Perfilamiento_y_ventas_GLA', c)).filter((x) => x.estado_pipeline !== 'Cierre perdido');
      const clientes = await buscarPorCedula(sb, 'BD_Cliente_GLA', c);
      const { data: firmas } = await sb.from('firmas_contrato').select('id,caso_id,estado,enviado_en,firmado_en,vence_en').eq('cedula', c);
      const tramites = [];
      for (const cli of clientes) tramites.push(armarTramite(casos.find((x) => String(x.id) === String(cli.caso_id)) || null, cli, firmas));
      for (const caso of casos) if (!clientes.some((cli) => String(cli.caso_id) === String(caso.id)) && ['Negociación', 'Cliente'].includes(caso.estado_pipeline)) tramites.push(armarTramite(caso, null, firmas));
      const nombre = a.nombre || (clientes[0] && clientes[0].nombre_cliente) || (casos[0] && casos[0].nombre_cliente) || '';
      res.json({ nombre, tramites, whatsapp: '573009136657' });
    } catch (e) { console.error('portal/mi-tramite:', e); res.status(500).json({ error: 'No pudimos cargar su trámite. Intente de nuevo.' }); }
  });

  // ---- Descargar una evidencia (se verifica que sea de este cliente)
  app.get('/api/portal/evidencia', async (req, res) => {
    const c = leerToken(req); if (!c) return res.status(401).json({ error: 'Su sesión terminó.' });
    const id = String(req.query.id || '');
    const sb = sbServicio();
    try {
      if (/^s:/.test(id)) {
        const [, cliId, campo] = id.split(':');
        if (!/^soporte_[a-z_]+$/.test(campo) || !ETAPAS.some((e) => e.soporte === campo)) return res.status(400).end();
        const { data: cli } = await sb.from('BD_Cliente_GLA').select('*').eq('id', cliId).maybeSingle();
        if (!cli || ced(cli.numero_identificacion) !== c || !cli[campo]) return res.status(404).json({ error: 'No encontrado.' });
        const { data: blob, error } = await sb.storage.from(BUCKET_SOPORTES).download(cli[campo]);
        if (error || !blob) return res.status(404).json({ error: 'No encontramos el archivo.' });
        const buf = Buffer.from(await blob.arrayBuffer());
        res.set('Content-Type', blob.type || (/\.pdf$/i.test(cli[campo]) ? 'application/pdf' : 'application/octet-stream'));
        return res.send(buf);
      }
      if (/^[ck]:/.test(id)) {
        const { data: f } = await sb.from('firmas_contrato').select('*').eq('id', id.slice(2)).maybeSingle();
        if (!f || ced(f.cedula) !== c || f.estado !== 'firmado') return res.status(404).json({ error: 'No encontrado.' });
        const buf = id[0] === 'c' ? (await sp.descargarArchivo(f.archivo_id)).buffer : firma.construirConstancia(f);
        res.set('Content-Type', 'application/pdf');
        return res.send(buf);
      }
      res.status(400).json({ error: 'Evidencia no válida.' });
    } catch (e) { console.error('portal/evidencia:', e); res.status(500).json({ error: 'No pudimos abrir el archivo.' }); }
  });

  // ---- Panel (equipo): activar, consultar y desactivar accesos
  app.post('/api/portal/activar', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const b = req.body || {};
    const c = ced(b.cedula);
    if (c.length < 5) return res.status(400).json({ error: 'Falta la cédula del cliente.' });
    let mail = String(b.correo || '').trim().toLowerCase();
    let cel = dig(b.celular).slice(-10);
    let nombre = String(b.nombre || '').trim();
    if (!mail || !cel || !nombre) { // se completa con el caso
      const casos = await buscarPorCedula(ctx.sb, 'Perfilamiento_y_ventas_GLA', c);
      const k = casos[0] || {};
      if (!mail) mail = String(k.email || '').trim().toLowerCase();
      if (!cel) cel = dig(k.telefono).slice(-10);
      if (!nombre) nombre = k.nombre_cliente || '';
    }
    if (!EMAIL_OK.test(mail)) mail = '';
    if (!mail && cel.length !== 10) return res.status(400).json({ error: 'El cliente necesita un correo o un celular para recibir su código.' });
    const fila = { cedula: c, nombre: nombre || null, correo: mail || null, celular: cel.length === 10 ? cel : null, activo: true, activado_por: ctx.email, activado_en: new Date().toISOString() };
    const { error } = await ctx.sb.from(TABLA).upsert(fila, { onConflict: 'cedula' });
    if (error) return res.status(500).json({ error: 'No pude guardar el acceso: ' + error.message + (/relation|does not exist/.test(error.message) ? ' (falta correr portal_cliente.sql)' : '') });
    const avisos = [];
    if (mail) {
      try {
        await correo(mail, 'Ya puede seguir su trámite en línea', marco('Siga su trámite en línea', `<p style="margin:0 0 12px">Hola${nombre ? ', <b>' + esc(nombre.split(/\s+/)[0]) + '</b>' : ''}:</p>
          <p style="margin:0 0 12px">Activamos su acceso a <b>Mi trámite</b>, donde puede ver en qué va su solicitud ante la UPME y la DIAN, las fechas de cada etapa y los soportes.</p>
          <p style="text-align:center;margin:24px 0"><a href="${URL_PORTAL()}" style="background:#1f6a5b;color:#fff;text-decoration:none;font-weight:700;padding:14px 30px;border-radius:10px;display:inline-block">Ver mi trámite</a></p>
          <p style="margin:0;font-size:13px;color:#4a5b56">Para entrar, escriba su número de documento y le enviaremos un código de un solo uso. No necesita contraseña.</p>`));
        avisos.push('correo ' + mascaraCorreo(mail));
      } catch (e) { console.error('portal/activar correo:', e.message); }
    }
    try {
      const w = require('./wasapi');
      if (cel.length === 10 && w.avisarCliente && await w.avisarCliente(ctx.sb, cel, `¡Hola${nombre ? ', ' + nombre.split(/\s+/)[0] : ''}! Ya puede seguir su trámite en línea: ${URL_PORTAL()}\n\nEntre con su número de documento y le enviamos un código de acceso.`)) avisos.push('WhatsApp');
    } catch (e) { console.error('portal/activar WhatsApp:', e.message); }
    await ctx.sb.from('panel_historial').insert({ caso_id: b.casoId || null, campo: 'portal_cliente', valor_anterior: null, valor_nuevo: 'Acceso al portal activado' + (avisos.length ? ' (aviso por ' + avisos.join(' y ') + ')' : ''), usuario_email: ctx.email }).then(() => {}, () => {});
    res.json({ ok: true, avisadoPor: avisos, url: URL_PORTAL() });
  });

  app.get('/api/portal/accesos', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const lista = String(req.query.cedulas || '').split(',').map(ced).filter((x) => x.length >= 5).slice(0, 500);
    if (!lista.length) return res.json({ accesos: {} });
    const { data, error } = await ctx.sb.from(TABLA).select('cedula,activo,ultimo_ingreso,ingresos,activado_en').in('cedula', lista);
    if (error) return res.json({ accesos: {}, falta_sql: true });
    const out = {}; (data || []).forEach((r) => { out[r.cedula] = r; });
    res.json({ accesos: out });
  });

  app.post('/api/portal/desactivar', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const c = ced((req.body || {}).cedula);
    await ctx.sb.from(TABLA).update({ activo: false, codigo_hash: null }).eq('cedula', c);
    res.json({ ok: true });
  });
};

module.exports.armarTramite = armarTramite; // para pruebas
