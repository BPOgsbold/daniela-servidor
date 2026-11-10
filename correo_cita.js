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
// Siempre reciben el correo (además de la lista de arriba o de MAIL_DESTINATARIOS), solo en envío real.
const SIEMPRE_EN_COPIA = ['danielagomezzuluaga52@hotmail.com'];
const DESTINOS = () => {
  const base = ES_REAL() ? (process.env.MAIL_DESTINATARIOS ? process.env.MAIL_DESTINATARIOS.split(',') : DESTINATARIOS_DEFECTO).concat(SIEMPRE_EN_COPIA) : ['mfsierra@bpogs.com'];
  const vistos = new Set();
  return base.map((x) => x.trim()).filter((x) => { const k = x.toLowerCase(); if (!x || vistos.has(k)) return false; vistos.add(k); return true; });
};

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function htmlCorreo({ cli, archivos, paquete }) {
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
   ${fila('Nombre', cli.nombre_cliente)}${fila('Cédula / NIT', cli.numero_identificacion)}${fila('Teléfono', cli.telefono)}${fila('Correo', cli.email || cli.correo)}${fila('Ciudad (define la seccional DIAN)', cli.ciudad || 'Por confirmar')}${fila('Seccional DIAN', cli.seccional)}${fila('Placa', cli.placa)}${fila('Código de registro UPME', cli.codigo_registro_upme)}${fila('Resultado certificado UPME', cli.resultado_certificado_upme)}
  </table>
  <div style="font-size:13px;font-weight:700;letter-spacing:.06em;color:#1f6a5b;margin:22px 0 8px">DOCUMENTACIÓN ADJUNTA (${archivos.length})</div>
  ${paquete ? `<div style="font-size:13px;color:#5b6b66;margin:0 0 8px">Todo viene en <b>una sola carpeta comprimida</b>: <b>${esc(paquete)}</b>. Descárguela y descomprímala para ver los documentos ya ordenados.</div>` : ''}
  <table style="width:100%;border-collapse:collapse;background:#f8fbfa;border-radius:10px;overflow:hidden">${docs || '<tr><td style="padding:10px 14px;font-size:13px">No se encontraron documentos en la carpeta del cliente.</td></tr>'}</table>
  <p style="margin:22px 0 6px">Quedamos <b>atentos al agendamiento de la cita</b>. Agradecemos confirmar por este mismo medio la fecha, hora y seccional asignadas para informar al cliente.</p>
  <p style="margin:18px 0 0">Cordialmente,</p>
  <p style="margin:2px 0 0"><b>Gómez Legal Abogados S.A.S.</b><br><span style="color:#5b6b66;font-size:13px">Beneficios tributarios EV · Tecnología BPO Global Services</span></p>
 </div>
 <div style="background:#f2f6f4;padding:14px 30px;font-size:11.5px;color:#7a8a85">Mensaje generado automáticamente desde el panel interno de Gómez Legal al completar la etapa "Certificado UPME emitido". Contiene información confidencial del cliente.</div>
</div></div>`;
}


// ---------- Paquete ordenado: una carpeta .zip con los documentos sin duplicados ----------
const zlib = require('zlib');
const TABLA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function crearZip(entradas) { // entradas: [{ ruta, buffer }] — sin compresión (los PDF/JPG ya vienen comprimidos)
  const d = new Date();
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locales = [], centrales = []; let pos = 0;
  for (const e of entradas) {
    const nombre = Buffer.from(e.ruta, 'utf8'), crc = crc32(e.buffer), tam = e.buffer.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(hora, 10); lh.writeUInt16LE(fecha, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(tam, 18); lh.writeUInt32LE(tam, 22); lh.writeUInt16LE(nombre.length, 26); lh.writeUInt16LE(0, 28);
    locales.push(lh, nombre, e.buffer);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(hora, 12); ch.writeUInt16LE(fecha, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(tam, 20); ch.writeUInt32LE(tam, 24); ch.writeUInt16LE(nombre.length, 28); ch.writeUInt32LE(pos, 42);
    centrales.push(ch, nombre);
    pos += 30 + nombre.length + tam;
  }
  const cd = Buffer.concat(centrales);
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(entradas.length, 8); fin.writeUInt16LE(entradas.length, 10); fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...locales, cd, fin]);
}
const limpiarNombre = (t) => String(t || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
const ORDEN_TIPOS = ['Cédula', 'RUT', 'Factura', 'Certificado UPME', 'Soporte de pago'];
// Solo ordena (cédula, RUT, factura, certificado, soportes). NO descarta archivos por tipo: con doble titularidad
// hay dos cédulas y dos RUT legítimos. Los repetidos exactos se quitan después, por contenido (ver sinRepetidos).
function ordenarArchivos(archivos) {
  const idx = (t) => { const i = ORDEN_TIPOS.indexOf(t); return i < 0 ? ORDEN_TIPOS.length : i; };
  return [...archivos].sort((a, b) => idx(a.tipo) - idx(b.tipo) || String(a.modificado || '').localeCompare(String(b.modificado || '')));
}
// Quita únicamente los archivos idénticos (mismo contenido byte a byte), p. ej. la misma cédula subida dos veces.
function sinRepetidos(descargados) {
  const vistos = new Set();
  return descargados.filter((d) => { const h = require('crypto').createHash('sha256').update(d.buffer).digest('hex'); if (vistos.has(h)) return false; vistos.add(h); return true; });
}
// descargados: [{ tipo, nombre (original), buffer }] ya ordenados → { adjunto, lista, nombreZip }
function armarPaquete(cli, descargados) {
  const ced = String(cli.numero_identificacion || '').replace(/\D/g, '');
  const carpeta = limpiarNombre(`${cli.nombre_cliente || 'Cliente'} - CC ${ced}${cli.placa ? ' - ' + cli.placa : ''}`);
  const contador = {}; const lista = [];
  const entradas = descargados.map((a, i) => {
    const ext = (String(a.nombre).match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0].toLowerCase();
    contador[a.tipo] = (contador[a.tipo] || 0) + 1;
    const repetido = descargados.filter((x) => x.tipo === a.tipo).length > 1 ? ' ' + contador[a.tipo] : '';
    const nombre = `${String(i + 1).padStart(2, '0')} - ${limpiarNombre(a.tipo || 'Documento')}${repetido}${ext}`;
    lista.push({ tipo: a.tipo || 'Documento', nombre });
    return { ruta: `${carpeta}/${nombre}`, buffer: a.buffer };
  });
  return { adjunto: { nombre: `${carpeta}.zip`, buffer: crearZip(entradas), mime: 'application/zip' }, lista, nombreZip: `${carpeta}.zip` };
}

module.exports = { htmlCorreo, REMITENTE, DESTINOS, ES_REAL, mb, ordenarArchivos, sinRepetidos, armarPaquete };
