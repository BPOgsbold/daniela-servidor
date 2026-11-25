// Aviso a Teams cuando un cliente pasa de "Registro UPME" a "Pendiente pago UPME" (tablero de Seguimiento).
// Es la solicitud al equipo para contactar al cliente y gestionar el pago de la UPME.
// Webhook: variable de entorno TEAMS_WEBHOOK_PAGO_UPME en Render (Flujos de trabajo de Teams, chat GLA_Notificar_Pago).
// Un solo aviso por cliente y día (tabla informes_diarios, tipo "pago_upme:<id del cliente>").
// POST /api/notificar/pago-upme { clienteId }  → lo llama el panel justo después de mover la tarjeta.

const PANEL_URL = () => (process.env.PANEL_URL || 'https://gomezlegal.netlify.app').replace(/\/+$/, '');
const fechaBog = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
const fechaHora = (v) => (v ? new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(v)) : '');
const digitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');

async function datosCliente(sb, clienteId) {
  const { data: cli, error } = await sb.from('BD_Cliente_GLA').select('*').eq('id', clienteId).maybeSingle();
  if (error || !cli) throw new Error('No encontré el cliente.');
  const ced = digitos(cli.numero_identificacion);
  let caso = '', vehiculo = '';
  try {
    if (ced) {
      const { data } = await sb.from('bo_gestion_upme').select('*').limit(5000);
      const r = (data || []).find((x) => digitos(x.cedula) === ced);
      caso = (r && r.numero_caso) || '';
    }
  } catch (_) { /* sin consolidado */ }
  try {
    if (cli.caso_id) {
      const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('vehiculo').eq('id', cli.caso_id).maybeSingle();
      vehiculo = (data && data.vehiculo) || '';
    }
  } catch (_) { /* sin vehículo */ }
  return { cli, ced, caso, vehiculo };
}

function tarjeta({ cli, ced, caso, vehiculo }, quien) {
  const tel = digitos(cli.telefono);
  const wa = tel ? `https://wa.me/${tel.length === 10 ? '57' + tel : tel}` : '';
  const hechos = [
    { title: 'Cliente', value: cli.nombre_cliente || '—' },
    { title: 'Teléfono', value: tel || '—' },
    { title: 'Caso UPME', value: caso || 'sin número de caso' },
    { title: 'Placa', value: cli.placa || 'sin placa' },
    ...(vehiculo ? [{ title: 'Vehículo', value: vehiculo }] : []),
    { title: 'Cédula', value: ced || '—' },
    { title: 'Pasó a pago', value: `${fechaHora(cli.fecha_pendiente_pago_upme || new Date())}${quien ? ' · por ' + String(quien).split('@')[0] : ''}` },
  ];
  const acciones = [{ type: 'Action.OpenUrl', title: '📂 Abrir el caso en el panel', url: `${PANEL_URL()}/?cliente=${encodeURIComponent(cli.id)}` }];
  if (wa) acciones.push({ type: 'Action.OpenUrl', title: '💬 Escribirle por WhatsApp', url: wa });
  return {
    type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
    body: [
      { type: 'TextBlock', text: '💳 Solicitud de contacto para pago UPME', weight: 'Bolder', size: 'Medium', color: 'Accent', wrap: true },
      { type: 'TextBlock', text: 'El cliente ya tiene registro y caso en la UPME y pasó a **Pendiente pago UPME**. Contáctalo para gestionar el pago.', wrap: true, spacing: 'Small' },
      { type: 'FactSet', facts: hechos },
    ],
    actions: acciones,
  };
}

async function enviar(card) {
  const url = process.env.TEAMS_WEBHOOK_PAGO_UPME;
  if (!url) throw new Error('Falta TEAMS_WEBHOOK_PAGO_UPME en Render.');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] }) });
  if (!r.ok) throw new Error(`Teams respondió ${r.status}`);
}

function montarAvisoPagoUpme(app, { exigirEquipo, sbServicio }) {
  app.post('/api/notificar/pago-upme', async (req, res) => {
    const ctx = await exigirEquipo(req, res); if (!ctx) return;
    const clienteId = req.body && req.body.clienteId;
    if (!clienteId) return res.status(400).json({ error: 'Falta clienteId.' });
    const sb = sbServicio();
    const tipo = `pago_upme:${clienteId}`, fecha = fechaBog();
    try {
      const d = await datosCliente(sb, clienteId);
      if (!d.cli.fecha_pendiente_pago_upme) return res.json({ enviado: false, motivo: 'El cliente no está en Pendiente pago UPME.' });
      // Un solo aviso por cliente y día, aunque se mueva o se refresque varias veces
      const { error: dup } = await sb.from('informes_diarios').insert({ tipo, fecha });
      if (dup) return res.json({ enviado: false, motivo: /duplicate|23505/.test(dup.message + dup.code) ? 'Ya se avisó hoy.' : dup.message });
      try { await enviar(tarjeta(d, ctx.email)); }
      catch (e) { await sb.from('informes_diarios').delete().eq('tipo', tipo).eq('fecha', fecha); throw e; }
      if (d.cli.caso_id) await sb.from('panel_historial').insert({ caso_id: d.cli.caso_id, campo: 'aviso_pago_upme', valor_anterior: null, valor_nuevo: 'Aviso a Teams (GLA_Notificar_Pago): contactar para pago UPME', usuario_email: ctx.email }).then(() => {}, () => {});
      console.log(`[pago-upme] aviso Teams: ${d.cli.nombre_cliente} (${d.ced}) por ${ctx.email}`);
      res.json({ enviado: true });
    } catch (e) {
      console.error('[pago-upme]', e.message);
      res.status(500).json({ enviado: false, error: e.message });
    }
  });
}

module.exports = { montarAvisoPagoUpme, tarjeta };
