// Correo "Solicitud cita DIAN": se envía cuando un cliente pasa de "Certificado UPME emitido" a
// "Pendiente cita DIAN". Sale desde el buzón compartido gomezlegal@bpogs.com (Microsoft Graph),
// con todos los documentos de la carpeta del cliente en SharePoint EXCEPTO el contrato.
// Variables en Render (opcionales): MAIL_REMITENTE, MAIL_DESTINATARIOS (separados por coma).
// Requiere el permiso de aplicación "Mail.Send" en la app de Azure (la misma de SharePoint).

const DESTINATARIOS_DEFECTO = [
  'dgomez@gomeztovarabogadas.com', 'maurohenao@gmail.com', 'jccifuentesp@gmail.com',
  'auxiliar@bpogs.com', 'arolong@bpogs.com', 'mfsierra@bpogs.com', 'aarcila@bpogs.com',
];
const REMITENTE = () => process.env.MAIL_REMITENTE || 'gomezlegal@bpogs.com';
// MODO PRUEBA (por defecto): solo llega a mfsierra@bpogs.com. Para enviar a los 7 destinatarios reales,
// en Render poner MAIL_ENVIO_REAL=si
const ES_REAL = () => String(process.env.MAIL_ENVIO_REAL || '').toLowerCase() === 'si';
const DESTINOS = () => (ES_REAL() ? (process.env.MAIL_DESTINATARIOS ? process.env.MAIL_DESTINATARIOS.split(',') : DESTINATARIOS_DEFECTO) : ['mfsierra@bpogs.com']).map((s) => s.trim()).filter(Boolean);

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function htmlCorreo({ cli, archivos }) {
  const fila = (k, v) => v ? `<tr><td style="padding:8px 14px;color:#5b6b66;font-size:13px;border-bottom:1px solid #e6efec;width:38%">${k}</td><td style="padding:8px 14px;font-size:14px;font-weight:600;color:#10241f;border-bottom:1px solid #e6efec">${esc(v)}</td></tr>` : '';
  const docs = archivos.map((a) => `<tr><td style="padding:7px 14px;font-size:13px;border-bottom:1px solid #eef3f1">📎 ${esc(a.tipo)}</td><td style="padding:7px 14px;font-size:12.5px;color:#5b6b66;border-bottom:1px solid #eef3f1">${esc(a.nombre)}</td></tr>`).join('');
  const fecha = new Date().toLocaleDateString('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' });
  return `<div style="background:#f2f6f4;padding:24px 10px;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:660px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(15,58,49,.12)">
 <div style="background-color:#0f3a31;background-image:linear-gradient(135deg,#0f3a31,#1f6a5b);padding:26px 30px;color:#ffffff">
  <div style="font-size:12px;letter-spacing:.3em;opacity:.8">GÓMEZ LEGAL ABOGADOS</div>
  <div style="font-size:26px;font-weight:700;margin-top:8px">Solicitud de cita DIAN</div>
  <div style="font-size:14px;opacity:.9;margin-top:4px">Beneficio tributario vehículos eléctricos e híbridos · ${esc(fecha)}</div>
 </div>
 <div style="padding:28px 30px;color:#10241f;font-size:15px;line-height:1.55">
  <p style="margin:0 0 14px">Buen día, equipo:</p>
  <p style="margin:0 0 14px">Les informamos que el cliente <b>${esc(cli.nombre_cliente)}</b> ya cuenta con su <b>Certificado UPME emitido</b> y pasa a la etapa de <b style="color:#1f6a5b">Pendiente cita DIAN</b>.
  Solicitamos amablemente el <b>agendamiento de la cita ante la DIAN</b> para continuar con la solicitud de devolución del IVA.</p>
  <div style="font-size:13px;font-weight:700;letter-spacing:.06em;color:#1f6a5b;margin:22px 0 8px">DATOS DEL CLIENTE</div>
  <table style="width:100%;border-collapse:collapse;background:#f8fbfa;border-radius:10px;overflow:hidden">
   ${fila('Nombre', cli.nombre_cliente)}${fila('Cédula / NIT', cli.numero_identificacion)}${fila('Teléfono', cli.telefono)}${fila('Correo', cli.email || cli.correo)}${fila('Placa', cli.placa)}${fila('Código de registro UPME', cli.codigo_registro_upme)}${fila('Resultado certificado UPME', cli.resultado_certificado_upme)}
  </table>
  <div style="font-size:13px;font-weight:700;letter-spacing:.06em;color:#1f6a5b;margin:22px 0 8px">DOCUMENTACIÓN ADJUNTA (${archivos.length})</div>
  <table style="width:100%;border-collapse:collapse;background:#f8fbfa;border-radius:10px;overflow:hidden">${docs || '<tr><td style="padding:10px 14px;font-size:13px">No se encontraron documentos en la carpeta del cliente.</td></tr>'}</table>
  <p style="margin:22px 0 6px">Quedamos <b>atentos al agendamiento de la cita</b>. Agradecemos confirmar por este mismo medio la fecha, hora y seccional asignadas para informar al cliente.</p>
  <p style="margin:18px 0 0">Cordialmente,</p>
  <p style="margin:2px 0 0"><b>Gómez Legal Abogados S.A.S.</b><br><span style="color:#5b6b66;font-size:13px">Beneficios tributarios EV · Tecnología BPO Global Services</span></p>
 </div>
 <div style="background:#f2f6f4;padding:14px 30px;font-size:11.5px;color:#7a8a85">Mensaje generado automáticamente desde el panel interno de Gómez Legal al completar la etapa "Certificado UPME emitido". Contiene información confidencial del cliente.</div>
</div></div>`;
}

module.exports = { htmlCorreo, REMITENTE, DESTINOS, ES_REAL, mb };
