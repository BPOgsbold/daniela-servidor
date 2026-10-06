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
  certificacion_bancaria: 'Certificación bancaria',
  contrato: 'Contrato',
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

const PENDIENTES = ['Pendiente de contrato', 'Pendiente de firma', 'Pendiente de pago'];
// Un caso es "Cliente" (carpeta definitiva) cuando su estado es Cliente y ya
// no tiene nada pendiente (igual que el embudo del panel).
function esClienteDefinitivo(caso) {
  return !!caso && caso.estado_pipeline === 'Cliente' && !PENDIENTES.includes(caso.siguiente_paso);
}

const rutaBase = () => limpiar(process.env.SHAREPOINT_BASE_FOLDER || 'Clientes');
const rutaProspectos = () => limpiar(process.env.SHAREPOINT_PROSPECTOS_FOLDER || '00. En proceso');

async function obtenerItem(siteId, ruta) {
  try {
    return await graph(`/sites/${siteId}/drive/root:/${ruta.split('/').map(encodeURIComponent).join('/')}`);
  } catch (e) {
    if (/404|itemNotFound/i.test(e.message)) return null;
    throw e;
  }
}

// Mueve la carpeta de un prospecto (Clientes/00. En proceso/<cédula - nombre>)
// a su lugar definitivo (Clientes/<cédula - nombre>). No borra archivos: si la
// carpeta definitiva ya existe, pasa los archivos uno a uno (sin pisar) y solo
// borra la carpeta vieja si quedó vacía.
async function moverACliente(cedula, nombre) {
  const siteId = await obtenerSite();
  const carpeta = nombreCarpeta(cedula, nombre);
  const origen = await obtenerItem(siteId, `${rutaBase()}/${rutaProspectos()}/${carpeta}`);
  if (!origen) return { movida: false, motivo: 'no tenía carpeta en proceso' };
  const base = await obtenerItem(siteId, rutaBase());
  if (!base) throw new Error('No encuentro la carpeta base en SharePoint.');
  const destino = await obtenerItem(siteId, `${rutaBase()}/${carpeta}`);
  const patch = (id, parentId) => graph(`/sites/${siteId}/drive/items/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: parentId }, '@microsoft.graph.conflictBehavior': 'rename' }),
  });
  if (!destino) {
    await patch(origen.id, base.id);
    return { movida: true, modo: 'carpeta completa' };
  }
  const hijos = await graph(`/sites/${siteId}/drive/items/${origen.id}/children?$top=200`);
  for (const h of hijos.value || []) await patch(h.id, destino.id);
  const quedan = await graph(`/sites/${siteId}/drive/items/${origen.id}/children?$top=1`);
  if (!(quedan.value || []).length) {
    await graph(`/sites/${siteId}/drive/items/${origen.id}`, { method: 'DELETE' });
  }
  return { movida: true, modo: 'archivos combinados' };
}

// Sube el archivo. Prospectos: Clientes/00. En proceso/<cédula - nombre>/.
// Clientes definitivos: Clientes/<cédula - nombre>/ (y, si todavía tenía su
// carpeta en proceso, primero se mueve). Si ya hay un archivo con ese nombre
// no lo pisa (renombra).
async function subirDocumento({ cedula, nombre, tipo, nombreArchivo, buffer, esCliente }) {
  const siteId = await obtenerSite();
  const base = rutaBase();
  const carpeta = nombreCarpeta(cedula, nombre);
  if (esCliente) {
    try { await moverACliente(cedula, nombre); } catch (e) { console.error('No se pudo mover la carpeta a Cliente:', e.message); }
  }
  const rutaCarpeta = esCliente ? `${base}/${carpeta}` : `${base}/${rutaProspectos()}/${carpeta}`;
  const ext = (String(nombreArchivo || '').match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0].toLowerCase();
  const fecha = new Date().toISOString().slice(0, 10);
  const archivo = `${TIPOS_DOC[tipo]} ${fecha}${ext}`;
  const enc = (t) => t.split('/').map(encodeURIComponent).join('/');
  const ruta = `/sites/${siteId}/drive/root:/${enc(rutaCarpeta)}/${encodeURIComponent(archivo)}`;
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
  let linkCarpeta = null;
  try {
    const c = await obtenerItem(siteId, rutaCarpeta);
    linkCarpeta = c && c.webUrl;
  } catch (e) {}
  return { carpeta: esCliente ? carpeta : `${rutaProspectos()}/${carpeta}`, archivo: item.name || archivo, linkArchivo: item.webUrl, linkCarpeta };
}

module.exports = { TIPOS_DOC, configurado, subirDocumento, nombreCarpeta, moverACliente, esClienteDefinitivo };
