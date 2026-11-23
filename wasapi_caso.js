// Daniela por WhatsApp: crea o actualiza el caso del cliente en el panel, sube a SharePoint cada documento que el
// cliente manda (con su tipo) y, cuando están los documentos y el cliente aceptó, pide el contrato automáticamente.
// Mismas reglas del asistente: si el teléfono o la cédula ya existen, NO se crea otro caso: se actualiza el que hay.

const sp = require('./sharepoint');
const { crearCaso, actualizarCaso } = require('./supabase');
const { buscarDuplicados } = require('./duplicados');

const ASESOR = 'Daniela (WhatsApp)';
const TIPOS_VALIDOS = ['cedula', 'factura', 'rut', 'certificado_upme', 'soporte_pago', 'certificacion_bancaria'];
const RANGO = { Contacto: 1, Interesado: 2, 'Negociación': 3 };
const digitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');

function fuenteDeOrigen(origen) {
  const t = String(origen || '').toLowerCase();
  if (/sura/.test(t)) return 'WhatsApp Sura';
  if (/epm|fepep/.test(t)) return 'EPM';
  if (/confamilia|familia/.test(t)) return 'Confamilia';
  if (/referix/.test(t)) return 'Referix';
  return t ? 'WhatsApp Cliente' : null;
}
function certificadoTexto(v) {
  if (v === true || /^s[ií]/i.test(String(v || ''))) return 'Sí tiene certificado';
  if (/tr[aá]mite/i.test(String(v || ''))) return 'Certificado en trámite';
  if (v === false || /^no/i.test(String(v || ''))) return 'No tiene certificado';
  return null;
}
function montoNumero(v) {
  if (typeof v === 'number') return v;
  const d = String(v || '').replace(/[^\d,.]/g, '');
  if (!d) return null;
  const n = Number(/,\d{1,2}$/.test(d) ? d.replace(/\./g, '').replace(',', '.') : d.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? Math.round(n) : null;
}
function estadoSegunPerfil(p) {
  if (p.acepta_avanzar) return 'Negociación';
  if (p.interesado || p.marca_modelo || (p._docs || []).includes('factura')) return 'Interesado';
  return 'Contacto';
}

// Datos del caso a partir de la ficha que arma Daniela (solo lo que se sabe).
function datosDelPerfil(p, waId, canal) {
  const cedula = digitos(p.cedula);
  const datos = {
    nombre_cliente: p.nombre_completo || p.nombre || null,
    telefono: digitos(waId).slice(-10) || null,
    email: p.correo && /@/.test(p.correo) ? String(p.correo).trim().toLowerCase() : null,
    numero_identificacion: cedula || null,
    tipo_identificacion: cedula ? (cedula.length >= 9 && /^[89]/.test(cedula) ? 'NIT' : 'CC') : null,
    canal: canal || 'WhatsApp',
    fuente: fuenteDeOrigen(p.origen),
    vehiculo: p.marca_modelo || null,
    tecnologia: p.tipo_vehiculo || null,
    fecha_compra: /^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha_compra || '')) ? p.fecha_compra : null,
    valor_sin_iva: montoNumero(p.valor_sin_iva),
    ciudad: p.ciudad || null,
    tiene_certificado_upme: certificadoTexto(p.tiene_certificado_upme),
  };
  for (const k of Object.keys(datos)) if (datos[k] === null || datos[k] === '') delete datos[k];
  return datos;
}

// Candado: dos atenciones del MISMO cliente al mismo tiempo (Daniela autónoma + copiloto de un agente, o dos ciclos)
// se hacen una detrás de la otra. Así la segunda encuentra el caso que creó la primera y no crea otro.
let colaCasos = Promise.resolve();
function enFila(fn) {
  const r = colaCasos.then(fn, fn);
  colaCasos = r.then(() => {}, () => {});
  return r;
}
const DE_DANIELA = /^(ct|wa)-/;

// Crea el caso la primera vez (si no existe por teléfono/cédula) y lo mantiene al día. Devuelve el id del caso.
function sincronizarCaso(p, waId, sb, o = {}) { return enFila(() => sincronizarCasoUnico(p, waId, sb, o)); }
async function sincronizarCasoUnico(p, waId, sb, o = {}) {
  if (!p.nombre && !p.nombre_completo) return null; // sin nombre todavía no se crea nada
  const datos = datosDelPerfil(p, waId, o.canal);
  const estado = estadoSegunPerfil(p);
  let caso = null;
  if (p._caso_id) {
    const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('id', p._caso_id).maybeSingle();
    caso = data || null;
  }
  if (!caso) {
    const dup = await buscarDuplicados({ telefono: datos.telefono, numero_identificacion: datos.numero_identificacion });
    if (dup.casos && dup.casos.length) {
      // Si hay varios, el más reciente.
      caso = dup.casos.slice().sort((x, y) => String(y.updated_at || y.created_at || '').localeCompare(String(x.updated_at || x.created_at || '')))[0];
    }
  }
  // Si el cliente ya tiene historial con esa cédula en un caso MÁS ANTIGUO, se sigue en ese (no se duplica).
  if (caso && datos.numero_identificacion && DE_DANIELA.test(String(caso.session_id || ''))) {
    const otros = await buscarDuplicados({ numero_identificacion: datos.numero_identificacion, excluirId: caso.id });
    const viejo = (otros.casos || []).filter((x) => String(x.created_at || '') < String(caso.created_at || '')).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0];
    if (viejo) {
      console.log(`[wasapi-caso] ${caso.id} es duplicado de ${viejo.id} (misma cédula): se sigue en ${viejo.id}`);
      await quitarDuplicado(sb, caso, viejo);
      caso = viejo;
    }
  }
  if (!caso) {
    // Última verificación justo antes de crear (por si otro proceso lo creó hace un instante).
    const otra = await buscarDuplicados({ telefono: datos.telefono, numero_identificacion: datos.numero_identificacion });
    if (otra.casos && otra.casos.length) caso = otra.casos[otra.casos.length - 1];
  }
  if (!caso) {
    const nuevo = await crearCaso(`${o.prefijo || 'wa'}-${digitos(waId)}`, o.asesor || ASESOR, { ...datos, estado_pipeline: estado });
    console.log(`[wasapi-caso] caso NUEVO ${nuevo.id}: ${datos.nombre_cliente} (${datos.telefono})`);
    // Control después de crear: si aparece otro caso del mismo cliente creado antes, se queda el más antiguo.
    try {
      const des = await buscarDuplicados({ telefono: datos.telefono, numero_identificacion: datos.numero_identificacion, excluirId: nuevo.id });
      const viejo = (des.casos || []).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0];
      if (viejo) { await quitarDuplicado(sb, nuevo, viejo); return viejo.id; }
    } catch (e) { console.error('[wasapi-caso] control de duplicado:', e.message); }
    return nuevo.id;
  }
  // Ya existe: no se crea otro. Solo se completan los datos vacíos (no se pisa lo que llenó el asesor)
  // y el estado solo avanza (Contacto -> Interesado -> Negociación); nunca retrocede ni toca "Cliente"/"Cierre perdido".
  const cambios = {};
  for (const [k, v] of Object.entries(datos)) {
    if (k === 'telefono') continue;
    if (caso[k] === null || caso[k] === undefined || caso[k] === '') cambios[k] = v;
  }
  const actual = RANGO[caso.estado_pipeline] || 0;
  const puedeAvanzar = !caso.estado_pipeline || RANGO[caso.estado_pipeline] !== undefined;
  if (puedeAvanzar && (RANGO[estado] || 0) > actual) cambios.estado_pipeline = estado;
  if (Object.keys(cambios).length) {
    await actualizarCaso(caso.id, cambios);
    console.log(`[wasapi-caso] caso ${caso.id} actualizado: ${Object.keys(cambios).join(', ')}`);
  }
  return caso.id;
}

// Sube a la carpeta del cliente (una por cédula) los archivos de este mensaje. Sin cédula aún, quedan en espera.
async function subirDocumentos(p, archivos, o = {}) {
  const cedula = digitos(p.cedula);
  const nombre = p.nombre_completo || p.nombre || '';
  const hechos = [];
  const pendientes = Array.isArray(p._pendientes) ? p._pendientes : [];
  for (const a of archivos) {
    if (!TIPOS_VALIDOS.includes(a.tipo)) continue;
    if (a.hash && (p._hashes || []).includes(a.hash)) continue; // ya se subió antes (Chattigo reenvía los archivos en cada consulta)
    if (!cedula || cedula.length < 5 || !sp.configurado()) { if (a.url) pendientes.push({ url: a.url, nombre: a.nombre, tipo: a.tipo }); continue; }
    try {
      const r = await sp.subirDocumento({ cedula, nombre, tipo: a.tipo, nombreArchivo: a.nombre || ('archivo' + (a.ext || '')), buffer: a.buf, esCliente: false });
      if (a.tipo === 'soporte_pago') require('./pagos').registrarPago({ cedula, nombre, telefono: p._telefono || null, canal: o.canal || p._canal || 'WhatsApp',
        cargado_por: o.asesor || 'Daniela (' + (o.canal || p._canal || 'WhatsApp') + ')', archivo: a.nombre, link: r && (r.linkArchivo || r.linkCarpeta), caso_id: p._caso_id });
      hechos.push(a.tipo);
      if (a.hash) p._hashes = [...(p._hashes || []), a.hash].slice(-40);
    } catch (e) {
      console.error('[wasapi-caso] no pude subir', a.tipo, e.message);
      if (a.url) pendientes.push({ url: a.url, nombre: a.nombre, tipo: a.tipo });
    }
  }
  p._pendientes = pendientes.slice(-10);
  p._docs = Array.from(new Set([...(p._docs || []), ...hechos]));
  return hechos;
}

// Reintenta los archivos que llegaron antes de conocer la cédula (se vuelven a descargar de Wasapi).
async function subirPendientes(p, bajarArchivo) {
  const lista = Array.isArray(p._pendientes) ? p._pendientes : [];
  if (!lista.length || digitos(p.cedula).length < 5) return [];
  p._pendientes = [];
  const archivos = [];
  for (const x of lista) {
    try { const f = await bajarArchivo(x.url); archivos.push({ buf: f.buf, nombre: x.nombre, tipo: x.tipo }); } catch (e) { console.error('[wasapi-caso] pendiente perdido', x.tipo, e.message); }
  }
  return subirDocumentos(p, archivos);
}

// Con factura, RUT y cédula ya en SharePoint y el cliente de acuerdo: se pide el contrato (una sola vez).
async function pedirContratoSiListo(p, sb, o = {}) {
  if (!p._caso_id || p._contrato_pedido || !p.acepta_avanzar) return false;
  const docs = p._docs || [];
  if (!['factura', 'rut', 'cedula'].every((d) => docs.includes(d))) return false;
  const yaTieneUpme = /^s[ií]/i.test(String(certificadoTexto(p.tiene_certificado_upme) || ''));
  const fila = { caso_id: p._caso_id, cedula: digitos(p.cedula), nombre_cliente: p.nombre_completo || p.nombre || null, asesor: o.asesor || ASESOR,
    servicio: yaTieneUpme ? 'Solo DIAN' : 'Servicio completo', auto_firma: true, origen: o.origen || 'whatsapp' };
  // Nunca dos solicitudes vivas para el mismo caso.
  const { data: previas } = await sb.from('solicitudes_contrato').select('id').eq('caso_id', p._caso_id).in('estado', ['pendiente', 'procesando', 'listo']).limit(1);
  if (previas && previas.length) { p._contrato_pedido = new Date().toISOString(); return false; }
  let { error } = await sb.from('solicitudes_contrato').insert(fila);
  if (error && /auto_firma|origen/.test(error.message || '')) {
    delete fila.auto_firma; delete fila.origen;
    ({ error } = await sb.from('solicitudes_contrato').insert(fila));
  }
  if (error) { console.error('[wasapi-caso] no pude pedir el contrato:', error.message); return false; }
  p._contrato_pedido = new Date().toISOString();
  console.log(`[wasapi-caso] contrato pedido automáticamente para ${fila.nombre_cliente} (${fila.cedula})`);
  return true;
}

// Borra un caso que Daniela acaba de duplicar (solo los creados por Daniela, recientes y sin cliente cerrado),
// pasando antes al caso antiguo los datos que a este le faltan. Si no se puede borrar, queda registrado en el log.
async function quitarDuplicado(sb, dup, viejo) {
  try {
    if (!DE_DANIELA.test(String(dup.session_id || '')) || ['Cliente', 'Cierre perdido'].includes(dup.estado_pipeline)) return;
    if (Date.now() - new Date(dup.created_at || Date.now()).getTime() > 7 * 86400000) return;
    const { data: completo } = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('id', dup.id).maybeSingle();
    const cambios = {};
    for (const [k, v] of Object.entries(completo || {})) {
      if (['id', 'session_id', 'created_at', 'updated_at', 'estado_pipeline', 'asesor'].includes(k)) continue;
      if (v !== null && v !== '' && (viejo[k] === null || viejo[k] === undefined || viejo[k] === '')) cambios[k] = v;
    }
    if (Object.keys(cambios).length) await actualizarCaso(viejo.id, cambios);
    for (const t of ['panel_historial', 'solicitudes_contrato', 'pagos_cargados', 'terminos_sura']) {
      await sb.from(t).update({ caso_id: t === 'pagos_cargados' || t === 'terminos_sura' ? String(viejo.id) : viejo.id }).eq('caso_id', t === 'pagos_cargados' || t === 'terminos_sura' ? String(dup.id) : dup.id).then(() => {}, () => {});
    }
    const { error } = await sb.from('Perfilamiento_y_ventas_GLA').delete().eq('id', dup.id);
    if (error) console.error(`[wasapi-caso] no pude borrar el duplicado ${dup.id}:`, error.message);
    else console.log(`[wasapi-caso] duplicado ${dup.id} borrado; queda ${viejo.id}`);
  } catch (e) { console.error('[wasapi-caso] quitar duplicado:', e.message); }
}

// Todo junto, después de responder al cliente (nunca bloquea ni rompe la conversación).
async function sincronizarTodo({ perfil, waId, archivos, sb, bajarArchivo, opciones }) {
  const o = opciones || {};
  try {
    const id = await sincronizarCaso(perfil, waId, sb, o);
    if (id) perfil._caso_id = id;
  } catch (e) { console.error('[wasapi-caso] caso:', e.message); }
  if (o.canal) perfil._canal = o.canal;
  if (waId) perfil._telefono = String(waId).replace(/\D/g, '').slice(-10);
  try { await subirDocumentos(perfil, archivos || [], o); } catch (e) { console.error('[wasapi-caso] documentos:', e.message); }
  if (bajarArchivo) try { await subirPendientes(perfil, bajarArchivo); } catch (e) { console.error('[wasapi-caso] pendientes:', e.message); }
  if (!o.sinContrato) try { await pedirContratoSiListo(perfil, sb, o); } catch (e) { console.error('[wasapi-caso] contrato:', e.message); }
}

module.exports = { sincronizarTodo, datosDelPerfil, fuenteDeOrigen, TIPOS_VALIDOS };
