// Informe gerencial diario del tablero "Seguimiento de clientes" (Kanban) por correo — 8:00 p. m. hora Colombia.
// - Foto del tablero: cuántos clientes hay en cada fase, días promedio y alertas.
// - Qué se movió HOY (etapas marcadas hoy y clientes nuevos que entraron a seguimiento).
// - ALERTAS: clientes con 3 días o más sin cambiar de fase (amarillo 3-9 días, rojo 10+), los más antiguos primero.
// - Top de los que más tiempo llevan en cada fase y clientes con etapas sin soporte.
// Una sola vez por día (tabla informes_diarios, tipo 'seguimiento'). Destinatarios: INFORME_SEGUIMIENTO_PARA (o la lista por defecto).
// Endpoints:  GET  /api/reportes/seguimiento/disparar  (despierta el servidor; envía si ya son las 8 p. m. y no se ha enviado)
//             POST /api/reportes/seguimiento/vista     (equipo con sesión: devuelve el HTML del informe, no envía nada)
//             POST /api/reportes/seguimiento/prueba    (equipo con sesión: lo envía SOLO a quien lo pide; máx. 1 cada 3 min)

const { createClient } = require('@supabase/supabase-js');

const PARA_DEFECTO = ['auxiliar@bpogs.com', 'jcifuentes@bpogs.com', 'arolong@bpogs.com', 'aarcila@bpogs.com'];
const HORA_ENVIO = () => String(process.env.INFORME_SEGUIMIENTO_HORA || '20:00');
const UMBRAL = () => Number(process.env.INFORME_SEGUIMIENTO_UMBRAL || 3);      // días sin moverse para entrar en alerta
const ROJO = 10;
const PANEL_URL = () => process.env.PANEL_URL || 'https://gomezlegal.netlify.app';

const ETAPAS = [
  { campo: 'fecha_pendiente_registro_upme', label: 'Registro UPME', soporte: 'soporte_registro_upme' },
  { campo: 'fecha_pendiente_pago_upme', label: 'Pendiente pago UPME', soporte: 'soporte_pago_upme' },
  { campo: 'fecha_pendiente_certificado_upme', label: 'Certificado UPME solicitado', soporte: 'soporte_certificado_solicitado' },
  { campo: 'fecha_certificado_upme_emitido', label: 'Certificado UPME emitido', soporte: 'soporte_certificado_emitido' },
  { campo: 'fecha_pendiente_cita_dian', label: 'Pendiente cita DIAN' },
  { campo: 'fecha_agendado_dian', label: 'Agendado DIAN', soporte: 'soporte_agendado_dian' },
  { campo: 'fecha_radicado_dian', label: 'Radicado DIAN', soporte: 'soporte_radicado_dian' },
  { campo: 'fecha_desembolso', label: 'Desembolso' },
];
const FASES = ['Cliente nuevo'].concat(ETAPAS.map((e) => e.label)); // índice = pasoActivo (0 = nuevo, 8 = desembolsado)
const N = ETAPAS.length;
const PREVIAS_CON_CERT = 3;

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let _sb = null;
const sb = () => (_sb = _sb || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));
const fechaBog = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
const horaBog = (d = new Date()) => new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const diaDe = (v) => { if (!v) return ''; const s = String(v); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const d = new Date(s); return isNaN(d) ? '' : fechaBog(d); };
const diasEntre = (desde, hasta) => Math.max(0, Math.round((Date.parse(hasta + 'T12:00:00Z') - Date.parse(desde + 'T12:00:00Z')) / 86400000));
const sinTildes = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const fechaLarga = (f) => new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(f + 'T12:00:00Z'));

// Misma lógica del panel (pasoActivoCliente / etapaPrevia / clienteVigente)
const tieneCert = (c) => sinTildes(c.tiene_certificado_upme).startsWith('si tiene');
function pasoActivo(c) {
  for (let i = 0; i < N; i++) {
    if (tieneCert(c) && i < PREVIAS_CON_CERT && !c[ETAPAS[i].campo]) continue;
    if (!c[ETAPAS[i].campo]) return i;
  }
  return N;
}
function fechaEntradaFase(c, pa) {
  for (let k = Math.min(pa, N) - 1; k >= 0; k--) if (c[ETAPAS[k].campo]) return diaDe(c[ETAPAS[k].campo]);
  return diaDe(c.creado_en);
}
const faltaSoporte = (c) => ETAPAS.filter((e) => e.soporte && c[e.campo] && !c[e.soporte]).map((e) => e.label);

async function traerTodo(tabla, cols) {
  const out = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb().from(tabla).select(cols).range(desde, desde + 999);
    if (error) throw new Error(tabla + ': ' + error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function datosInforme(fecha = fechaBog()) {
  const [clientes, casos] = await Promise.all([traerTodo('BD_Cliente_GLA', '*'), traerTodo('Perfilamiento_y_ventas_GLA', 'id,estado_pipeline,vehiculo')]);
  const caso = new Map(casos.map((x) => [String(x.id), x]));
  const vig = clientes.filter((c) => { const k = c.caso_id && caso.get(String(c.caso_id)); return !k || k.estado_pipeline === 'Cliente'; });
  const U = UMBRAL();
  const filas = vig.map((c) => {
    const pa = pasoActivo(c);
    const entrada = fechaEntradaFase(c, pa) || fecha;
    const k = c.caso_id && caso.get(String(c.caso_id));
    return {
      id: c.id, nombre: c.nombre_cliente || '—', cedula: c.numero_identificacion || '', fuente: c.fuente || '',
      vehiculo: c.placa || (k && k.vehiculo) || '', pa, fase: FASES[pa], dias: diasEntre(entrada, fecha),
      diasTotal: c.creado_en ? diasEntre(diaDe(c.creado_en), fecha) : 0, sinSoporte: faltaSoporte(c),
      movHoy: ETAPAS.map((e, i) => ({ i, f: diaDe(c[e.campo]) })).filter((x) => x.f === fecha).map((x) => x.i),
      nuevoHoy: diaDe(c.creado_en) === fecha,
    };
  });
  const fases = FASES.map((label, i) => {
    const it = filas.filter((f) => f.pa === i).sort((a, b) => b.dias - a.dias);
    const activos = i < N;
    return {
      i, label, n: it.length,
      prom: it.length ? Math.round(it.reduce((s, f) => s + f.dias, 0) / it.length) : 0,
      alertas: activos ? it.filter((f) => f.dias >= U).length : 0, rojos: activos ? it.filter((f) => f.dias >= ROJO).length : 0,
      top: activos ? it.slice(0, 3) : [], items: it,
    };
  });
  const movimientos = [];
  filas.forEach((f) => {
    // un cliente que avanzó varias fases hoy sale una sola vez, con la fase más alta a la que llegó
    if (f.movHoy.length) { const i = Math.max(...f.movHoy); movimientos.push({ ...f, a: ETAPAS[i].label + (f.movHoy.length > 1 ? ` (avanzó ${f.movHoy.length} fases)` : ''), aIdx: i + 1, n: f.movHoy.length }); }
    else if (f.nuevoHoy) movimientos.push({ ...f, a: 'Cliente nuevo (entró a seguimiento)', aIdx: 0, n: 1 });
  });
  movimientos.sort((a, b) => b.aIdx - a.aIdx);
  // Movimientos de los últimos 7 días (tendencia)
  const semana = [];
  for (let d = 6; d >= 0; d--) {
    const dia = fechaBog(new Date(Date.parse(fecha + 'T12:00:00-05:00') - d * 86400000));
    semana.push({ dia, n: vig.reduce((s, c) => s + ETAPAS.filter((e) => diaDe(c[e.campo]) === dia).length, 0) });
  }
  const alertas = filas.filter((f) => f.pa < N && f.dias >= U).sort((a, b) => b.dias - a.dias);
  return {
    fecha, umbral: U, total: filas.length, enProceso: filas.filter((f) => f.pa < N).length, completos: filas.filter((f) => f.pa === N).length,
    fases, movimientos, alertas, semana, sinSoporte: filas.filter((f) => f.sinSoporte.length).sort((a, b) => b.dias - a.dias),
    estancada: fases.filter((f) => f.i < N).sort((a, b) => b.alertas - a.alertas || b.prom - a.prom)[0],
  };
}

// ---------------- HTML (tablas + estilos en línea para que se vea bien en Outlook)
const C = { verde: '#123D32', naranja: '#EE8139', fondo: '#F4F6F5', borde: '#E3E8E6', rojo: '#C0443A', ambar: '#B6720F', azul: '#26418F', ok: '#2E8B57', gris: '#6B7570' };
const td = 'padding:7px 9px;border-bottom:1px solid #EDF0EF;font-size:13px;vertical-align:top';
const th = `padding:7px 9px;background:${C.verde};color:#fff;font-size:12px;text-align:left;font-weight:600`;
const pill = (d, U) => { const col = d >= ROJO ? C.rojo : d >= U ? C.ambar : C.ok; return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${col};color:#fff;font-size:12px;font-weight:700">${d} ${d === 1 ? 'día' : 'días'}</span>`; };

function htmlInforme(d) {
  const U = d.umbral;
  const kpi = (lab, n, sub, col) => `<td style="padding:6px" width="25%"><div style="background:#fff;border:1px solid ${C.borde};border-top:4px solid ${col};border-radius:8px;padding:12px 10px">
    <div style="font-size:12px;color:${C.gris}">${lab}</div><div style="font-size:26px;font-weight:800;color:${col};line-height:1.2">${n}</div><div style="font-size:11px;color:${C.gris}">${sub}</div></div></td>`;
  const maxN = Math.max(1, ...d.fases.map((f) => f.n));
  const filaFase = (f) => `<tr>
    <td style="${td}"><b>${f.i + 1}. ${esc(f.label)}</b></td>
    <td style="${td};text-align:center;font-weight:700">${f.n}</td>
    <td style="${td};width:34%"><div style="background:#EDF0EF;border-radius:4px;height:12px"><div style="width:${Math.round((f.n / maxN) * 100)}%;background:${f.i === N ? C.ok : C.naranja};height:12px;border-radius:4px"></div></div></td>
    <td style="${td};text-align:center">${f.i === N ? '—' : f.prom + ' d'}</td>
    <td style="${td};text-align:center">${f.i === N ? '—' : f.alertas ? `<b style="color:${f.rojos ? C.rojo : C.ambar}">${f.alertas}</b>${f.rojos ? ` <span style="color:${C.rojo};font-size:11px">(${f.rojos} rojo)</span>` : ''}` : `<span style="color:${C.ok}">0</span>`}</td></tr>`;
  const maxS = Math.max(1, ...d.semana.map((s) => s.n));
  const barrasSemana = d.semana.map((s) => `<td style="vertical-align:bottom;text-align:center;padding:0 4px" width="14%">
      <div style="font-size:11px;font-weight:700;color:${C.verde}">${s.n}</div>
      <div style="height:${Math.max(3, Math.round((s.n / maxS) * 60))}px;background:${s.dia === d.fecha ? C.naranja : '#9DB7AE'};border-radius:3px 3px 0 0"></div>
      <div style="font-size:10px;color:${C.gris};padding-top:3px">${new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'short', day: 'numeric' }).format(new Date(s.dia + 'T12:00:00Z'))}</div></td>`).join('');
  const movHtml = d.movimientos.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><th style="${th}">Cliente</th><th style="${th}">Pasó a</th><th style="${th}">Vehículo</th></tr>` +
      d.movimientos.map((m) => `<tr><td style="${td}"><b>${esc(m.nombre)}</b><br><span style="color:${C.gris};font-size:11px">CC ${esc(m.cedula)}${m.fuente ? ' · ' + esc(m.fuente) : ''}</span></td>
        <td style="${td}">➡ <b style="color:${m.aIdx === N ? C.ok : C.verde}">${esc(m.a)}</b></td><td style="${td}">${esc(m.vehiculo)}</td></tr>`).join('') + '</table>'
    : `<div style="padding:12px;background:#FFF6EC;border:1px solid #F5D3AE;border-radius:8px;font-size:13px">⚠ <b>Hoy no se movió ningún cliente de fase.</b></div>`;
  const alertasPorFase = d.fases.filter((f) => f.i < N && f.alertas).map((f) => {
    const it = f.items.filter((x) => x.dias >= U);
    return `<tr><td colspan="4" style="padding:10px 9px 5px;font-size:13px;font-weight:800;color:${C.verde};border-bottom:2px solid ${C.naranja}">${f.i + 1}. ${esc(f.label)} · ${it.length} sin moverse</td></tr>` +
      it.map((x) => `<tr><td style="${td}"><b>${esc(x.nombre)}</b><br><span style="color:${C.gris};font-size:11px">CC ${esc(x.cedula)}${x.vehiculo ? ' · ' + esc(x.vehiculo) : ''}</span></td>
        <td style="${td};text-align:center">${pill(x.dias, U)}</td><td style="${td};text-align:center;color:${C.gris}">${x.diasTotal} d</td>
        <td style="${td};font-size:12px">${x.sinSoporte.length ? `<span style="color:${C.rojo}">⚠ Falta soporte: ${esc(x.sinSoporte.join(', '))}</span>` : (x.fuente ? esc(x.fuente) : '')}</td></tr>`).join('');
  }).join('');
  const topHtml = d.fases.filter((f) => f.i < N && f.top.length).map((f) => `<tr><td style="${td};width:30%"><b>${esc(f.label)}</b></td><td style="${td}">${f.top.map((x) => `${esc(x.nombre)} ${pill(x.dias, U)}`).join('<br>')}</td></tr>`).join('');
  const est = d.estancada;
  const lectura = [
    `Hay <b>${d.total}</b> clientes en seguimiento: <b>${d.enProceso}</b> en proceso y <b>${d.completos}</b> con desembolso.`,
    `Hoy se registraron <b>${d.movimientos.length}</b> movimientos${d.movimientos.length ? '' : ' (el tablero no avanzó)'}; en los últimos 7 días, <b>${d.semana.reduce((s, x) => s + x.n, 0)}</b>.`,
    `<b>${d.alertas.length}</b> clientes llevan ${U} días o más sin cambiar de fase${d.alertas.filter((x) => x.dias >= ROJO).length ? `, de ellos <b style="color:${C.rojo}">${d.alertas.filter((x) => x.dias >= ROJO).length}</b> con ${ROJO} días o más` : ''}.`,
    est && est.alertas ? `La fase más represada es <b>${esc(est.label)}</b>: ${est.alertas} de ${est.n} clientes en alerta (promedio ${est.prom} días en la fase).` : '',
    d.sinSoporte.length ? `<b>${d.sinSoporte.length}</b> clientes tienen etapas marcadas sin su soporte adjunto.` : '',
  ].filter(Boolean).map((t) => `<li style="margin-bottom:5px">${t}</li>`).join('');
  const sec = (titulo, sub, cuerpo) => `<tr><td style="padding:18px 22px 4px"><div style="font-size:16px;font-weight:800;color:${C.verde}">${titulo}</div>${sub ? `<div style="font-size:12px;color:${C.gris};margin-top:2px">${sub}</div>` : ''}<div style="margin-top:10px">${cuerpo}</div></td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Informe Seguimiento de clientes ${d.fecha}</title></head>
<body style="margin:0;background:${C.fondo};font-family:Segoe UI,Arial,sans-serif;color:#1F2A26">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.fondo}"><tr><td align="center" style="padding:18px 8px">
<table width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${C.borde}">
  <tr><td style="background:${C.verde};padding:20px 22px;color:#fff">
    <div style="font-size:12px;letter-spacing:1px;color:#FFD9B8">GÓMEZ LEGAL · INFORME GERENCIAL</div>
    <div style="font-size:22px;font-weight:800;margin-top:4px">Seguimiento de clientes</div>
    <div style="font-size:13px;margin-top:4px;color:#D8E6E1">${esc(fechaLarga(d.fecha))} · corte ${esc(horaBog())} (hora Colombia)</div></td></tr>
  <tr><td style="padding:14px 16px 0"><table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${kpi('Clientes en seguimiento', d.total, 'tablero completo', C.azul)}${kpi('Movimientos hoy', d.movimientos.length, 'clientes que avanzaron hoy', C.naranja)}
    ${kpi(`En alerta (${U}+ días)`, d.alertas.length, `${d.alertas.filter((x) => x.dias >= ROJO).length} con ${ROJO}+ días`, C.rojo)}${kpi('Desembolsados', d.completos, 'proceso completo', C.ok)}</tr></table></td></tr>
  ${sec('🧭 Lectura del día', '', `<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5">${lectura}</ul>`)}
  ${sec('📋 Así está el tablero', 'Clientes por fase (dónde están hoy), días promedio en la fase y cuántos están en alerta', `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
     <tr><th style="${th}">Fase</th><th style="${th};text-align:center">Clientes</th><th style="${th}">Volumen</th><th style="${th};text-align:center">Prom. días</th><th style="${th};text-align:center">En alerta</th></tr>${d.fases.map(filaFase).join('')}</table>`)}
  ${sec('🔄 Qué se movió hoy', `${d.movimientos.length} clientes avanzaron o entraron el ${esc(d.fecha)}`, movHtml)}
  ${sec('📈 Movimientos de los últimos 7 días', '', `<table width="100%" cellpadding="0" cellspacing="0"><tr>${barrasSemana}</tr></table>`)}
  ${sec(`🚨 Alertas: clientes sin moverse ${U} días o más`, `Por fase, el más antiguo primero. <span style="color:${C.ambar}">■</span> ${U}-${ROJO - 1} días · <span style="color:${C.rojo}">■</span> ${ROJO}+ días. "Total" = días desde que entró a seguimiento.`,
      alertasPorFase ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><th style="${th}">Cliente</th><th style="${th};text-align:center">En la fase</th><th style="${th};text-align:center">Total</th><th style="${th}">Nota</th></tr>${alertasPorFase}</table>`
        : `<div style="padding:12px;background:#EEF8F2;border:1px solid #BFE3CD;border-radius:8px;font-size:13px">✅ Ningún cliente lleva ${U} días o más sin moverse.</div>`)}
  ${topHtml ? sec('⏳ Los que más tiempo llevan en cada fase', 'Top 3 por fase', `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${topHtml}</table>`) : ''}
  <tr><td style="padding:20px 22px"><a href="${esc(PANEL_URL())}" style="display:inline-block;background:${C.naranja};color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;font-size:14px">Abrir el panel de Seguimiento</a>
    <div style="font-size:11px;color:${C.gris};margin-top:14px">Informe automático de las ${esc(HORA_ENVIO())} · Gómez Legal Abogados S.A.S. · Tecnología por BPO Global Services. Uso interno: no reenviar fuera del equipo.</div></td></tr>
</table></td></tr></table></body></html>`;
}

async function enviarInforme({ fecha = fechaBog(), para, forzar = false } = {}) {
  const sp = require('./sharepoint');
  const { REMITENTE } = require('./correo_cita');
  if (!forzar) {
    const { error } = await sb().from('informes_diarios').insert({ tipo: 'seguimiento', fecha });
    if (error) return { enviado: false, motivo: /duplicate|23505/.test(error.message + error.code) ? 'ya se envió hoy' : error.message };
  }
  try {
    const d = await datosInforme(fecha);
    const env = String(process.env.INFORME_SEGUIMIENTO_PARA || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    const lista = para || (env.length ? env : PARA_DEFECTO);
    const asunto = `📋 Seguimiento clientes ${fecha} · ${d.movimientos.length} movimientos hoy · ${d.alertas.length} en alerta (${d.umbral}+ días) · ${d.total} en tablero`;
    await sp.enviarCorreo({ remitente: REMITENTE(), destinatarios: lista, asunto, html: htmlInforme(d), adjuntos: [] });
    console.log(`[seguimiento] informe ${fecha} enviado a ${lista.join(', ')} (${d.movimientos.length} mov., ${d.alertas.length} alertas)`);
    return { enviado: true, para: lista, movimientos: d.movimientos.length, alertas: d.alertas.length };
  } catch (e) {
    if (!forzar) await sb().from('informes_diarios').delete().eq('tipo', 'seguimiento').eq('fecha', fecha); // se reintenta en el siguiente minuto
    throw e;
  }
}

function montarInformeSeguimiento(app, { exigirEquipo } = {}) {
  let enCurso = false;
  async function revisar() {
    if (enCurso || horaBog() < HORA_ENVIO()) return null;
    enCurso = true;
    try { return await enviarInforme(); } catch (e) { console.error('[seguimiento] informe:', e.message); return { enviado: false, motivo: e.message }; } finally { enCurso = false; }
  }
  setInterval(revisar, 60e3);
  app.get('/api/reportes/seguimiento/disparar', async (req, res) => {
    const r = await revisar();
    res.json(r || { enviado: false, motivo: `aún no son las ${HORA_ENVIO()} (hora Colombia: ${horaBog()})` });
  });
  app.post('/api/reportes/seguimiento/vista', async (req, res) => {
    const ctx = exigirEquipo ? await exigirEquipo(req, res) : {}; if (!ctx) return;
    try { const d = await datosInforme(); res.json({ ok: true, html: htmlInforme(d), movimientos: d.movimientos.length, alertas: d.alertas.length }); }
    catch (e) { res.status(500).json({ error: 'No pude armar el informe: ' + e.message }); }
  });
  let ultimaPrueba = 0;
  app.post('/api/reportes/seguimiento/prueba', async (req, res) => {
    const ctx = exigirEquipo ? await exigirEquipo(req, res) : null; if (!ctx) return;
    if (Date.now() - ultimaPrueba < 3 * 60e3) return res.json({ enviado: false, motivo: 'Espera 3 minutos entre pruebas.' });
    ultimaPrueba = Date.now();
    try { res.json(await enviarInforme({ forzar: true, para: [ctx.email] })); } catch (e) { res.status(500).json({ enviado: false, motivo: e.message }); }
  });
}

module.exports = { montarInformeSeguimiento, datosInforme, htmlInforme, enviarInforme, pasoActivo };
