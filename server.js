require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./supabase');
const { responderAyuda, iaDisponible } = require('./claude');

const app = express();
app.use(cors());
app.use(express.json({ limit: '6mb' }));
// ⚡ Velocidad del panel: respuestas JSON grandes comprimidas (gzip) y caché corta en memoria
const zlib = require('zlib');
const CACHE = new Map();
app.use((req, res, next) => {
  const orig = res.json.bind(res);
  res.json = (obj) => {
    const txt = JSON.stringify(obj);
    if (txt.length < 30000 || !/gzip/.test(req.headers['accept-encoding'] || '')) return orig(obj);
    zlib.gzip(txt, { level: 6 }, (err, buf) => {
      if (err) { res.set('Content-Type', 'application/json; charset=utf-8'); return res.send(txt); }
      if (res.locals.guardarCache && res.statusCode === 200) res.locals.guardarCache(buf);
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.send(buf);
    });
    return res;
  };
  next();
});
// Cualquier cambio desde el panel (subir OCM, bases, editar ventas…) borra la caché; el chat de los asesores no, para no anularla
app.use((req, res, next) => { if (req.method !== 'GET' && req.path.startsWith('/api/panel/')) CACHE.clear(); next(); });
// Guarda la respuesta comprimida unos segundos: si otro usuario (o el mismo) pide lo mismo, sale al instante
const cachear = (ms) => (req, res, next) => {
  if (req.query.fresco) return next();
  const k = req.path + '?' + Object.entries(req.query).sort().map(([a, b]) => a + '=' + b).join('&');
  const c = CACHE.get(k);
  if (c && Date.now() - c.t < ms && /gzip/.test(req.headers['accept-encoding'] || '')) {
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'X-Cache': 'hit' });
    return res.send(c.buf);
  }
  res.locals.guardarCache = (buf) => { CACHE.set(k, { t: Date.now(), buf }); while (CACHE.size > 40) CACHE.delete(CACHE.keys().next().value); };
  next();
};
// Registro de peticiones en los logs de Render (para diagnosticar errores de los asesores)
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const t = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/chat' || res.statusCode >= 400 || Date.now() - t > 4000) {
      console.log(`[peticion] ${req.method} ${req.path} → ${res.statusCode} · ${Date.now() - t} ms · ${String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0]} · ${req.body?.cedula ? 'cc ' + String(req.body.cedula).slice(-4) : req.body?.asesor || ''}`);
    }
  });
  next();
});

const PORT = process.env.PORT || 3000;
const leer = (archivo) => fs.readFileSync(path.join(__dirname, archivo), 'utf8');
// Se leen en cada mensaje: si editas los archivos de config no hace falta reiniciar.
const CAMPOS = () => JSON.parse(leer('campos.json'));

// ---------------------------------------------------------------------------
// Interruptores que el back prende/apaga desde el panel (tabla marce_config).
// Se guardan 30 s en memoria para no consultar Supabase en cada mensaje.
// ---------------------------------------------------------------------------
let CONFIG = { datos: {}, ts: 0 };
async function refrescarConfig(forzar) {
  if (!forzar && Date.now() - CONFIG.ts < 30000) return CONFIG.datos;
  try {
    CONFIG = { datos: await db.leerConfig(), ts: Date.now() };
  } catch (e) {
    CONFIG.ts = Date.now(); // si la tabla no existe todavía, todo queda apagado
  }
  return CONFIG.datos;
}
const activo = (clave) => Boolean(CONFIG.datos[clave]?.valor);

// ---------------------------------------------------------------------------
// Asesores: cada uno entra con su cédula; el nombre sale de la tabla "asesores".
// ---------------------------------------------------------------------------
const ASESORES = new Map(); // cédula → { fila, ts }
const soloDigitos = (v) => String(v || '').replace(/\D/g, '');
async function resolverAsesor(cedula) {
  const ced = soloDigitos(cedula);
  if (!ced) return null;
  const guardado = ASESORES.get(ced);
  if (guardado && Date.now() - guardado.ts < 60000) return guardado.fila;
  const fila = await db.buscarAsesor(ced);
  ASESORES.set(ced, { fila, ts: Date.now() });
  return fila;
}
const AVISO_CEDULA = {
  no_existe: '⚠️ Tu cédula no está registrada en Marce. Pídele a tu supervisor que te agregue en el panel (pestaña 👥 Asesores).',
  inactivo: '⚠️ Tu usuario está desactivado en Marce. Habla con tu supervisor.',
};


// ---------------------------------------------------------------------------
// Sesiones (una por ventana de chat). Viven en memoria del servidor.
// ---------------------------------------------------------------------------
const sesiones = new Map();
function nuevaSesion() {
  return {
    modo: 'libre', // 'libre' | 'captura' | 'buscar' | 'seleccion' | 'duplicado'
    captura: null, // { tipo, campos, paso, datos }
    cliente: null, // cliente abierto (fila de "interesados" + venta)
    resultados: [], // resultados de la última búsqueda
    accionPendiente: null, // acción a ejecutar cuando se elija un cliente
  };
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const OP = {
  NUEVO: 'Tengo un cliente interesado',
  BUSCAR: 'Buscar cliente',
  RESUMEN: 'Resumen de hoy',
  RESUMEN_EQUIPO: 'Resumen del equipo',
  VENTA: 'Registrar venta',
  NO_VENTA: 'No se interesó',
  COBERTURA: 'Actualizar cobertura',
  CANCELAR: 'Cancelar',
  HOY: 'Mis clientes',
  RESUMEN_MES: 'Resumen del mes',
  RELLAMAR: 'Volver a llamar',
  RELLAMADAS: 'Mis volver a llamar',
  ESCALAMIENTOS: 'Mis escalamientos',
  VENTAS: 'Mis ventas',
  OT_ACTIVA: 'OT activa',
  MIS_OT: 'Mis OT activas',
  EDITAR: '✏️ Editar datos',
  NOTA: '📝 Agregar nota',
  ALERTAS: '🔥 Clientes recuperables',
  ESCALAR: 'Escalamiento',
};
const MENU = [OP.NUEVO, OP.BUSCAR, OP.HOY, OP.RELLAMADAS, OP.RESUMEN];

const INTENCIONES = [
  ['cancelar', /^(cancelar|cancela|salir|olvidalo|reiniciar|empezar de nuevo)$/],
  ['menu', /^(nuevo|nueva|menu|opciones|ayuda|inicio|hola+|holi+|oli+|ola+|hey|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que mas|que hubo|quiubo|saludos|que puedes hacer|que haces|\+ ?nuevo)[\s.!?,]*(marce)?[.!?]*$/],
  ['hoy', /clientes\s+de\s+hoy|mis\s+clientes|mi\s+historial|^historial|mis\s+interesados|interesados\s+de\s+hoy|los\s+de\s+hoy|registrados\s+hoy|lista\s+de\s+(hoy|clientes)/],
  ['resumen_mes', /resumen\s+del\s+mes|como\s+voy\s+(en\s+)?(el|este)\s+mes|numeros\s+del\s+mes|en\s+el\s+mes/],
  ['resumen_equipo', /resumen\s+(del|de\s+todo\s+el)\s+equipo|como\s+va\s+el\s+equipo|numeros\s+del\s+equipo/],
  ['alertas', /alerta|recuperable|confirmo\s+cobertura|si\s+tenia\s+cobertura/],
  ['resumen', /resumen|consolid|como\s+voy|mis\s+numeros|cuant[oa]s\s+(llevo|tengo|van|ventas|interesados)/],
  ['venta', /registrar\s+(la\s+|una\s+)?venta|(es|fue|hubo|cerre|cerramos|se\s+hizo)\s+(una\s+)?venta|^venta$|ya\s+compro|acepto\s+la\s+oferta/],
  ['no_venta', /no\s+se\s+intereso|no\s+le\s+intereso|no\s+(esta|estuvo)\s+interesad|^no\s+venta$|no\s+quiso|rechazo/],
  ['cobertura', /(actualizar|cambiar|corregir)\s+(la\s+)?cobertura/],
  ['misot', /mis\s+ot|ots?\s+activas|mis\s+ordenes|seguimiento\s+(de\s+)?ot/],
  ['ot_activa', /ot\s+activa|tiene\s+(una\s+)?ot\b|orden\s+(de\s+trabajo\s+)?activa|^ot$/],
  ['misventas', /mis\s+ventas|ventas\s+(del\s+mes|instaladas|pendientes)|como\s+van\s+mis\s+ventas|instalacion(es)?\s+pendientes/],
  ['escalamientos', /mis\s+escalamientos|escalamientos\s+pendientes|como\s+van\s+(mis\s+)?escalamientos/],
  ['escalar', /escalar|escalamiento|escalacion|crear\s+(la\s+)?direccion|validar\s+(la\s+)?cedula|cartera|factibilidad/],
  ['nota', /agregar\s+(una\s+)?nota|dejar\s+(una\s+)?nota|poner\s+(una\s+)?nota|^nota$|^observaci/],
  ['editar', /editar|corregir\s+(un\s+|el\s+|los\s+)?datos?|cambiar\s+(un\s+|el\s+|los\s+)?datos?|actualizar\s+(un\s+|el\s+|los\s+)?datos?|modificar|me\s+equivoque/],
  ['rellamadas', /mis\s+volver\s+a\s+llamar|mis\s+rellamadas|rellamadas\s+(de\s+hoy|pendientes)|a\s+quien\s+(debo|tengo\s+que)\s+(volver\s+a\s+)?llamar|^rellamadas$|pendientes\s+por\s+llamar/],
  ['rellamar', /volver\s+a\s+llamar|rellamar|reprogramar|agendar\s+(una\s+)?(llamada|rellamada)|llamar\s+(despues|mas\s+tarde|otro\s+dia|manana)/],
  ['nuevo', /(tengo|hay|tenemos)\s+(un|una)?\s*(cliente|persona|prospecto)?\s*(interesad|nuev)|cliente\s+interesad|nuevo\s+(interesado|prospecto|cliente)|registrar\s+(un\s+)?interesado/],
  ['buscar', /^(buscar|busca|buscame|consultar|consulta)\b|buscar\s+(a|al|el|la)?\s*cliente|(info|informacion|datos|estado|ficha)\s+(de|del)\s+|como\s+va\s+(el|la)?\s*cliente|ya\s+(fue|esta)\s+(registrad|atendid)/],
];
function detectarIntencion(texto) {
  const t = norm(texto);
  for (const [nombre, re] of INTENCIONES) if (re.test(t)) return nombre;
  return null;
}

// "buscar a maría gómez" → "maría gómez"
function extraerTermino(texto) {
  let t = String(texto || '').trim();
  const quitar = [
    /^por\s+favor\s+/i,
    /^(buscar|busca|búscame|buscame|consultar|consulta|dame|traeme|tráeme|quiero|necesito)\s+/i,
    /^(la|el)\s+/i,
    /^(info|información|informacion|datos|estado|ficha)\s+/i,
    /^(de la|del|de|al|a|el|la)\s+/i,
    /^(cliente|clienta|señor|señora|sr\.?|sra\.?)(\s+|$)/i,
  ];
  for (let i = 0; i < 2; i++) for (const re of quitar) t = t.replace(re, '').trim();
  t = t.replace(/[?¿!¡.]+$/g, '').trim();
  return t.length >= 3 ? t : null;
}

const esCelular = (t) => /^3\d{9}$/.test(String(t).replace(/\D/g, '')) && String(t).replace(/[\d\s-]/g, '') === '';
const esCedula = (t) => /^\d{6,10}$/.test(String(t).replace(/[\s.]/g, ''));

// ---------------------------------------------------------------------------
// Tarjetas y textos
// ---------------------------------------------------------------------------
const ESTADOS = { en_gestion: 'En gestión', venta: 'Venta', no_venta: 'No se interesó', volver_llamar: 'Volver a llamar', escalado: 'Escalado', ot_activa: 'OT activa' };

// ---------------------------------------------------------------------------
// Fechas de rellamada (hora Colombia)
// ---------------------------------------------------------------------------
const hoyCO = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const sumarDias = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
function fechaBonita(iso) {
  if (!iso) return '';
  const hoy = hoyCO();
  if (iso === hoy) return 'hoy';
  if (iso === sumarDias(hoy, 1)) return 'mañana';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' });
}
function textoRellamada(c) {
  return [fechaBonita(c.rellamar_fecha), c.rellamar_hora].filter(Boolean).join(' · ');
}
// "hoy", "mañana", "pasado mañana", "viernes", "18/10", "18/10/2026", "en 3 dias"
function validarFechaFutura(crudo) {
  const t = norm(crudo).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const hoy = hoyCO();
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = t;
  else if (/^hoy\b/.test(t)) iso = hoy;
  else if (/^pasado\s*manana/.test(t)) iso = sumarDias(hoy, 2);
  else if (/^manana/.test(t)) iso = sumarDias(hoy, 1);
  else if (/^en\s+(\d{1,2})\s+dias?/.test(t)) iso = sumarDias(hoy, parseInt(t.match(/^en\s+(\d{1,2})/)[1], 10));
  else {
    const dia = DIAS.findIndex((d) => t.startsWith(d) || t.startsWith('el ' + d) || t.startsWith('este ' + d) || t.startsWith('proximo ' + d));
    if (dia >= 0) {
      const hoyDia = new Date(hoy + 'T12:00:00Z').getUTCDay();
      let n = (dia - hoyDia + 7) % 7;
      if (n === 0) n = 7;
      iso = sumarDias(hoy, n);
    } else {
      const m = t.match(/^(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(\d{2,4}))?$/);
      if (m) {
        let anio = m[3] ? parseInt(m[3], 10) : parseInt(hoy.slice(0, 4), 10);
        if (anio < 100) anio += 2000;
        const cand = `${anio}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
        const d = new Date(cand + 'T12:00:00Z');
        if (!isNaN(d) && d.toISOString().slice(0, 10) === cand) iso = !m[3] && cand < hoy ? `${anio + 1}${cand.slice(4)}` : cand;
      }
    }
  }
  if (!iso) return { ok: false };
  if (iso < hoy) return { ok: false, mensaje: 'Esa fecha ya pasó. ¿Para cuándo quedó la nueva llamada?' };
  return { ok: true, valor: iso };
}

// Fecha de una venta de días anteriores: desde hace 31 días hasta hoy.
const DIAS_ATRAS = 31;
function validarFechaPasada(crudo) {
  const t = norm(crudo).replace(/^📅\s*/, '');
  const hoy = hoyCO();
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = t;
  else if (/^hoy\b/.test(t)) iso = hoy;
  else if (/^antier|^anteayer/.test(t)) iso = sumarDias(hoy, -2);
  else if (/^ayer/.test(t)) iso = sumarDias(hoy, -1);
  else {
    const m = t.match(/^(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(\d{2,4}))?$/);
    if (m) {
      let anio = m[3] ? parseInt(m[3], 10) : parseInt(hoy.slice(0, 4), 10);
      if (anio < 100) anio += 2000;
      const cand = `${anio}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
      const d = new Date(cand + 'T12:00:00Z');
      if (!isNaN(d) && d.toISOString().slice(0, 10) === cand) iso = !m[3] && cand > hoy ? `${anio - 1}${cand.slice(4)}` : cand;
    }
  }
  if (!iso) return { ok: false };
  if (iso > hoy) return { ok: false, mensaje: 'La venta no puede ser de una fecha futura.' };
  if (iso < sumarDias(hoy, -DIAS_ATRAS)) return { ok: false, mensaje: `Solo se pueden registrar ventas de los últimos ${DIAS_ATRAS} días.` };
  return { ok: true, valor: iso };
}

const TEXTO_TORRE = { instalado: '✅ Instalado', reagendado: '📅 Reagendado', cancelado: '🚫 Cancelado', pendiente: '⏳ Pendiente', iniciado: '🚚 Iniciado', sin_iniciar_am: '🕗 Sin iniciar AM', sin_iniciar_pm: '🕑 Sin iniciar PM' };
const fechaDM = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const textoTorre = (v) => v.torre_salida ? `Torre: ${TEXTO_TORRE[v.torre_salida] || v.torre_salida}${v.torre_fecha_reagenda ? ` → ${fechaDM(v.torre_fecha_reagenda)}` : ''}${v.torre_motivo ? ` (${v.torre_motivo})` : ''}` : '';
const TEXTO_APROBACION = { cantada_viable: '✅ Cantada viable', cantada_no_viable: '⚖️ Cantada no viable (50/50)', rechazada: '⛔ Rechazada (no cantada)' };
// Estado de instalación de una venta (lo marca el back office en el panel).
function textoInstalacion(v) {
  const fecha = v.instalacion_fecha
    ? ' · ' + new Date(v.instalacion_fecha).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short' })
    : '';
  if (v.estado_instalacion === 'instalada') return '✅ Instalada' + fecha;
  if (v.estado_instalacion === 'no_instalada') return '❌ No instalada' + fecha;
  if (v.estado_instalacion === 'cancelada') return '🚫 Cancelada' + fecha;
  return '⏳ Pendiente de instalación';
}

// Lo que el back office dijo sobre la cobertura (auditoría desde el panel).
function textoAuditoria(c) {
  if (c.auditoria_cobertura === 'confirmada') return ' · ✅ auditada';
  if (c.auditoria_cobertura === 'sin_cobertura') return ' · ❌ auditoría: sin cobertura';
  return '';
}

// 🔔 Alerta: el asesor marcó "No" y el back confirmó que SÍ tiene cobertura.
// Se apaga sola cuando el asesor vuelve a gestionar al cliente (actualiza cobertura,
// registra venta, no se interesó, volver a llamar…).
function alertaCobertura(c) {
  if (!c || c.auditoria_cobertura !== 'confirmada' || norm(c.cobertura_validada) !== 'no') return false;
  if (c.resultado === 'venta') return false;
  const aud = new Date(c.auditoria_fecha || 0).getTime();
  const upd = new Date(c.updated_at || 0).getTime();
  return !(upd - aud > 60000);
}
async function alertasDe(asesor) {
  return (await db.alertasCobertura(asesor)).filter(alertaCobertura);
}

function tarjetaDe(c) {
  const fecha = c.created_at
    ? new Date(c.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '';
  const cob = norm(c.cobertura_validada);
  const detalles = [
    ['Gestiona', c.asesor],
    ['Teléfono', c.telefono],
    ['Dirección', [c.direccion, c.ciudad, regionalDe(c.ciudad, c.datos?.departamento)].filter(Boolean).join(' · ')],
    ['Cobertura', (cob === 'si' ? 'Sí' : cob === 'no' ? 'No' : 'Sin validar') + textoAuditoria(c)],
    ['Registrado', fecha],
  ];
  if (alertaCobertura(c)) detalles.unshift(['🔥 Recuperable', 'El back confirmó que SÍ tiene cobertura — vuelve a llamarlo']);
  if (c.venta) {
    const v = c.venta;
    if (v.datos?.registrada_el && v.created_at) {
      detalles.push(['📅 Fecha venta', new Date(v.created_at).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short' }) + ' (fecha anterior)']);
    }
    detalles.push(['Tipo de venta', v.tipo_venta || v.datos?.tipo_venta]);
    const serv = v.servicios_vendidos || v.datos?.servicios_vendidos;
    if (serv) detalles.push(['Servicios vendidos', String(serv)]);
    const multi = v.multiasistencia || v.datos?.multiasistencia;
    if (multi) detalles.push(['Multiasistencia', norm(multi) === 'si' ? `Sí · ${v.multiasistencia_cual || v.datos?.multiasistencia_cual || ''}` : 'No']);
    const ott = v.ott || v.datos?.ott;
    if (ott) detalles.push(['OTT', norm(ott) === 'si' ? `Sí · ${v.ott_cual || v.datos?.ott_cual || ''}` : 'No']);
    detalles.push(['Cédula', v.cedula], ['Plan', v.plan], ['OT', v.numero_ot], ['Cuenta', v.numero_cuenta]);
    detalles.push(['Agenda', [v.fecha_agenda, v.hora_agenda].filter(Boolean).join(' · ')]);
    detalles.push(['Instalación', textoInstalacion(v)]);
    if (v.instalacion_nota) detalles.push([/no_instalada|cancelada/.test(v.estado_instalacion || '') ? 'Motivo' : 'Nota instalación', v.instalacion_nota]);
    if (v.torre_salida) detalles.push(['Torre de control', textoTorre(v).replace(/^Torre: /, '')]);
    if (v.aprobacion_bo) detalles.push(['Aprobación BO', TEXTO_APROBACION[v.aprobacion_bo] + (v.aprobacion_motivo ? ` · ${v.aprobacion_motivo}` : '')]);
  }
  if (c.resultado === 'no_venta' && c.motivo_no_interes) detalles.push(['Motivo', c.motivo_no_interes]);
  if (c.ot_activa_numero) {
    const est = c.ot_activa_estado === 'liberada' ? '✅ liberada' : '⏳ activa';
    detalles.push(['🧾 OT activa', `${c.ot_activa_numero} · ${est}`]);
    if (c.ot_activa_respuesta) detalles.push(['Respuesta back', c.ot_activa_respuesta]);
  }
  if (c.escalamiento_tipo) {
    const est = c.escalamiento_estado === 'resuelto' ? '✅ resuelto' : '⏳ pendiente';
    detalles.push(['🛠 Escalamiento', `${c.escalamiento_tipo} · ${est}`]);
    if (c.escalamiento_detalle) detalles.push(['Detalle', c.escalamiento_detalle]);
    if (c.escalamiento_respuesta) detalles.push(['Respuesta back', c.escalamiento_respuesta]);
  }
  if (c.resultado === 'volver_llamar') {
    detalles.push(['📞 Volver a llamar', textoRellamada(c)]);
    if (c.rellamar_nota && norm(c.rellamar_nota) !== 'ninguna') detalles.push(['Nota', c.rellamar_nota]);
  }
  const obs = c.venta?.observaciones || c.observaciones;
  if (obs && norm(obs) !== 'ninguna') detalles.push(['📝 Observaciones', obs]);
  const estado = c.resultado || 'en_gestion';
  const horaCorta = c.created_at
    ? new Date(c.created_at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' })
    : '';
  return {
    id: c.id,
    horaCorta,
    nombre: c.nombre_cliente || 'Sin nombre',
    estado,
    estadoTexto: ESTADOS[estado] || estado,
    detalles: detalles.filter(([, v]) => v).map(([label, valor]) => ({ label, valor: String(valor) })),
  };
}

function accionesPara(c) {
  if (!c) return MENU;
  const sinCobertura = norm(c.cobertura_validada) === 'no';
  if (c.resultado === 'venta') return [OP.NOTA, OP.EDITAR, OP.BUSCAR, OP.NUEVO];
  if (c.resultado === 'no_venta') return [OP.VENTA, OP.RELLAMAR, OP.OT_ACTIVA, OP.ESCALAR, OP.COBERTURA, OP.NOTA, OP.EDITAR];
  if (sinCobertura) return [OP.COBERTURA, OP.ESCALAR, OP.NO_VENTA, OP.RELLAMAR, OP.NOTA, OP.EDITAR];
  return [OP.VENTA, OP.NO_VENTA, OP.RELLAMAR, OP.OT_ACTIVA, OP.ESCALAR, OP.COBERTURA, OP.NOTA, OP.EDITAR];
}

// ---------------------------------------------------------------------------
// Editar un dato de la ficha
// ---------------------------------------------------------------------------
// Datos que se pueden corregir: los del interesado siempre, los de la venta si tiene venta.
const EDITABLES_INTERESADO = ['nombre_cliente', 'telefono', 'direccion', 'ciudad'];
const EDITABLES_VENTA = ['tipo_venta', 'servicios_vendidos', 'multiasistencia', 'multiasistencia_cual', 'cedula', 'barrio', 'plan', 'numero_ot', 'numero_cuenta', 'fecha_agenda', 'hora_agenda', 'observaciones'];
function campoEditable(id) {
  const todos = [...(CAMPOS().interesado || []), ...(CAMPOS().venta || [])];
  const def = todos.find((c) => c.id === id);
  if (!def) return null;
  if (id === 'observaciones') {
    return { ...def, label: 'Observaciones', prompt: '📝 ¿Qué nota quieres dejar sobre este cliente? Escríbela como quieras 👇', opcionesSugeridas: undefined, regex: '^.{2,}$', errorMessage: 'Escribe la nota (mínimo 2 caracteres).' };
  }
  return { ...def, prompt: `✏️ Escribe el nuevo dato de **${def.label.toLowerCase()}**:`, opcionesSugeridas: undefined };
}
function editablesPara(c) {
  const ids = [...EDITABLES_INTERESADO, ...(c?.venta ? EDITABLES_VENTA : ['observaciones'])];
  return ids.map(campoEditable).filter(Boolean);
}
function valorActual(c, id) {
  if (!c) return '';
  if (id === 'observaciones') return c.venta?.observaciones || c.observaciones || '';
  if (EDITABLES_VENTA.includes(id)) return c.venta?.[id] || '';
  return c[id] || '';
}
function pedirNota(sesion) {
  const c = sesion.cliente;
  const campo = campoEditable('observaciones');
  sesion.modo = 'captura';
  sesion.captura = { tipo: 'editar', campoId: 'observaciones', campos: [campo], paso: 0, datos: {} };
  const actual = valorActual(c, 'observaciones');
  const previa = actual && norm(actual) !== 'ninguna' ? `Nota actual:\n${actual}\n\nLo que escribas se **agrega** (no se borra lo anterior).\n\n` : '';
  return { reply: `${previa}📝 ¿Qué nota quieres dejar sobre **${c.nombre_cliente || 'este cliente'}**? Escríbela como quieras 👇`, opciones: [OP.CANCELAR] };
}
function pedirQueEditar(sesion) {
  const c = sesion.cliente;
  if (!c) return { reply: 'Primero abre la ficha del cliente (búscalo por nombre o celular).', opciones: [OP.BUSCAR, OP.HOY] };
  sesion.modo = 'editar_elegir';
  return {
    reply: `✏️ ¿Qué dato de **${c.nombre_cliente || 'este cliente'}** deseas actualizar?`,
    opciones: [...editablesPara(c).map((f) => f.label), OP.CANCELAR],
  };
}

function preguntar(campo, cap) {
  const resp = {
    reply: campo.prompt,
    progreso: { actual: cap.paso + 1, total: cap.campos.length, titulo: TITULOS[cap.tipo] },
  };
  const ops = campo.opciones || campo.opcionesSugeridas;
  if (ops) resp.opciones = [...ops];
  // Al preguntar la cobertura, se muestra la dirección en Google Maps para que el asesor la confirme.
  const dir = cap.datos.direccion || cap.datos._direccion;
  if (campo.id === 'cobertura' && dir) {
    const ciudad = cap.datos.ciudad || cap.datos._ciudad || '';
    const texto = [dir, ciudad].filter(Boolean).join(', ');
    resp.reply = `📍 Esta es la dirección en Google Maps:\n**${texto}**\n¿La validaste bien?\n\n${campo.prompt}`;
    const paraMapa = [cap.datos.direccion_original || dir, ciudad].filter(Boolean).join(', ');
    resp.enlace = { texto: '🗺 Ver dirección en Google Maps', url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(paraMapa + ', Colombia') };
  }
  if (campo.entrada) {
    resp.entrada = { tipo: campo.entrada, formato: campo.formato || 'iso' };
    if (campo.tipo === 'fecha_pasada') Object.assign(resp.entrada, { min: sumarDias(hoyCO(), -DIAS_ATRAS), max: hoyCO() });
    // Venta de un día anterior: la instalación pudo quedar agendada desde ese día.
    // Fecha de instalación: se permite una fecha anterior a hoy (backlog), hasta 90 días atrás.
    if (campo.id === 'fecha_agenda') resp.entrada.min = sumarDias(hoyCO(), -90);
  }
  return resp;
}
const TITULOS = { interesado: 'Nuevo interesado', venta: 'Registro de venta', no_venta: 'No se interesó', cobertura: 'Cobertura', rellamar: 'Volver a llamar', escalamiento: 'Escalamiento', ot_activa: 'OT activa', editar: 'Editar dato' };

const conCliente = (sesion) => (sesion.cliente ? ` de ${sesion.cliente.nombre_cliente}` : '');

// ---------------------------------------------------------------------------
// Capturas (interesado, venta, no venta, cobertura)
// ---------------------------------------------------------------------------
// Salta los campos ya respondidos y los que dependen de otra respuesta (ej. "¿Cuál multiasistencia?" solo si dijo Sí).
function avanzar(cap) {
  while (cap.paso < cap.campos.length) {
    const c = cap.campos[cap.paso];
    if (c.id in cap.datos) { cap.paso += 1; continue; }
    if (c.siCampo && norm(cap.datos[c.siCampo.id]) !== norm(c.siCampo.valor)) { cap.datos[c.id] = null; cap.paso += 1; continue; }
    break;
  }
}
function iniciarCaptura(sesion, tipo, datosPrevios = {}) {
  const campos = CAMPOS()[tipo];
  const cap = { tipo, campos, paso: 0, datos: { ...datosPrevios } };
  // Campos que solo aparecen si el back los activó en el panel (ej. fecha de venta anterior).
  for (const c of campos) if (c.soloSi && !activo(c.soloSi) && !(c.id in cap.datos)) cap.datos[c.id] = null;
  avanzar(cap);
  sesion.modo = 'captura';
  sesion.captura = cap;
  return preguntar(campos[cap.paso], cap);
}

// ---------------------------------------------------------------------------
// Ciudades / municipios de Colombia (1.119, fuente DANE). El asesor escribe y
// Marce la reconoce aunque venga sin tilde o con errores de digitación.
// ---------------------------------------------------------------------------
let MUNICIPIOS = null;
function municipios() {
  if (!MUNICIPIOS) {
    const lista = JSON.parse(leer('municipios.json'));
    const repetidos = new Set(lista.map((m) => m[0]).filter((n, i, a) => a.indexOf(n) !== i));
    MUNICIPIOS = lista.map(([nombre, depto]) => ({
      nombre,
      depto,
      etiqueta: repetidos.has(nombre) ? `${nombre} (${depto})` : nombre,
      llave: llaveCiudad(nombre),
    }));
  }
  return MUNICIPIOS;
}
function llaveCiudad(s) {
  return norm(s)
    .replace(/\b(d\.?\s?c\.?|distrito capital|distrito)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const ALIAS_CIUDAD = { bogota: 'Bogotá D.C.', bta: 'Bogotá D.C.', 'cartagena de indias': 'Cartagena', 'san jose de cucuta': 'Cúcuta', mede: 'Medellín', 'santafe de bogota': 'Bogotá D.C.',
  villavo: 'Villavicencio', bquilla: 'Barranquilla', 'b quilla': 'Barranquilla', bmanga: 'Bucaramanga', 'b manga': 'Bucaramanga',
  'santa fe de bogota': 'Bogotá D.C.', 'bogota dc': 'Bogotá D.C.' };
function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const f = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = f[0];
    f[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = f[j];
      f[j] = Math.min(f[j] + 1, f[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return f[b.length];
}
const DEJAR = '✍️ Dejar: ';
function validarMunicipio(crudo) {
  const texto = String(crudo || '').trim();
  if (texto.startsWith(DEJAR)) {
    const v = texto.slice(DEJAR.length).replace(/^"|"$/g, '').trim();
    return v.length >= 3 ? { ok: true, valor: v } : { ok: false };
  }
  const lista = municipios();
  // Botón elegido: "Granada (Meta)" o nombre exacto
  const porEtiqueta = lista.find((m) => norm(m.etiqueta) === norm(texto));
  if (porEtiqueta) return { ok: true, valor: porEtiqueta.etiqueta, extra: { departamento: porEtiqueta.depto } };
  const k = llaveCiudad(texto);
  if (k.length < 3) return { ok: false };
  const alias = ALIAS_CIUDAD[k];
  const exactos = alias ? lista.filter((m) => m.nombre === alias) : lista.filter((m) => m.llave === k);
  if (exactos.length === 1) return { ok: true, valor: exactos[0].etiqueta, extra: { departamento: exactos[0].depto } };
  if (exactos.length > 1) {
    return { ok: false, mensaje: `Hay varios municipios llamados "${exactos[0].nombre}". ¿Cuál es?`, sugerencias: exactos.map((m) => m.etiqueta) };
  }
  const candidatos = lista
    .map((m) => {
      let d = distancia(k, m.llave);
      if (m.llave.startsWith(k)) d = Math.min(d, 0.5);
      else if (k.length >= 4 && m.llave.includes(k)) d = Math.min(d, 1);
      return { m, d };
    })
    .filter((x) => x.d <= (k.length >= 7 ? 2 : 1))
    .sort((a, b) => a.d - b.d || a.m.nombre.length - b.m.nombre.length)
    .slice(0, 5);
  if (candidatos.length === 1 && candidatos[0].d <= 1 && !candidatos[0].m.llave.startsWith(k)) {
    // Un solo parecido muy cercano (ej. "medelin" → Medellín): lo tomamos de una.
    const m = candidatos[0].m;
    return { ok: true, valor: m.etiqueta, extra: { departamento: m.depto } };
  }
  return {
    ok: false,
    mensaje: candidatos.length
      ? `No encontré "${texto}" exacto. ¿Es alguna de estas?`
      : `No encontré "${texto}" entre los municipios de Colombia. Revisa cómo está escrito, o déjalo así si estás seguro.`,
    sugerencias: [...candidatos.map((x) => x.m.etiqueta), `${DEJAR}${texto}`],
  };
}

// ---------------------------------------------------------------------------
// Direcciones homologadas (nomenclatura IGAC / Agustín Codazzi)
// Ej.: "calle 6c # 82a-25 torre 1 apto 1103" → "CL 6C # 82A - 25 TO 1 AP 1103"
// ---------------------------------------------------------------------------
const VIAS = [
  [/^(AVENIDA|AV|AVE|AVDA)\s*(CALLE|CL|CLL)$/, 'AC'],
  [/^(AVENIDA|AV|AVE|AVDA)\s*(CARRERA|KR|CR|CRA|KRA)$/, 'AK'],
  [/^(CALLE|CALL|CALLLE|CLL|CLLE|CL|CAL|CLE)$/, 'CL'],
  [/^(CARRERA|CARERA|CARRRERA|CRA|CRR|CARR|CR|KRA|KR|KRR|CRRA|CAR)$/, 'KR'],
  [/^(AVENIDA|AV|AVE|AVDA|AVN)$/, 'AV'],
  [/^(DIAGONAL|DIAG|DG|DGNAL|DIAGNAL)$/, 'DG'],
  [/^(TRANSVERSAL|TRANSV|TRANSVER|TRV|TR|TV|TRASVERSAL|TRANVERSAL)$/, 'TV'],
  [/^(CIRCULAR|CIR|CIRC)$/, 'CIR'],
  [/^(CIRCUNVALAR|CRV|CIRCUNV)$/, 'CRV'],
  [/^(AUTOPISTA|AUTOP|AU)$/, 'AU'],
  [/^(CARRETERA|CARRET|CT)$/, 'CT'],
  [/^(VEREDA|VDA|VRDA)$/, 'VDA'],
  [/^(KILOMETRO|KM)$/, 'KM'],
];
const COMPLEMENTOS = [
  [/^(APARTAMENTO|APARTAMENT|APTO|APT|AP|APART|APTOS|DPTO|DEPARTAMENTO)$/, 'AP'],
  [/^(TORRE|TORR|TOR|TO|T)$/, 'TO'],
  [/^(BLOQUE|BLQ|BL|BLOQ)$/, 'BL'],
  [/^(CASA|CS|CA)$/, 'CA'],
  [/^(INTERIOR|INT|IN)$/, 'IN'],
  [/^(PISO|PI|P)$/, 'PI'],
  [/^(LOCAL|LC|LOC)$/, 'LC'],
  [/^(OFICINA|OFI|OF)$/, 'OF'],
  [/^(MANZANA|MZ|MZA|MANZ)$/, 'MZ'],
  [/^(LOTE|LT|LTE)$/, 'LT'],
  [/^(ETAPA|ET)$/, 'ET'],
  [/^(CONJUNTO|CONJ|CJ|CONJUNTOS)$/, 'CONJ'],
  [/^(EDIFICIO|EDIF|ED)$/, 'ED'],
  [/^(URBANIZACION|URB|UR)$/, 'UR'],
  [/^(BARRIO|BRR|BR|BARR)$/, 'BR'],
  [/^(SECTOR|SEC|SC)$/, 'SC'],
  [/^(UNIDAD|UND|UN)$/, 'UN'],
  [/^(PORTERIA|PT)$/, 'PT'],
  [/^(SOTANO|SS)$/, 'SS'],
  [/^(FINCA|FCA)$/, 'FCA'],
];
const CARDINAL = { SUR: 'SUR', ESTE: 'ESTE', NORTE: 'NORTE', OESTE: 'OESTE', OCC: 'OESTE', OCCIDENTE: 'OESTE' };
const mapear = (lista, w) => { for (const [re, v] of lista) if (re.test(w)) return v; return null; };

function homologarDireccion(texto) {
  const original = String(texto || '').trim();
  let t = original
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/N[°º]\s*|\bNO\.\s*|\bNUMERO\b|\bNRO\.?\b/g, ' # ')
    .replace(/[,;:()]/g, ' ')
    .replace(/[#]/g, ' # ')
    .replace(/[-–]/g, ' - ')
    .replace(/\./g, ' ')
    // separar números pegados a letras: 58ASUR → 58 A SUR ; TORRE2 → TORRE 2 ; AP1103 → AP 1103
    .replace(/([A-Z]{2,})(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z]+)/g, (m, d, l) => {
      if (l === 'BIS') return `${d} BIS`;
      const m2 = l.match(/^([A-Z]?)(BIS)?([A-Z]?)(SUR|ESTE|NORTE|OESTE)?$/);
      return m2 ? `${d} ${[m2[1], m2[2], m2[3], m2[4]].filter(Boolean).join(' ')}` : `${d} ${l}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
  let w = t.split(' ').filter(Boolean);
  // Tipo de vía (también "AVENIDA CALLE")
  let via = null;
  if (w.length >= 2) { via = mapear(VIAS, w[0] + ' ' + w[1]) ? mapear(VIAS, w[0] + ' ' + w[1]) : null; if (via && /^(AC|AK)$/.test(via)) w = w.slice(2); else via = null; }
  if (!via && w.length) { via = mapear(VIAS, w[0]); if (via) w = w.slice(1); }
  if (!via) return { ok: false, original };
  if (via === 'VDA' || via === 'KM' || via === 'CT' || via === 'AU') {
    return { ok: true, valor: [via, ...w.filter((x) => x !== '#' && x !== '-')].join(' '), original };
  }
  // Separar complementos (torre, apto...) que pueden venir en cualquier parte
  const principal = [];
  const comp = [];
  for (let i = 0; i < w.length; i++) {
    const c = mapear(COMPLEMENTOS, w[i]);
    // "T" o "P" sueltas solo cuentan como complemento si van seguidas de un número
    if (c && !((w[i] === 'T' || w[i] === 'P' || w[i] === 'CA' || w[i] === 'IN') && !/^\d/.test(w[i + 1] || ''))) {
      const partes = [c];
      if (['CONJ', 'ED', 'UR', 'BR', 'SC', 'FCA', 'UN'].includes(c)) {
        // Complementos con nombre: "CONJ LOS PINOS", "ED TORRES DEL PARQUE"
        while (i + 1 < w.length && !mapear(COMPLEMENTOS, w[i + 1]) && !/^[#-]$/.test(w[i + 1]) && !/^\d/.test(w[i + 1])) partes.push(w[++i]);
        comp.push(partes.join(' '));
        continue;
      }
      while (i + 1 < w.length && w[i + 1] !== '#' && !mapear(COMPLEMENTOS, w[i + 1]) && (/^\d/.test(w[i + 1]) || /^[A-Z]$/.test(w[i + 1]) || partes.length === 1)) {
        partes.push(w[++i]);
        if (/^\d/.test(partes[partes.length - 1]) && !/^[A-Z]$/.test(w[i + 1] || '')) break;
      }
      comp.push(partes.join(' '));
    } else principal.push(w[i]);
  }
  // Grupos numéricos: vía (6C BIS SUR) # cruce (82A) - placa (25)
  const grupos = [];
  let cardinales = [];
  let actual = null;
  const sobrantes = [];
  // Nombre de la vía (ej. "AV BOYACA 16B - 53"): palabras antes del primer número.
  const nombreVia = [];
  while (principal.length && !/^\d/.test(principal[0]) && principal[0] !== '#' && principal[0] !== '-' && !CARDINAL[principal[0]] && !mapear(VIAS, principal[0])) nombreVia.push(principal.shift());
  for (const x of principal) {
    if (mapear(VIAS, x)) { if (actual) { grupos.push(actual); actual = null; } continue; } // "CL 20 CR 77-80": la segunda vía es el cruce
    if (x === '#' || x === '-' || x === 'CON') { if (actual) { grupos.push(actual); actual = null; } continue; }
    if (CARDINAL[x]) { cardinales.push(CARDINAL[x]); continue; }
    if (/^\d+$/.test(x)) { if (actual) grupos.push(actual); actual = x; continue; }
    if (actual && (/^[A-Z]$/.test(x) || x === 'BIS')) { actual += (x === 'BIS' ? ' BIS' : (/BIS$/.test(actual) ? ' ' + x : x)); continue; }
    if (actual) { grupos.push(actual); actual = null; }
    sobrantes.push(x);
  }
  if (actual) grupos.push(actual);
  let valor, g3, resto;
  if (nombreVia.length) {
    if (grupos.length < 2) return { ok: false, original };
    let g2;
    [g2, g3, ...resto] = grupos;
    valor = `${via} ${nombreVia.join(' ')} # ${g2} - ${g3}`;
  } else {
    if (grupos.length < 2) return { ok: false, original };
    let g1, g2;
    [g1, g2, g3, ...resto] = grupos;
    valor = `${via} ${g1} # ${g2}`;
    if (g3) valor += ` - ${g3}`;
  }
  if (cardinales.length) valor += ' ' + [...new Set(cardinales)].join(' ');
  if (resto.length) valor += ' ' + resto.join(' ');
  // Orden de complementos de lo general a lo particular (conjunto → torre → apartamento)
  const ORDEN = ['UR', 'BR', 'SC', 'CONJ', 'UN', 'ED', 'MZ', 'LT', 'ET', 'BL', 'TO', 'IN', 'CA', 'PI', 'AP', 'LC', 'OF', 'PT', 'SS', 'FCA'];
  comp.sort((a, b) => ORDEN.indexOf(a.split(' ')[0]) - ORDEN.indexOf(b.split(' ')[0]));
  if (comp.length) valor += ' ' + comp.join(' ');
  if (sobrantes.length) valor += ' ' + sobrantes.join(' ');
  return { ok: Boolean(g3), parcial: !g3, valor: valor.replace(/\s+/g, ' ').trim(), original };
}

// El asesor escribe la dirección como sea; Marce la deja homologada.
// ---------------------------------------------------------------------------
// Regionales (R1–R5) según el departamento de la ciudad
// ---------------------------------------------------------------------------
const REGIONAL_DEPTO = {
  atlantico: 'R1', bolivar: 'R1', cesar: 'R1', cordoba: 'R1', 'la guajira': 'R1', magdalena: 'R1', sucre: 'R1', 'archipielago de san andres': 'R1',
  antioquia: 'R2', choco: 'R2', caldas: 'R2', quindio: 'R2', risaralda: 'R2',
  caqueta: 'R3', cauca: 'R3', huila: 'R3', narino: 'R3', putumayo: 'R3', tolima: 'R3', 'valle del cauca': 'R3',
  'bogota d.c.': 'R4', cundinamarca: 'R4',
  meta: 'R5', boyaca: 'R5', santander: 'R5', 'norte de santander': 'R5', arauca: 'R5', casanare: 'R5', amazonas: 'R5', guainia: 'R5', guaviare: 'R5', vaupes: 'R5', vichada: 'R5',
};
// Barrios, corregimientos y nombres mal escritos que se ven en la operación → regional
const REGIONAL_CIUDAD = {
  'san antonio de prado': 'R2', manrique: 'R2', belen: 'R2', rionegro: 'R2', barbosa: 'R2', valparaiso: 'R2', armenia: 'R2', dosquebras: 'R2', 'dos quebradas': 'R2',
  sohacha: 'R4', sobo: 'R4', bogoat: 'R4', bpgota: 'R4', boogota: 'R4', bgota: 'R4', fuza: 'R4',
  rioacha: 'R1', satelcaribe: 'R1', guachaca: 'R1', 'san andes': 'R1', bayunca: 'R1', santamarta: 'R1', norosi: 'R1', 'puerto colombia': 'R1',
  restrepo: 'R5', sopata: 'R5', capinajeo: 'R5', florencia: 'R3', candelaria: 'R3',
};
// Departamentos escritos con errores ("CUNDINAMNARCA", "ANTIOQUIIA"…) → regional
const REGIONAL_TEXTO = [
  [/^valle( del)?( cau\w*)?$/, 'R3'], [/^cun\w*$|^cind\w*$|^cundi$/, 'R4'], [/^bog\w*( d ?c)?$/, 'R4'], [/^ant\w*qu\w*$|^antio\w*$/, 'R2'], [/^norte (de )?santander$/, 'R5'],
  [/^san andres$/, 'R1'], [/^atlant\w*$/, 'R1'], [/^(la )?guajira$/, 'R1'], [/^mag\w*na$|^madal\w*$/, 'R1'], [/^cald\w*$/, 'R2'], [/^quind\w*$/, 'R2'], [/^risar\w*$/, 'R2'],
  [/^(regional )?eje cafetero$/, 'R2'], [/^casanar\w*$/, 'R5'],
];
const CACHE_REGIONAL = new Map();
function regionalDe(ciudad, depto) {
  if (depto && REGIONAL_DEPTO[norm(depto)]) return REGIONAL_DEPTO[norm(depto)];
  const t = String(ciudad || '').trim();
  if (!t) return null;
  if (CACHE_REGIONAL.has(t)) return CACHE_REGIONAL.get(t);
  const k = norm(t).replace(/[^a-z0-9() ]/g, ' ').replace(/\s+/g, ' ').trim();
  let r = REGIONAL_CIUDAD[k] || REGIONAL_DEPTO[k] || null;
  if (!r) {
    // Ciudad con departamento: "Granada (Meta)"
    const conDepto = k.match(/\(([^)]+)\)\s*$/);
    if (conDepto && REGIONAL_DEPTO[conDepto[1]]) r = REGIONAL_DEPTO[conDepto[1]];
  }
  if (!r) {
    // Nombre exacto de municipio; si hay varios con ese nombre y todos son de la misma regional, se toma esa.
    const iguales = municipios().filter((m) => m.llave === llaveCiudad(t));
    const regs = [...new Set(iguales.map((m) => REGIONAL_DEPTO[norm(m.depto)]))];
    if (regs.length === 1) r = regs[0] || null;
  }
  if (!r) for (const [re, reg] of REGIONAL_TEXTO) if (re.test(k)) { r = reg; break; }
  if (!r) {
    const m = validarMunicipio(t); // reconoce la ciudad aunque venga con errores de digitación
    if (m.ok && m.extra?.departamento) r = REGIONAL_DEPTO[norm(m.extra.departamento)] || null;
  }
  CACHE_REGIONAL.set(t, r);
  return r;
}
const conRegional = (f) => (f ? { ...f, regional: regionalDe(f.ciudad, f.datos?.departamento) } : f);

function validarDireccion(crudo) {
  const texto = String(crudo || '').trim();
  if (texto.startsWith(DEJAR)) {
    const v = texto.slice(DEJAR.length).replace(/^"|"$/g, '').trim();
    return v.length >= 5 ? { ok: true, valor: v.toUpperCase(), extra: { direccion_original: v, direccion_sin_homologar: true } } : { ok: false };
  }
  if (texto.length < 5) return { ok: false };
  const r = homologarDireccion(texto);
  if (r.ok) return { ok: true, valor: r.valor, extra: { direccion_original: texto }, homologada: r.valor };
  return {
    ok: false,
    mensaje: `No pude homologar "${texto}". Escríbela con el tipo de vía y los números, por ejemplo: **Calle 6C # 82A-25 Torre 1 Apto 1103**. Si es rural o especial, déjala así.`,
    sugerencias: [`${DEJAR}${texto}`],
  };
}

// Uno o varios celulares: "3001234567, 3109876543" → "3001234567 / 3109876543"
function validarTelefonos(crudo) {
  const partes = String(crudo || '').split(/[,;/|]|\s+y\s+|\s{2,}|\n/i).map((x) => x.replace(/\D/g, '')).filter(Boolean)
    .map((x) => (x.length === 12 && x.startsWith('57') ? x.slice(2) : x));
  // Si escribió los números seguidos sin separador (ej. "3001234567 3109876543"), se cortan de 10 en 10
  const nums = partes.flatMap((x) => (x.length > 10 && x.length % 10 === 0 ? x.match(/\d{10}/g) : [x]));
  const malos = nums.filter((x) => !/^(3\d{9}|60\d{8})$/.test(x));
  if (!nums.length || malos.length) return { ok: false, mensaje: malos.length && nums.length > 1 ? `Revisa este número: ${malos.join(', ')}. Cada celular debe tener 10 dígitos y empezar en 3.` : '' };
  return { ok: true, valor: [...new Set(nums)].slice(0, 5).join(' / ') };
}
const telefonosDe = (valor) => String(valor || '').split('/').map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 7);
function validar(campo, crudo) {
  if (campo.tipo === 'telefonos') return validarTelefonos(crudo);
  if (campo.tipo === 'municipio') return validarMunicipio(crudo);
  if (campo.tipo === 'direccion') return validarDireccion(crudo);
  if (campo.tipo === 'fecha_futura') return validarFechaFutura(crudo);
  if (campo.tipo === 'fecha_pasada') return validarFechaPasada(crudo);
  let v = String(crudo || '').trim();
  if (campo.normalizar === 'solo_numeros') v = v.replace(/\D/g, '');
  if (campo.opciones) {
    const op = campo.opciones.find((o) => norm(o) === norm(v) || norm(o).startsWith(norm(v)) && norm(v).length >= 2);
    return op ? { ok: true, valor: op } : { ok: false };
  }
  if (campo.regex && !new RegExp(campo.regex, 'i').test(v)) return { ok: false };
  return { ok: Boolean(v), valor: v };
}

async function responderCaptura(sesion, asesor, texto) {
  const cap = sesion.captura;
  const campo = cap.campos[cap.paso];
  const r = validar(campo, texto);
  if (!r.ok && r.sugerencias) {
    return { reply: r.mensaje, opciones: r.sugerencias, progreso: preguntar(campo, cap).progreso };
  }
  if (!r.ok) {
    const msg = r.mensaje ? `⚠️ ${r.mensaje}` : campo.opciones ? `Elige una de las opciones 👇` : `⚠️ ${campo.errorMessage || 'Revisa ese dato.'}`;
    const p = preguntar(campo, cap);
    return { ...p, reply: `${msg}\n\n${p.reply}` };
  }
  cap.datos[campo.id] = r.valor;
  if (r.extra) Object.assign(cap.datos, r.extra);
  cap.paso += 1;

  // Al tener el teléfono de un interesado nuevo, revisamos si ya existe.
  if (cap.tipo === 'interesado' && campo.id === 'telefono') {
    try {
      const previos = await db.buscarPorTelefono(r.valor);
      if (previos.length) {
        sesion.modo = 'duplicado';
        sesion.resultados = previos;
        return {
          reply: avisoDuplicado(previos, asesor),
          tarjetas: previos.map(tarjetaDe),
          opciones: ['Sí, es el mismo', 'No, es otro cliente'],
        };
      }
    } catch (e) {
      console.error('No pude revisar duplicados:', e.message);
    }
  }

  avanzar(cap);
  const siguiente = cap.paso < cap.campos.length ? preguntar(cap.campos[cap.paso], cap) : await finalizarCaptura(sesion, asesor);
  if (r.homologada && siguiente?.reply) siguiente.reply = `📍 Dirección homologada: **${r.homologada}**\n\n${siguiente.reply}`;
  return siguiente;
}

async function finalizarCaptura(sesion, asesor) {
  const { tipo, datos } = sesion.captura;
  const campoEditadoId = sesion.captura.campoId;
  sesion.modo = 'libre';
  sesion.captura = null;
  try {
    if (tipo === 'interesado') {
      const creado = await db.crearInteresado(asesor, { ...datos, cobertura: norm(datos.cobertura) === 'si' ? 'sí' : 'no' });
      sesion.cliente = { ...creado, venta: null };
      const conCob = norm(datos.cobertura) === 'si';
      return {
        reply: conCob
          ? '✅ ¡Interesado registrado con cobertura! Sigue con la oferta — si pone una objeción, escríbemela y te ayudo.'
          : '✅ Interesado registrado. Quedó marcado **sin cobertura**; si después se valida, toca "Actualizar cobertura".',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: accionesPara(sesion.cliente),
      };
    }
    const c = sesion.cliente;
    if (tipo === 'venta') {
      await db.guardarVenta(asesor, c, datos);
      await db.actualizarInteresado(c.id, { resultado: 'venta', ciudad: datos.ciudad || c.ciudad || null });
      sesion.cliente = await db.obtenerCliente(c.id);
      return {
        reply: '🎉 ¡Venta registrada! Excelente trabajo, así se hace.',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.EDITAR, OP.RESUMEN],
        celebrar: true,
      };
    }
    if (tipo === 'no_venta') {
      sesion.cliente = {
        ...(await db.actualizarInteresado(c.id, {
          resultado: 'no_venta',
          motivo_no_interes: datos.motivo_no_interes || null,
          observaciones: datos.observaciones || null,
        })),
        venta: c.venta,
      };
      return {
        reply: 'Listo, quedó registrado. Ánimo, ¡el siguiente es tuyo! 💪',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.BUSCAR, OP.RESUMEN],
      };
    }
    if (tipo === 'editar') {
      const id = campoEditadoId || Object.keys(datos)[0];
      let valor = datos[id];
      if (id === 'observaciones') {
        const previa = valorActual(c, 'observaciones');
        const cuando = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
        const nueva = `[${cuando}] ${valor}`;
        valor = previa && norm(previa) !== 'ninguna' ? `${previa}\n${nueva}` : nueva;
      }
      const etiqueta = (campoEditable(id)?.label || id).toLowerCase();
      if (EDITABLES_INTERESADO.includes(id) || id === 'observaciones') await db.actualizarInteresado(c.id, { [id]: valor });
      if (c.venta && (EDITABLES_VENTA.includes(id) || EDITABLES_INTERESADO.includes(id))) await db.actualizarVenta(c.venta.id, { [id]: valor });
      sesion.cliente = await db.obtenerCliente(c.id);
      return {
        reply: id === 'observaciones' ? '📝 ¡Nota guardada! Queda en la ficha del cliente y el back la ve en el panel.' : `✅ Listo, actualicé **${etiqueta}**: ${valor}`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.EDITAR, ...accionesPara(sesion.cliente).filter((o) => o !== OP.EDITAR)].slice(0, 6),
      };
    }
    if (tipo === 'ot_activa') {
      const actualizado = await db.actualizarInteresado(c.id, {
        resultado: 'ot_activa',
        ot_activa_numero: datos.ot_activa_numero,
        ot_activa_estado: 'activa',
        ot_activa_fecha: new Date().toISOString(),
        ot_activa_respuesta: null,
        ot_activa_por: null,
        ot_activa_liberada_fecha: null,
      });
      sesion.cliente = { ...actualizado, venta: c.venta };
      return {
        reply: `🧾 Listo, quedó registrado con **OT activa ${datos.ot_activa_numero}**. Lo ves en la pestaña "OT" para hacerle seguimiento; cuando el back office la marque como liberada te aviso.`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.RELLAMAR, OP.NUEVO, OP.MIS_OT],
      };
    }
    if (tipo === 'escalamiento') {
      const actualizado = await db.actualizarInteresado(c.id, {
        resultado: 'escalado',
        escalamiento_tipo: datos.escalamiento_tipo,
        escalamiento_detalle: datos.escalamiento_detalle,
        escalamiento_estado: 'pendiente',
        escalamiento_respuesta: null,
        escalamiento_por: null,
        escalamiento_fecha: new Date().toISOString(),
      });
      sesion.cliente = { ...actualizado, venta: c.venta };
      return {
        reply: `🛠 Listo, quedó escalado: **${datos.escalamiento_tipo}**. El back office lo ve en el panel y la respuesta te aparece en la ficha del cliente.`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.RELLAMAR, OP.NUEVO, OP.BUSCAR],
      };
    }
    if (tipo === 'rellamar') {
      const actualizado = await db.actualizarInteresado(c.id, {
        resultado: 'volver_llamar',
        rellamar_fecha: datos.rellamar_fecha,
        rellamar_hora: datos.rellamar_hora,
        rellamar_nota: datos.rellamar_nota,
        rellamar_veces: (c.rellamar_veces || 0) + 1,
      });
      sesion.cliente = { ...actualizado, venta: c.venta };
      return {
        reply: `📞 Listo, quedó para volver a llamar **${textoRellamada(sesion.cliente)}**. Te lo recuerdo en "Mis rellamadas".`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.RELLAMADAS, OP.BUSCAR],
      };
    }
    if (tipo === 'cobertura') {
      const valor = norm(datos.cobertura) === 'si' ? 'sí' : 'no';
      sesion.cliente = { ...(await db.actualizarInteresado(c.id, { cobertura_validada: valor })), venta: c.venta };
      return {
        reply: `✅ Cobertura actualizada a **${valor === 'sí' ? 'Sí' : 'No'}**.`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: accionesPara(sesion.cliente),
      };
    }
  } catch (e) {
    console.error('Error guardando:', e);
    return {
      reply: `No pude guardar en la base de datos (${e.message}). Los datos no se perdieron en esta ventana; avisa a soporte.`,
      error: true,
      opciones: MENU,
    };
  }
  return { reply: 'Listo.', opciones: MENU };
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
async function ejecutarBusqueda(sesion, termino) {
  let resultados;
  try {
    resultados = await db.buscarClientes(termino);
  } catch (e) {
    console.error('Error buscando:', e);
    sesion.modo = 'libre';
    return { reply: `No pude consultar la base de datos (${e.message}). Intenta de nuevo en un momento.`, error: true };
  }
  if (!resultados.length) {
    sesion.modo = 'libre';
    sesion.accionPendiente = null;
    return {
      reply: `No encontré clientes con "${termino}". Revisa cómo está escrito, o si es nuevo regístralo.`,
      opciones: [OP.NUEVO, OP.BUSCAR],
    };
  }
  if (resultados.length === 1) return abrirCliente(sesion, resultados[0]);
  sesion.modo = 'seleccion';
  sesion.resultados = resultados;
  return {
    reply: `Encontré ${resultados.length} clientes con "${termino}". ¿Cuál es?`,
    tarjetas: resultados.map((c, i) => ({ ...tarjetaDe(c), compacta: true, elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: resultados.map((c, i) => `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}`).concat(OP.CANCELAR),
  };
}

// "Ojo: este cliente lo está gestionando Ana Torres…"
const mismoAsesor = (a, b) => norm(a) === norm(b);
function quienGestiona(c) {
  const fecha = c.created_at
    ? new Date(c.created_at).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short' })
    : '';
  const estado = (ESTADOS[c.resultado] || 'En gestión').toLowerCase();
  return `**${c.asesor || 'otro asesor'}**${fecha ? ` (lo registró el ${fecha})` : ''} · estado: ${estado}`;
}
function avisoDuplicado(previos, asesor) {
  const deOtros = previos.filter((c) => c.asesor && !mismoAsesor(c.asesor, asesor));
  if (!deOtros.length) return '👀 Ojo: ese celular ya lo registraste antes. ¿Es el mismo cliente?';
  const c = deOtros[0];
  let txt = `⚠️ Ojo: este cliente ya lo está gestionando ${quienGestiona(c)}.`;
  if (c.resultado === 'venta') txt += '\n\nYa tiene una **venta registrada** por ese asesor.';
  return txt + '\n\n¿Es el mismo cliente?';
}

async function abrirCliente(sesion, cliente) {
  sesion.cliente = cliente;
  sesion.modo = 'libre';
  sesion.resultados = [];
  const pendiente = sesion.accionPendiente;
  sesion.accionPendiente = null;
  if (pendiente) {
    const inicio = await arrancarAccion(sesion, pendiente);
    return { ...inicio, tarjetas: [tarjetaDe(cliente)], reply: inicio.reply };
  }
  const otro = cliente.asesor && asesorActual && !mismoAsesor(cliente.asesor, asesorActual);
  return {
    reply:
      (otro ? `⚠️ Este cliente lo está gestionando ${quienGestiona(cliente)}.\n\n` : '') +
      `Este es el cliente${cliente.resultado === 'venta' ? ' — ya tiene venta registrada ✅' : ''}. ¿Qué hacemos?`,
    tarjetas: [tarjetaDe(cliente)],
    opciones: accionesPara(cliente),
  };
}

function arrancarAccion(sesion, accion) {
  const c = sesion.cliente;
  if (accion === 'venta') {
    if (c.resultado === 'venta') return { reply: 'Este cliente ya tiene una venta registrada ✅.', opciones: [OP.NUEVO, OP.BUSCAR] };
    if (norm(c.cobertura_validada) === 'no') {
      return { reply: 'Este cliente está marcado **sin cobertura**. Si ya se validó que sí tiene, actualízala primero.', opciones: [OP.COBERTURA, OP.NO_VENTA] };
    }
    return iniciarCaptura(sesion, 'venta', c.ciudad ? { ciudad: c.ciudad } : {});
  }
  if (accion === 'no_venta') {
    // Sin preguntas: si campos.json no tiene campos para "no_venta", se registra de una vez.
    if (!(CAMPOS().no_venta || []).length) {
      sesion.modo = 'captura';
      sesion.captura = { tipo: 'no_venta', campos: [], paso: 0, datos: {} };
      return finalizarCaptura(sesion, asesorActual);
    }
    return iniciarCaptura(sesion, 'no_venta');
  }
  if (accion === 'cobertura') return iniciarCaptura(sesion, 'cobertura', { _direccion: c.direccion || '', _ciudad: c.ciudad || '' });
  if (accion === 'escalar') return iniciarCaptura(sesion, 'escalamiento');
  if (accion === 'editar') return pedirQueEditar(sesion);
  if (accion === 'nota') return pedirNota(sesion);
  if (accion === 'ot_activa') {
    if (c.resultado === 'venta') return { reply: 'Este cliente ya tiene una venta registrada ✅.', opciones: [OP.NUEVO, OP.BUSCAR] };
    return iniciarCaptura(sesion, 'ot_activa');
  }
  if (accion === 'rellamar') {
    if (c.resultado === 'venta') return { reply: 'Este cliente ya tiene una venta registrada ✅.', opciones: [OP.NUEVO, OP.BUSCAR] };
    return iniciarCaptura(sesion, 'rellamar');
  }
  return { reply: '¿Qué hacemos?', opciones: accionesPara(c) };
}

// ---------------------------------------------------------------------------
// Mis clientes de hoy (para elegir sin tener el teléfono)
// ---------------------------------------------------------------------------
// Mis clientes: por periodo (hoy, últimos 7 días, este mes o todo el historial).
const PERIODOS_CLIENTES = {
  hoy: { texto: 'de hoy', chip: '📅 Hoy' },
  semana: { texto: 'de los últimos 7 días', chip: '🗓 Últimos 7 días' },
  mes: { texto: 'de este mes', chip: '📆 Este mes' },
  todo: { texto: 'de todo tu historial', chip: '🗂 Todo mi historial' },
};
const chipsPeriodo = (actual) => Object.entries(PERIODOS_CLIENTES).filter(([k]) => k !== actual).map(([k, v]) => `Mis clientes · ${v.chip}`);
async function clientesDeHoy(sesion, asesor, periodo = 'mes') {
  const p = PERIODOS_CLIENTES[periodo] ? periodo : 'mes';
  let lista;
  try {
    lista = await db.clientesDeHoy(asesor, p);
  } catch (e) {
    console.error('Error listando clientes:', e);
    return { reply: `No pude traer la lista (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: `No tienes clientes ${PERIODOS_CLIENTES[p].texto}.`, opciones: [...chipsPeriodo(p), OP.BUSCAR] };
  }
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  const tope = lista.length >= 150 ? ' (los 150 más recientes; para uno más antiguo usa "Buscar cliente")' : '';
  return {
    reply: `Tus ${lista.length} cliente(s) ${PERIODOS_CLIENTES[p].texto}${tope}, del más reciente al más antiguo. Toca el que necesitas 👇 (o escribe parte del nombre).`,
    tarjetas: lista.map((c, i) => ({
      ...tarjetaDe(c),
      compacta: true,
      horaCorta: new Date(c.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
      elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}`,
    })),
    opciones: [...chipsPeriodo(p), OP.CANCELAR],
  };
}

// ---------------------------------------------------------------------------
// Mis rellamadas (pendientes de hoy y vencidas, y las próximas)
// ---------------------------------------------------------------------------
async function misRellamadas(sesion, asesor) {
  let lista;
  try {
    lista = await db.rellamadasPendientes(asesor);
  } catch (e) {
    console.error('Error rellamadas:', e);
    return { reply: `No pude traer las rellamadas (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes rellamadas pendientes 🙌.', opciones: [OP.NUEVO, OP.HOY] };
  }
  const hoy = hoyCO();
  const paraHoy = lista.filter((c) => c.rellamar_fecha <= hoy).length;
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply:
      (paraHoy ? `📞 Tienes **${paraHoy}** rellamada(s) para hoy o atrasadas` : '📞 No tienes rellamadas para hoy') +
      ` y ${lista.length - paraHoy} próxima(s). Toca la que vas a llamar 👇`,
    tarjetas: lista.map((c, i) => ({
      ...tarjetaDe(c),
      compacta: true,
      horaCorta: (c.rellamar_fecha < hoy ? '⚠ ' : '') + textoRellamada(c),
      elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}`,
    })),
    opciones: [OP.CANCELAR],
  };
}

// Las ventas se muestran como "clientes" (con su venta adentro) para poder abrir la ficha.
const ventaComoCliente = (v) => ({
  id: v.interesado_id || v.id,
  nombre_cliente: v.nombre_cliente,
  telefono: v.telefono,
  direccion: v.direccion,
  ciudad: v.ciudad,
  asesor: v.asesor,
  created_at: v.created_at,
  resultado: 'venta',
  venta: v,
});

async function misVentas(sesion, asesor) {
  let ventas;
  try {
    ventas = await db.ventasDeAsesor(asesor);
  } catch (e) {
    return { reply: `No pude traer tus ventas (${e.message}).`, error: true };
  }
  if (!ventas.length) {
    sesion.modo = 'libre';
    return { reply: 'Todavía no tienes ventas registradas en los últimos 45 días. ¡La primera está cerca! 💪', opciones: MENU };
  }
  const inst = ventas.filter((v) => v.estado_instalacion === 'instalada').length;
  const pend = ventas.filter((v) => !v.estado_instalacion || v.estado_instalacion === 'pendiente').length;
  const lista = ventas.map(ventaComoCliente);
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🎉 Tus ventas (últimos 45 días): **${ventas.length}** · ✅ ${inst} instalada(s) · ⏳ ${pend} pendiente(s). Toca una para ver la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: textoInstalacion(c.venta), elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

async function misOtActivas(sesion, asesor) {
  let lista;
  try {
    lista = await db.otActivasDeAsesor(asesor);
  } catch (e) {
    return { reply: `No pude traer las OT activas (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes clientes con OT activa. 🙌', opciones: MENU };
  }
  const lib = lista.filter((c) => c.ot_activa_estado === 'liberada').length;
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🧾 Tienes **${lista.length - lib}** cliente(s) con OT activa${lib ? ` y **${lib}** ya liberada(s) ✅ (puedes retomar la venta)` : ''}. Toca uno para abrir la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: `OT ${c.ot_activa_numero} · ${c.ot_activa_estado === 'liberada' ? '✅ liberada' : '⏳ activa'}`, elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

async function misAlertas(sesion, asesor) {
  let lista;
  try {
    lista = await alertasDe(asesor);
  } catch (e) {
    return { reply: `No pude traer las alertas (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes clientes recuperables por ahora. 🙌', opciones: MENU };
  }
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🔥 ¡Clientes recuperables! El back confirmó que **${lista.length}** cliente(s) que marcaste **sin cobertura** SÍ tienen. ¡Es una venta por recuperar! Vuelve a llamarlos. Toca uno para abrir la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: '🔥 Sí tiene cobertura', elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

async function misEscalamientos(sesion, asesor) {
  let lista;
  try {
    lista = await db.escalamientosDeAsesor(asesor);
  } catch (e) {
    return { reply: `No pude traer los escalamientos (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes escalamientos. 🙌', opciones: MENU };
  }
  const pend = lista.filter((c) => c.escalamiento_estado !== 'resuelto').length;
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🛠 Tienes **${pend}** escalamiento(s) pendiente(s) y ${lista.length - pend} resuelto(s) recientemente. Toca uno para abrir la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: c.escalamiento_estado === 'resuelto' ? '✅ resuelto' : '⏳ pendiente', elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
async function resumen(asesor, equipo, periodo = 'hoy') {
  try {
    const r = await db.resumenDeHoy(equipo ? null : asesor, periodo);
    const efect = r.interesados ? Math.round((r.ventas / r.interesados) * 100) : 0;
    const quien = equipo ? 'del equipo' : asesor ? `de ${asesor.split(' ')[0]}` : '';
    const esMes = periodo === 'mes';
    let reply = esMes ? `📊 Así va el mes ${quien}:` : `📊 Así va el día ${quien}:`;
    if (!r.interesados && !r.ventas) reply = esMes ? `📊 Este mes todavía no hay registros ${quien}.` : `📊 Hoy todavía no hay registros ${quien}. ¡A darle! 💪`;
    else if (r.enGestion) reply += `\n\nTienes **${r.enGestion}** interesado(s) todavía en gestión — búscalos para cerrarlos.`;
    return {
      reply,
      resumen: {
        titulo: esMes
          ? `Este mes · ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', month: 'long', year: 'numeric' })}`
          : `Hoy · ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' })}`,
        items: [
          { label: 'Interesados', valor: r.interesados },
          { label: 'Ventas', valor: r.ventas, destacado: true },
          { label: 'Efectividad', valor: `${efect}%` },
          { label: 'Con cobertura', valor: r.conCobertura },
          { label: 'Sin cobertura', valor: r.sinCobertura },
          { label: 'No se interesó', valor: r.noVenta },
          { label: 'Por rellamar', valor: r.porRellamar ?? 0 },
        ],
      },
      opciones: esMes ? [OP.RESUMEN, OP.RESUMEN_EQUIPO, OP.VENTAS] : equipo ? [OP.RESUMEN, OP.RESUMEN_MES, OP.NUEVO] : [OP.RESUMEN_MES, OP.RESUMEN_EQUIPO, OP.VENTAS],
    };
  } catch (e) {
    console.error('Error en resumen:', e);
    return { reply: `No pude traer el resumen (${e.message}).`, error: true };
  }
}

// ---------------------------------------------------------------------------
// Ayuda con IA (objeciones, ganchos, proceso)
// ---------------------------------------------------------------------------
async function ayuda(sesion, texto) {
  if (!iaDisponible()) {
    return {
      reply:
        'Puedo ayudarte a registrar interesados, buscar clientes, registrar ventas y darte el resumen del día. ' +
        '(Para ayudarte con objeciones necesito que configuren la clave de IA en el servidor.)',
      opciones: MENU,
    };
  }
  try {
    const campo = sesion.modo === 'captura' ? sesion.captura.campos[sesion.captura.paso] : null;
    const respuesta = await responderAyuda(texto, {
      sop: leer('sop.md'),
      objeciones: leer('objeciones.md'),
      cliente: sesion.cliente
        ? { nombre: sesion.cliente.nombre_cliente, cobertura: sesion.cliente.cobertura_validada, estado: sesion.cliente.resultado }
        : null,
      pasoActual: campo?.prompt,
    });
    return { reply: respuesta };
  } catch (e) {
    console.error('Error IA:', e.message);
    return {
      reply: 'Esa no la pude responder ahora mismo 😅. Mientras tanto, puedo ayudarte con esto 👇',
      opciones: sesion.cliente ? accionesPara(sesion.cliente) : MENU,
    };
  }
}

// ---------------------------------------------------------------------------
// Cerebro del chat
// ---------------------------------------------------------------------------
let asesorActual = '';
async function manejar(sesion, asesor, texto) {
  asesorActual = asesor;
  await refrescarConfig();
  const t = String(texto || '').trim();
  const n = norm(t);
  const nombre = asesor ? asesor.split(' ')[0] : '';

  if (t === '__inicio__') {
    let aviso = '';
    try {
      const pend = (await db.rellamadasPendientes(asesor)).filter((c) => c.rellamar_fecha <= hoyCO()).length;
      if (pend) aviso = `\n\n📞 Ojo: tienes **${pend}** rellamada(s) para hoy. Mírala(s) en la pestaña "Volver a llamar".`;
      const hace2 = Date.now() - 2 * 86400000;
      const nuevas = (await db.ventasDeAsesor(asesor)).filter((v) => v.estado_instalacion === 'instalada' && new Date(v.instalacion_fecha).getTime() > hace2).length;
      const otLib = (await db.otActivasDeAsesor(asesor)).filter((c) => c.ot_activa_estado === 'liberada' && Date.now() - new Date(c.ot_activa_liberada_fecha).getTime() < 2 * 86400000).length;
      if (otLib) aviso += `\n\n🧾 **${otLib}** cliente(s) con OT activa ya quedaron **liberados**. Mira la pestaña "OT" y retoma la venta.`;
      const alertas = (await alertasDe(asesor)).length;
      if (alertas) aviso += `\n\n🔥 **${alertas}** cliente(s) que marcaste sin cobertura **SÍ tienen** según el back. Toca "${OP.ALERTAS}".`;
      if (nuevas) aviso += `\n\n🎉 ¡Buenas noticias! **${nuevas}** de tus ventas quedó(aron) **instalada(s)**. Mira la pestaña "Ventas".`;
    } catch (_) {}
    return {
      reply:
        `¡Hola${nombre ? `, ${nombre}` : ''}! Soy **Marce**, tu asistente comercial 🙌. ` +
        'Cuando tengas un interesado dime "tengo un cliente interesado" y lo registramos. ' +
        'También puedo buscar un cliente (por nombre, celular o cédula), registrar la venta, ' +
        'programar una rellamada, ayudarte con objeciones o darte el resumen del día.' + aviso,
      opciones: /🔥/.test(aviso) ? [OP.ALERTAS, ...MENU] : MENU,
    };
  }
  if (t === '__nuevo__') {
    Object.assign(sesion, nuevaSesion());
    return { ...iniciarCaptura(sesion, 'interesado'), reply: '¡Vamos! 🙌 ' + CAMPOS().interesado[0].prompt };
  }

  // Abrir un cliente directo (desde las pestañas "Volver a llamar" / "Escalamientos" de la ventana)
  if (t.startsWith('__abrir__:')) {
    try {
      const cliente = await db.obtenerClienteOVenta(t.slice('__abrir__:'.length).trim());
      sesion.captura = null;
      return abrirCliente(sesion, cliente);
    } catch (e) {
      return { reply: `No pude abrir ese cliente (${e.message}).`, error: true, opciones: MENU };
    }
  }

  const intencion = detectarIntencion(t);

  if (intencion === 'cancelar') {
    const habia = sesion.modo !== 'libre';
    sesion.modo = 'libre';
    sesion.captura = null;
    sesion.accionPendiente = null;
    return { reply: habia ? 'Listo, lo dejamos ahí. ¿Qué sigue?' : '¿En qué te ayudo?', opciones: sesion.cliente ? accionesPara(sesion.cliente) : MENU };
  }

  // Formulario a medias que ya no existe (cambió la configuración): se descarta sin error.
  if (sesion.modo === 'captura' && !sesion.captura?.campos?.[sesion.captura.paso]) {
    sesion.modo = 'libre';
    sesion.captura = null;
  }

  // --- Respondiendo un formulario ---
  if (sesion.modo === 'captura') {
    const cap = sesion.captura;
    const campo = cap.campos[cap.paso];
    const esOpcion = (campo.opciones || campo.opcionesSugeridas || []).some((o) => norm(o) === n);
    // Saltos explícitos de flujo (solo frases claras, para no confundir datos con comandos)
    if (!esOpcion && ['resumen', 'resumen_equipo', 'resumen_mes', 'buscar', 'nuevo', 'hoy', 'menu', 'rellamadas', 'escalamientos', 'misventas', 'misot', 'alertas'].includes(intencion) && n.split(' ').length <= 6) {
      const titulo = TITULOS[cap.tipo];
      return {
        reply: `Estamos en medio de "${titulo}". ¿Lo dejamos y seguimos con lo otro?`,
        opciones: [OP.CANCELAR, 'Seguir donde iba'],
      };
    }
    if (n === 'seguir donde iba') return preguntar(campo, cap);
    if (!esOpcion && /\?\s*$/.test(t)) {
      const a = await ayuda(sesion, t);
      const p = preguntar(campo, cap);
      return { ...p, reply: `${a.reply}\n\n➡️ ${p.reply}` };
    }
    return responderCaptura(sesion, asesor, t);
  }

  // --- Eligiendo qué dato editar ---
  if (sesion.modo === 'editar_elegir') {
    const campo = editablesPara(sesion.cliente).find((f) => norm(f.label) === n || (norm(f.label).startsWith(n) && n.length >= 3));
    if (campo && campo.id === 'observaciones') return pedirNota(sesion);
    if (campo) {
      sesion.modo = 'captura';
      sesion.captura = { tipo: 'editar', campoId: campo.id, campos: [campo], paso: 0, datos: {} };
      const actual = valorActual(sesion.cliente, campo.id);
      const p = preguntar(campo, sesion.captura);
      return { ...p, progreso: undefined, reply: (actual ? `Ahora dice: **${actual}**\n\n` : '') + p.reply };
    }
    if (!intencion) return { ...pedirQueEditar(sesion), reply: 'Elige uno de los datos 👇' };
    sesion.modo = 'libre';
  }

  // --- Posible duplicado ---
  if (sesion.modo === 'duplicado') {
    if (/^si/.test(n)) {
      sesion.captura = null;
      return abrirCliente(sesion, sesion.resultados[0]);
    }
    if (/^no/.test(n)) {
      sesion.modo = 'captura';
      const cap = sesion.captura;
      avanzar(cap);
      if (cap.paso < cap.campos.length) return { ...preguntar(cap.campos[cap.paso], cap), reply: 'Ok, sigamos. ' + cap.campos[cap.paso].prompt };
      return finalizarCaptura(sesion, asesor);
    }
    return { reply: '¿Es el mismo cliente?', opciones: ['Sí, es el mismo', 'No, es otro cliente'] };
  }

  // --- Eligiendo entre varios resultados ---
  if (sesion.modo === 'seleccion') {
    const num = parseInt(n, 10);
    let elegido = Number.isInteger(num) ? sesion.resultados[num - 1] : null;
    if (!elegido) elegido = sesion.resultados.find((c) => norm(c.nombre_cliente) === n || (c.telefono && t.replace(/\D/g, '').length >= 7 && String(c.telefono).replace(/\D/g, '').includes(t.replace(/\D/g, ''))));
    if (!elegido && !intencion && n.length >= 3) {
      const parecidos = sesion.resultados.filter((c) => norm(c.nombre_cliente).includes(n) || norm(c.direccion).includes(n));
      if (parecidos.length === 1) elegido = parecidos[0];
    }
    if (elegido) return abrirCliente(sesion, elegido);
    if (!intencion) return ejecutarBusqueda(sesion, t); // escribió otro término
    sesion.modo = 'libre';
  }

  // --- Esperando el término de búsqueda ---
  if (sesion.modo === 'buscar' && !intencion) {
    return ejecutarBusqueda(sesion, t);
  }

  // --- Intenciones ---
  if (intencion === 'menu') {
    sesion.modo = 'libre';
    sesion.accionPendiente = null;
    const saludo = /^(hola|holi|oli|ola|hey|buen|que mas|que hubo|quiubo|saludos)/.test(n);
    return { reply: saludo ? `¡Hola${nombre ? `, ${nombre}` : ''}! 👋 ¿Qué quieres hacer?` : '¿Qué quieres hacer? 👇', opciones: MENU };
  }
  if (intencion === 'hoy') {
    const periodo = /\bhoy\b/.test(n) ? 'hoy' : /semana|7\s*dias/.test(n) ? 'semana' : /todo|historial/.test(n) ? 'todo' : 'mes';
    return clientesDeHoy(sesion, asesor, periodo);
  }
  if (intencion === 'nuevo') {
    sesion.cliente = null;
    return { ...iniciarCaptura(sesion, 'interesado'), reply: '¡Bien! 🙌 Registremos al interesado. ' + CAMPOS().interesado[0].prompt };
  }
  if (intencion === 'resumen' || intencion === 'resumen_equipo' || intencion === 'resumen_mes') {
    sesion.modo = 'libre';
    return resumen(asesor, intencion === 'resumen_equipo', intencion === 'resumen_mes' ? 'mes' : 'hoy');
  }
  if (intencion === 'buscar') {
    const termino = extraerTermino(t);
    if (termino && !/^cliente$/i.test(termino)) return ejecutarBusqueda(sesion, termino);
    sesion.modo = 'buscar';
    return {
      reply: 'Claro 🔎. Escríbeme el nombre, el celular o la cédula del cliente.\n\n¿No tienes el dato a la mano? Toca "Mis clientes de hoy" y lo eliges de la lista.',
      opciones: [OP.HOY, OP.CANCELAR],
    };
  }
  if (intencion === 'rellamadas') return misRellamadas(sesion, asesor);
  if (intencion === 'escalamientos') return misEscalamientos(sesion, asesor);
  if (intencion === 'misventas') return misVentas(sesion, asesor);
  if (intencion === 'misot') return misOtActivas(sesion, asesor);
  if (intencion === 'alertas') return misAlertas(sesion, asesor);
  if (intencion === 'venta' || intencion === 'no_venta' || intencion === 'cobertura' || intencion === 'rellamar' || intencion === 'escalar' || intencion === 'ot_activa' || intencion === 'editar' || intencion === 'nota') {
    if (!sesion.cliente) {
      sesion.accionPendiente = intencion;
      sesion.modo = 'buscar';
      const que = { venta: 'registrar la venta', no_venta: 'registrar que no se interesó', cobertura: 'actualizar la cobertura', rellamar: 'programar la rellamada', escalar: 'hacer el escalamiento', ot_activa: 'registrar la OT activa', editar: 'editar los datos', nota: 'agregar la nota' }[intencion];
      return { reply: `Listo, para ${que} primero dime de qué cliente: nombre, celular o cédula.`, opciones: [OP.CANCELAR] };
    }
    return arrancarAccion(sesion, intencion);
  }

  // --- Escribió directamente un celular o cédula: lo buscamos ---
  if (esCelular(t) || esCedula(t)) return ejecutarBusqueda(sesion, t);

  // --- Todo lo demás: objeciones, ganchos, dudas → IA ---
  const a = await ayuda(sesion, t);
  return a;
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
// Diagnóstico: minutos encendido y memoria en MB (si 'encendido' vuelve a 0 sin deploy, Render reinició el servidor)
app.get('/api/health', (req, res) => { const m = process.memoryUsage(); res.json({ ok: true, ia: iaDisponible(), encendidoMin: Math.round(process.uptime() / 60), memoriaMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576) }); });

// Pestañas de la ventana: "Volver a llamar" y "Escalamientos" del asesor.
// La extensión valida la cédula del asesor y recibe su nombre oficial.
app.get('/api/asesor', async (req, res) => {
  try {
    const fila = await resolverAsesor(req.query.cedula);
    if (!fila) return res.status(404).json({ error: AVISO_CEDULA.no_existe });
    if (!fila.activo) return res.status(403).json({ error: AVISO_CEDULA.inactivo });
    res.json({ ok: true, cedula: fila.cedula, nombre: fila.nombre, campana: fila.campana });
  } catch (err) {
    console.error('Error /api/asesor:', err.message);
    res.status(500).json({ error: /asesores/.test(err.message) ? 'Falta crear la tabla de asesores en Supabase (supabase_asesores.sql).' : err.message });
  }
});

app.get('/api/mis-pendientes', async (req, res) => {
  try {
    let asesor = String(req.query.asesor || '').trim();
    if (req.query.cedula) {
      const fila = await resolverAsesor(req.query.cedula);
      if (!fila || !fila.activo) return res.status(403).json({ error: AVISO_CEDULA[fila ? 'inactivo' : 'no_existe'] });
      asesor = fila.nombre;
    }
    if (!asesor) return res.status(400).json({ error: 'Falta el asesor' });
    const [rell, escs, vts, ots, alertas] = await Promise.all([db.rellamadasPendientes(asesor), db.escalamientosDeAsesor(asesor), db.ventasDeAsesor(asesor), db.otActivasDeAsesor(asesor), alertasDe(asesor).catch(() => [])]);
    const hoy = hoyCO();
    const corto = (c) => ({
      id: c.id,
      nombre: c.nombre_cliente || 'Sin nombre',
      telefono: c.telefono,
      direccion: [c.direccion, c.ciudad].filter(Boolean).join(' · '),
    });
    res.json({
      hoy,
      alertasCobertura: alertas.map((c) => ({ ...corto(c), fecha: c.auditoria_fecha, por: c.auditoria_por, nota: c.auditoria_nota })),
      rellamadas: rell.map((c) => ({
        ...corto(c),
        fecha: c.rellamar_fecha,
        cuando: textoRellamada(c),
        nota: c.rellamar_nota && norm(c.rellamar_nota) !== 'ninguna' ? c.rellamar_nota : '',
        grupo: c.rellamar_fecha < hoy ? 'atrasada' : c.rellamar_fecha === hoy ? 'hoy' : 'proxima',
      })),
      escalamientos: escs.map((c) => ({
        ...corto(c),
        tipo: c.escalamiento_tipo,
        detalle: c.escalamiento_detalle,
        estado: c.escalamiento_estado === 'resuelto' ? 'resuelto' : 'pendiente',
        respuesta: c.escalamiento_respuesta,
        por: c.escalamiento_por,
        fecha: c.escalamiento_fecha,
      })),
      otActivas: ots.map((c) => ({
        ...corto(c),
        ot: c.ot_activa_numero,
        estado: c.ot_activa_estado === 'liberada' ? 'liberada' : 'activa',
        respuesta: c.ot_activa_respuesta,
        por: c.ot_activa_por,
        fecha: c.ot_activa_fecha,
        liberadaReciente: c.ot_activa_estado === 'liberada' && Date.now() - new Date(c.ot_activa_liberada_fecha).getTime() < 2 * 86400000,
      })),
      ventas: vts.map((v) => ({
        id: v.interesado_id || v.id,
        nombre: v.nombre_cliente || 'Sin nombre',
        telefono: v.telefono,
        direccion: [v.direccion, v.ciudad].filter(Boolean).join(' · '),
        plan: v.plan,
        ot: v.numero_ot,
        agenda: [v.fecha_agenda, v.hora_agenda].filter(Boolean).join(' · '),
        // "cancelada" viaja como no_instalada para que la extensión ya instalada la muestre (el texto dice Cancelada).
        estado: v.estado_instalacion === 'cancelada' ? 'no_instalada' : v.estado_instalacion || 'pendiente',
        estadoReal: v.estado_instalacion || 'pendiente',
        estadoTexto: textoInstalacion(v),
        // Motivo + aprobación del BO en un solo texto (lo muestra cualquier versión de la extensión).
        nota: [v.instalacion_nota, v.aprobacion_bo ? `Aprobación BO: ${TEXTO_APROBACION[v.aprobacion_bo]}${v.aprobacion_motivo ? ` (${v.aprobacion_motivo})` : ''}` : '', v.llamada_ocm ? `OCM: ${v.llamada_ocm === 'si' ? 'Sí' : 'No'}` : '', textoTorre(v)].filter(Boolean).join(' · '),
        instaladaReciente: v.estado_instalacion === 'instalada' && Date.now() - new Date(v.instalacion_fecha).getTime() < 2 * 86400000,
        fecha: v.created_at,
      })),
    });
  } catch (err) {
    console.error('Error mis-pendientes:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Panel web (back office). Protegido con la clave PANEL_CLAVE de Render.
// ---------------------------------------------------------------------------
// Fecha "AAAA-MM-DD" (hora Colombia) → ISO
const isoColombia = (fecha, finDelDia) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return null;
  const d = new Date(`${fecha}T00:00:00-05:00`);
  if (finDelDia) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

// ---------------------------------------------------------------------------
// Acceso al panel: usuario + contraseña con PERFIL. Cada cambio queda en el historial.
// La clave PANEL_CLAVE de Render sirve como usuario "admin" de respaldo.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const PERFILES = {
  admin: { nombre: 'Administrador', permisos: ['ver', 'gestion', 'torre', 'editar', 'eliminar', 'administrar', 'usuarios', 'historial'] },
  supervisor: { nombre: 'Supervisor', permisos: ['ver', 'gestion', 'torre', 'editar', 'eliminar', 'administrar', 'historial'] },
  backoffice: { nombre: 'Back office', permisos: ['ver', 'gestion', 'torre', 'editar'] },
  gtr: { nombre: 'GTR', permisos: ['ver', 'administrar', 'historial'] },
  torre: { nombre: 'Torre de control', permisos: ['ver', 'gestion', 'torre', 'editar', 'historial'] },
  consulta: { nombre: 'Solo consulta', permisos: ['ver'] },
};
const SECRETO = () => process.env.PANEL_SECRETO || process.env.PANEL_CLAVE || 'marce';
const b64 = (s) => Buffer.from(s).toString('base64url');
function firmarToken(u) {
  const cuerpo = b64(JSON.stringify({ u: u.usuario, n: u.nombre, p: u.perfil, exp: Date.now() + 7 * 24 * 3600 * 1000 })); // la sesión dura 7 días
  return cuerpo + '.' + crypto.createHmac('sha256', SECRETO()).update(cuerpo).digest('base64url');
}
function leerToken(t) {
  const [cuerpo, firma] = String(t || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = crypto.createHmac('sha256', SECRETO()).update(cuerpo).digest('base64url');
  if (firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
  const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
  return d.exp > Date.now() ? { usuario: d.u, nombre: d.n, perfil: d.p } : null;
}
const hashClave = (clave, sal = crypto.randomBytes(16).toString('hex')) => `${sal}:${crypto.scryptSync(String(clave), sal, 32).toString('hex')}`;
function claveOk(clave, hash) {
  const [sal, h] = String(hash || '').split(':');
  if (!sal || !h) return false;
  const calc = crypto.scryptSync(String(clave), sal, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(h));
}
// Usuarios desactivados: se revisa cada minuto
const USUARIOS_ACTIVOS = new Map();
async function sigueActivo(usuario) {
  if (usuario === 'admin') return true;
  const c = USUARIOS_ACTIVOS.get(usuario);
  if (c && Date.now() - c.ts < 60000) return c.activo;
  let activo = true;
  try { const u = await db.buscarUsuario(usuario); activo = Boolean(u?.activo); } catch (_) {}
  USUARIOS_ACTIVOS.set(usuario, { activo, ts: Date.now() });
  return activo;
}
async function exigirClave(req, res, next) {
  const clave = process.env.PANEL_CLAVE;
  const tok = leerToken(req.get('x-panel-token'));
  if (tok) {
    if (!(await sigueActivo(tok.usuario))) return res.status(401).json({ error: 'Tu usuario está desactivado.' });
    req.usuario = tok;
  } else if (clave && req.get('x-panel-clave') === clave) {
    req.usuario = { usuario: 'admin', nombre: 'Administrador', perfil: 'admin' };
  } else {
    return res.status(401).json({ error: 'Tu sesión terminó. Vuelve a entrar.' });
  }
  // Quien hace el cambio es SIEMPRE el usuario que entró (no lo que diga el navegador).
  if (req.body && typeof req.body === 'object') req.body.auditor = req.usuario.nombre;
  next();
}
// Permiso por acción según el perfil
const puede = (req, permiso) => (PERFILES[req.usuario?.perfil]?.permisos || []).includes(permiso);
const PERMISO_RUTA = {
  '/api/panel/gestion-bo': ['gestion', 'torre'], '/api/panel/instalacion': ['gestion'], '/api/panel/ot': ['gestion'], '/api/panel/escalamiento': ['gestion'],
  '/api/panel/auditar': ['gestion'], '/api/panel/registro': ['editar'], '/api/panel/editar': ['editar'], '/api/panel/eliminar': ['eliminar'],
  '/api/panel/config': ['administrar'], '/api/panel/asesores': ['administrar'], '/api/panel/asesores/lote': ['administrar'], '/api/panel/asesores/unir': ['administrar'],
  '/api/panel/homologar-direcciones': ['administrar'], '/api/panel/usuarios': ['usuarios'],
  '/api/panel/importar': ['usuarios'], '/api/panel/importar/enlazar': ['usuarios'], '/api/panel/campana-dia': ['administrar'], '/api/panel/ocm': ['administrar'], '/api/panel/ocm/borrar': ['administrar'], '/api/panel/base-asesor/cargar': ['administrar'], '/api/panel/base-asesor/accion': ['administrar'], '/api/panel/bases': ['administrar'], '/api/panel/bases/borrar': ['administrar'], '/api/panel/importar/deshacer': ['usuarios'],
};
app.use('/api/panel', (req, res, next) => {
  if (req.method !== 'POST' || req.path === '/login' || req.path === '/mi-clave') return next();
  const ruta = req.path; // se guarda aquí: más adelante Express le devuelve el prefijo /api/panel
  return exigirClave(req, res, () => {
    const necesita = PERMISO_RUTA['/api/panel' + ruta];
    if (necesita && !necesita.some((p) => puede(req, p))) return res.status(403).json({ error: `Tu perfil (${PERFILES[req.usuario.perfil]?.nombre || req.usuario.perfil}) no puede hacer esto.` });
    // El perfil "torre" solo cambia la torre de control: lo demás de la venta queda como estaba.
    if (ruta === '/gestion-bo' && !puede(req, 'gestion')) req.body._soloTorre = true;
    // Historial: se guarda cada cambio que salga bien
    const json = res.json.bind(res);
    res.json = (cuerpo) => {
      if (res.statusCode < 400) {
        const b = { ...(req.body || {}) }; delete b.clave; delete b.clave_nueva; delete b.auditor; delete b._soloTorre;
        if (Array.isArray(b.asesores)) b.asesores = `${b.asesores.length} asesores`;
        if (Array.isArray(b.filas)) b.filas = `${b.filas.length} filas`;
        if (Array.isArray(b.cubo)) b.cubo = `${b.cubo.length} grupos`;
        if (Array.isArray(b.asignaciones)) b.asignaciones = b.asignaciones.map((x) => `${x.cedula}: ${(x.filas || []).length}`).join(' · ');
        for (const k of ['tels', 'marcados', 'resumen']) if (b[k]) b[k] = '(omitido)';
        db.registrarHistorial({ usuario: req.usuario.usuario, nombre: req.usuario.nombre, perfil: req.usuario.perfil, accion: ruta.replace(/^\//, ''),
          registro: String(b.id || b.venta_id || b.interesado_id || b.cedula || b.clave || b.usuario || b.de || ''), detalle: req._cambio ? { ...b, _cambio: req._cambio } : b }).catch((e) => console.error('Historial:', e.message));
      }
      return json(cuerpo);
    };
    next();
  });
});

// Entrar con usuario y contraseña
app.post('/api/panel/login', async (req, res) => {
  try {
    const usuario = String(req.body?.usuario || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    if (!usuario || !clave) return res.status(400).json({ error: 'Escribe tu usuario y contraseña.' });
    // Respaldo: usuario "admin" con la clave PANEL_CLAVE de Render
    if (usuario === 'admin' && process.env.PANEL_CLAVE && clave === process.env.PANEL_CLAVE) {
      const u = { usuario: 'admin', nombre: 'Administrador', perfil: 'admin' };
      return res.json({ ok: true, token: firmarToken(u), ...u, permisos: PERFILES.admin.permisos });
    }
    let u = null;
    try { u = await db.buscarUsuario(usuario); } catch (e) {
      return res.status(500).json({ error: /panel_usuarios/.test(e.message) ? 'Falta correr supabase_usuarios.sql en Supabase. Mientras tanto entra con usuario "admin" y la clave del panel.' : e.message });
    }
    if (!u || !claveOk(clave, u.hash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    if (!u.activo) return res.status(401).json({ error: 'Tu usuario está desactivado. Habla con el administrador.' });
    db.marcarIngreso(u.usuario).catch(() => {});
    db.registrarHistorial({ usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, accion: 'ingreso', registro: '', detalle: {} }).catch(() => {});
    res.json({ ok: true, token: firmarToken(u), usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, permisos: PERFILES[u.perfil]?.permisos || ['ver'] });
  } catch (err) {
    console.error('Error panel/login:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ¿Sigue válida la sesión? (al recargar la página)
app.get('/api/panel/login', exigirClave, (req, res) => res.json({ ok: true, ...req.usuario, permisos: PERFILES[req.usuario.perfil]?.permisos || ['ver'] }));

// Cambiar mi propia contraseña
app.post('/api/panel/mi-clave', exigirClave, async (req, res) => {
  try {
    const { clave, clave_nueva } = req.body || {};
    if (req.usuario.usuario === 'admin') return res.status(400).json({ error: 'El usuario admin de respaldo usa la clave de Render.' });
    if (String(clave_nueva || '').length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 6 caracteres.' });
    const u = await db.buscarUsuario(req.usuario.usuario);
    if (!u || !claveOk(clave, u.hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    await db.guardarUsuario({ usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, activo: u.activo, hash: hashClave(clave_nueva) });
    db.registrarHistorial({ usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, accion: 'cambio de contraseña', registro: u.usuario, detalle: {} }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔐 Usuarios (solo admin)
app.get('/api/panel/usuarios', exigirClave, async (req, res) => {
  if (!puede(req, 'usuarios')) return res.status(403).json({ error: 'Solo el administrador ve los usuarios.' });
  try { res.json({ usuarios: await db.listarUsuarios(), perfiles: PERFILES }); }
  catch (err) { res.status(500).json({ error: /panel_usuarios/.test(err.message) ? 'Falta correr supabase_usuarios.sql en Supabase.' : err.message }); }
});
app.post('/api/panel/usuarios', async (req, res) => {
  try {
    const usuario = String(req.body?.usuario || '').trim().toLowerCase().replace(/\s+/g, '.');
    const nombre = String(req.body?.nombreUsuario || '').trim();
    const perfil = String(req.body?.perfil || '');
    const { activo, claveNueva } = req.body || {};
    if (!/^[a-z0-9._-]{3,}$/.test(usuario)) return res.status(400).json({ error: 'El usuario debe tener mínimo 3 letras o números (sin espacios).' });
    if (usuario === 'admin') return res.status(400).json({ error: '"admin" está reservado.' });
    if (!PERFILES[perfil]) return res.status(400).json({ error: 'Perfil no válido.' });
    const antes = await db.buscarUsuario(usuario);
    if (!antes && String(claveNueva || '').length < 6) return res.status(400).json({ error: 'Pon una contraseña de mínimo 6 caracteres.' });
    if (!nombre && !antes) return res.status(400).json({ error: 'Escribe el nombre de la persona.' });
    const fila = { usuario, nombre: nombre || antes.nombre, perfil, activo: activo ?? antes?.activo ?? true, hash: claveNueva ? hashClave(claveNueva) : antes.hash };
    const u = await db.guardarUsuario(fila);
    USUARIOS_ACTIVOS.delete(usuario);
    res.json({ ok: true, usuario: u });
  } catch (err) {
    console.error('Error panel/usuarios:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 📜 Historial de cambios (admin y supervisor)
app.get('/api/panel/historial', exigirClave, async (req, res) => {
  if (!puede(req, 'historial')) return res.status(403).json({ error: 'Tu perfil no puede ver el historial.' });
  try {
    const desde = isoColombia(req.query.desde, false), hasta = isoColombia(req.query.hasta, true);
    res.json({ historial: await db.leerHistorial({ desde, hasta, usuario: req.query.usuario || '' }) });
  } catch (err) {
    res.status(500).json({ error: /marce_historial/.test(err.message) ? 'Falta correr supabase_historial.sql en Supabase.' : err.message });
  }
});

app.get('/api/panel/datos', exigirClave, cachear(30000), async (req, res) => {
  try {
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const desde = isoColombia(req.query.desde || hoy, false);
    const hasta = isoColombia(req.query.hasta || hoy, true);
    if (!desde || !hasta) return res.status(400).json({ error: 'Fechas inválidas (usa AAAA-MM-DD).' });
    const d = await db.panelDatos(desde, hasta);
    // Ventas que se instalan / tienen agenda en el rango (aunque se hayan vendido antes)
    try { d.ventasAgenda = await db.ventasPorAgenda(req.query.desde || hoy, req.query.hasta || hoy); } catch (e) { console.error('ventasPorAgenda:', e.message); d.ventasAgenda = []; }
    for (const k of Object.keys(d)) if (Array.isArray(d[k])) d[k] = d[k].map((f) => ({ ...conRegional(f), venta: f.venta ? conRegional(f.venta) : f.venta, tipo_venta: f.tipo_venta || f.datos?.tipo_venta || undefined, servicios_vendidos: f.servicios_vendidos || f.datos?.servicios_vendidos || undefined, multiasistencia: f.multiasistencia || f.datos?.multiasistencia || undefined, multiasistencia_cual: f.multiasistencia_cual || f.datos?.multiasistencia_cual || undefined }));
    res.json(d);
  } catch (err) {
    console.error('Error panel/datos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Agenda del día y "¿Cómo vamos hoy?": ventas agendadas para la fecha y ventas registradas ese día.
app.get('/api/panel/hoy', exigirClave, cachear(30000), async (req, res) => {
  try {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : hoyCO();
    const [agenda, ventas, gestionadas] = await Promise.all([db.agendaDelDia(fecha), db.ventasDelDia(fecha), db.ventasGestionadasDia(fecha).catch(() => [])]);
    const prep = (v) => ({ ...conRegional(v), tipo_venta: v.tipo_venta || v.datos?.tipo_venta || null, servicios_vendidos: v.servicios_vendidos || v.datos?.servicios_vendidos || null, multiasistencia: v.multiasistencia || v.datos?.multiasistencia || null, multiasistencia_cual: v.multiasistencia_cual || v.datos?.multiasistencia_cual || null });
    res.json({ fecha, agenda: agenda.map(prep), ventas: ventas.map(prep), gestionadas: gestionadas.map(prep) });
  } catch (err) {
    console.error('Error panel/hoy:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/panel/ot', exigirClave, async (req, res) => {
  try {
    const { id, estado, respuesta, auditor } = req.body || {};
    if (!id || !['liberada', 'activa'].includes(estado)) return res.status(400).json({ error: 'Falta id o el estado no es válido.' });
    const interesado = await db.actualizarInteresado(id, {
      ot_activa_estado: estado,
      ot_activa_respuesta: respuesta || null,
      ot_activa_por: estado === 'liberada' ? auditor || null : null,
      ot_activa_liberada_fecha: estado === 'liberada' ? new Date().toISOString() : null,
    });
    res.json({ ok: true, interesado });
  } catch (err) {
    console.error('Error panel/ot:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/panel/instalacion', exigirClave, async (req, res) => {
  try {
    const { id, estado, nota, auditor } = req.body || {};
    if (!id || !['instalada', 'no_instalada', 'cancelada', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Falta id o el estado no es válido.' });
    if ((estado === 'no_instalada' || estado === 'cancelada') && !String(nota || '').trim()) return res.status(400).json({ error: 'Escribe el motivo.' });
    const venta = await db.actualizarVenta(id, {
      estado_instalacion: estado,
      instalacion_nota: nota || null,
      instalacion_por: estado === 'pendiente' ? null : auditor || null,
      instalacion_fecha: estado === 'pendiente' ? null : new Date().toISOString(),
    });
    res.json({ ok: true, venta });
  } catch (err) {
    console.error('Error panel/instalacion:', err);
    res.status(500).json({ error: err.message });
  }
});

// Gestión completa del BO sobre una venta: instalación (+motivo), aprobación (+motivo) y llamada en OCM.
app.post('/api/panel/gestion-bo', exigirClave, async (req, res) => {
  try {
    let { id, estado, motivo, aprobacion_bo, aprobacion_motivo, llamada_ocm, torre_salida, torre_motivo, torre_fecha_reagenda, tecnologia, aliado_tecnico, auditor } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta la venta.' });
    if (!['pendiente', 'instalada', 'no_instalada', 'cancelada'].includes(estado)) return res.status(400).json({ error: 'Estado de instalación no válido.' });
    if ((estado === 'no_instalada' || estado === 'cancelada') && !String(motivo || '').trim()) {
      return res.status(400).json({ error: `Escribe el motivo de ${estado === 'cancelada' ? 'cancelación' : 'no instalación'}.` });
    }
    if (aprobacion_bo && !TEXTO_APROBACION[aprobacion_bo]) return res.status(400).json({ error: 'Aprobación BO no válida.' });
    if (llamada_ocm && !['si', 'no'].includes(llamada_ocm)) return res.status(400).json({ error: 'Llamada en OCM no válida.' });
    if (torre_salida && !TEXTO_TORRE[torre_salida]) return res.status(400).json({ error: 'Salida de torre de control no válida.' });
    const tMotivo = String(torre_motivo || '').trim();
    if (['reagendado', 'cancelado', 'pendiente'].includes(torre_salida) && !tMotivo) {
      return res.status(400).json({ error: 'Torre de control: escribe el motivo.' });
    }
    if (torre_salida === 'reagendado' && !/^\d{4}-\d{2}-\d{2}$/.test(torre_fecha_reagenda || '')) {
      return res.status(400).json({ error: 'Torre de control: elige la fecha del nuevo reagendamiento.' });
    }
    const antes = await db.obtenerVenta(id);
    if (req.body._soloTorre && antes) {
      // Perfil torre: la aprobación BO y la OCM quedan como estaban
      aprobacion_bo = antes.aprobacion_bo || ''; aprobacion_motivo = antes.aprobacion_motivo || ''; llamada_ocm = antes.llamada_ocm || '';
      if (!((antes.torre_salida || '') !== (torre_salida || ''))) { estado = antes.estado_instalacion || 'pendiente'; motivo = antes.instalacion_nota || ''; }
    }
    // La torre y el estado de instalación son lo mismo: si cambia uno, se actualiza el otro.
    const TORRE_A_ESTADO = { instalado: 'instalada', cancelado: 'cancelada', pendiente: 'pendiente', reagendado: 'pendiente', iniciado: 'pendiente', sin_iniciar_am: 'pendiente', sin_iniciar_pm: 'pendiente' };
    const ESTADO_A_TORRE = { instalada: 'instalado', cancelada: 'cancelado' };
    const torreCambio = (antes?.torre_salida || '') !== (torre_salida || '');
    const estadoCambio = (antes?.estado_instalacion || 'pendiente') !== estado;
    if (torreCambio && torre_salida && TORRE_A_ESTADO[torre_salida] && !estadoCambio) {
      estado = TORRE_A_ESTADO[torre_salida];
      if (estado === 'cancelada' && !String(motivo || '').trim()) motivo = tMotivo;
    } else if (estadoCambio && !torreCambio && ESTADO_A_TORRE[estado]) {
      torre_salida = ESTADO_A_TORRE[estado];
      if (estado === 'cancelada' && !tMotivo) torre_motivo = String(motivo || '').trim();
    }
    const cambios = {
      torre_salida: torre_salida || null,
      torre_motivo: String(torre_motivo || '').trim() || null,
      // La nueva fecha solo aplica si la salida es reagendado/pendiente (así no queda una fecha vieja colgada)
      torre_fecha_reagenda: ['reagendado', 'pendiente'].includes(torre_salida) ? torre_fecha_reagenda || null : null,
      estado_instalacion: estado,
      instalacion_nota: String(motivo || '').trim() || null,
      aprobacion_bo: aprobacion_bo || null,
      aprobacion_motivo: String(aprobacion_motivo || '').trim() || null,
      llamada_ocm: llamada_ocm || null,
    };
    // Tecnología y aliado técnico (los llena la torre); solo si vienen
    if (tecnologia !== undefined) cambios.tecnologia = String(tecnologia || '').trim().toUpperCase() || null;
    if (aliado_tecnico !== undefined) cambios.aliado_tecnico = String(aliado_tecnico || '').trim().toUpperCase() || null;
    req._cambio = { ...fichaOrden(antes), cambios: diferencias(antes, cambios, ['estado_instalacion', 'instalacion_nota', 'aprobacion_bo', 'aprobacion_motivo', 'llamada_ocm', 'torre_salida', 'torre_motivo', 'torre_fecha_reagenda', 'tecnologia', 'aliado_tecnico']) };
    // Quién y cuándo, solo si cambió esa parte
    if (!antes || antes.estado_instalacion !== estado || antes.instalacion_nota !== cambios.instalacion_nota) {
      cambios.instalacion_por = estado === 'pendiente' ? null : auditor || null;
      cambios.instalacion_fecha = estado === 'pendiente' ? null : new Date().toISOString();
    }
    if (!antes || antes.aprobacion_bo !== cambios.aprobacion_bo || antes.aprobacion_motivo !== cambios.aprobacion_motivo || antes.llamada_ocm !== cambios.llamada_ocm) {
      cambios.aprobacion_por = auditor || null;
      cambios.aprobacion_fecha = new Date().toISOString();
    }
    if (!antes || antes.torre_salida !== cambios.torre_salida || antes.torre_motivo !== cambios.torre_motivo || (antes.torre_fecha_reagenda || null) !== cambios.torre_fecha_reagenda) {
      cambios.torre_por = cambios.torre_salida ? auditor || null : null;
      cambios.torre_fecha = cambios.torre_salida ? new Date().toISOString() : null;
    }
    res.json({ ok: true, venta: await db.actualizarVenta(id, cambios) });
  } catch (err) {
    console.error('Error panel/gestion-bo:', err.message);
    res.status(500).json({ error: /tecnologia|aliado_tecnico/.test(err.message) ? 'Falta correr supabase_tecnologia.sql en Supabase.' : /torre_/.test(err.message) ? 'Falta correr supabase_torre_control.sql en Supabase.' : /aprobacion|llamada_ocm/.test(err.message) ? 'Falta correr supabase_gestion_bo.sql en Supabase.' : err.message });
  }
});

app.post('/api/panel/escalamiento', exigirClave, async (req, res) => {
  try {
    const { id, estado, respuesta, auditor } = req.body || {};
    if (!id || !['resuelto', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Falta id o el estado no es válido.' });
    const interesado = await db.actualizarInteresado(id, {
      escalamiento_estado: estado,
      escalamiento_respuesta: respuesta || null,
      escalamiento_por: estado === 'resuelto' ? auditor || null : null,
      escalamiento_resuelto_fecha: estado === 'resuelto' ? new Date().toISOString() : null,
    });
    res.json({ ok: true, interesado });
  } catch (err) {
    console.error('Error panel/escalamiento:', err);
    res.status(500).json({ error: err.message });
  }
});

// Interruptores del panel (ej. permitir ventas con fecha anterior).
const CLAVES_CONFIG = ['ventas_fecha_anterior', 'metas_cierre'];
app.get('/api/panel/config', exigirClave, async (req, res) => {
  try {
    res.json(await db.leerConfig());
  } catch (err) {
    res.status(500).json({ error: /marce_config/.test(err.message) ? 'Falta crear la tabla marce_config en Supabase (supabase_config.sql).' : err.message });
  }
});
app.post('/api/panel/config', exigirClave, async (req, res) => {
  try {
    const { clave, valor, auditor } = req.body || {};
    if (!CLAVES_CONFIG.includes(clave)) return res.status(400).json({ error: 'Interruptor no válido.' });
    // metas_cierre = { "OUT Hogar": 20, "Recuperación": 40 } · los demás son interruptores Sí/No
    const v = clave === 'metas_cierre' ? Object.fromEntries(Object.entries(valor || {}).filter(([k, n]) => String(k).trim() && Number(n) >= 0).map(([k, n]) => [String(k).trim().slice(0, 60), Math.round(Number(n))])) : Boolean(valor);
    await db.guardarConfig(clave, v, auditor);
    await refrescarConfig(true);
    res.json({ ok: true, config: CONFIG.datos });
  } catch (err) {
    console.error('Error panel/config:', err);
    res.status(500).json({ error: /marce_config/.test(err.message) ? 'Falta crear la tabla marce_config en Supabase (supabase_config.sql).' : err.message });
  }
});

// Ventas con fecha de instalación (agenda o reagenda) en un rango: para mirar la torre hacia atrás
app.get('/api/panel/agenda-rango', exigirClave, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) return res.status(400).json({ error: 'Fechas inválidas.' });
    res.json({ ventas: (await db.ventasPorAgenda(desde, hasta)).map(conRegional) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- 📅 Campaña por día ----------
app.get('/api/panel/campana-dia', exigirClave, async (req, res) => {
  try { res.json({ dias: await db.leerCampanasDia(req.query.desde, req.query.hasta) }); }
  catch (err) { res.status(500).json({ error: /marce_campana_dia/.test(err.message) ? 'Falta correr supabase_campana_dia.sql en Supabase.' : err.message }); }
});
app.post('/api/panel/campana-dia', exigirClave, async (req, res) => {
  try {
    const { fecha, asesor, campana } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !String(asesor || '').trim()) return res.status(400).json({ error: 'Falta la fecha o el asesor.' });
    res.json({ ok: true, dia: await db.guardarCampanaDia(fecha, String(asesor).trim(), String(campana || '').trim(), req.usuario?.nombre) });
  } catch (err) { res.status(500).json({ error: /marce_campana_dia/.test(err.message) ? 'Falta correr supabase_campana_dia.sql en Supabase.' : err.message }); }
});

// ---------- 📉 Embudo de gestión (base del marcador OCM) ----------
// El panel lee el Excel de OCM y manda por día: un "cubo" (conteos por canal, skill, asesor, tipificación y nivel)
// y las filas que llegaron a contacto (para ver el detalle). Si se sube otra vez el mismo día, se reemplaza.
const ERR_OCM = (err) => /marce_ocm_dia/.test(err.message) ? 'Falta correr supabase_ocm.sql en Supabase.' : err.message;
app.post('/api/panel/ocm', exigirClave, async (req, res) => {
  try {
    const { dia, campana, cubo, filas, archivo, total } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || '') || !Array.isArray(cubo)) return res.status(400).json({ error: 'Falta el día o los datos de la base.' });
    if (cubo.length > 20000 || (filas || []).length > 20000) return res.status(400).json({ error: 'La base es demasiado grande para un solo día.' });
    const fila = { dia, campana: String(campana || '').trim(), cubo, filas: Array.isArray(filas) ? filas : [], archivo: archivo || null, total: +total || null, cargado_por: req.usuario?.nombre || null };
    const marcados = typeof req.body.marcados === 'string' ? req.body.marcados.slice(0, 3000000) : null;
    try { res.json({ ok: true, dia: await db.guardarOcmDia(marcados ? { ...fila, marcados } : fila) }); }
    catch (e) {
      if (!/marcados/.test(e.message)) throw e;
      res.json({ ok: true, dia: await db.guardarOcmDia(fila), aviso: 'Falta correr supabase_bases.sql: sin eso no se cruzan los marcados con las bases.' });
    }
  } catch (err) { res.status(500).json({ error: ERR_OCM(err) }); }
});

// ---------- 👤 Base por asesor: el admin asigna clientes por cédula; el asesor los gestiona de a 2 ----------
const ERR_BA = (err) => (/marce_base_asesor/.test(err.message) ? 'Falta correr supabase_base_asesor.sql en Supabase.' : err.message);
const MAX_A_LA_VEZ = 2;
const corteBA = (f) => ({
  id: f.id, lote: f.lote, estado: f.estado, datos: f.datos || {}, telefono: f.telefono, cargado: f.cargado,
  contesto: f.contesto, efectivo: f.efectivo, util: f.util, interesado: f.interesado, venta: f.venta,
  resultado: f.resultado, seguimiento_fecha: f.seguimiento_fecha, nota: f.nota, intentos: f.intentos, gestionado_at: f.gestionado_at,
});
async function datosMiBase(fila) {
  const ced = String(fila.cedula);
  const [actuales, conteo, seg, hoyL] = await Promise.all([
    db.tomarBaseAsesor(ced, MAX_A_LA_VEZ),
    db.leerBaseAsesorCampos(ced, 'estado, contesto, interesado, venta, gestionado_at'),
    db.seguimientosBaseAsesor(ced),
    db.gestionadosBaseAsesor(ced, isoColombia(hoyCO(), false)),
  ]);
  const hoyIni = isoColombia(hoyCO(), false);
  const r = { total: conteo.length, pendientes: 0, enGestion: 0, gestionados: 0, seguimiento: 0, hoy: 0, hoyContesto: 0, hoyInteresados: 0, hoyVentas: 0 };
  for (const x of conteo) {
    if (x.estado === 'pendiente') r.pendientes += 1; else if (x.estado === 'en_gestion') r.enGestion += 1; else if (x.estado === 'seguimiento') r.seguimiento += 1; else r.gestionados += 1;
    if (x.gestionado_at && x.gestionado_at >= hoyIni) { r.hoy += 1; if (x.contesto) r.hoyContesto += 1; if (x.interesado) r.hoyInteresados += 1; if (x.venta) r.hoyVentas += 1; }
  }
  return { ok: true, cedula: ced, asesor: fila.nombre, campana: fila.campana, hoy: hoyCO(), resumen: r, actuales: actuales.map(corteBA), seguimientos: seg.map(corteBA), gestionadosHoy: hoyL.map(corteBA) };
}
app.get('/api/mi-base', async (req, res) => {
  try {
    const fila = await resolverAsesor(req.query.cedula);
    if (!fila) return res.status(404).json({ error: AVISO_CEDULA.no_existe });
    if (!fila.activo) return res.status(403).json({ error: AVISO_CEDULA.inactivo });
    res.json(await datosMiBase(fila));
  } catch (err) { console.error('mi-base:', err.message); res.status(500).json({ error: ERR_BA(err) }); }
});
// Resultado en cadena: contestó → efectivo (gestionable) → útil para recuperar → interesado → venta / seguimiento
app.post('/api/mi-base/resultado', async (req, res) => {
  try {
    const b = req.body || {};
    const fila = await resolverAsesor(b.cedula);
    if (!fila || !fila.activo) return res.status(403).json({ error: AVISO_CEDULA[fila ? 'inactivo' : 'no_existe'] });
    const reg = await db.leerFilaBase(+b.id);
    if (!reg || String(reg.cedula) !== String(fila.cedula)) return res.status(404).json({ error: 'Ese cliente no está asignado a tu cédula.' });
    if (!['en_gestion', 'seguimiento', 'pendiente'].includes(reg.estado)) return res.status(400).json({ error: 'Ese cliente ya fue gestionado.' });
    const si = (v) => v === true || v === 'si' || v === 1;
    const c = { contesto: si(b.contesto), efectivo: null, util: null, interesado: null, venta: null, seguimiento_fecha: null };
    let estado = 'gestionado', resultado;
    if (!c.contesto) { estado = 'no_contesto'; resultado = 'No contestó'; }
    else {
      c.efectivo = si(b.efectivo);
      if (!c.efectivo) resultado = 'Contestó · no es cliente efectivo';
      else {
        c.util = si(b.util);
        if (!c.util) resultado = 'Efectivo · no útil para recuperar';
        else {
          c.interesado = si(b.interesado);
          if (!c.interesado) resultado = 'Útil · no interesado';
          else if (b.seguimiento) { estado = 'seguimiento'; resultado = 'Interesado · en seguimiento'; c.seguimiento_fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.seguimiento_fecha || '') ? b.seguimiento_fecha : null; }
          else { c.venta = si(b.venta); resultado = c.venta ? 'Venta lograda' : 'Interesado · no se logró la venta'; }
        }
      }
    }
    await db.guardarResultadoBase(reg.id, String(fila.cedula), { ...c, estado, resultado, nota: String(b.nota || '').slice(0, 1000) || reg.nota || null, intentos: (reg.intentos || 0) + 1, gestionado_at: new Date().toISOString() });
    res.json(await datosMiBase(fila));
  } catch (err) { console.error('mi-base/resultado:', err.message); res.status(500).json({ error: ERR_BA(err) }); }
});
// Admin: cargar base (ya repartida por cédula en el panel)
app.post('/api/panel/base-asesor/cargar', exigirClave, async (req, res) => {
  try {
    const { asignaciones, lote } = req.body || {};
    if (!Array.isArray(asignaciones) || !asignaciones.length) return res.status(400).json({ error: 'No hay filas para cargar.' });
    const filas = []; const resumen = [];
    for (const a of asignaciones) {
      const fila = await resolverAsesor(a.cedula);
      if (!fila) return res.status(400).json({ error: `La cédula ${a.cedula} no está registrada en Asesores.` });
      (a.filas || []).forEach((d, i) => {
        const tels = (Array.isArray(d.telefonos) ? d.telefonos : []).map((t) => soloDigitos(t)).filter((t) => t.length >= 7);
        filas.push({ cedula: String(fila.cedula), asesor: fila.nombre, lote: String(lote || '').slice(0, 200) || null, cargado_por: req.usuario?.nombre || null, orden: i, telefono: tels[0] || null, datos: { ...d, telefonos: tels } });
      });
      resumen.push({ cedula: fila.cedula, asesor: fila.nombre, n: (a.filas || []).length });
    }
    if (filas.length > 20000) return res.status(400).json({ error: 'Máximo 20.000 clientes por carga.' });
    const n = await db.insertarBaseAsesor(filas);
    res.json({ ok: true, cargados: n, resumen });
  } catch (err) { res.status(500).json({ error: ERR_BA(err) }); }
});
// Admin: consumo y resultados por cédula y por lote
app.get('/api/panel/base-asesor', exigirClave, async (req, res) => {
  try {
    const filas = await db.leerBaseAsesorCampos(null, 'cedula, asesor, lote, estado, contesto, efectivo, util, interesado, venta, gestionado_at, cargado');
    const hoyIni = isoColombia(hoyCO(), false);
    const nuevo = () => ({ total: 0, pendientes: 0, enGestion: 0, gestionados: 0, noContesto: 0, contesto: 0, efectivos: 0, utiles: 0, interesados: 0, ventas: 0, seguimiento: 0, hoy: 0, ultima: null, cargado: null });
    const porCed = {}, porLote = {};
    for (const f of filas) {
      for (const [m, k] of [[porCed, f.cedula], [porLote, (f.lote || 'Sin nombre') + '\u0001' + f.cedula]]) {
        const x = (m[k] ??= { ...nuevo(), cedula: f.cedula, asesor: f.asesor, lote: f.lote });
        x.total += 1;
        if (f.estado === 'pendiente') x.pendientes += 1; else if (f.estado === 'en_gestion') x.enGestion += 1; else x.gestionados += 1;
        if (f.estado === 'no_contesto') x.noContesto += 1;
        if (f.estado === 'seguimiento') x.seguimiento += 1;
        if (f.contesto) x.contesto += 1; if (f.efectivo) x.efectivos += 1; if (f.util) x.utiles += 1; if (f.interesado) x.interesados += 1; if (f.venta) x.ventas += 1;
        if (f.gestionado_at && f.gestionado_at >= hoyIni) x.hoy += 1;
        if (f.gestionado_at && (!x.ultima || f.gestionado_at > x.ultima)) x.ultima = f.gestionado_at;
        if (f.cargado && (!x.cargado || f.cargado > x.cargado)) x.cargado = f.cargado;
      }
    }
    res.json({ asesores: Object.values(porCed), lotes: Object.values(porLote) });
  } catch (err) { res.status(500).json({ error: ERR_BA(err) }); }
});
app.get('/api/panel/base-asesor/detalle', exigirClave, async (req, res) => {
  try { res.json({ filas: (await db.detalleBaseAsesor(req.query.cedula || null, req.query.lote || null)).map((f) => ({ ...corteBA(f), cedula: f.cedula, asesor: f.asesor, cargado_por: f.cargado_por })) }); }
  catch (err) { res.status(500).json({ error: ERR_BA(err) }); }
});
app.post('/api/panel/base-asesor/accion', exigirClave, async (req, res) => {
  try {
    const { accion, cedula, lote, aCedula } = req.body || {};
    if (!cedula) return res.status(400).json({ error: 'Falta la cédula.' });
    let aNombre = null;
    if (accion === 'reasignar') { const f = await resolverAsesor(aCedula); if (!f) return res.status(400).json({ error: 'La cédula destino no está en Asesores.' }); aNombre = f.nombre; }
    res.json({ ok: true, n: await db.accionBaseAsesor(accion, { cedula: String(cedula), lote: lote || null, aCedula: String(aCedula || ''), aNombre }) });
  } catch (err) { res.status(500).json({ error: ERR_BA(err) }); }
});

// ---------- 📈 Histórico del embudo ----------
// Resumen pequeño por día y campaña (se calcula una vez y queda guardado): así el histórico completo carga en segundos.
// L = teléfonos únicos que llegaron a cada etapa (0 marcado … 6 venta OCM) · cubo = llamadas por canal, asesor y etapa
// vm = ventas de Marce registradas ese día de teléfonos del marcador [canal, asesor] · ints = interesados [canal, asesor, en Marce 1/0]
async function calcularResumenOcm(f) {
  const nv = new Map();
  for (const p of String(f.marcados || '').split(',')) { const [t, n0] = p.split(':'); if (!t) continue; const n = Math.min(+n0 || 0, 6); if (!(nv.get(t) >= n)) nv.set(t, n); }
  const info = new Map();
  for (const x of f.filas || []) { const n = Math.min(x[6], 6); if (!(nv.get(x[0]) >= n)) nv.set(x[0], n); const pr = info.get(x[0]); if (!pr || x[6] > pr.n) info.set(x[0], { c: x[2] || '', a: x[5] || '', n: x[6] }); }
  const L = [0, 0, 0, 0, 0, 0, 0];
  for (const n of nv.values()) for (let k = 0; k <= n; k++) L[k] += 1;
  const cub = new Map();
  for (const c of f.cubo || []) { const k = [c[0] || '', c[2] || '', Math.min(c[4], 6)].join('\u0001'); cub.set(k, (cub.get(k) || 0) + (c[5] || 0)); }
  const cubo = [...cub.entries()].map(([k, n]) => { const p = k.split('\u0001'); return [p[0], p[1], +p[2], n]; });
  const partes = (t) => String(t || '').split(/[\/,;|]|\sy\s/i).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length >= 7);
  const vm = [];
  for (const v of await db.ventasCreadasEntre(isoColombia(f.dia, false), isoColombia(f.dia, true))) {
    const t = partes(v.telefono).find((x) => nv.has(x)); if (!t) continue;
    const x = info.get(t) || {}; vm.push([x.c || '', x.a || '']);
  }
  const intsTel = [...nv.entries()].filter(([, n]) => n >= 5).map(([t]) => t);
  const ini = sumarDias(f.dia, -30), fin = sumarDias(f.dia, 1);
  const marce = intsTel.length ? await db.marcePorTelefonos(intsTel) : { interesados: [], ventas: [] };
  const conReg = new Set();
  for (const r of [...marce.interesados, ...marce.ventas]) { const d = new Date(Date.parse(r.created_at) - 5 * 3600e3).toISOString().slice(0, 10); if (d >= ini && d <= fin) for (const t of partes(r.telefono)) conReg.add(t); }
  const ints = intsTel.map((t) => { const x = info.get(t) || {}; return [x.c || '', x.a || '', conReg.has(t) ? 1 : 0]; });
  return { v: 1, L, cubo, vm, ints, calc: new Date().toISOString() };
}
app.get('/api/panel/ocm/historico', exigirClave, cachear(300000), async (req, res) => {
  try {
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : hoyCO();
    const filas = await db.leerOcmResumenes(hasta);
    // Se recalcula si no tiene resumen o si se calculó antes de cerrar el día siguiente (los asesores aún pueden registrar en Marce)
    const pend = filas.filter((f) => !f.resumen || String(f.resumen.calc || '') < sumarDias(f.dia, 2));
    const t0 = Date.now(); let hechos = 0;
    for (const f of pend) {
      if (Date.now() - t0 > 20000) break;
      try { f.resumen = await calcularResumenOcm(await db.leerOcmFila(f.dia, f.campana)); await db.guardarOcmResumen(f.dia, f.campana, f.resumen); hechos += 1; }
      catch (e) { console.error('resumen OCM', f.dia, f.campana, e.message); hechos += 1; }
    }
    const pendientes = pend.length - hechos;
    if (pendientes > 0) res.locals.guardarCache = null; // no guardar en caché una respuesta incompleta
    res.json({ dias: filas.filter((f) => f.resumen).map((f) => ({ dia: f.dia, campana: f.campana, total: f.total, r: f.resumen })), pendientes });
  } catch (err) {
    res.status(500).json({ error: /resumen/.test(err.message) ? 'Falta correr supabase_ocm_resumen.sql en Supabase.' : ERR_OCM(err) });
  }
});
app.post('/api/panel/ocm/borrar', exigirClave, async (req, res) => {
  try {
    const { dia, campana } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) return res.status(400).json({ error: 'Falta el día.' });
    await db.borrarOcmDia(dia, String(campana || '').trim());
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: ERR_OCM(err) }); }
});
// Lee los días cargados y cruza cada interesado de OCM con Marce por celular
app.get('/api/panel/ocm', exigirClave, cachear(180000), async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) return res.status(400).json({ error: 'Fechas inválidas.' });
    const dias = await db.leerOcmDias(desde, hasta);
    // Nivel 5 = interesado (o más). Columnas de cada fila: [tel, hora, canal, skill, tipificación, asesor, nivel, procedencia, intentos]
    const tels = []; for (const d of dias) for (const f of d.filas || []) if (f[6] >= 5) tels.push(f[0]);
    const marce = tels.length ? await db.marcePorTelefonos(tels) : { interesados: [], ventas: [] };
    const cruce = {};
    const partes = (t) => String(t || '').split(/[\/,;|]|\sy\s/i).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length >= 7);
    const meter = (t, x) => { for (const n of partes(t)) (cruce[n] = cruce[n] || []).push(x); };
    for (const i of marce.interesados) meter(i.telefono, { tipo: 'interesado', id: i.id, asesor: i.asesor, resultado: i.resultado || '', fecha: i.created_at, cliente: i.nombre_cliente });
    for (const v of marce.ventas) meter(v.telefono, { tipo: 'venta', id: v.id, asesor: v.asesor, resultado: 'venta', fecha: v.created_at, cliente: v.nombre_cliente, ot: v.numero_ot, interesado_id: v.interesado_id, agenda: Boolean(v.fecha_agenda), instalada: v.estado_instalacion === 'instalada' || v.torre_salida === 'instalado' });
    // Nombre de cada asesor (OCM trae la cédula)
    const asesores = {};
    try { for (const a of await db.listarAsesores()) asesores[String(a.cedula)] = a.nombre; } catch (e) { console.error('ocm asesores:', e.message); }
    res.json({ dias, cruce, asesores });
  } catch (err) { res.status(500).json({ error: ERR_OCM(err) }); }
});

// ---------- 🗂 Gestión base de datos (bases preparadas por fuente × marcador OCM × Marce) ----------
// El panel lee la base preparada (una o varias sub-bases por archivo) y manda por archivo un resumen y sus teléfonos.
const ERR_BASES = (err) => /marce_base_dia|marcados/.test(err.message) ? 'Falta correr supabase_bases.sql en Supabase.' : err.message;
app.post('/api/panel/bases', exigirClave, async (req, res) => {
  try {
    const { dia, archivo, fuente, canal, campana, resumen, tels, total, archivo_origen } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || '') || !String(archivo || '').trim() || typeof tels !== 'string') return res.status(400).json({ error: 'Falta el día, el archivo o los teléfonos.' });
    res.json({ ok: true, base: await db.guardarBaseDia({ dia, archivo: String(archivo).trim().slice(0, 300), fuente: fuente || null, canal: canal || null, campana: campana || null,
      resumen: resumen || {}, tels: tels.slice(0, 4000000), total: +total || null, archivo_origen: archivo_origen || null, cargado_por: req.usuario?.nombre || null }) });
  } catch (err) { res.status(500).json({ error: ERR_BASES(err) }); }
});
app.post('/api/panel/bases/borrar', exigirClave, async (req, res) => {
  try {
    const { dia, archivo } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) return res.status(400).json({ error: 'Falta el día.' });
    await db.borrarBaseDia(dia, archivo || null);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: ERR_BASES(err) }); }
});
app.get('/api/panel/bases', exigirClave, cachear(120000), async (req, res) => {
  try {
    const todos = await db.diasBases();
    const resumenDias = {};
    for (const b of todos) { const d = (resumenDias[b.dia] = resumenDias[b.dia] || { dia: b.dia, archivos: 0, total: 0, fuentes: [] }); d.archivos += 1; d.total += b.total || 0; if (b.fuente && !d.fuentes.includes(b.fuente)) d.fuentes.push(b.fuente); }
    const dias = Object.values(resumenDias).sort((a, b) => (a.dia < b.dia ? 1 : -1));
    const ocmDias = await db.diasOcm().catch(() => []);
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dia || '') ? req.query.dia : dias[0]?.dia;
    if (!dia) return res.json({ dias, ocmDias, dia: null, bases: [], ocm: [], cruce: {} });
    const [bases, ocm] = await Promise.all([db.leerBasesDia(dia), db.leerOcmDia(dia).catch(() => [])]);
    // Interesados (nivel ≥ 5) del marcador: se buscan en Marce para saber si hubo venta e instalación
    const tels = new Set();
    for (const o of ocm) {
      for (const f of o.filas || []) if (f[6] >= 5) tels.add(f[0]);
      for (const p of String(o.marcados || '').split(',')) { const [t, n] = p.split(':'); if (+n >= 5) tels.add(t); }
    }
    const marce = tels.size ? await db.marcePorTelefonos([...tels]) : { interesados: [], ventas: [] };
    const cruce = {};
    const partes = (t) => String(t || '').split(/[\/,;|]|\sy\s/i).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length >= 7);
    // "En Marce" = el asesor dejó registrado (interesado o venta) ese celular entre 30 días antes y el día siguiente
    const enVentana = (iso) => { if (!iso) return false; const d = new Date(Date.parse(iso) - 5 * 3600 * 1000).toISOString().slice(0, 10); const ini = new Date(Date.parse(dia + 'T12:00:00Z') - 30 * 864e5).toISOString().slice(0, 10); const fin = new Date(Date.parse(dia + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10); return d >= ini && d <= fin; };
    for (const i of marce.interesados) for (const n of partes(i.telefono)) { const c = (cruce[n] = cruce[n] || { int: 0, venta: 0, agenda: 0, inst: 0 }); c.int += 1; if (enVentana(i.created_at)) c.marce = 1; }
    // Solo cuenta como venta del día la que se registró ESE día (hora Colombia). Las de otros días (por ejemplo,
    // la venta original de un cliente de Recuperación) se reportan aparte para no inflar el cierre.
    const diaCO = (iso) => new Date(Date.parse(iso) - 5 * 3600 * 1000).toISOString().slice(0, 10);
    for (const v of marce.ventas) for (const n of partes(v.telefono)) {
      const c = (cruce[n] = cruce[n] || { int: 0, venta: 0, agenda: 0, inst: 0, ventaAntes: 0, ventaDespues: 0 });
      const vd = v.created_at ? diaCO(v.created_at) : '';
      if (enVentana(v.created_at)) c.marce = 1;
      if (vd === dia) { c.venta += 1; if (v.fecha_agenda) c.agenda += 1; if (v.estado_instalacion === 'instalada' || v.torre_salida === 'instalado') c.inst += 1; }
      else if (vd && vd < dia) c.ventaAntes += 1;
      else c.ventaDespues += 1;
    }
    const asesores = {};
    try { for (const a of await db.listarAsesores()) asesores[String(a.cedula)] = a.nombre; } catch (e) { console.error('bases asesores:', e.message); }
    // Ventas registradas en Marce ese día (para cuadrar contra las ventas tipificadas en OCM)
    let ventasDia = [];
    try { ventasDia = (await db.ventasDelDia(dia)).map((v) => ({ tels: partes(v.telefono), hora: v.created_at ? new Date(Date.parse(v.created_at) - 5 * 3600 * 1000).toISOString().slice(11, 13) : '', asesor: v.asesor, cliente: v.nombre_cliente, ot: v.numero_ot, tipo: v.tipo_venta || v.datos?.tipo_venta || '' })); } catch (e) { console.error('bases ventasDia:', e.message); }
    let interesadosDia = [];
    try { interesadosDia = (await db.interesadosDelDia(dia)).map((i) => ({ tels: partes(i.telefono), asesor: i.asesor, resultado: i.resultado || '' })); } catch (e) { console.error('bases interesadosDia:', e.message); }
    res.json({ dias, ocmDias, dia, bases, asesores, ventasDia, interesadosDia, ocm: ocm.map((o) => ({ campana: o.campana, total: o.total, archivo: o.archivo, actualizado: o.actualizado, marcados: o.marcados || '', filas: o.filas || [], cubo: o.cubo || [] })), cruce });
  } catch (err) { res.status(500).json({ error: ERR_BASES(err) }); }
});

// ---------- 📥 Importar historial de ventas (Excel) ----------
// No modifica nada que ya exista: solo agrega las ventas cuya OT (o cuenta + cédula) no está en la base.
const CAMPOS_IMPORT = ['asesor', 'nombre_cliente', 'cedula', 'telefono', 'direccion', 'barrio', 'ciudad', 'plan', 'numero_ot', 'numero_cuenta', 'fecha_agenda', 'hora_agenda', 'observaciones',
  'tipo_venta', 'servicios_vendidos', 'multiasistencia', 'multiasistencia_cual', 'tecnologia', 'estado_instalacion', 'instalacion_nota', 'aprobacion_bo', 'aprobacion_motivo', 'llamada_ocm'];
const dig = (x) => String(x || '').replace(/\D/g, '');
app.get('/api/panel/importar', exigirClave, async (req, res) => {
  try { res.json({ importadas: await db.contarImportadas() }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/panel/importar', exigirClave, async (req, res) => {
  try {
    const { filas = [], simular = false } = req.body || {};
    if (!Array.isArray(filas) || filas.length > 1000) return res.status(400).json({ error: 'Envía máximo 1000 filas por lote.' });
    const { ots, cuentas, cedDia } = await db.llavesVentas();
    const diaCO = (iso) => (iso ? new Date(new Date(iso).getTime() - 5 * 3600e3).toISOString().slice(0, 10) : '');
    const nuevas = [], existentes = [];
    for (const f of filas) {
      const ot = dig(f.numero_ot), cta = dig(f.numero_cuenta) + '|' + dig(f.cedula);
      // Ya existe si: misma OT · o (sin OT) misma cuenta + cédula · o el mismo cliente (cédula) ya tiene una venta ese mismo día (ej. registrada en Marce sin OT)
      const cd = dig(f.cedula) && f.created_at ? dig(f.cedula) + '|' + diaCO(f.created_at) : '';
      if ((ot && ots.has(ot)) || (!ot && dig(f.numero_cuenta) && cuentas.has(cta)) || (cd && cedDia.has(cd))) { existentes.push(f.numero_ot || f.numero_cuenta); continue; }
      if (ot) ots.add(ot); else cuentas.add(cta); // tampoco se repite dentro del mismo lote
      const row = { session_id: 'import-' + (ot || dig(f.numero_cuenta) || crypto.randomUUID()), datos: { ...(f.datos || {}), origen: 'importado_excel', importado_el: new Date().toISOString() } };
      for (const c of CAMPOS_IMPORT) if (f[c] !== undefined && f[c] !== null && f[c] !== '') row[c] = f[c];
      if (row.direccion) { const h = homologarDireccion(row.direccion); if (h && h.valor) { row.direccion = h.valor; row.datos.direccion_original = h.original; } }
      if (/^\d{4}-\d{2}-\d{2}T/.test(f.created_at || '')) row.created_at = f.created_at;
      nuevas.push(row);
    }
    if (simular) return res.json({ ok: true, nuevas: nuevas.length, existentes: existentes.length });
    // Cada venta nueva queda enlazada al interesado que ya existía con el mismo celular
    const mapa = await db.mapaInteresadosPorCelular().catch(() => new Map());
    const aMarcar = new Set();
    for (const row of nuevas) { const i = db.interesadoDeVenta(row, mapa); if (i) { row.interesado_id = i.id; if (i.resultado !== 'venta') aMarcar.add(i.id); } }
    let guardadas = 0;
    for (let i = 0; i < nuevas.length; i += 200) guardadas += await db.insertarVentasLote(nuevas.slice(i, i + 200));
    if (aMarcar.size) await db.marcarInteresadosVenta([...aMarcar]).catch((e) => console.error('marcar venta:', e.message));
    res.json({ ok: true, nuevas: guardadas, existentes: existentes.length, enlazadas: nuevas.filter((r) => r.interesado_id).length });
  } catch (err) {
    console.error('Error panel/importar:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/panel/importar/enlazar', exigirClave, async (req, res) => {
  try { res.json({ ok: true, ...(await db.enlazarVentasImportadas()) }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/panel/importar/deshacer', exigirClave, async (req, res) => {
  try { res.json({ ok: true, borradas: await db.deshacerImportacion() }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- 👥 Asesores (panel) ----------
const normNombre = (s) => norm(s).replace(/\s+/g, ' ').trim();
app.get('/api/panel/asesores', exigirClave, async (req, res) => {
  try {
    const [lista, conteo] = await Promise.all([db.listarAsesores(), db.conteoPorAsesor()]);
    const registrados = new Set(lista.map((a) => a.nombre));
    const asesores = lista.map((a) => ({ ...a, interesados: conteo.interesados[a.nombre] || 0, ventas: conteo.ventas[a.nombre] || 0 }));
    const nombres = new Set([...Object.keys(conteo.interesados), ...Object.keys(conteo.ventas)]);
    const sinRegistrar = [...nombres]
      .filter((n) => !registrados.has(n))
      .map((n) => ({ nombre: n, interesados: conteo.interesados[n] || 0, ventas: conteo.ventas[n] || 0 }))
      .sort((x, y) => y.interesados + y.ventas - (x.interesados + x.ventas));
    res.json({ asesores, sinRegistrar });
  } catch (err) {
    console.error('Error panel/asesores:', err.message);
    res.status(500).json({ error: /asesores/.test(err.message) ? 'Falta crear la tabla de asesores en Supabase (supabase_asesores.sql).' : err.message });
  }
});
app.post('/api/panel/asesores', exigirClave, async (req, res) => {
  try {
    const cedula = soloDigitos(req.body?.cedula);
    const nombre = String(req.body?.nombre || '').replace(/\s+/g, ' ').trim();
    const { campana, activo } = req.body || {};
    if (cedula.length < 5 || nombre.length < 3) return res.status(400).json({ error: 'Escribe la cédula y el nombre completo.' });
    const antes = await db.buscarAsesor(cedula);
    // Mismo nombre que otro asesor (otra cédula): no se permite, se mezclarían los registros.
    const choca = (await db.listarAsesores()).find((a) => a.cedula !== cedula && normNombre(a.nombre) === normNombre(nombre));
    if (choca) return res.status(400).json({ error: `Ese nombre ya lo tiene la cédula ${choca.cedula}.` });
    const fila = await db.guardarAsesor({ cedula, nombre, campana: campana ?? antes?.campana, activo: activo ?? antes?.activo ?? true });
    let movidos = null;
    if (antes && antes.nombre !== nombre) movidos = await db.renombrarAsesor(antes.nombre, nombre); // su historial se va con él
    ASESORES.delete(cedula);
    res.json({ ok: true, asesor: fila, movidos });
  } catch (err) {
    console.error('Error panel/asesores POST:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Carga varios asesores de una vez (desde un Excel en el panel).
app.post('/api/panel/asesores/lote', exigirClave, async (req, res) => {
  try {
    const filas = Array.isArray(req.body?.asesores) ? req.body.asesores.slice(0, 2000) : [];
    const existentes = await db.listarAsesores();
    const porCedula = new Map(existentes.map((a) => [a.cedula, a]));
    let nuevos = 0, actualizados = 0, omitidos = 0;
    for (const f of filas) {
      const cedula = soloDigitos(f.cedula);
      const nombre = String(f.nombre || '').replace(/\s+/g, ' ').trim();
      if (cedula.length < 5 || nombre.length < 3) { omitidos += 1; continue; }
      const antes = porCedula.get(cedula);
      if (antes && antes.nombre === nombre && (antes.campana || '') === (f.campana || '')) { omitidos += 1; continue; }
      await db.guardarAsesor({ cedula, nombre, campana: f.campana || antes?.campana || null, activo: antes ? antes.activo : true });
      if (antes && antes.nombre !== nombre) await db.renombrarAsesor(antes.nombre, nombre);
      ASESORES.delete(cedula);
      antes ? (actualizados += 1) : (nuevos += 1);
    }
    res.json({ ok: true, nuevos, actualizados, omitidos });
  } catch (err) {
    console.error('Error panel/asesores/lote:', err.message);
    res.status(500).json({ error: /asesores/.test(err.message) ? 'Falta crear la tabla de asesores en Supabase (supabase_asesores.sql).' : err.message });
  }
});

app.post('/api/panel/asesores/unir', exigirClave, async (req, res) => {
  try {
    const { de, a } = req.body || {};
    if (!de || !a || de === a) return res.status(400).json({ error: 'Elige el nombre a unir y el asesor destino.' });
    const destino = (await db.listarAsesores()).find((x) => x.nombre === a);
    if (!destino) return res.status(400).json({ error: 'El asesor destino no está registrado.' });
    res.json({ ok: true, movidos: await db.renombrarAsesor(de, a) });
  } catch (err) {
    console.error('Error panel/asesores/unir:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Registro manual y edición desde el panel ----------
const CAMPOS_INT_PANEL = ['asesor', 'nombre_cliente', 'telefono', 'direccion', 'ciudad', 'cobertura_validada', 'resultado', 'motivo_no_interes', 'observaciones'];
// Qué cambió en una orden (antes → después), para la hoja "Cambios en órdenes"
function diferencias(antes, despues, campos) {
  const v = (x) => (x === undefined || x === null ? '' : String(x).trim());
  return campos.filter((c) => despues[c] !== undefined && (!antes || c in antes) && v(antes?.[c]) !== v(despues[c])).map((c) => ({ campo: c, antes: antes?.[c] ?? null, despues: despues[c] ?? null }));
}
const fichaOrden = (v) => ({ ot: v?.numero_ot || '', cliente: v?.nombre_cliente || '', asesor: v?.asesor || '', fecha_agenda: v?.fecha_agenda || '' });
const CAMPOS_VEN_PANEL = ['tecnologia', 'aliado_tecnico', 'tipo_venta', 'servicios_vendidos', 'multiasistencia', 'multiasistencia_cual', 'cedula', 'barrio', 'plan', 'numero_ot', 'numero_cuenta', 'fecha_agenda', 'hora_agenda', 'observaciones'];
const COMPARTIDOS = ['asesor', 'nombre_cliente', 'telefono', 'direccion', 'ciudad'];
const RESULTADOS = ['en_gestion', 'venta', 'no_venta', 'volver_llamar', 'escalado', 'ot_activa'];
const limpiarCampos = (obj, permitidos) => {
  const out = {};
  for (const k of permitidos) if (obj && k in obj) out[k] = obj[k] === '' ? null : String(obj[k]).trim();
  return out;
};
function validarPanel(i) {
  if (i.direccion) {
    const h = homologarDireccion(i.direccion);
    if (h.ok) i.direccion = h.valor;
  }
  if ('telefono' in i && i.telefono) {
    const t = validarTelefonos(i.telefono);
    if (!t.ok) return t.mensaje || 'El celular debe tener 10 dígitos y empezar en 3. Si son varios, sepáralos con coma.';
    i.telefono = t.valor;
  }
  if ('resultado' in i && i.resultado && !RESULTADOS.includes(i.resultado)) return 'Estado no válido.';
  if ('cobertura_validada' in i && i.cobertura_validada) i.cobertura_validada = norm(i.cobertura_validada) === 'si' ? 'sí' : 'no';
  return null;
}
async function crearVentaPanel(asesor, cliente, venta, fecha) {
  const datos = { ...limpiarCampos(venta, CAMPOS_VEN_PANEL), ciudad: cliente.ciudad, fecha_venta: fecha || hoyCO() };
  return db.guardarVenta(asesor, cliente, datos);
}

// Homologa las direcciones que ya estaban guardadas. Primero muestra cuántas cambian; con aplicar=true las corrige.
app.post('/api/panel/homologar-direcciones', exigirClave, async (req, res) => {
  try {
    const aplicar = Boolean(req.body?.aplicar);
    const filas = await db.todasLasDirecciones();
    const cambios = [];
    let sinHomologar = 0;
    for (const f of filas) {
      if (!f.direccion) continue;
      const h = homologarDireccion(f.direccion);
      if (!h.ok) { sinHomologar += 1; continue; }
      if (h.valor !== f.direccion) cambios.push({ ...f, nueva: h.valor });
    }
    if (aplicar) for (const c of cambios) await db.actualizarDireccion(c.tabla, c.id, c.nueva, c.direccion);
    res.json({ ok: true, aplicado: aplicar, cambian: cambios.length, sinHomologar, ejemplos: cambios.slice(0, 8).map((c) => ({ antes: c.direccion, despues: c.nueva })) });
  } catch (err) {
    console.error('Error homologar-direcciones:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Crea a mano un cliente (y su venta) con la fecha que se elija. Sirve para no perder lo que no se registró en Marce.
app.post('/api/panel/registro', exigirClave, async (req, res) => {
  try {
    const { interesado = {}, venta = null, fecha, auditor } = req.body || {};
    const i = limpiarCampos(interesado, CAMPOS_INT_PANEL);
    const err = validarPanel(i);
    if (err) return res.status(400).json({ error: err });
    if (!i.asesor || !i.nombre_cliente || !i.telefono || !i.direccion) return res.status(400).json({ error: 'Faltan datos: asesor, cliente, celular y dirección.' });
    const hoy = hoyCO();
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : hoy;
    if (dia > hoy) return res.status(400).json({ error: 'La fecha no puede ser futura.' });
    const creado = await db.crearInteresado(i.asesor, {
      direccion: i.direccion, nombre_cliente: i.nombre_cliente, telefono: i.telefono, ciudad: i.ciudad || null,
      cobertura: i.cobertura_validada || 'sí', registro_manual: auditor || 'panel',
    });
    const extra = { resultado: i.resultado || 'en_gestion', motivo_no_interes: i.motivo_no_interes || null, observaciones: i.observaciones || null };
    if (dia < hoy) extra.created_at = new Date(`${dia}T12:00:00-05:00`).toISOString();
    let cliente = await db.actualizarInteresado(creado.id, extra);
    if (extra.resultado === 'venta') await crearVentaPanel(i.asesor, cliente, venta || {}, dia);
    res.json({ ok: true, interesado: cliente });
  } catch (err) {
    console.error('Error panel/registro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Edita un cliente y/o su venta desde el panel.
app.post('/api/panel/editar', exigirClave, async (req, res) => {
  try {
    const { interesado_id, venta_id, interesado = {}, venta = null } = req.body || {};
    if (!interesado_id && !venta_id) return res.status(400).json({ error: 'Falta el registro a editar.' });
    const i = limpiarCampos(interesado, CAMPOS_INT_PANEL);
    const err = validarPanel(i);
    if (err) return res.status(400).json({ error: err });
    let cliente = null;
    if (interesado_id && Object.keys(i).length) {
      cliente = await db.actualizarInteresado(interesado_id, i);
      await db.actualizarVentasDeInteresado(interesado_id, limpiarCampos(i, COMPARTIDOS));
    }
    if (venta_id) {
      const antesV = await db.obtenerVenta(venta_id).catch(() => null);
      req._cambio = { ...fichaOrden(antesV), cambios: diferencias(antesV, { ...limpiarCampos(i, CAMPOS_INT_PANEL), ...limpiarCampos(venta || {}, CAMPOS_VEN_PANEL) }, [...new Set([...CAMPOS_INT_PANEL, ...CAMPOS_VEN_PANEL])]) };
    }
    if (venta && venta_id) {
      const v = limpiarCampos(venta, CAMPOS_VEN_PANEL);
      if (!interesado_id) Object.assign(v, limpiarCampos(i, COMPARTIDOS));
      if (Object.keys(v).length) await db.actualizarVenta(venta_id, v);
    } else if (venta && interesado_id && i.resultado === 'venta') {
      cliente = cliente || (await db.obtenerCliente(interesado_id));
      if (!cliente.venta) await crearVentaPanel(cliente.asesor, cliente, venta, null);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error panel/editar:', err.message);
    res.status(500).json({ error: /tecnologia|aliado_tecnico/.test(err.message) ? 'Falta correr supabase_tecnologia.sql en Supabase.' : err.message });
  }
});

// Eliminar registros mal subidos. Solo desde el panel (con la clave).
app.post('/api/panel/eliminar', exigirClave, async (req, res) => {
  try {
    const { tipo, id, auditor } = req.body || {};
    if (!id || !['venta', 'interesado'].includes(tipo)) return res.status(400).json({ error: 'Falta id o el tipo no es válido.' });
    console.log(`Panel: ${auditor || 'alguien'} eliminó ${tipo} ${id}`);
    if (tipo === 'venta') { const v = await db.obtenerVenta(id).catch(() => null); req._cambio = { ...fichaOrden(v), cambios: [{ campo: 'eliminada', antes: 'venta', despues: 'eliminada' }] }; }
    res.json(tipo === 'venta' ? await db.eliminarVenta(id) : await db.eliminarInteresado(id));
  } catch (err) {
    console.error('Error panel/eliminar:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/panel/auditar', exigirClave, async (req, res) => {
  try {
    const { id, resultado, nota, auditor } = req.body || {};
    if (!id || !['confirmada', 'sin_cobertura', 'pendiente'].includes(resultado)) {
      return res.status(400).json({ error: 'Falta id o el resultado no es válido.' });
    }
    res.json({ ok: true, interesado: await db.auditarCobertura(id, { resultado, nota, auditor }) });
  } catch (err) {
    console.error('Error panel/auditar:', err);
    res.status(500).json({ error: err.message });
  }
});

// El estado de la conversación viaja con cada mensaje (lo guarda la extensión).
// Así, aunque Render reinicie o "duerma" el servidor, no se pierde el paso
// en el que iba el asesor.
function serializar(sesion) {
  const { captura, ...resto } = sesion;
  return {
    ...resto,
    captura: captura ? { tipo: captura.tipo, paso: captura.paso, datos: captura.datos, campoId: captura.campoId } : null,
  };
}
function hidratar(estado) {
  if (!estado || typeof estado !== 'object') return null;
  const sesion = { ...nuevaSesion(), ...estado };
  if (sesion.captura) {
    const campos = sesion.captura.tipo === 'editar'
      ? [campoEditable(sesion.captura.campoId)].filter(Boolean)
      : CAMPOS()[sesion.captura.tipo];
    // Si el formulario cambió o quedó vacío (ej. "no_venta" ya no pide datos), se descarta.
    if (!Array.isArray(campos) || !campos.length) sesion.captura = null;
    else sesion.captura = { ...sesion.captura, campos, paso: Math.min(sesion.captura.paso || 0, campos.length - 1) };
  }
  if (sesion.modo === 'captura' && !sesion.captura) sesion.modo = 'libre';
  return sesion;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message, estado, cedula } = req.body || {};
    let { asesor } = req.body || {};
    if (!sessionId || !message) return res.status(400).json({ error: 'Falta sessionId o message' });
    // Con cédula, el nombre siempre sale de la tabla de asesores (así nunca queda escrito distinto).
    if (cedula) {
      const fila = await resolverAsesor(cedula);
      if (!fila || !fila.activo) {
        return res.json({ reply: AVISO_CEDULA[fila ? 'inactivo' : 'no_existe'], error: true, estado: estado || null, sinAcceso: true });
      }
      asesor = fila.nombre;
    }
    const sesion = hidratar(estado) || sesiones.get(sessionId) || nuevaSesion();
    const respuesta = await manejar(sesion, asesor, message);
    sesiones.set(sessionId, sesion);
    if (sesiones.size > 2000) sesiones.delete(sesiones.keys().next().value);
    res.json({ ...respuesta, estado: serializar(sesion), asesor: asesor || undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Marce · Asistente de Venta escuchando en http://localhost:${PORT}`);
  });
}

module.exports = { manejar, nuevaSesion };
