// Pagos cargados por Daniela (asistente del panel, WhatsApp y Chattigo) + informe ejecutivo diario por correo (8:00 p. m.).
// - registrarPago(): se llama cada vez que un "soporte de pago" queda guardado en SharePoint.
// - A las 8:00 p. m. (hora de Colombia) se envía el informe del día a INFORME_PAGOS_PARA (una sola vez por día).
// - GET /api/reportes/pagos/disparar: lo llama una tarea programada a las 7:58 p. m. para despertar el servidor gratuito.
// - GET /api/reportes/pagos/vista: muestra el informe de hoy en el navegador (no envía nada).
// Tablas: pagos_cargados e informes_diarios (pagos_cargados.sql).

const { createClient } = require('@supabase/supabase-js');

const PARA_DEFECTO = ['aarcila@bpogs.com', 'jcifuentes@bpogs.com', 'auxiliar@bpogs.com', 'mfsierra@bpogs.com'];
const HORA_ENVIO = () => String(process.env.INFORME_PAGOS_HORA || '20:00');
const digitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let _sb = null;
const sb = () => (_sb = _sb || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));

const fechaBog = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d); // AAAA-MM-DD
const horaBog = (d = new Date()) => new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const rangoDia = (fecha) => ({ desde: new Date(fecha + 'T00:00:00-05:00').toISOString(), hasta: new Date(fecha + 'T23:59:59.999-05:00').toISOString() });

async function registrarPago({ cedula, nombre, telefono, canal, cargado_por, archivo, link, caso_id }) {
  try {
    const { error } = await sb().from('pagos_cargados').insert({
      cedula: digitos(cedula) || null, nombre: nombre || null, telefono: digitos(telefono).slice(-10) || null, canal: canal || null,
      cargado_por: cargado_por || null, archivo: archivo || null, link: link || null, caso_id: caso_id ? String(caso_id) : null,
    });
    if (error) console.error('[pagos] no pude registrar el pago (¿falta ejecutar pagos_cargados.sql?):', error.message);
  } catch (e) { console.error('[pagos] registrarPago:', e.message); }
}

async function datosInforme(fecha) {
  const { desde, hasta } = rangoDia(fecha);
  const { data: pagos } = await sb().from('pagos_cargados').select('*').gte('creado_en', desde).lte('creado_en', hasta).order('creado_en', { ascending: true });
  // Mes en curso (para contexto)
  const inicioMes = new Date(fecha.slice(0, 7) + '-01T00:00:00-05:00').toISOString();
  const { count: mes } = await sb().from('pagos_cargados').select('id', { count: 'exact', head: true }).gte('creado_en', inicioMes).lte('creado_en', hasta);
  // Pendientes de pago: contrato FIRMADO, el caso no está en "Cliente" ni "Cierre perdido" y no hay pago cargado de esa cédula.
  const hace60 = new Date(Date.now() - 60 * 864e5).toISOString();
  const { data: firmas } = await sb().from('firmas_contrato').select('*').eq('estado', 'firmado').gte('firmado_en', hace60).order('firmado_en', { ascending: true }).limit(500);
  const ids = [...new Set((firmas || []).map((f) => f.caso_id).filter(Boolean))];
  let casos = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb().from('Perfilamiento_y_ventas_GLA').select('id,nombre_cliente,telefono,numero_identificacion,estado_pipeline,asesor,fuente').in('id', ids.slice(i, i + 100));
    casos = casos.concat(data || []);
  }
  const cedulas = [...new Set((firmas || []).map((f) => digitos(f.cedula)).filter(Boolean))];
  let pagadas = new Set();
  for (let i = 0; i < cedulas.length; i += 100) {
    const { data } = await sb().from('pagos_cargados').select('cedula').in('cedula', cedulas.slice(i, i + 100));
    (data || []).forEach((r) => pagadas.add(r.cedula));
  }
  const vistos = new Set();
  const pendientes = [];
  for (const f of firmas || []) {
    const caso = casos.find((c) => String(c.id) === String(f.caso_id));
    const ced = digitos(f.cedula || (caso && caso.numero_identificacion));
    if (!ced || vistos.has(ced) || pagadas.has(ced)) continue;
    if (caso && ['Cliente', 'Cierre perdido'].includes(caso.estado_pipeline)) continue;
    vistos.add(ced);
    pendientes.push({ nombre: (caso && caso.nombre_cliente) || f.nombre || f.nombre_cliente || 'Cliente', cedula: ced, telefono: (caso && caso.telefono) || '',
      asesor: (caso && caso.asesor) || '', firmado: f.firmado_en, dias: Math.floor((Date.now() - new Date(f.firmado_en).getTime()) / 864e5) });
  }
  pendientes.sort((a, b) => b.dias - a.dias);
  return { fecha, pagos: pagos || [], mes: mes || 0, pendientes };
}

function htmlInforme({ fecha, pagos, mes, pendientes }) {
  const porCanal = {};
  pagos.forEach((p) => { const k = p.canal || 'Otro'; porCanal[k] = (porCanal[k] || 0) + 1; });
  const fechaLarga = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(fecha + 'T12:00:00Z'));
  const kpi = (n, t, color) => `<td style="padding:6px"><div style="background:#fff;border:1px solid #e1dac5;border-top:4px solid ${color};border-radius:10px;padding:14px 16px">
    <div style="font-size:30px;font-weight:800;color:#0b1f3a;line-height:1">${n}</div><div style="font-size:12px;color:#5b6b78;margin-top:6px">${t}</div></div></td>`;
  const filaPago = (p) => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${esc(horaBog(new Date(p.creado_en)))}</td><td style="padding:8px;border-bottom:1px solid #eee"><b>${esc(p.nombre || '—')}</b></td>
    <td style="padding:8px;border-bottom:1px solid #eee">${esc(p.cedula || '—')}</td><td style="padding:8px;border-bottom:1px solid #eee">${esc(p.canal || '—')}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${esc(p.cargado_por || '—')}</td><td style="padding:8px;border-bottom:1px solid #eee">${p.link ? `<a href="${esc(p.link)}">Ver soporte</a>` : '—'}</td></tr>`;
  const filaPend = (p) => `<tr><td style="padding:8px;border-bottom:1px solid #eee"><b>${esc(p.nombre)}</b></td><td style="padding:8px;border-bottom:1px solid #eee">${esc(p.cedula)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${esc(p.telefono || '—')}</td><td style="padding:8px;border-bottom:1px solid #eee">${esc(p.asesor || '—')}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;color:${p.dias >= 3 ? '#9b1c13' : '#1c2430'};font-weight:${p.dias >= 3 ? 700 : 400}">${p.dias} día(s)</td></tr>`;
  const th = (t) => `<th style="text-align:left;padding:8px;background:#f6f4ee;font-size:12px;color:#5b6b78;border-bottom:2px solid #e1dac5">${t}</th>`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;background:#f6f4ee;padding:24px;color:#1c2430">
  <div style="max-width:760px;margin:0 auto">
   <div style="background:linear-gradient(135deg,#0b1f3a,#1c3a63);color:#e9dfbf;border-radius:14px 14px 0 0;padding:20px 24px">
    <div style="font-size:12px;letter-spacing:.08em;font-weight:700">GÓMEZ LEGAL ABOGADOS · INFORME EJECUTIVO</div>
    <div style="font-size:22px;font-weight:800;color:#fff;margin-top:6px">Pagos cargados hoy</div>
    <div style="font-size:13px;margin-top:4px">${esc(fechaLarga.charAt(0).toUpperCase() + fechaLarga.slice(1))} · corte ${esc(HORA_ENVIO())}</div></div>
   <div style="background:#fff;border-radius:0 0 14px 14px;padding:18px 18px 24px">
    <table style="width:100%;border-collapse:separate"><tr>${kpi(pagos.length, 'Pagos cargados hoy', '#1f5c4d')}${kpi(mes, 'Pagos en el mes', '#b6912f')}${kpi(pendientes.length, 'Firmados sin pago', pendientes.length ? '#c0392b' : '#1f5c4d')}</tr></table>
    ${Object.keys(porCanal).length ? `<p style="font-size:13px;color:#5b6b78;margin:10px 6px">Por canal: ${Object.entries(porCanal).map(([k, v]) => `<b>${esc(k)}</b> ${v}`).join(' · ')}</p>` : ''}
    <h3 style="margin:18px 6px 8px;font-size:16px;color:#0b1f3a">✅ Pagos cargados hoy (${pagos.length})</h3>
    ${pagos.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${th('Hora')}${th('Cliente')}${th('Cédula/NIT')}${th('Canal')}${th('Cargado por')}${th('Soporte')}</tr>${pagos.map(filaPago).join('')}</table>`
      : '<p style="margin:6px;color:#5b6b78">Hoy no se cargaron soportes de pago.</p>'}
    <h3 style="margin:22px 6px 8px;font-size:16px;color:#0b1f3a">⏳ Pendientes de pago: contrato firmado, sin soporte (${pendientes.length})</h3>
    ${pendientes.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${th('Cliente')}${th('Cédula/NIT')}${th('Celular')}${th('Asesor')}${th('Firmó hace')}</tr>${pendientes.map(filaPend).join('')}</table>
      <p style="font-size:12px;color:#5b6b78;margin:8px 6px">En rojo: 3 días o más desde la firma. Sugerencia: llamarlos o pedirle a Daniela un seguimiento (botón "Encargar a Daniela").</p>`
      : '<p style="margin:6px;color:#5b6b78">No hay clientes con contrato firmado pendientes de pago. 🎉</p>'}
    <p style="font-size:11px;color:#8a979f;margin:20px 6px 0">Incluye los soportes de pago cargados por Daniela (asistente del panel, WhatsApp y Chattigo). Los archivos subidos a mano directo en SharePoint no se cuentan.</p>
   </div></div></div>`;
}

async function enviarInforme({ fecha = fechaBog(), para, forzar = false } = {}) {
  const sp = require('./sharepoint');
  const { REMITENTE } = require('./correo_cita');
  if (!forzar) { // una sola vez por día (también entre varias instancias del servidor)
    const { error } = await sb().from('informes_diarios').insert({ tipo: 'pagos', fecha });
    if (error) return { enviado: false, motivo: /duplicate|23505/.test(error.message + error.code) ? 'ya se envió hoy' : error.message };
  }
  const d = await datosInforme(fecha);
  const destinatarios = para || String(process.env.INFORME_PAGOS_PARA || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const lista = destinatarios.length ? destinatarios : PARA_DEFECTO;
  try {
    await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: lista, asunto: `📊 Pagos cargados hoy: ${d.pagos.length} · pendientes de pago: ${d.pendientes.length} (${fecha})`, html: htmlInforme(d), adjuntos: [] });
  } catch (e) {
    if (!forzar) await sb().from('informes_diarios').delete().eq('tipo', 'pagos').eq('fecha', fecha); // se reintenta en el siguiente minuto
    throw e;
  }
  console.log(`[pagos] informe ${fecha} enviado a ${lista.join(', ')} (${d.pagos.length} pagos, ${d.pendientes.length} pendientes)`);
  return { enviado: true, pagos: d.pagos.length, pendientes: d.pendientes.length, para: lista };
}

function montarPagos(app) {
  const tocaHoy = () => horaBog() >= HORA_ENVIO();
  let enCurso = false;
  async function revisar() {
    if (enCurso || !tocaHoy()) return null;
    enCurso = true;
    try { return await enviarInforme(); } catch (e) { console.error('[pagos] informe:', e.message); return { enviado: false, motivo: e.message }; } finally { enCurso = false; }
  }
  setInterval(revisar, 60e3);
  app.get('/api/reportes/pagos/disparar', async (req, res) => {
    const r = await revisar();
    res.json(r || { enviado: false, motivo: `aún no son las ${HORA_ENVIO()} (hora Colombia: ${horaBog()})` });
  });
  app.get('/api/reportes/pagos/vista', async (req, res) => {
    try { res.send(htmlInforme(await datosInforme(/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha)) ? req.query.fecha : fechaBog()))); }
    catch (e) { res.status(500).send('No pude armar el informe: ' + esc(e.message)); }
  });
  let ultimaPrueba = 0;
  app.get('/api/reportes/pagos/prueba', async (req, res) => { // envía el informe de hoy SOLO a mfsierra@bpogs.com (máx. 1 cada 5 min)
    if (Date.now() - ultimaPrueba < 5 * 60e3) return res.json({ enviado: false, motivo: 'espera 5 minutos entre pruebas' });
    ultimaPrueba = Date.now();
    try { res.json(await enviarInforme({ forzar: true, para: ['mfsierra@bpogs.com'] })); } catch (e) { res.status(500).json({ enviado: false, motivo: e.message }); }
  });
}

module.exports = { registrarPago, montarPagos, datosInforme, htmlInforme };
