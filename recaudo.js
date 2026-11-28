// CONTROL DE PAGOS (honorarios) — 27/11/2026
// - Busca en TODAS las carpetas de clientes de SharePoint los soportes de pago (no UPME).
// - La IA lee cada soporte: valor, fecha de pago, medio y referencia. Queda en la tabla pagos_honorarios
//   (una fila por archivo; nunca se lee dos veces el mismo archivo).
// - Cruza con BD_Cliente_GLA / Perfilamiento: fecha en que se creó el cliente, convenio y teléfono.
// - El equipo revisa/corrige en el panel (pestaña "Control de pagos"); también se pueden registrar pagos a mano.
// Tabla: pagos_honorarios.sql
//
// POST /api/pagos/escanear {mes:'AAAA-MM'}   → inicia la búsqueda en SharePoint (en segundo plano)
// GET  /api/pagos/escanear/estado            → avance de la búsqueda
// GET  /api/pagos/lista?mes=AAAA-MM          → pagos del mes
// POST /api/pagos/editar {id, ...}           → corrige valor/fecha/estado/nota
// POST /api/pagos/manual {...}               → registra un pago a mano
// GET  /api/pagos/auto                       → (tarea programada) busca los del mes actual, máx. 1 vez cada 3 h

const digitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');
const fechaBog = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
const finDeMes = (mes) => { const d = new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };
const sumarDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ES_PAGO = /pago|comprobante|transferencia|consignaci|recibo|soporte de pago|nequi|daviplata|bancolombia|pse/i;

function convenioDe(t) {
  t = String(t || '').toLowerCase();
  if (t.includes('sura')) return 'SURA';
  if (t.includes('epm') || t.includes('fepep')) return 'EPM';
  if (t.includes('confamilia') || t.includes('familia')) return 'Confamilia';
  if (t.includes('referix')) return 'ReferiX';
  if (/\brrss\b|redes|instagram/.test(t)) return 'Redes Daniela';
  return t ? 'Otros' : 'Sin dato';
}

// Supabase entrega máximo 1.000 filas por consulta: se trae por páginas.
async function todo(hacer) { const out = []; for (let i = 0; i < 50; i++) { const { data, error } = await hacer().range(i * 1000, i * 1000 + 999); if (error) return { data: out, error }; out.push(...(data || [])); if (!data || data.length < 1000) break; } return { data: out, error: null }; }

const PROMPT = `Eres auxiliar contable de Gómez Legal Abogados. Te muestro UN archivo de la carpeta de un cliente que parece un soporte de pago.
Responde SOLO un JSON válido, sin texto extra:
{"es_pago":true|false,"es_upme":true|false,"valor":numero_en_pesos_o_null,"fecha_pago":"AAAA-MM-DD" o null,"medio":"Bancolombia|Nequi|Daviplata|PSE|Davivienda|Efectivo|Otro" o null,"referencia":"número de comprobante/aprobación" o null,"pagador":"nombre de quien paga" o null,"destinatario":"a quién se pagó" o null,"observacion":"texto corto" o null}
Reglas:
- es_pago=true solo si es un comprobante real de un pago/transferencia ya hecho (no una factura de compra del carro, no una certificación bancaria, no un RUT).
- es_upme=true si el pago es a la UPME (Unidad de Planeación Minero Energética, tarifa del certificado) y no a Gómez Legal.
- valor: el monto pagado, en pesos, número sin puntos ni signos (ej. 352000). Si hay varios, el total transferido.
- fecha_pago: la fecha de la transacción.`;

async function leerSoporte(buf, mime, nombre, llamarClaude) {
  const b64 = buf.toString('base64');
  let bloque = null;
  if (/pdf/i.test(mime || '') || /\.pdf$/i.test(nombre || '')) bloque = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else {
    const m = String(mime || '').toLowerCase();
    const tipo = /png/.test(m) || /\.png$/i.test(nombre) ? 'image/png' : /webp/.test(m) ? 'image/webp' : /gif/.test(m) ? 'image/gif' : (/jpe?g/.test(m) || /\.jpe?g$/i.test(nombre) ? 'image/jpeg' : null);
    if (tipo) bloque = { type: 'image', source: { type: 'base64', media_type: tipo, data: b64 } };
  }
  if (!bloque) return null;
  if (buf.length > 18 * 1024 * 1024) return null;
  const txt = await llamarClaude(PROMPT, [{ role: 'user', content: [bloque, { type: 'text', text: 'Archivo: ' + nombre }] }]);
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function montarRecaudo(app, { exigirEquipo, sbServicio }) {
  const sp = require('./sharepoint');
  const llamarClaude = (s, m) => require('./wasapi').ia.llamarClaude(s, m);
  const estado = { corriendo: false, mes: null, carpetas: 0, revisadas: 0, soportes: 0, nuevos: 0, errores: 0, inicio: null, fin: null, ultimo_error: null };
  let ultimoAuto = 0;

  async function datosCliente(sb, ced) {
    if (!ced) return {};
    const { data: clis } = await sb.from('BD_Cliente_GLA').select('*').eq('numero_identificacion', ced).limit(5);
    let cli = (clis || [])[0];
    if (!cli) { const r = await sb.from('BD_Cliente_GLA').select('*').ilike('numero_identificacion', '%' + ced + '%').limit(1); cli = (r.data || [])[0]; }
    let caso = null;
    if (cli && cli.caso_id) { const r = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('id', cli.caso_id).maybeSingle(); caso = r.data; }
    if (!caso) { const r = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('numero_identificacion', ced).limit(1); caso = (r.data || [])[0] || null; }
    const fuente = (cli && cli.fuente) || (caso && caso.fuente) || (caso && caso.campana) || '';
    return {
      cliente_id: cli ? String(cli.id) : null, caso_id: caso ? String(caso.id) : (cli && cli.caso_id ? String(cli.caso_id) : null),
      nombre: (cli && cli.nombre_cliente) || (caso && (caso.nombre_cliente || caso.nombre)) || null,
      telefono: digitos((cli && cli.telefono) || (caso && (caso.telefono || caso.celular)) || '').slice(-10) || null,
      convenio: convenioDe(fuente),
      fecha_creacion_cliente: (cli && (cli.creado_en || cli.created_at)) || null,
      fecha_lead: (caso && (caso.created_at || caso.creado_en)) || null,
    };
  }

  async function escanear(mes, soloCarpetas) {
    if (estado.corriendo) return;
    Object.assign(estado, { corriendo: true, mes, carpetas: 0, revisadas: 0, soportes: 0, nuevos: 0, errores: 0, inicio: new Date().toISOString(), fin: null, ultimo_error: null });
    const sb = sbServicio();
    // mes = 'todo' → todo el historial (todas las fechas)
    const sinFecha = mes === 'todo' || mes === 'clientes';
    const desde = sinFecha ? '2000-01-01' : mes + '-01';
    const hasta = sinFecha ? sumarDias(fechaBog(), 1) : sumarDias(finDeMes(mes), 10); // un soporte del 30 se puede subir unos días después
    try {
      if (!sp.configurado || !sp.configurado()) throw new Error('SharePoint no está configurado en el servidor');
      let carpetas = (await sp.listarCarpetasClientes()) || [];
      if (Array.isArray(soloCarpetas)) { const set = new Set(soloCarpetas.map(String)); carpetas = carpetas.filter((c) => set.has(String(c.id))); }
      estado.carpetas = carpetas.length;
      const { data: ya, error: errYa } = await todo(() => sb.from('pagos_honorarios').select('id,sp_item_id').not('sp_item_id', 'is', null).order('id'));
      if (errYa && /does not exist|schema cache|relation/i.test(errYa.message)) throw new Error('Falta crear la tabla pagos_honorarios (ejecutar pagos_honorarios.sql en Supabase)');
      const vistos = new Set((ya || []).map((x) => x.sp_item_id));
      let i = 0;
      const trabajar = async () => {
        while (i < carpetas.length) {
          const c = carpetas[i++];
          try {
            const r = await sp.listarDocumentosDeCarpeta(String(c.id));
            for (const a of (r && r.archivos) || []) {
              if (a.subcarpeta && /^paquete dian/i.test(a.subcarpeta)) continue;
              const texto = String(a.tipo || '') + ' ' + String(a.nombre || '');
              if (!ES_PAGO.test(texto) || /upme/i.test(a.nombre || '') || /certificaci[oó]n bancaria|bancaria/i.test(texto)) continue;
              const dia = a.modificado ? fechaBog(new Date(a.modificado)) : '';
              if (!dia || dia < desde || dia > hasta) continue;
              estado.soportes++;
              if (vistos.has(a.id)) continue;
              vistos.add(a.id);
              const ced = digitos(c.cedula || String(c.nombre || '').split('-')[0]);
              const nomCarpeta = String(c.nombre || '').replace(/^\s*\d+\s*-\s*/, '').trim();
              let leido = null, link = r.webUrl || null, err = null;
              try {
                const e = await sp.enlaceDeArchivo(a.id);
                link = e.webUrl || link;
                const resp = await fetch(e.url);
                if (!resp.ok) throw new Error('descarga ' + resp.status);
                const buf = Buffer.from(await resp.arrayBuffer());
                leido = await leerSoporte(buf, e.mime || a.mime, a.nombre, llamarClaude);
              } catch (e) { err = e.message; }
              const cli = await datosCliente(sb, ced).catch(() => ({}));
              const noEs = leido && (leido.es_pago === false || leido.es_upme === true);
              const fila = {
                sp_item_id: a.id, cedula: ced || null, nombre: cli.nombre || nomCarpeta || null, telefono: cli.telefono || null,
                cliente_id: cli.cliente_id || null, caso_id: cli.caso_id || null, convenio: cli.convenio || 'Sin dato',
                fecha_creacion_cliente: cli.fecha_creacion_cliente || null, fecha_lead: cli.fecha_lead || null,
                fecha_pago: (leido && /^\d{4}-\d{2}-\d{2}$/.test(String(leido.fecha_pago || '')) ? leido.fecha_pago : dia),
                valor: leido && Number(leido.valor) > 0 ? Math.round(Number(leido.valor)) : null,
                medio: (leido && leido.medio) || null, referencia: (leido && leido.referencia) ? String(leido.referencia).slice(0, 80) : null,
                archivo: a.nombre, link, carpeta_link: r.webUrl || null, origen: 'SharePoint',
                estado: noEs ? 'no_es_pago' : 'por_revisar',
                nota: noEs ? (leido.es_upme ? 'La IA lo leyó como pago a la UPME' : 'La IA no lo reconoce como comprobante de pago') : (err ? 'No se pudo leer: ' + err : (!leido ? 'Revisar a mano: la IA no pudo leer el archivo' : null)),
                leido_ia: leido || null, subido_en: a.modificado || null,
              };
              const { error } = await sb.from('pagos_honorarios').insert(fila);
              if (error) { estado.errores++; estado.ultimo_error = error.message; if (/does not exist|relation/i.test(error.message)) throw new Error('Falta crear la tabla pagos_honorarios (ejecutar pagos_honorarios.sql en Supabase)'); }
              else estado.nuevos++;
            }
          } catch (e) { if (/Falta crear la tabla/.test(e.message)) throw e; estado.errores++; estado.ultimo_error = e.message; }
          estado.revisadas++;
        }
      };
      await Promise.all(Array.from({ length: 5 }, trabajar));
    } catch (e) { estado.ultimo_error = e.message; console.error('[recaudo]', e.message); }
    estado.corriendo = false; estado.fin = new Date().toISOString();
    console.log(`[recaudo] ${mes}: ${estado.revisadas}/${estado.carpetas} carpetas, ${estado.soportes} soportes, ${estado.nuevos} nuevos, ${estado.errores} errores`);
  }

  const mesValido = (m) => (m === 'todo' || /^\d{4}-\d{2}$/.test(String(m || '')) ? m : fechaBog().slice(0, 7));

  app.post('/api/pagos/escanear', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    // 28/11/2026: la búsqueda SIEMPRE revisa todas las fechas (lo ya leído no se vuelve a leer), así nunca se queda un mes por fuera.
    if (!estado.corriendo) escanear('todo');
    res.json(estado);
  });
  app.get('/api/pagos/escanear/estado', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    res.json(estado);
  });
  app.get('/api/pagos/auto', (req, res) => {
    if (!estado.corriendo && Date.now() - ultimoAuto > 3 * 3600e3) { ultimoAuto = Date.now(); escanear('todo'); }
    res.json({ ok: true, corriendo: estado.corriendo });
  });

  app.get('/api/pagos/lista', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const mes = mesValido(req.query.mes);
    const sb = sbServicio();
    const { data, error } = await todo(() => { let q = sb.from('pagos_honorarios').select('*'); if (mes !== 'todo') q = q.gte('fecha_pago', mes + '-01').lte('fecha_pago', finDeMes(mes)); return q.order('fecha_pago', { ascending: true }).order('id'); });
    if (error) return res.status(500).json({ error: /does not exist|schema cache|relation/i.test(error.message) ? 'Falta crear la tabla pagos_honorarios: ejecuta pagos_honorarios.sql en Supabase.' : error.message });
    res.json({ mes, pagos: data || [], escaneo: estado });
  });

  const CAMPOS_EDIT = ['valor', 'fecha_pago', 'estado', 'nota', 'medio', 'referencia', 'convenio', 'nombre', 'telefono'];
  app.post('/api/pagos/editar', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: 'Falta id' });
    const cambios = {};
    for (const k of CAMPOS_EDIT) if (k in b) cambios[k] = b[k] === '' ? null : b[k];
    if ('valor' in cambios && cambios.valor != null) cambios.valor = Math.round(Number(digitos(cambios.valor)) || 0) || null;
    if ('estado' in cambios && !['por_revisar', 'confirmado', 'no_es_pago', 'duplicado'].includes(cambios.estado)) return res.status(400).json({ error: 'Estado no válido' });
    // Corregir la cédula: se vuelve a cruzar con el cliente correcto (nombre, teléfono, convenio, fechas).
    if (b.cedula !== undefined && digitos(b.cedula)) {
      cambios.cedula = digitos(b.cedula);
      const cli = await datosCliente(sbServicio(), cambios.cedula).catch(() => ({}));
      Object.assign(cambios, { cliente_id: cli.cliente_id || null, caso_id: cli.caso_id || null, telefono: cli.telefono || null, fecha_creacion_cliente: cli.fecha_creacion_cliente || null, fecha_lead: cli.fecha_lead || null });
      if (cli.nombre) cambios.nombre = cli.nombre;
      if (cli.convenio) cambios.convenio = cli.convenio;
    }
    cambios.revisado_por = ctx.email; cambios.revisado_en = new Date().toISOString();
    const { data, error } = await sbServicio().from('pagos_honorarios').update(cambios).eq('id', b.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, pago: data });
  });

  // Confirmar varios pagos de una vez (los que ya tienen valor leído)
  app.post('/api/pagos/confirmar-varios', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 2000) : [];
    if (!ids.length) return res.json({ ok: true, n: 0 });
    const { data, error } = await sbServicio().from('pagos_honorarios').update({ estado: 'confirmado', revisado_por: ctx.email, revisado_en: new Date().toISOString() })
      .in('id', ids).eq('estado', 'por_revisar').not('valor', 'is', null).select('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, n: (data || []).length });
  });

  app.post('/api/pagos/manual', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const b = req.body || {};
    const ced = digitos(b.cedula);
    const valor = Math.round(Number(digitos(b.valor)) || 0);
    if (!ced || !valor || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_pago || ''))) return res.status(400).json({ error: 'Faltan cédula, valor o fecha de pago.' });
    const sb = sbServicio();
    const cli = await datosCliente(sb, ced).catch(() => ({}));
    const { data, error } = await sb.from('pagos_honorarios').insert({
      cedula: ced, nombre: b.nombre || cli.nombre || null, telefono: cli.telefono || null, cliente_id: cli.cliente_id || null, caso_id: cli.caso_id || null,
      convenio: cli.convenio || 'Sin dato', fecha_creacion_cliente: cli.fecha_creacion_cliente || null, fecha_lead: cli.fecha_lead || null,
      fecha_pago: b.fecha_pago, valor, medio: b.medio || null, referencia: b.referencia || null, nota: b.nota || null,
      origen: 'Manual', estado: 'confirmado', revisado_por: ctx.email, revisado_en: new Date().toISOString(),
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, pago: data });
  });

  // CRUCE: clientes (estado Cliente) SIN soporte de pago, y pagos de personas que NO están en estado Cliente.
  const normNom = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-zñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  async function cruceDatos(sb) {
    const [casosR, clisR, pagosR] = await Promise.all([
      todo(() => sb.from('Perfilamiento_y_ventas_GLA').select('*').order('id')),
      todo(() => sb.from('BD_Cliente_GLA').select('*').order('id')),
      todo(() => sb.from('pagos_honorarios').select('*').in('estado', ['por_revisar', 'confirmado']).order('id')),
    ]);
    if (pagosR.error) throw new Error(/does not exist|schema cache|relation/i.test(pagosR.error.message) ? 'Falta crear la tabla pagos_honorarios en Supabase.' : pagosR.error.message);
    const casos = casosR.data || [], clis = clisR.data || [], pagos = pagosR.data || [];
    let carpetas = [];
    try { if (sp.configurado && sp.configurado()) carpetas = (await sp.listarCarpetasClientes()) || []; } catch (e) { console.error('[recaudo] carpetas:', e.message); }
    const carpetaDe = {}; carpetas.forEach((c) => { const k = digitos(c.cedula); if (k && !carpetaDe[k]) carpetaDe[k] = c; });
    // Si la cédula del caso no tiene carpeta, se busca la carpeta por NOMBRE (todas las palabras del nombre de la carpeta están en el nombre del cliente).
    const carpetaPorNombre = (nombre) => {
      const t = new Set(normNom(nombre)); if (t.size < 2) return null;
      const hall = carpetas.filter((c) => { const w = normNom(String(c.nombre || '').replace(/^\s*\d+\s*-\s*/, '')); return w.length >= 2 && w.every((x) => t.has(x)); });
      return hall.length === 1 ? hall[0] : null;
    };
    const cliDe = {}; clis.forEach((c) => { const k = digitos(c.numero_identificacion); if (k && !cliDe[k]) cliDe[k] = c; });
    const pagadas = {}; pagos.forEach((p) => { const k = digitos(p.cedula); if (k) (pagadas[k] = pagadas[k] || []).push(p); });
    const estadoDe = {}; casos.forEach((c) => { const k = digitos(c.numero_identificacion); if (!k) return; const e = estadoDe[k]; if (!e || c.estado_pipeline === 'Cliente') estadoDe[k] = c; });
    const hoy = Date.now();
    const cedEquiv = {}; // cédula de la carpeta ↔ cédula del caso cuando difieren

    const sinSoporte = [], clientes = [];
    // Un cliente puede tener 2 o 3 vehículos (un caso por vehículo, misma cédula) y pagar uno por cada uno.
    const cliPorCaso = {}; clis.forEach((x) => { if (x.caso_id != null) cliPorCaso[String(x.caso_id)] = x; });
    const casosCliente = casos.filter((c) => c.estado_pipeline === 'Cliente');
    const vehPorCed = {}; casosCliente.forEach((c) => { const k = digitos(c.numero_identificacion); if (k) (vehPorCed[k] = vehPorCed[k] || []).push(c); });
    Object.values(vehPorCed).forEach((l) => l.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id))));
    casosCliente.forEach((c) => {
      const k = digitos(c.numero_identificacion);
      const nombre = c.nombre_cliente || (cliDe[k] && cliDe[k].nombre_cliente) || '';
      let car = (k && carpetaDe[k]) || null, por = car ? 'cedula' : null;
      if (!car) { car = carpetaPorNombre(nombre); if (car) por = 'nombre'; }
      const cedCarpeta = car ? digitos(car.cedula) : '';
      if (cedCarpeta && k && cedCarpeta !== k) { cedEquiv[cedCarpeta] = k; }
      const cli = cliPorCaso[String(c.id)] || cliDe[k] || null;
      const desde = (cli && cli.creado_en) || c.created_at || null;
      const grupo = (k && vehPorCed[k]) || [c], nVeh = grupo.length, idxVeh = Math.max(0, grupo.indexOf(c));
      const placa = (cli && cli.placa) || c.placa || '';
      // Ficha de TODOS los clientes (hoja "Clientes": cuadra el total con / sin soporte)
      const susPagos = (k && pagadas[k]) || (cedCarpeta && pagadas[cedCarpeta]) || [];
      const ult = susPagos.slice().sort((a, b) => String(b.fecha_pago).localeCompare(String(a.fecha_pago)))[0];
      clientes.push({ caso_id: c.id, nombre, cedula: k || '', telefono: digitos(c.telefono || (cli && cli.telefono) || '').slice(-10),
        fuente: c.fuente || (cli && cli.fuente) || c.campana || '', convenio: convenioDe(c.fuente || (cli && cli.fuente) || c.campana), asesor: c.asesor || '', servicio: c.servicio_contratado || '',
        placa, vehiculos: nVeh, vehiculo_n: idxVeh + 1,
        cliente_desde: desde, estado_pago: !susPagos.length ? 'sin_soporte' : susPagos.length < nVeh && idxVeh >= susPagos.length ? 'parcial' : susPagos.some((x) => x.estado === 'confirmado') ? 'confirmado' : 'por_revisar',
        n_pagos: susPagos.length, valor: susPagos.reduce((a, x) => a + (Number(x.valor) || 0), 0), sin_valor: susPagos.some((x) => !x.valor), ultimo_pago: ult ? ult.fecha_pago : null,
        carpeta_id: car ? car.id : null, carpeta_link: car ? car.webUrl : null, cedula_carpeta: cedCarpeta && cedCarpeta !== k ? cedCarpeta : null });
      // Ya tiene pago (con su cédula o la de su carpeta). Con varios vehículos: falta pago si hay menos pagos que vehículos.
      if (susPagos.length && (susPagos.length >= nVeh || idxVeh < susPagos.length)) return;
      sinSoporte.push({ caso_id: c.id, cliente_id: cli ? cli.id : null, nombre, cedula: k || '', telefono: digitos(c.telefono || (cli && cli.telefono) || '').slice(-10),
        fuente: c.fuente || (cli && cli.fuente) || c.campana || '', convenio: convenioDe(c.fuente || (cli && cli.fuente) || c.campana), asesor: c.asesor || '', servicio: c.servicio_contratado || '',
        cliente_desde: desde, dias: desde ? Math.floor((hoy - new Date(desde).getTime()) / 864e5) : null,
        carpeta_id: car ? car.id : null, carpeta_link: car ? car.webUrl : null, carpeta: car ? car.nombre : null, carpeta_por: por,
        cedula_carpeta: cedCarpeta && cedCarpeta !== k ? cedCarpeta : null, placa, vehiculos: nVeh, vehiculo_n: idxVeh + 1, pagos_encontrados: susPagos.length });
    });
    sinSoporte.sort((a, b) => (b.dias || 0) - (a.dias || 0));

    const pagoNoCliente = [];
    Object.entries(pagadas).forEach(([k, lista]) => {
      const caso = estadoDe[k] || estadoDe[cedEquiv[k]];
      if (caso && caso.estado_pipeline === 'Cliente') return;
      const p = lista.slice().sort((a, b) => String(b.fecha_pago).localeCompare(String(a.fecha_pago)))[0];
      pagoNoCliente.push({ pago_id: p.id, nombre: p.nombre || (caso && caso.nombre_cliente) || '', cedula: k, telefono: p.telefono || digitos(caso && caso.telefono).slice(-10), convenio: p.convenio,
        fuente: (caso && caso.fuente) || '', valor: lista.reduce((s2, x) => s2 + (Number(x.valor) || 0), 0), pagos: lista.length, fecha_pago: p.fecha_pago, link: p.link,
        estado_embudo: caso ? (caso.estado_pipeline || 'Sin estado') : 'No está en el embudo', caso_id: caso ? caso.id : null, asesor: caso ? caso.asesor || '' : '',
        carpeta_link: (carpetaDe[k] && carpetaDe[k].webUrl) || p.carpeta_link || null });
    });
    pagoNoCliente.sort((a, b) => String(b.fecha_pago).localeCompare(String(a.fecha_pago)));
    clientes.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    return { sinSoporte, pagoNoCliente, clientes, carpetasLeidas: carpetas.length };
  }
  app.get('/api/pagos/cruce', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    try { res.json(await cruceDatos(sbServicio())); }
    catch (e) { console.error('[recaudo] cruce:', e.message); res.status(500).json({ error: e.message }); }
  });
  // ---- Ajuste desde el panel, sin entrar a SharePoint ----
  // Archivos de la carpeta del cliente
  app.get('/api/pagos/archivos-carpeta', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    try {
      const r = await sp.listarDocumentosDeCarpeta(String(req.query.carpeta_id || ''));
      const { data: usados } = await sbServicio().from('pagos_honorarios').select('sp_item_id,estado,cedula,valor').in('sp_item_id', (r.archivos || []).map((a) => a.id).slice(0, 300));
      const uso = {}; (usados || []).forEach((u) => { uso[u.sp_item_id] = u; });
      res.json({ carpeta: r.carpeta, webUrl: r.webUrl, archivos: (r.archivos || []).map((a) => ({ id: a.id, nombre: a.nombre, tipo: a.tipo, modificado: a.modificado, subcarpeta: a.subcarpeta,
        parece_pago: ES_PAGO.test(String(a.tipo || '') + ' ' + String(a.nombre || '')) && !/upme|bancaria/i.test(a.nombre || ''), registrado: uso[a.id] || null })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Enlace temporal para ver un archivo
  app.get('/api/pagos/ver-archivo', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    try { const e = await sp.enlaceDeArchivo(String(req.query.id || '')); res.json({ url: e.url, webUrl: e.webUrl, nombre: e.nombre }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // "Este es el pago": la IA lee ese archivo y lo registra a nombre del cliente del caso (con la cédula CORRECTA del caso).
  // Si ese archivo ya estaba registrado (p. ej. con otra cédula o como "no es pago"), se corrige ese mismo registro.
  app.post('/api/pagos/usar-archivo', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const b = req.body || {};
    const ced = digitos(b.cedula);
    if (!b.sp_item_id || !ced) return res.status(400).json({ error: 'Faltan el archivo o la cédula del cliente.' });
    try {
      const sb = sbServicio();
      const e = await sp.enlaceDeArchivo(String(b.sp_item_id));
      const resp = await fetch(e.url); if (!resp.ok) throw new Error('No pude descargar el archivo (' + resp.status + ')');
      const buf = Buffer.from(await resp.arrayBuffer());
      let leido = null; try { leido = await leerSoporte(buf, e.mime, e.nombre, llamarClaude); } catch (er) { console.error('[recaudo] usar-archivo IA:', er.message); }
      const cli = await datosCliente(sb, ced).catch(() => ({}));
      const fila = {
        sp_item_id: String(b.sp_item_id), cedula: ced, nombre: b.nombre || cli.nombre || null, telefono: cli.telefono || null, cliente_id: cli.cliente_id || null,
        caso_id: b.caso_id ? String(b.caso_id) : (cli.caso_id || null), convenio: cli.convenio || 'Sin dato', fecha_creacion_cliente: cli.fecha_creacion_cliente || null, fecha_lead: cli.fecha_lead || null,
        fecha_pago: leido && /^\d{4}-\d{2}-\d{2}$/.test(String(leido.fecha_pago || '')) ? leido.fecha_pago : fechaBog(),
        valor: leido && Number(leido.valor) > 0 ? Math.round(Number(leido.valor)) : null,
        medio: (leido && leido.medio) || null, referencia: leido && leido.referencia ? String(leido.referencia).slice(0, 80) : null,
        archivo: e.nombre, link: e.webUrl || null, origen: 'Panel (elegido)', estado: 'confirmado',
        nota: leido ? (leido.es_upme ? '⚠ La IA cree que es pago a la UPME: revisar' : null) : 'La IA no pudo leer el valor: ponlo a mano',
        leido_ia: leido || null, revisado_por: ctx.email, revisado_en: new Date().toISOString(),
      };
      if (!fila.valor) fila.estado = 'por_revisar';
      const { data: ya } = await sb.from('pagos_honorarios').select('id').eq('sp_item_id', fila.sp_item_id).maybeSingle();
      const r = ya ? await sb.from('pagos_honorarios').update(fila).eq('id', ya.id).select().single() : await sb.from('pagos_honorarios').insert(fila).select().single();
      if (r.error) throw new Error(r.error.message);
      res.json({ ok: true, pago: r.data, corregido: !!ya });
    } catch (er) { res.status(500).json({ error: er.message }); }
  });

  // Busca el soporte SOLO en las carpetas de los clientes que salen "sin soporte" (todas las fechas).
  app.post('/api/pagos/escanear-sin-soporte', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    if (estado.corriendo) return res.json(estado);
    try {
      const c = await cruceDatos(sbServicio());
      const ids = [...new Set(c.sinSoporte.map((x) => x.carpeta_id).filter(Boolean))];
      escanear('clientes', ids);
      res.json(Object.assign({}, estado, { carpetas: ids.length }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Mientras el servidor esté despierto, revisa el mes actual cada 3 horas (así el registro se va llenando solo).
  setInterval(() => { if (!estado.corriendo && Date.now() - ultimoAuto > 3 * 3600e3) { ultimoAuto = Date.now(); escanear('todo'); } }, 30 * 60e3).unref();
  // Al arrancar el servidor (Render lo despierta), una revisión completa a los 2 minutos.
  setTimeout(() => { if (!estado.corriendo) { ultimoAuto = Date.now(); escanear('todo'); } }, 2 * 60e3).unref();
}

module.exports = { montarRecaudo, convenioDe, leerSoporte };
