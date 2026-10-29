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

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

// Lista las subcarpetas de una carpeta (con paginación).
async function listarCarpetas(siteId, ruta) {
  const enc = ruta.split('/').map(encodeURIComponent).join('/');
  let url = `/sites/${siteId}/drive/root:/${enc}:/children?$top=500`;
  const salida = [];
  try {
    while (url) {
      const d = await graph(url);
      for (const it of d.value || []) if (it.folder) salida.push(it);
      url = d['@odata.nextLink'] || null;
    }
  } catch (e) {
    if (/404|itemNotFound/i.test(e.message)) return [];
    throw e;
  }
  return salida;
}

// Busca TODAS las carpetas de esa cédula (da igual cómo esté escrito el nombre):
// en Clientes/ (definitivas) y en Clientes/00. En proceso/ (prospectos).
async function carpetasPorCedula(siteId, cedula) {
  const ced = soloDigitos(cedula);
  if (ced.length < 5) return [];
  const lugares = [
    { ruta: rutaBase(), enRoot: true },
    { ruta: `${rutaBase()}/${rutaProspectos()}`, enRoot: false },
  ];
  const hallazgos = [];
  for (const l of lugares) {
    for (const it of await listarCarpetas(siteId, l.ruta)) {
      if (soloDigitos(String(it.name).split('-')[0]) === ced) hallazgos.push({ item: it, enRoot: l.enRoot });
    }
  }
  // Primero las definitivas y, dentro de cada grupo, la más antigua.
  return hallazgos.sort((x, y) => (y.enRoot - x.enRoot) || String(x.item.createdDateTime).localeCompare(String(y.item.createdDateTime)));
}

const patchPadre = (siteId, id, parentId) => graph(`/sites/${siteId}/drive/items/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ parentReference: { id: parentId }, '@microsoft.graph.conflictBehavior': 'rename' }),
});

// Junta una carpeta repetida dentro de la principal (sin pisar archivos) y la borra solo si quedó vacía.
async function fusionar(siteId, origen, destino) {
  const hijos = await graph(`/sites/${siteId}/drive/items/${origen.id}/children?$top=500`);
  for (const h of hijos.value || []) await patchPadre(siteId, h.id, destino.id);
  const quedan = await graph(`/sites/${siteId}/drive/items/${origen.id}/children?$top=1`);
  if (!(quedan.value || []).length) await graph(`/sites/${siteId}/drive/items/${origen.id}`, { method: 'DELETE' });
}

// Cola por cédula: si llegan 3 documentos a la vez, se procesan de a uno (evita crear carpetas dobles).
const colas = new Map();
function enCola(clave, fn) {
  const previo = colas.get(clave) || Promise.resolve();
  const actual = previo.catch(() => {}).then(fn);
  colas.set(clave, actual);
  actual.finally(() => { if (colas.get(clave) === actual) colas.delete(clave); }).catch(() => {});
  return actual;
}

// Devuelve la ruta de la UNA carpeta del cliente (la reutiliza si ya existe, aunque el nombre esté
// escrito distinto) y junta las repetidas. Si no existe ninguna, devuelve la ruta donde se creará.
async function resolverCarpeta(siteId, cedula, nombre, esCliente) {
  const base = rutaBase();
  const nuevaRuta = () => esCliente ? `${base}/${nombreCarpeta(cedula, nombre)}`
    : `${base}/${rutaProspectos()}/${nombreCarpeta(cedula, nombre)}`;
  const hallazgos = await carpetasPorCedula(siteId, cedula);
  if (!hallazgos.length) return { ruta: nuevaRuta(), nombre: nombreCarpeta(cedula, nombre), enRoot: !!esCliente, creada: true };
  const [principal, ...otras] = hallazgos;
  for (const o of otras) {
    try { await fusionar(siteId, o.item, principal.item); }
    catch (e) { console.error('No se pudo juntar la carpeta repetida', o.item.name, e.message); }
  }
  let enRoot = principal.enRoot;
  if (esCliente && !enRoot) {
    try {
      const raiz = await obtenerItem(siteId, base);
      if (raiz) { await patchPadre(siteId, principal.item.id, raiz.id); enRoot = true; }
    } catch (e) { console.error('No se pudo mover la carpeta a Cliente:', e.message); }
  }
  const nombreReal = principal.item.name;
  return { ruta: enRoot ? `${base}/${nombreReal}` : `${base}/${rutaProspectos()}/${nombreReal}`, nombre: nombreReal, enRoot, creada: false };
}

// Mueve la carpeta de un prospecto a su lugar definitivo (Clientes/<cédula - nombre>) sin duplicar.
async function moverACliente(cedula, nombre) {
  const siteId = await obtenerSite();
  return enCola(soloDigitos(cedula), async () => {
    const r = await resolverCarpeta(siteId, cedula, nombre, true);
    return { movida: !r.creada, modo: 'carpeta unica por cedula' };
  });
}

// Sube el archivo. Prospectos: Clientes/00. En proceso/<cédula - nombre>/.
// Clientes definitivos: Clientes/<cédula - nombre>/ (y, si todavía tenía su
// carpeta en proceso, primero se mueve). Si ya hay un archivo con ese nombre
// no lo pisa (renombra).
async function subirDocumento(args) {
  const siteId = await obtenerSite();
  return enCola(soloDigitos(args.cedula), () => subirDocumentoSeguro(siteId, args));
}

async function subirDocumentoSeguro(siteId, { cedula, nombre, tipo, nombreArchivo, buffer, esCliente }) {
  const carpetaInfo = await resolverCarpeta(siteId, cedula, nombre, esCliente);
  const rutaCarpeta = carpetaInfo.ruta;
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
  return { carpeta: carpetaInfo.enRoot ? carpetaInfo.nombre : `${rutaProspectos()}/${carpetaInfo.nombre}`, archivo: item.name || archivo, linkArchivo: item.webUrl, linkCarpeta };
}


// ---------- Documentos del cliente (para el panel: ver sin descargar a mano) ----------
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
function tipoDeArchivo(nombre) {
  const n = norm(nombre);
  if (/CERTIFICACION BANCARIA|BANCARIA/.test(n)) return 'Certificación bancaria';
  if (/SOPORTE DE PAGO|PAGO/.test(n)) return 'Soporte de pago';
  if (/CERTIFICADO UPME|UPME/.test(n)) return 'Certificado UPME';
  if (/CONTRATO/.test(n)) return 'Contrato';
  if (/FACTURA/.test(n)) return 'Factura';
  if (/\bRUT\b/.test(n)) return 'RUT';
  if (/CEDULA|\bCC\b/.test(n)) return 'Cédula';
  return 'Otro';
}

async function hijosDeItem(siteId, itemId) {
  let url = `/sites/${siteId}/drive/items/${itemId}/children?$top=200`;
  const salida = [];
  while (url) {
    const d = await graph(url);
    salida.push(...(d.value || []));
    url = d['@odata.nextLink'] || null;
  }
  return salida;
}

// Lista los archivos de la carpeta del cliente (la busca por cédula, en Clientes y en 00. En proceso).
async function listarDocumentosPorCedula(cedula) {
  const siteId = await obtenerSite();
  const hallazgos = await carpetasPorCedula(siteId, cedula);
  if (!hallazgos.length) return { encontrada: false, archivos: [] };
  const p = hallazgos[0];
  const archivos = [];
  for (const it of await hijosDeItem(siteId, p.item.id)) {
    const grupo = it.folder ? await hijosDeItem(siteId, it.id) : [it];
    for (const f of grupo) {
      if (!f.file || String(f.name).startsWith('~')) continue;
      archivos.push({
        id: f.id, nombre: f.name, tipo: tipoDeArchivo(f.name), tamano: f.size || 0,
        modificado: f.lastModifiedDateTime || null, subcarpeta: it.folder ? it.name : null, mime: (f.file && f.file.mimeType) || null,
      });
    }
  }
  archivos.sort((a, b) => String(b.modificado).localeCompare(String(a.modificado)));
  return { encontrada: true, carpeta: p.item.name, enClientes: p.enRoot, webUrl: p.item.webUrl, archivos };
}

// Enlace temporal (~1 hora) para abrir/ver un archivo de SharePoint sin descargarlo a mano.
// Solo sirve para archivos que estén dentro de la carpeta de clientes.
async function enlaceDeArchivo(itemId) {
  if (!/^[A-Za-z0-9!_-]{10,}$/.test(String(itemId || ''))) throw new Error('Identificador de archivo no válido.');
  const siteId = await obtenerSite();
  const it = await graph(`/sites/${siteId}/drive/items/${itemId}`);
  const ruta = decodeURIComponent(String((it.parentReference && it.parentReference.path) || ''));
  if (!it.file || !ruta.includes(`/${rutaBase()}/`) && !ruta.endsWith(`/${rutaBase()}`)) throw new Error('Ese archivo no está en la carpeta de clientes.');
  return { url: it['@microsoft.graph.downloadUrl'] || it.webUrl, nombre: it.name, webUrl: it.webUrl, mime: (it.file && it.file.mimeType) || null };
}
module.exports = { listarDocumentosPorCedula, enlaceDeArchivo, tipoDeArchivo, TIPOS_DOC, configurado, subirDocumento, nombreCarpeta, moverACliente, esClienteDefinitivo };
