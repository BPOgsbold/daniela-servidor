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

const inicioMesAnterior = (fecha) => { const d = new Date(fecha.slice(0, 7) + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); };
const sumarDias = (fecha, n) => { const d = new Date(fecha + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasDelMes = (fecha) => new Date(Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7), 0)).getUTCDate();

// Soportes de pago que están en SharePoint con fecha de hoy (subidos por Daniela antes de que existiera el registro, o a mano).
let cacheSP = { fecha: null, t: 0, lista: [] };
async function pagosSharePoint(fecha) {
  if (cacheSP.fecha === fecha && Date.now() - cacheSP.t < 10 * 60e3) return cacheSP.lista;
  const sp = require('./sharepoint');
  if (!sp.configurado || !sp.configurado()) return [];
  const carpetas = (await sp.listarCarpetasClientes()) || [];
  const lista = [];
  let i = 0;
  const trabajar = async () => {
    while (i < carpetas.length) {
      const c = carpetas[i++];
      try {
        const r = await sp.listarDocumentosDeCarpeta(String(c.id));
        for (const a of (r && r.archivos) || []) {
          if (!/pago/i.test(String(a.tipo || '') + ' ' + String(a.nombre || '')) || /upme/i.test(String(a.nombre || ''))) continue;
          const enNombre = (String(a.nombre || '').match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
          const dia = enNombre || (a.modificado ? fechaBog(new Date(a.modificado)) : '');
          if (!dia || dia < inicioMesAnterior(fecha) || dia > fecha) continue;
          const nomCarpeta = String(c.nombre || (r && r.carpeta) || '');
          const m = nomCarpeta.match(/^(\d{5,12})\s*-\s*(.+)$/);
          lista.push({ cedula: m ? m[1] : '', nombre: m ? m[2].trim() : nomCarpeta, canal: 'SharePoint', cargado_por: '—', archivo: a.nombre, dia,
            link: (r && r.webUrl) || null, creado_en: a.modificado && fechaBog(new Date(a.modificado)) === dia ? a.modificado : new Date(dia + 'T12:00:00-05:00').toISOString() });
        }
      } catch (_) { /* una carpeta con problema no detiene el informe */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, trabajar));
  cacheSP = { fecha, t: Date.now(), lista };
  return lista;
}

async function datosInforme(fecha) {
  const { hasta } = rangoDia(fecha);
  const desdeHist = new Date(inicioMesAnterior(fecha) + 'T00:00:00-05:00').toISOString();
  const { data: registrados } = await sb().from('pagos_cargados').select('*').gte('creado_en', desdeHist).lte('creado_en', hasta).order('creado_en', { ascending: true }).limit(5000);
  let deSP = [];
  try { deSP = await pagosSharePoint(fecha); } catch (e) { console.error('[pagos] SharePoint:', e.message); }
  // Un pago = una cédula en un día (si está en el registro y en SharePoint, se cuenta una vez; manda el registro).
  const porDia = {};
  const claves = new Set();
  const sumar = (p, dia) => { const k = dia + '|' + (digitos(p.cedula) || p.archivo); if (claves.has(k)) return; claves.add(k); (porDia[dia] = porDia[dia] || []).push(p); };
  (registrados || []).forEach((p) => sumar(p, fechaBog(new Date(p.creado_en))));
  deSP.forEach((p) => sumar(p, p.dia));
  const pagos = (porDia[fecha] || []).slice().sort((a, b) => String(a.creado_en).localeCompare(String(b.creado_en)));
  const contar = (desde, hastaDia) => Object.entries(porDia).filter(([d]) => d >= desde && d <= hastaDia).reduce((n, [, l]) => n + l.length, 0);
  // Semana (lunes a hoy) vs. el mismo tramo de la semana pasada; mes al corte vs. el mismo corte del mes pasado.
  const dow = (new Date(fecha + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = lunes
  const lunes = sumarDias(fecha, -dow);
  const semana = contar(lunes, fecha), semanaAnt = contar(sumarDias(lunes, -7), sumarDias(fecha, -7));
  const inicioMes = fecha.slice(0, 7) + '-01';
  const mesAnt0 = inicioMesAnterior(fecha);
  const diaN = +fecha.slice(8, 10);
  const corteAnt = mesAnt0.slice(0, 8) + String(Math.min(diaN, diasDelMes(mesAnt0))).padStart(2, '0');
  const mes = contar(inicioMes, fecha), mesAntCorte = contar(mesAnt0, corteAnt), mesAntTotal = contar(mesAnt0, sumarDias(inicioMes, -1));
  const promedio = diaN ? mes / diaN : 0;
  const proyeccion = Math.round(promedio * diasDelMes(fecha));
  const serie = Array.from({ length: diaN }, (_, k) => { const d = inicioMes.slice(0, 8) + String(k + 1).padStart(2, '0'); return { dia: d, n: (porDia[d] || []).length }; });
  const canalesMes = {}, quienMes = {};
  Object.entries(porDia).filter(([d]) => d >= inicioMes && d <= fecha).forEach(([, l]) => l.forEach((p) => {
    canalesMes[p.canal || 'Otro'] = (canalesMes[p.canal || 'Otro'] || 0) + 1;
    if (p.cargado_por && p.cargado_por !== '—') quienMes[p.cargado_por] = (quienMes[p.cargado_por] || 0) + 1;
  }));
  const tendencia = { semana, semanaAnt, mes, mesAntCorte, mesAntTotal, promedio, proyeccion, serie, canalesMes, quienMes, mejorDia: serie.reduce((m, x) => (x.n > (m ? m.n : -1) ? x : m), null) };
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
  Object.values(porDia).forEach((l) => l.forEach((p) => pagadas.add(digitos(p.cedula))));
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
  return { fecha, pagos, mes, pendientes, tendencia };
}

function htmlTendencia(fecha, t) {
  if (!t) return '';
  const nombreMes = new Intl.DateTimeFormat('es-CO', { month: 'long', timeZone: 'UTC' }).format(new Date(fecha + 'T12:00:00Z'));
  const var_ = (a, b) => { if (!b) return a ? '<span style="color:#17663b">▲ nuevo</span>' : '<span style="color:#8a979f">= sin datos previos</span>';
    const p = Math.round((a - b) * 100 / b); return p > 0 ? `<span style="color:#17663b">▲ ${p}%</span>` : p < 0 ? `<span style="color:#9b1c13">▼ ${Math.abs(p)}%</span>` : '<span style="color:#8a979f">= igual</span>'; };
  const caja = (n, t1, t2) => `<td style="padding:6px;width:25%"><div style="background:#fbfaf6;border:1px solid #e1dac5;border-radius:10px;padding:12px 14px">
    <div style="font-size:24px;font-weight:800;color:#0b1f3a;line-height:1">${n}</div><div style="font-size:12px;color:#5b6b78;margin-top:6px">${t1}</div><div style="font-size:12px;margin-top:4px">${t2}</div></div></td>`;
  const max = Math.max(1, ...t.serie.map((x) => x.n));
  const barras = t.serie.map((x) => { const h = Math.round((x.n / max) * 90); const hoy = x.dia === fecha;
    return `<td valign="bottom" align="center" style="padding:0 1px;font-size:9px;color:#5b6b78">${x.n ? `<div style="font-size:10px;color:#0b1f3a;font-weight:700">${x.n}</div>` : ''}
      <div style="width:100%;min-width:8px;height:${Math.max(h, 2)}px;background:${hoy ? '#b6912f' : x.n ? '#1f5c4d' : '#e1dac5'};border-radius:3px 3px 0 0"></div><div>${+x.dia.slice(8)}</div></td>`; }).join('');
  const lista = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<b>${esc(k)}</b> ${v}`).join(' · ');
  return `<h3 style="margin:24px 6px 8px;font-size:16px;color:#0b1f3a">📈 Tendencia y consolidado de ${esc(nombreMes)}</h3>
    <table style="width:100%;border-collapse:separate"><tr>
      ${caja(t.semana, 'Esta semana (lun. a hoy)', var_(t.semana, t.semanaAnt) + ' <span style="color:#8a979f">vs. ' + t.semanaAnt + ' sem. pasada</span>')}
      ${caja(t.mes, 'En el mes al corte', var_(t.mes, t.mesAntCorte) + ' <span style="color:#8a979f">vs. ' + t.mesAntCorte + ' mes pasado</span>')}
      ${caja(t.promedio.toFixed(1), 'Promedio por día', '<span style="color:#8a979f">mejor día: ' + (t.mejorDia && t.mejorDia.n ? +t.mejorDia.dia.slice(8) + ' (' + t.mejorDia.n + ')' : '—') + '</span>')}
      ${caja(t.proyeccion, 'Proyección cierre de mes', '<span style="color:#8a979f">mes pasado cerró en ' + t.mesAntTotal + '</span>')}
    </tr></table>
    <div style="margin:10px 6px 0;font-size:12px;color:#5b6b78">Pagos por día de ${esc(nombreMes)} (en dorado, hoy):</div>
    <table style="width:100%;border-collapse:collapse;margin:6px 0 4px;height:120px"><tr>${barras}</tr></table>
    ${Object.keys(t.canalesMes).length ? `<p style="font-size:13px;color:#5b6b78;margin:10px 6px 2px">En el mes por canal: ${lista(t.canalesMes)}</p>` : ''}
    ${Object.keys(t.quienMes).length ? `<p style="font-size:13px;color:#5b6b78;margin:2px 6px">En el mes por quién cargó: ${lista(t.quienMes)}</p>` : ''}`;
}

function htmlInforme({ fecha, pagos, mes, pendientes, tendencia }) {
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
    <table style="width:100%;border-collapse:separate"><tr>${kpi(pagos.length, 'Pagos cargados hoy', '#1f5c4d')}${kpi(tendencia ? tendencia.semana : 0, 'Pagos esta semana', '#1c3a63')}${kpi(mes, 'Pagos en el mes', '#b6912f')}${kpi(pendientes.length, 'Firmados sin pago', pendientes.length ? '#c0392b' : '#1f5c4d')}</tr></table>
    ${Object.keys(porCanal).length ? `<p style="font-size:13px;color:#5b6b78;margin:10px 6px">Por canal: ${Object.entries(porCanal).map(([k, v]) => `<b>${esc(k)}</b> ${v}`).join(' · ')}</p>` : ''}
    <h3 style="margin:18px 6px 8px;font-size:16px;color:#0b1f3a">✅ Pagos cargados hoy (${pagos.length})</h3>
    ${pagos.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${th('Hora')}${th('Cliente')}${th('Cédula/NIT')}${th('Canal')}${th('Cargado por')}${th('Soporte')}</tr>${pagos.map(filaPago).join('')}</table>`
      : '<p style="margin:6px;color:#5b6b78">Hoy no se cargaron soportes de pago.</p>'}
    ${htmlTendencia(fecha, tendencia)}
    <h3 style="margin:22px 6px 8px;font-size:16px;color:#0b1f3a">⏳ Pendientes de pago: contrato firmado, sin soporte (${pendientes.length})</h3>
    ${pendientes.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${th('Cliente')}${th('Cédula/NIT')}${th('Celular')}${th('Asesor')}${th('Firmó hace')}</tr>${pendientes.map(filaPend).join('')}</table>
      <p style="font-size:12px;color:#5b6b78;margin:8px 6px">En rojo: 3 días o más desde la firma. Sugerencia: llamarlos o pedirle a Daniela un seguimiento (botón "Encargar a Daniela").</p>`
      : '<p style="margin:6px;color:#5b6b78">No hay clientes con contrato firmado pendientes de pago. 🎉</p>'}
    <p style="font-size:11px;color:#8a979f;margin:20px 6px 0">Incluye los soportes de pago cargados por Daniela (asistente del panel, WhatsApp y Chattigo) y los soportes de pago que están en las carpetas de SharePoint (canal "SharePoint"; la tendencia los toma desde el mes anterior). Un pago = una cédula por día.</p>
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
    await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: lista, asunto: `📊 Pagos hoy: ${d.pagos.length} · semana: ${d.tendencia.semana} · mes: ${d.tendencia.mes} · pendientes: ${d.pendientes.length} (${fecha})`, html: htmlInforme(d), adjuntos: [] });
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
