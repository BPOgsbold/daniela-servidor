// Subida de documentos del cliente a SharePoint (Microsoft Graph).
// Variables en Render: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
// SHAREPOINT_SITE (ej. "bpogs.sharepoint.com:/sites/GomezLegal"),
// SHAREPOINT_BASE_FOLDER (opcional, por defecto "Clientes").

const TIPOS_DOC = {
  cedula: 'Cédula',
  factura: 'Factura de compra',
  rut: 'RUT',
  certificado_upme: 'Certificado UPME',
  soporte_pago: 'Soporte de pago',
};

let tokenCache = { valor: null, vence: 0 };
let siteCache = null;

function configurado() {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.SHAREPOINT_SITE);
}

async function obtenerToken() {
  if (tokenCache.valor && Date.now() < tokenCache.vence) return tokenCache.valor;
  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Microsoft rechazó las credenciales: ' + (d.error_description || d.error || r.status));
  tokenCache = { valor: d.access_token, vence: Date.now() + (d.expires_in - 120) * 1000 };
  return tokenCache.valor;
}

async function graph(ruta, opciones = {}) {
  const token = await obtenerToken();
  const r = await fetch(ruta.startsWith('http') ? ruta : `https://graph.microsoft.com/v1.0${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${token}`, ...(opciones.headers || {}) },
  });
  const texto = await r.text();
  let d = {};
  try { d = texto ? JSON.parse(texto) : {}; } catch (e) { d = { raw: texto }; }
  if (!r.ok) throw new Error(`Graph ${r.status}: ${(d.error && d.error.message) || texto.slice(0, 200)}`);
  return d;
}

async function obtenerSite() {
  if (siteCache) return siteCache;
  const site = await graph(`/sites/${process.env.SHAREPOINT_SITE}`);
  siteCache = site.id;
  return siteCache;
}

const limpiar = (t) => String(t || '').replace(/[\\/:*?"<>|#%~&{}]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');

function nombreCarpeta(cedula, nombre) {
  return limpiar(`${cedula} - ${nombre}`).slice(0, 120);
}

// Sube el archivo a Clientes/<cedula - nombre>/<Tipo>.<ext>. Crea la carpeta
// si no existe y, si ya hay un archivo con ese nombre, no lo pisa (renombra).
async function subirDocumento({ cedula, nombre, tipo, nombreArchivo, buffer }) {
  const siteId = await obtenerSite();
  const base = limpiar(process.env.SHAREPOINT_BASE_FOLDER || 'Clientes');
  const carpeta = nombreCarpeta(cedula, nombre);
  const ext = (String(nombreArchivo || '').match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0].toLowerCase();
  const fecha = new Date().toISOString().slice(0, 10);
  const archivo = `${TIPOS_DOC[tipo]} ${fecha}${ext}`;
  const ruta = `/sites/${siteId}/drive/root:/${encodeURI(base)}/${encodeURI(carpeta)}/${encodeURI(archivo)}`;
  let item;
  if (buffer.length <= 3.5 * 1024 * 1024) {
    item = await graph(`${ruta}:/content?@microsoft.graph.conflictBehavior=rename`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer,
    });
  } else {
    const ses = await graph(`${ruta}:/createUploadSession`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
    });
    const r = await fetch(ses.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(buffer.length), 'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}` },
      body: buffer,
    });
    if (!r.ok) throw new Error('No se pudo subir el archivo grande: ' + r.status);
    item = await r.json();
  }
  // Enlace a la carpeta del cliente
  let linkCarpeta = null;
  try {
    const c = await graph(`/sites/${siteId}/drive/root:/${encodeURI(base)}/${encodeURI(carpeta)}`);
    linkCarpeta = c.webUrl;
  } catch (e) {}
  return { carpeta, archivo: item.name || archivo, linkArchivo: item.webUrl, linkCarpeta };
}

module.exports = { TIPOS_DOC, configurado, subirDocumento, nombreCarpeta };
