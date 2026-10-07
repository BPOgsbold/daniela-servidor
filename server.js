require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const { responderAyuda } = require('./claude');
const {
  crearCaso,
  actualizarCaso,
  guardarEscalamientoJuridico,
  guardarConocimiento,
  obtenerConocimientoReciente,
  buscarCasoPorTermino,
  obtenerVehiculosReferencia,
  guardarVehiculoNoListado,
} = require('./supabase');

const { TIPOS_DOC, configurado: sharepointConfigurado, subirDocumento, moverACliente, esClienteDefinitivo } = require('./sharepoint');

const app = express();
app.use(cors());
// Los documentos adjuntos llegan en base64: este endpoint admite hasta ~25mb.
app.use('/api/adjuntar', express.json({ limit: '35mb' }));
// Límite subido de 100kb (default de Express) a 2mb: una entrada de
// conocimiento larga (ej. un Excel convertido a texto) puede pesar más de
// 100kb y Express la rechazaría con un error 413 antes de llegar a la
// validación de MAX_TEXTO_CONOCIMIENTO de abajo.
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const CAMPOS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'campos.json'), 'utf8')
);
const SOP_TEXT = fs.readFileSync(path.join(__dirname, 'sop.md'), 'utf8');
const OBJECIONES_TEXT = fs.readFileSync(
  path.join(__dirname, 'objeciones.md'),
  'utf8'
);

const sesiones = new Map();

// --- Conocimiento adicional ("enseñarle" cosas nuevas a Daniela) ---
// Se guarda en Supabase (tabla `conocimiento`) para que sobreviva reinicios
// del servidor, y se mantiene en memoria (con una actualización cada vez que
// se agrega algo nuevo) para no consultar la base de datos en cada mensaje.
// Conocimiento con BÚSQUEDA: en vez de pasarle a Claude TODO lo enseñado en
// cada duda, se indexa en trozos y solo se envían los que se parecen a la
// pregunta. Lo corto que se enseña a mano ("principios", avisos) se sigue
// enviando siempre, como antes; lo largo o cargado en lote (la guía) se busca.
let conocimientoCache = { siempre: [], trozos: [], idf: new Map(), at: 0 };
const CONOCIMIENTO_TTL_MS = 60 * 1000;
const MAX_SIEMPRE = 20;          // entradas manuales cortas que siempre van
const MAX_TROZOS_RESPUESTA = 6;  // trozos de la guía que se envían por duda
const MAX_CARACTERES_BUSQUEDA = 12000;
const UMBRAL_LARGO = 4000;       // desde aquí una entrada manual se busca en vez de enviarse completa
const TAM_TROZO = 1800;

const STOP = new Set(('de la el los las un una unos unas y o u e a al del en con por para que se su sus lo le les me mi mis te tu tus es son ser fue era soy eres este esta estos estas ese esa esos esas eso esto como mas pero si no ya muy hay han ha he tiene tienen tengo puede pueden quiero cual cuales cuando donde quien quienes cuanto cuantos cuanta cuantas sobre entre desde hasta tambien solo sin ni nos ante bajo cada otro otra otros otras alguno alguna algun todo toda todos todas'.split(' ')));

function tokensBusqueda(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w.replace(/(es|s)$/, '')));
}

function trocearTexto(texto, tam = TAM_TROZO) {
  const bloques = String(texto).split(/\n{2,}/);
  const trozos = [];
  let actual = '';
  for (const b of bloques) {
    if (actual && (actual.length + b.length + 2) > tam) { trozos.push(actual); actual = ''; }
    actual += (actual ? '\n\n' : '') + b;
    while (actual.length > tam * 1.6) { trozos.push(actual.slice(0, tam)); actual = actual.slice(tam); }
  }
  if (actual.trim()) trozos.push(actual);
  return trozos;
}

function esDeBusqueda(e) {
  const autor = String(e.agregado_por || '');
  if (/^principios/i.test(autor)) return false;           // siempre se envían
  return /^gu[ií]a/i.test(autor) || String(e.texto || '').length > UMBRAL_LARGO;
}

function etiquetaEntrada(e) {
  const fecha = e.created_at ? new Date(e.created_at).toLocaleDateString('es-CO') : '';
  return [e.titulo, e.agregado_por, fecha].filter(Boolean).join(' · ');
}

function formatearConocimiento(entradas) {
  if (!entradas || entradas.length === 0) return '';
  return entradas
    .map((e) => {
      const encabezado = etiquetaEntrada(e);
      return encabezado ? `### ${encabezado}\n${e.texto}` : e.texto;
    })
    .join('\n\n');
}

async function cargarConocimientoCache() {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await sb
    .from('conocimiento')
    .select('id, titulo, texto, agregado_por, created_at')
    .eq('activo', true)
    .order('created_at', { ascending: false })
    .limit(3000);
  if (error) throw error;
  const siempre = [];
  const trozos = [];
  for (const e of data || []) {
    if (!esDeBusqueda(e)) { if (siempre.length < MAX_SIEMPRE) siempre.push(e); continue; }
    const titulo = e.titulo || '';
    trocearTexto(e.texto).forEach((t, i, arr) => {
      const tk = tokensBusqueda(titulo + ' ' + titulo + ' ' + titulo + ' ' + t); // el título pesa x3
      const tf = new Map();
      tk.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
      trozos.push({ titulo: titulo + (arr.length > 1 ? ` (parte ${i + 1})` : ''), texto: t, tf, autor: e.agregado_por, created_at: e.created_at });
    });
  }
  const df = new Map();
  trozos.forEach((t) => t.tf.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
  const N = Math.max(trozos.length, 1);
  const idf = new Map();
  df.forEach((n, w) => idf.set(w, Math.log(1 + N / n)));
  conocimientoCache = { siempre, trozos, idf, at: Date.now() };
}

// Devuelve el texto de conocimiento para esta duda: lo "siempre" + los trozos
// de la guía más parecidos a la pregunta. Sin pregunta, solo lo "siempre".
async function obtenerConocimientoTexto(pregunta = '', forzar = false) {
  if (typeof pregunta === 'boolean') { forzar = pregunta; pregunta = ''; }
  if (forzar || Date.now() - conocimientoCache.at > CONOCIMIENTO_TTL_MS) {
    try {
      await cargarConocimientoCache();
    } catch (err) {
      console.error('No se pudo cargar el conocimiento adicional:', err.message);
      // seguimos con lo último que había en caché
    }
  }
  const { siempre, trozos, idf } = conocimientoCache;
  let texto = formatearConocimiento(siempre);
  const q = [...new Set(tokensBusqueda(pregunta))];
  if (q.length && trozos.length) {
    const puntuados = trozos
      .map((t) => {
        let sc = 0;
        for (const w of q) { const f = t.tf.get(w); if (f) sc += (idf.get(w) || 0) * (1 + Math.log(f)); }
        return { t, sc };
      })
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc);
    if (puntuados.length) {
      const corte = puntuados[0].sc * 0.4;
      let total = 0;
      const elegidos = [];
      for (const { t, sc } of puntuados) {
        if (elegidos.length >= MAX_TROZOS_RESPUESTA || sc < corte) break;
        if (total + t.texto.length > MAX_CARACTERES_BUSQUEDA) break;
        elegidos.push(t); total += t.texto.length;
      }
      if (elegidos.length) {
        const bloque = elegidos.map((t) => `### ${t.titulo}${t.autor ? ' · ' + t.autor : ''}\n${t.texto}`).join('\n\n');
        texto += (texto ? '\n\n' : '') + '## Respuestas de la guía más parecidas a la pregunta\n' + bloque;
      }
    }
  }
  return texto;
}

function nuevaSesion() {
  return {
    estado: 'inactivo',
    tipo: null,
    stepIndex: 0,
    data: {},
    casoId: null,
    pendienteEscalamiento: null,
    pendienteBusqueda: false,
    avisoDuplicadoMostrado: false,
    // Cuando el asesor responde "No" a "¿lograste el contacto?", le
    // preguntamos si quiere cerrar la interacción con ese cliente ahí mismo
    // (ya quedó guardado como "Contacto") o seguir igual con las preguntas.
    pendienteCierre: false,
    // Último caso único que encontró una búsqueda ("buscar cliente" / "ya
    // fue atendido"), para que el botón "Retomar este caso" sepa cuál es sin
    // tener que volver a buscar.
    candidatoRetomar: null,
    // Progreso en las 3 preguntas de negociación (estado de interés,
    // negociación, cliente acepta todo) que se hacen una vez el caso ya
    // tiene todos sus datos. Ver GATES_NEGOCIACION.
    negociacion: null,
  };
}

// Las 3 preguntas de negociación, en orden. Cada una es un gate Sí/No: si es
// "No" pide un motivo (con botones) y luego si cerrar la interacción; si es
// "Sí" pasa a la siguiente (la última pide el siguiente paso en vez de eso).
const GATES_NEGOCIACION = [
  {
    id: 'interes',
    pregunta: '¿El cliente sigue interesado en el proceso?',
    motivoCampo: 'motivo_no_interes',
    motivos: [
      'Tecnología del vehículo',
      'Antigüedad',
      'Segundo propietario',
      'No entrega información',
      'No le interesa el proceso',
    ],
  },
  {
    id: 'negociacion',
    pregunta: '¿El cliente acepta la propuesta?',
    motivoCampo: 'motivo_negociacion',
    motivos: ['Lo pensará', 'Pide volver a llamar', 'Va a consultar un tercero'],
  },
  {
    id: 'acepta',
    pregunta: '¿Finalizaste la negociación con el cliente?',
    motivoCampo: 'motivo_rechazo',
    motivos: ['No confía en el proceso', 'Precio', 'Tiempo limitado para el proceso'],
    siguientePasoOpciones: ['Pendiente de contrato', 'Pendiente de firma', 'Pendiente de pago', 'Proceso completado'],
    servicioOpciones: ['Solo DIAN', 'Servicio completo', 'Solo UPME'],
  },
];

// Última pregunta del flujo de negociación: cómo quedan los documentos del
// cliente al momento de escalar el caso (una vez ya se registró el servicio
// contratado).
const OPCIONES_ESCALAR_DOCUMENTOS = ['Escalar con documentos completos', 'Escalar con documentos pendientes'];

// Botones que se muestran en cada una de las 3 preguntas de negociación
// (interés, negociación, acepta): además de Sí/No, "Cerrar interacción" para
// cuando el cliente deja de responder a mitad de la gestión — así el asesor
// no queda trabado esperando una respuesta Sí/No que puede que nunca llegue;
// el caso ya está guardado en Supabase con lo que se alcanzó a registrar.
const OPCIONES_GATE_PREGUNTA = ['Sí', 'No', 'Cerrar interacción'];
const ETIQUETA_CERRAR_INTERACCION = 'Cerrar interacción';
function esCerrarInteraccion(mensaje) {
  return normalizarTexto(mensaje).trim() === normalizarTexto(ETIQUETA_CERRAR_INTERACCION).trim();
}

// Convierte un registro ya guardado en Supabase de vuelta al formato de
// `sesion.data` (id de campo -> valor), para poder "retomar" un caso
// existente sin volver a preguntar los datos que ya tiene. Solo se incluyen
// los campos que sí tienen valor: los que falten quedan pendientes, tal como
// los detecta `siguienteIndicePendiente`.
const CAMPOS_RETOMABLES = [
  'canal', 'fuente', 'nombre_cliente', 'telefono', 'contacto_logrado',
  'tipo_identificacion', 'numero_identificacion', 'email', 'id_rrss',
  'tipo_cuenta', 'nombre_empresa', 'cuenta',
  'tipo_persona', 'vehiculo', 'tecnologia', 'placa', 'fecha_compra',
  'valor_sin_iva', 'tiene_certificado_upme',
];
function datosDeCasoExistente(caso) {
  const datos = {};
  for (const id of CAMPOS_RETOMABLES) {
    if (caso[id] !== null && caso[id] !== undefined && caso[id] !== '') {
      datos[id] = caso[id];
    }
  }
  return datos;
}

// Cuando un mismo cliente vuelve con un SEGUNDO vehículo (se gestiona como un
// caso aparte, con su propio pipeline), reutilizamos solo sus datos de
// identidad/contacto — nunca los del vehículo — para no volver a preguntar
// nombre, teléfono, cédula, etc., pero sí pedir de cero los datos del carro
// nuevo (vehículo, tecnología, placa, fecha de compra, valor, certificado).
const CAMPOS_CLIENTE_COMPARTIDOS = CAMPOS_RETOMABLES.filter(
  (id) => !['vehiculo', 'tecnologia', 'placa', 'fecha_compra', 'valor_sin_iva', 'tiene_certificado_upme'].includes(id)
);
function datosClienteExistente(caso) {
  const datos = {};
  for (const id of CAMPOS_CLIENTE_COMPARTIDOS) {
    if (caso[id] !== null && caso[id] !== undefined && caso[id] !== '') {
      datos[id] = caso[id];
    }
  }
  return datos;
}

// Arma una respuesta legible con los casos que ya existen en Supabase para
// un cliente, para que el asesor pueda confirmar rápido si ya fue atendido
// antes en vez de crear un caso duplicado.
function formatearResultadosBusqueda(casos, termino) {
  if (!casos || casos.length === 0) {
    return `No encontré ningún caso ya registrado que coincida con "${termino}". Puede ser un cliente nuevo, o el dato no coincide exactamente (revisa que el nombre, la cédula/NIT o la placa estén bien escritos). Si es nuevo, dime "tengo un cliente nuevo" y arrancamos.`;
  }

  const bloques = casos.map((c) => {
    const fecha = c.updated_at || c.created_at;
    const fechaTexto = fecha
      ? new Date(fecha).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'fecha no registrada';

    let estadoTexto = 'en gestión, todavía sin resultado final';
    if (c.resultado === 'radicado') {
      const detalleRadicado = [
        c.numero_radicado_dian ? `radicado ${c.numero_radicado_dian}` : null,
        c.seccional ? `seccional ${c.seccional}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      estadoTexto = `ya quedó radicado${detalleRadicado ? ` (${detalleRadicado})` : ''}`;
    } else if (c.resultado === 'no_aplica') {
      estadoTexto = `no aplicó${c.motivo_no_aplica ? ` (motivo: ${c.motivo_no_aplica})` : ''}`;
    }

    // Motivo de negociación: mostramos el más reciente que tenga dato (si el
    // caso avanzó, un gate anterior puede haber quedado sin motivo porque se
    // respondió "Sí").
    const motivoNegociacion = c.motivo_rechazo || c.motivo_negociacion || c.motivo_no_interes || null;

    return (
      `• ${c.nombre_cliente || 'Sin nombre'} — ${c.tipo_identificacion || 'ID'} ${c.numero_identificacion || '—'}, ` +
      `placa ${c.placa || '—'}, vehículo ${c.vehiculo || '—'}.\n` +
      `  Estado del pipeline: ${c.estado_pipeline || 'sin definir'}${
        c.estado_pipeline && descripcionEstadoPipeline(c.estado_pipeline)
          ? ` (${descripcionEstadoPipeline(c.estado_pipeline)})`
          : ''
      }. Trámite ante la DIAN: ${estadoTexto}.` +
      ` Última comunicación: ${fechaTexto}.` +
      (c.siguiente_paso ? ` Siguiente paso: ${c.siguiente_paso}.` : '') +
      (c.servicio_contratado ? ` Servicio contratado: ${c.servicio_contratado}.` : '') +
      (c.escalamiento_documentos ? ` ${c.escalamiento_documentos}.` : '') +
      (motivoNegociacion ? ` Motivo: ${motivoNegociacion}.` : '') +
      (c.info_completa ? ` Información: ${c.info_completa}.` : '') +
      (c.observaciones ? ` Observaciones: ${c.observaciones}.` : '')
    );
  });

  const intro =
    casos.length === 1
      ? `Sí, encontré un caso ya registrado con "${termino}":`
      : `Encontré ${casos.length} casos que coinciden con "${termino}" (el más reciente primero):`;

  return `${intro}\n\n${bloques.join('\n\n')}\n\nAsí evitamos duplicar: si es el mismo trámite, sigue gestionando ese caso en vez de crear uno nuevo.`;
}

// Arma la respuesta de una búsqueda de cliente. Si hay una coincidencia exacta
// por cédula/NIT o placa, se queda solo con esa. Si quedan varios, ofrece un
// botón por cada uno para ELEGIR (antes no había forma de escoger).
function resolverBusqueda(sesion, termino, resultados) {
  const t = String(termino || '').trim();
  const tPlaca = t.toUpperCase().replace(/[\s-]+/g, '');
  const exactos = (resultados || []).filter(
    (c) =>
      (c.numero_identificacion && String(c.numero_identificacion).trim() === t) ||
      (c.placa && String(c.placa).toUpperCase().replace(/[\s-]+/g, '') === tPlaca)
  );
  const lista = exactos.length > 0 ? exactos : resultados || [];
  sesion.candidatoRetomar = null;
  sesion.candidatosLista = null;
  const reply = formatearResultadosBusqueda(lista, termino);
  if (lista.length === 1) {
    sesion.candidatoRetomar = lista[0];
    return { reply, opciones: ['Retomar este caso', 'Mismo cliente, otro vehículo'] };
  }
  if (lista.length > 1) {
    sesion.candidatosLista = lista.slice(0, 5);
    const opciones = sesion.candidatosLista.map((c, i) => {
      const dato = c.numero_identificacion || c.placa || '';
      return `Elegir ${i + 1}: ${c.nombre_cliente || 'Sin nombre'}${dato ? ' · ' + dato : ''}`;
    });
    return {
      reply: reply.replace(/\n\nAsí evitamos duplicar[^]*$/, '') +
        '\n\nToca el cliente que buscas (o escríbeme su cédula/placa exacta) para retomarlo.',
      opciones,
    };
  }
  return { reply };
}

function siguienteIndicePendiente(campos, data) {
  const idx = campos.findIndex((c) => !(c.id in data));
  return idx === -1 ? campos.length : idx;
}

function resumenCampos(campos, data) {
  return campos.map((c) => `• ${c.label}: ${data[c.id] ?? '—'}`).join('\n');
}

// Botón universal que se agrega a TODAS las preguntas de captura de datos:
// si el cliente no tiene o no quiso dar ese dato, el asesor puede darle clic
// y seguir sin quedar trabado esperando una respuesta que no va a llegar.
const ETIQUETA_SALTAR = 'No tiene este dato';

// Cuando al asesor le mostramos varias líneas candidatas de un vehículo (ver
// más abajo, desambiguación) y ninguna es la correcta, le damos la opción de
// escribir la referencia completa de una vez, en vez de solo poder saltar
// directo a preguntar la tecnología a mano.
const ETIQUETA_OTRO_VEHICULO = 'Otro (escribir la referencia completa)';

// Cuando el campo que se le está preguntando al asesor tiene opciones fijas
// (tipo "botones"/"botones_opcional"), se las mandamos a la extensión en
// `opciones` para que las pinte como botones clicables, además del texto. A
// esas opciones (o, si el campo es de texto libre, como única opción) se le
// suma siempre el botón de "No tiene este dato".
function conOpciones(base, campo) {
  if (!campo) return base;
  const opcionesCampo = campo.opciones || [];
  // Los campos marcados "sinSaltar" son obligatorios: no se les agrega el
  // botón de "No tiene este dato" (ej. nombre, teléfono, si se logró el
  // contacto).
  if (campo.sinSaltar) {
    return opcionesCampo.length ? { ...base, opciones: opcionesCampo } : base;
  }
  return { ...base, opciones: [...opcionesCampo, ETIQUETA_SALTAR] };
}

// Normaliza algunas respuestas cortas a una etiqueta completa y legible.
const TIPO_PERSONA_MAP = {
  '1': 'Persona natural',
  natural: 'Persona natural',
  'persona natural': 'Persona natural',
  particular: 'Persona natural',
  '2': 'Persona jurídica',
  juridica: 'Persona jurídica',
  jurídica: 'Persona jurídica',
  'persona juridica': 'Persona jurídica',
  'persona jurídica': 'Persona jurídica',
  empresa: 'Persona jurídica',
  sociedad: 'Persona jurídica',
  compañia: 'Persona jurídica',
  compañía: 'Persona jurídica',
};

const TECNOLOGIA_MAP = {
  electrico: 'Eléctrico',
  eléctrico: 'Eléctrico',
  electrica: 'Eléctrico',
  eléctrica: 'Eléctrico',
  ev: 'Eléctrico',
  hibrido: 'Híbrido',
  híbrido: 'Híbrido',
  hibrida: 'Híbrido',
  híbrida: 'Híbrido',
  hybrid: 'Híbrido',
  'hibrido enchufable': 'Híbrido enchufable',
  'híbrido enchufable': 'Híbrido enchufable',
  'hibrida enchufable': 'Híbrido enchufable',
  'híbrida enchufable': 'Híbrido enchufable',
  enchufable: 'Híbrido enchufable',
  phev: 'Híbrido enchufable',
  'plug-in': 'Híbrido enchufable',
  'plug in': 'Híbrido enchufable',
  reev: 'Híbrido de rango extendido',
  'rango extendido': 'Híbrido de rango extendido',
  'de rango extendido': 'Híbrido de rango extendido',
};

// ====== Base de referencia de vehículos que aplican al beneficio ======
// Se usa para autocompletar/validar la tecnología apenas el asesor escribe
// el vehículo del cliente. La base puede no estar completa todavía, así que
// si un vehículo no aparece NO se bloquea el caso — solo se avisa al asesor
// para que confirme bien que aplica, y queda registrado para ir creciendo la
// base con el tiempo (tabla vehiculos_no_listados).
let vehiculosReferenciaCache = null;
let vehiculosReferenciaCacheEn = 0;
const VEHICULOS_REFERENCIA_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function obtenerVehiculosReferenciaCacheada() {
  const ahora = Date.now();
  if (vehiculosReferenciaCache && ahora - vehiculosReferenciaCacheEn < VEHICULOS_REFERENCIA_TTL_MS) {
    return vehiculosReferenciaCache;
  }
  try {
    vehiculosReferenciaCache = await obtenerVehiculosReferencia();
    vehiculosReferenciaCacheEn = ahora;
  } catch (err) {
    console.error('Error cargando la base de referencia de vehículos:', err);
    // Si falla, seguimos con lo que hubiera en caché (aunque esté vencido) o
    // con una lista vacía — nunca bloqueamos el flujo por esto.
    vehiculosReferenciaCache = vehiculosReferenciaCache || [];
  }
  return vehiculosReferenciaCache;
}

function normalizarParaComparar(s) {
  return (s || '')
    .toString()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca el vehículo que escribió el asesor (texto libre, ej. "Toyota
 * Corolla Cross Hybrid") dentro de la base de referencia. No exige que
 * coincida exactamente: alcanza con que la marca aparezca en el texto y que
 * al menos una palabra significativa del modelo también aparezca.
 *
 * Devuelve TODAS las líneas que empatan en el mayor número de palabras
 * coincidentes (no solo la "mejor"), para poder distinguir un match único de
 * uno ambiguo. Ej.: "Toyota Corolla" a secas empata igual contra "Corolla
 * Cross Seg Hev", "Corolla Xei Hv" y "Corolla Xli Hv" (solo coincide la
 * palabra "Corolla" en los tres) — ahí no se puede adivinar cuál es, hay que
 * preguntar. En cambio "Toyota Corolla Cross" ya coincide en 2 palabras
 * ("Corolla" + "Cross") contra esa línea puntual, así que gana ella sola.
 *
 * Primero intenta anclar por marca + modelo (más confiable). Si el asesor no
 * escribió la marca (ej. escribió solo "Corolla" sin "Toyota"), eso no debe
 * hacer que el vehículo quede sin detectar — así que si esa primera pasada no
 * encuentra nada, se reintenta comparando solo por el modelo.
 */
function buscarVehiculosEnReferencia(textoVehiculo, referencia) {
  const texto = normalizarParaComparar(textoVehiculo);
  if (!texto) return [];
  const conMarca = coincidenciasVehiculo(texto, referencia, true);
  if (conMarca.length > 0) return conMarca;
  return coincidenciasVehiculo(texto, referencia, false);
}

// Distancia de edición (Levenshtein) entre dos palabras — cuenta cuántas
// letras hay que cambiar/agregar/quitar para pasar de una a la otra. Se usa
// para tolerar errores de tipeo (ej. "porolla" en vez de "Corolla") sin
// tener que escribir la palabra exacta.
function distanciaLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const fila = new Array(n + 1);
  for (let j = 0; j <= n; j++) fila[j] = j;
  for (let i = 1; i <= m; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = fila[j];
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, anterior + costo);
      anterior = temp;
    }
  }
  return fila[n];
}

// Cuántas letras de diferencia se toleran antes de considerar que dos
// palabras ya no son "la misma, con un error de tipeo". Palabras muy cortas
// (3 letras o menos, ej. "KIA", "MG") no toleran ningún error, para no
// confundir marcas distintas que se parecen; palabras más largas toleran 1
// o 2 letras de diferencia.
function toleranciaTipeo(longitud) {
  if (longitud <= 3) return 0;
  if (longitud <= 7) return 1;
  return 2;
}

// Compara una palabra de la referencia (ej. "COROLLA") contra todas las
// palabras que escribió el asesor, aceptando tanto coincidencia exacta como
// un error de tipeo pequeño (ej. "POROLLA" o "COROLA").
function algunaPalabraCoincide(palabraReferencia, palabrasTexto) {
  const tolerancia = toleranciaTipeo(palabraReferencia.length);
  for (const palabraTexto of palabrasTexto) {
    if (palabraTexto === palabraReferencia) return true;
    if (tolerancia === 0) continue;
    // Si la diferencia de longitud ya supera la tolerancia, ni vale la pena
    // calcular la distancia completa.
    if (Math.abs(palabraTexto.length - palabraReferencia.length) > tolerancia) continue;
    if (distanciaLevenshtein(palabraTexto, palabraReferencia) <= tolerancia) return true;
  }
  return false;
}

function coincidenciasVehiculo(texto, referencia, exigirMarca) {
  const palabrasTexto = texto.split(' ').filter(Boolean);
  let mejores = [];
  let mejorCoincidencias = 0;
  for (const v of referencia) {
    if (exigirMarca) {
      const marcaNorm = normalizarParaComparar(v.marca);
      if (!marcaNorm) continue;
      const marcaCoincide = texto.includes(marcaNorm) || algunaPalabraCoincide(marcaNorm, palabrasTexto);
      if (!marcaCoincide) continue;
    }
    const palabrasModelo = normalizarParaComparar(v.modelo)
      .split(' ')
      .filter((p) => p.length >= 3);
    if (palabrasModelo.length === 0) continue;
    const coincidencias = palabrasModelo.filter(
      (p) => texto.includes(p) || algunaPalabraCoincide(p, palabrasTexto)
    ).length;
    if (coincidencias === 0) continue;
    if (coincidencias > mejorCoincidencias) {
      mejorCoincidencias = coincidencias;
      mejores = [v];
    } else if (coincidencias === mejorCoincidencias) {
      mejores.push(v);
    }
  }
  return mejores;
}

/**
 * Arma la pregunta para que el asesor precise cuál de varias líneas
 * candidatas es la correcta. Se dirige al asesor por su nombre y suena a
 * pregunta de conversación normal (ej. "Migue, ¿el cliente tiene un Toyota
 * Corolla Cross, Seg, Xei o Xli?"), en vez de mostrar solo una lista fría de
 * referencias técnicas.
 */
function construirPreguntaDesambiguarVehiculo(candidatos, asesor) {
  const saludo = asesor ? `${asesor}, ` : '';
  const marca = candidatos[0].marca;
  // Palabras del modelo que se repiten en TODAS las líneas candidatas (ej.
  // "COROLLA" en Corolla Cross/Seg/Xei/Xli) — sirven para nombrar el modelo
  // en la pregunta ("Toyota Corolla") y no solo la marca ("Toyota").
  const palabrasComunes = normalizarParaComparar(candidatos[0].modelo)
    .split(' ')
    .filter((p) => candidatos.every((c) => normalizarParaComparar(c.modelo).split(' ').includes(p)));
  const modeloComun = palabrasComunes.length > 0 ? ` ${palabrasComunes.join(' ')}` : '';
  const lista = candidatos.map((c, i) => `${i + 1}. ${c.marca} ${c.modelo}`).join('\n');
  return (
    `${saludo}encontré varias versiones de ${marca}${modeloComun} que podrían ser — no quiero adivinar cuál le queda al cliente. ` +
    `¿Cuál de estas es exactamente?\n\n${lista}\n\nResponde con el número, dale clic a "${ETIQUETA_OTRO_VEHICULO}" si es otra línea distinta y me escribes la referencia completa, o a "${ETIQUETA_SALTAR}" si de plano no la sabes.`
  );
}

// Botones para la pregunta de desambiguar vehículo: uno por cada línea
// candidata (para poder responder con un clic), más "Otro" (para escribir la
// referencia completa cuando ninguna de las opciones listadas es la
// correcta) y "No tiene este dato" (para cuando el asesor de verdad no sabe
// cuál es) — no debe quedar bloqueado sin poder avanzar por ninguno de los
// dos motivos.
function opcionesDesambiguarVehiculo(candidatos) {
  return [...candidatos.map((c) => `${c.marca} ${c.modelo}`), ETIQUETA_OTRO_VEHICULO, ETIQUETA_SALTAR];
}

const TIPO_IDENTIFICACION_MAP = {
  cc: 'CC',
  'c.c': 'CC',
  'c.c.': 'CC',
  cedula: 'CC',
  cédula: 'CC',
  'cedula de ciudadania': 'CC',
  'cédula de ciudadanía': 'CC',
  ce: 'CE',
  'c.e': 'CE',
  'c.e.': 'CE',
  'cedula de extranjeria': 'CE',
  'cédula de extranjería': 'CE',
  nit: 'NIT',
  ti: 'TI',
  'tarjeta de identidad': 'TI',
  pasaporte: 'Pasaporte',
  passport: 'Pasaporte',
};

// Pone en "Nombre Propio" un texto que el asesor escribió libremente (nombre
// del cliente, vehículo, nombre del asesor): primera letra de cada palabra
// en mayúscula, el resto en minúscula — así no importa si lo escriben todo
// en mayúsculas, todo en minúsculas o mezclado, siempre queda parejo. Los
// conectores cortos (de, del, la...) se dejan en minúscula salvo que sean la
// primera palabra, para que se vea como un nombre real y no un título.
const CONECTORES_NOMBRE = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
function capitalizarNombrePropio(texto) {
  return texto
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((palabra, i) => {
      if (i > 0 && CONECTORES_NOMBRE.has(palabra)) return palabra;
      return palabra.charAt(0).toUpperCase() + palabra.slice(1);
    })
    .join(' ');
}

function normalizarValorCampo(campoId, valorCrudo) {
  const valor = valorCrudo.trim();
  if (campoId === 'tipo_persona') {
    return TIPO_PERSONA_MAP[valor.toLowerCase()] || valor;
  }
  if (campoId === 'tecnologia') {
    return TECNOLOGIA_MAP[valor.toLowerCase()] || valor;
  }
  if (campoId === 'tipo_identificacion') {
    return TIPO_IDENTIFICACION_MAP[valor.toLowerCase()] || valor;
  }
  if (campoId === 'placa') {
    return valor.toUpperCase().replace(/[\s-]+/g, '');
  }
  if (campoId === 'nombre_cliente' || campoId === 'vehiculo') {
    return capitalizarNombrePropio(valor);
  }
  if (campoId === 'email') {
    return valor.toLowerCase();
  }
  return valor;
}

// Interpreta una respuesta de sí/no dicha de forma natural (no exige que el
// asesor responda EXACTAMENTE "sí" o "no"). Ojo: \b de JS no funciona bien
// con tildes (í, é...), así que en vez de \b delimitamos con espacios.
function interpretarSiNo(texto) {
  const limpio = texto
    .toLowerCase()
    .replace(/[.,;:!¿?¡]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const t = ` ${limpio} `;
  if (/ (no|aún no|aun no|todavía no|todavia no|negativo|no lo tiene|no la tiene|hay que tramitarlo|desde cero) /.test(t)) {
    return 'no';
  }
  if (/ (s[ií]|claro|correcto|exacto|afirmativo|listo|ya lo tiene|ya la tiene|ya tiene) /.test(t)) {
    return 'sí';
  }
  return null;
}

// Valida y normaliza la respuesta del asesor para un campo. Los campos
// marcados con tipo "si_no" se interpretan de forma conversacional en vez de
// exigir una palabra exacta.
function validarYNormalizarCampo(campo, mensajeCrudo) {
  // El botón "No tiene este dato" funciona igual para cualquier tipo de
  // campo (texto libre, botones, si_no): si el asesor le da clic (o lo
  // escribe tal cual), se guarda null para ese dato y se sigue sin exigirlo.
  // Va primero, antes de cualquier validación específica del tipo de campo.
  // Los campos "sinSaltar" son obligatorios, así que ni siquiera aceptan
  // esta frase como respuesta válida (queda igual que si la hubieran
  // escrito como cualquier otro texto que no cumple el formato esperado).
  if (!campo.sinSaltar && normalizarTexto(mensajeCrudo).trim() === normalizarTexto(ETIQUETA_SALTAR).trim()) {
    return { ok: true, valor: null };
  }

  if (campo.tipo === 'si_no') {
    const valor = interpretarSiNo(mensajeCrudo);
    if (!valor) return { ok: false };
    return { ok: true, valor };
  }

  // Campos con botones fijos (canal, origen, contacto logrado, certificado
  // UPME): la extensión manda de vuelta exactamente el texto del botón que
  // el asesor clickeó, así que comparamos ignorando mayúsculas/tildes por si
  // lo escribe a mano en vez de dar clic.
  if (campo.tipo === 'botones') {
    const entrada = normalizarTexto(mensajeCrudo).trim();
    const match = (campo.opciones || []).find((o) => normalizarTexto(o).trim() === entrada);
    if (!match) return { ok: false };
    return { ok: true, valor: match };
  }

  // Campo opcional con botón de "Saltar" (ej. ID de redes sociales): si el
  // asesor da clic en el botón, o escribe algo como "no tiene"/"ninguno", se
  // guarda como null y seguimos; si escribe cualquier otra cosa, se guarda
  // tal cual.
  if (campo.tipo === 'botones_opcional') {
    const entrada = mensajeCrudo.trim();
    const entradaNorm = normalizarTexto(entrada);
    const esSaltar =
      (campo.opciones || []).some((o) => normalizarTexto(o).trim() === entradaNorm) ||
      /^(saltar|no tiene|ninguno|n\/a|no aplica|no)$/i.test(entrada);
    if (esSaltar) return { ok: true, valor: null };
    if (!entrada) return { ok: false };
    return { ok: true, valor: entrada };
  }

  const regex = new RegExp(campo.regex);
  if (!regex.test(mensajeCrudo.trim())) return { ok: false };
  return { ok: true, valor: normalizarValorCampo(campo.id, mensajeCrudo) };
}

// Frases que disparan cada transición automáticamente, sin necesidad de
// botones — el asesor simplemente cuenta cómo va el caso y Daniela
// reacciona.
//
// Para el escalamiento a jurídico usamos un regex flexible (en vez de
// frases exactas) para que funcione aunque el asesor meta palabras de por
// medio, ej. "necesito escalar esto a jurídico" o "toca pasarlo a jurídico".
const REGEX_ESCALAR_JURIDICO = /escalar.{0,25}jur[ií]dic|jur[ií]dic.{0,25}(escalar|revisa|decide|caso)|pasar.{0,20}a.{0,5}jur[ií]dic|consultar.{0,20}jur[ií]dic/;

const FRASES_RADICADO = [
  'ya se radicó', 'ya se radico', 'quedó radicado', 'quedo radicado', 'se radicó',
  'se radico', 'radicamos el caso', 'ya radicamos', 'quedó bien radicado',
  'quedo bien radicado', 'caso radicado', 'ya quedó en la dian', 'ya quedo en la dian',
];
const FRASES_NO_APLICA = [
  'no aplica', 'no califica', 'no calificó', 'no califico', 'el carro no aplica',
  'no cumple', 'se descartó', 'se descarto', 'no sigue el caso', 'no continuamos',
  'cliente no sigue', 'el caso no procede', 'no procede el caso',
];
const FRASES_NUEVO_CASO = [
  'tengo un cliente', 'tengo un caso', 'nuevo cliente', 'otro cliente',
  'cliente interesado', 'quiere el trámite', 'quiere el tramite', 'quiere tramitar',
  'nuevo caso', 'otro caso', 'siguiente cliente', 'siguiente caso', 'próximo cliente',
  'proximo cliente', 'próximo caso', 'proximo caso', 'me llamó un cliente',
  'me llamo un cliente', 'quiere el beneficio', 'pregunta por la devolución',
  'pregunta por la devolucion', 'compró un carro eléctrico', 'compro un carro electrico',
  'compró un híbrido', 'compro un hibrido', 'compró un eléctrico', 'compro un electrico',
  'nueva gestión', 'nueva gestion', 'otro interesado', 'nuevo interesado',
];

// Frases para detectar cuando el asesor quiere revisar si un cliente ya fue
// atendido antes (y traer su último caso), en vez de crear uno nuevo y
// duplicar información. Es más específico que FRASES_NUEVO_CASO a propósito
// (ej. exige "ya" + "atendido/gestionado/etc." o "duplicar"/"repetido") para
// que "tengo un cliente nuevo" siga cayendo en __nuevo_caso__.
// (Se agregaron además las variantes de "estado del caso"/"cómo va el caso":
// un asesor preguntando "puedes brindarme estado del caso del cliente X" es
// una consulta de estado tan válida como "buscar cliente", pero antes solo
// caía en el flujo libre de IA, que no tiene acceso a Supabase y por eso
// respondía que no podía consultar nada.)
const REGEX_BUSCAR_CLIENTE = /(ya\s+(fue|lo|la|hab[ií]amos|est[aá]|estuvo)\s+(atendid|gestionad|contactad|llamad)|cliente\s+(repetid|duplicad)|ya\s+(ten[ií]a|tiene|hab[ií]a)\s+caso|ya\s+existe\s+(ese|el|la|este)?\s*cliente|buscar\s+(el\s+|la\s+)?cliente|buscar\s+(este|ese)\s+cliente|consultar\s+(el\s+|la\s+)?cliente|revisar\s+si\s+ya\s+(existe|est[aá]|lo\s+(tenemos|ten[ií]amos))|no\s+(quiero|queremos)\s+duplicar|ya\s+lo\s+hab[ií]amos\s+atendido|ya\s+hab[ií]amos\s+hablado\s+con|ya\s+es\s+cliente|verificar\s+si\s+ya|est[aá]\s+repetido|hist[oó]rico\s+de(l)?\s+cliente|revisar\s+(el\s+)?historial|estado\s+(actual\s+|actualizado\s+)?del?\s+(caso|cliente|tr[aá]mite)|c[oó]mo\s+va\s+(el|ese|su|este)?\s*(caso|tr[aá]mite)|en\s+qu[eé]\s+va\s+(el|ese|este)?\s*(caso|tr[aá]mite)|(brindar|dar|dame|darme|pasar|pasarme)(me)?\s+(el\s+)?(estado|informaci[oó]n)|informaci[oó]n\s+del\s+caso|info\s+del\s+caso|consultar\s+(el\s+)?estado)/i;

// Si el mensaje que disparó "__buscar_cliente__" ya trae el nombre del
// cliente (ej. "...del cliente michael barco"), lo extraemos para buscar de
// una vez en vez de volver a preguntarle al asesor un dato que ya escribió.
function extraerTerminoBusqueda(mensaje) {
  const m = mensaje.match(/cliente\s+([a-záéíóúñ0-9.\-\s]{3,60})$/i);
  if (!m) return null;
  const termino = m[1].trim().replace(/[?.!¡¿]+$/g, '').trim();
  if (!termino || /^(nuevo|repetido|duplicado|es)$/i.test(termino)) return null;
  return termino;
}

// Quita tildes para comparar texto sin importar acentos.
function normalizarTexto(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Los 8 estados del pipeline comercial que define el negocio (distintos del
// resultado final del trámite ante la DIAN, que es otra cosa: radicado /
// no_aplica). El asesor los cambia escribiéndole a Daniela en lenguaje
// natural, ej. "cambia el estado a cliente" o "márcalo como en proceso upme".
// El pipeline llega hasta "Cliente" (ahí ya está ganado el caso). Lo que
// pasa DESPUÉS de ganar (trámite UPME, DIAN, desembolso) ya NO es un estado
// de este pipeline: vive aparte en la columna "estado_actual_cliente", que
// por ahora solo se maneja desde el panel web (no por chat).
const ESTADOS_PIPELINE = [
  {
    label: 'Registro',
    frases: ['registro'],
    descripcion: 'se intentó el contacto pero no se logró (el cliente no respondió o no se pudo hablar con él).',
  },
  {
    label: 'Contacto',
    frases: ['contacto'],
    descripcion: 'el cliente se comunicó pero no brindó todos los datos.',
  },
  {
    label: 'Interesado',
    frases: ['interesado'],
    descripcion: 'es el que llega y ya se completaron todos los datos que el cliente brinda.',
  },
  {
    label: 'Negociación',
    frases: ['negociacion', 'en negociacion', 'negociando'],
    descripcion: 'el cliente ya confirmó que sigue interesado y se está negociando la propuesta (aceptación, siguiente paso, servicio contratado).',
  },
  {
    label: 'Cliente',
    frases: ['cliente'],
    descripcion: 'ya tenemos todos los documentos que debe enviar el cliente, la firma del contrato y el pago realizado.',
  },
  {
    label: 'Cierre perdido',
    frases: ['cierre perdido'],
    descripcion: 'el cliente no firmó contrato, no envió documentación y/o no realizó el pago.',
  },
];

// Devuelve la explicación de negocio de un estado del pipeline (para
// mostrársela al asesor junto con el estado, no solo la etiqueta).
function descripcionEstadoPipeline(label) {
  const encontrado = ESTADOS_PIPELINE.find((e) => e.label === label);
  return encontrado ? encontrado.descripcion : null;
}

// Compara el texto capturado como "estado destino" contra los estados
// conocidos. Las frases de UNA sola palabra (cliente, contacto, interesado)
// exigen coincidencia EXACTA (después de quitar artículos como "el/la/un") —
// si aceptáramos "contiene", frases ya usadas en la app para otra cosa (ej.
// "otro cliente" de FRASES_NUEVO_CASO) dispararían un cambio de estado por
// error. Las frases de 2+ palabras (más específicas, ej. "proceso upme") sí
// aceptan que el texto capturado las contenga, para tolerar variaciones
// como "ya está en proceso upme".
function identificarEstadoPipeline(textoCrudo) {
  const norm = normalizarTexto(textoCrudo).trim().replace(/^(el|la|un|una|de|en)\s+/, '');
  if (!norm) return null;

  const candidatos = ESTADOS_PIPELINE.flatMap((e) =>
    e.frases.map((f) => ({ label: e.label, frase: normalizarTexto(f) }))
  );

  for (const c of candidatos) {
    if (norm === c.frase) return c.label;
  }
  for (const c of candidatos) {
    if (c.frase.split(' ').length >= 2 && norm.includes(c.frase)) return c.label;
  }
  return null;
}

// Frases que indican que el asesor quiere CAMBIAR el estado del pipeline de
// un cliente: un verbo de cambio ("cambia", "marca", "pasa", "actualiza",
// "pon"...) seguido, en algún punto, de "a"/"como"/"en" + el estado destino
// al final del mensaje. Solo capturamos el texto final (grupo 3): así, si el
// mensaje también menciona "cliente <nombre>" antes (ej. "cambia el estado
// del cliente juan pérez a cliente"), el nombre del cliente no se confunde
// con la palabra "cliente" usada como estado destino.
const REGEX_VERBO_CAMBIO_ESTADO = /\b(cambia|cambiar|actualiza|actualizar|pon|poner|marca|marcar|m[aá]rcal[oa]|pasa|pasar|p[aá]sal[oa]|mueve|mover|mu[eé]vel[oa])\b/i;

// Saca el nombre del cliente de la parte del mensaje ANTES del conector que
// introduce el estado destino. Primero intenta la frase explícita
// "cliente <nombre>"; si no aparece (ej. "marca a michael barco como..."),
// quita el verbo de cambio y palabras de relleno ("el estado", "del caso",
// artículos) y usa lo que sobre como nombre — pero solo si sobra algo con
// pinta de nombre real, para no terminar usando "estado" o "" como si fuera
// un cliente.
function extraerNombreDeCambioEstado(antes) {
  const t = antes.trim();
  const conCliente = t.match(/cliente\s+([a-záéíóúñ0-9.\-\s]{3,60})$/i);
  if (conCliente) {
    const nombre = conCliente[1].trim().replace(/[?.!¡¿]+$/g, '').trim();
    if (nombre) return nombre;
  }

  // Solo miramos el texto que viene DESPUÉS de la última aparición del
  // verbo de cambio, para no arrastrar palabras de relleno que el asesor
  // haya escrito antes del verbo (ej. "necesito cambiar el estado a
  // cliente" no debe capturar "necesito" como si fuera el nombre).
  const verbos = [...t.matchAll(new RegExp(REGEX_VERBO_CAMBIO_ESTADO.source, 'gi'))];
  const ultimoVerbo = verbos[verbos.length - 1];
  const desdeVerbo = ultimoVerbo ? t.slice(ultimoVerbo.index + ultimoVerbo[0].length) : t;

  const resto = desdeVerbo
    .replace(/\b(el|la|los|las|del|de|al|a|un|una|como)\b/gi, ' ')
    .replace(/\b(estado|pipeline|caso)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return resto.length >= 3 ? resto : null;
}

// Devuelve { estadoLabel, nombre } si el mensaje pide cambiar el estado de un
// cliente a un estado reconocido, o null si no aplica. Busca todas las
// apariciones de "a"/"como" como conector y prueba desde la más cercana al
// final hacia atrás: la primera cuyo texto siguiente coincide con uno de los
// 8 estados conocidos es la que separa "a quién" de "a qué estado". Esto
// evita depender de una sola conjetura de dónde está el conector correcto
// cuando el mensaje tiene varias apariciones de "a" (una para el cliente,
// otra para el estado).
function detectarCambioEstado(mensaje) {
  if (!REGEX_VERBO_CAMBIO_ESTADO.test(mensaje)) return null;

  const conectorRegex = /\b(a|como|en)\b/gi;
  const posiciones = [];
  let match;
  while ((match = conectorRegex.exec(mensaje)) !== null) {
    posiciones.push({ inicio: match.index, fin: match.index + match[0].length });
  }

  for (let i = posiciones.length - 1; i >= 0; i--) {
    const despues = mensaje.slice(posiciones[i].fin).trim();
    const estadoLabel = identificarEstadoPipeline(despues);
    if (estadoLabel) {
      // "antes" excluye el propio conector ("a"/"como"), para que no se
      // cuele como parte del nombre del cliente (ej. "...jimenez a" en vez
      // de "...jimenez").
      const antes = mensaje.slice(0, posiciones[i].inicio);
      const nombre = extraerNombreDeCambioEstado(antes);
      return { estadoLabel, nombre };
    }
  }
  return null;
}

function detectarIntencion(mensaje, sesion) {
  if (sesion.pendienteEscalamiento || sesion.pendienteBusqueda) return null;
  if (mensaje.startsWith('__')) return null; // ya es un comando literal
  // Normaliza errores de tipeo comunes ("ciente" por "cliente", etc.) antes
  // de comparar contra las frases, para que un typo no rompa la detección.
  const t = mensaje.trim().toLowerCase().replace(/\bciente\b/g, 'cliente');

  if (REGEX_ESCALAR_JURIDICO.test(t)) return '__escalar_juridico__';

  // Se revisa ANTES que "buscar cliente" porque frases como "cambia el
  // estado del cliente juan a cliente" también contienen "estado del
  // cliente", que REGEX_BUSCAR_CLIENTE reconocería como consulta de estado.
  if (detectarCambioEstado(mensaje)) return '__cambiar_estado__';

  if (REGEX_BUSCAR_CLIENTE.test(t)) return '__buscar_cliente__';

  if (sesion.estado === 'caso_abierto') {
    if (FRASES_RADICADO.some((f) => t.includes(f))) return '__radicado__';
    if (FRASES_NO_APLICA.some((f) => t.includes(f))) return '__no_aplica__';
  }

  // "Nuevo caso" puede llegar en CUALQUIER momento, incluso a mitad de
  // capturar los datos del caso anterior: si al asesor se le cayó la
  // llamada y ya está en otra con un cliente distinto, no tiene sentido
  // seguir insistiendo en los datos del que ya perdió.
  if (FRASES_NUEVO_CASO.some((f) => t.includes(f))) {
    return '__nuevo_caso__';
  }

  return null;
}

// Detecta si el mensaje es una duda/pregunta en vez de la respuesta directa
// al dato que se le está pidiendo. No basta con mirar si termina en "?": el
// asesor muchas veces escribe la duda sin signo de interrogación (ej. "el
// cliente me pregunta por la ley cual es"). También cubre pedidos de ayuda
// tipo "dime el script", "ayúdame con el guion", "qué le digo al cliente":
// antes estas frases no entraban aquí y Daniela las trataba como si fueran
// la respuesta al campo que estaba pidiendo, así que nunca llegaba a usar
// el SOP/objeciones/conocimiento cargado para responderlas.
const REGEX_PARECE_DUDA = /\?|pregunt|\bduda\b|no s[eé] qu[eé]|no s[eé] c[oó]mo|^(qu[eé]|c[oó]mo|cu[aá]l(es)?|cu[aá]ndo|d[oó]nde|por qu[eé]|cu[aá]nto|qui[eé]n)\b|\bscript\b|\bguion\b|\bguión\b|\blibreto\b|ay[uú]dame|necesito (ayuda|el script|saber)|qu[eé] le digo|c[oó]mo le (digo|respondo|explico)|explica(me)?|recu[eé]rdame|^dime (el|la|c[oó]mo|qu[eé])|env[ií]ame (el|la)/i;

function pareceDuda(mensaje) {
  return REGEX_PARECE_DUDA.test(mensaje.trim());
}

function campoActualDe(sesion) {
  if (sesion.pendienteEscalamiento) {
    const campos = CAMPOS.escalamiento_juridico;
    const campo = campos[sesion.pendienteEscalamiento.stepIndex];
    return campo ? campo.prompt : null;
  }
  if (sesion.estado === 'capturando_caso') {
    return CAMPOS.caso_nuevo[sesion.stepIndex]?.prompt ?? null;
  }
  if (sesion.estado === 'capturando_resultado') {
    return CAMPOS[sesion.tipo][sesion.stepIndex]?.prompt ?? null;
  }
  return null;
}

const MENSAJE_INICIAL =
  'Soy Daniela, tu asistente experta en beneficios tributarios por compra de ' +
  'vehículos eléctricos e híbridos 🙌. Solo cuéntame cómo vas y yo te voy guiando: ' +
  'dime algo como "tengo un cliente nuevo" en cuanto identifiques un caso, y arrancamos. ' +
  'Si no estás seguro de si ya atendimos antes a alguien, dime "ya fue atendido este cliente" ' +
  'o "buscar cliente" y te confirmo con nombre, cédula o placa antes de duplicar el caso. ' +
  'Mientras gestionas, escríbeme cualquier duda del proceso y te ayudo al toque.';

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// --- Enseñarle algo nuevo a Daniela (texto pegado o contenido de un
// documento .txt/.md leído por la extensión) ---
app.post('/api/conocimiento', async (req, res) => {
  try {
    const { texto, titulo, agregadoPor } = req.body || {};
    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'Falta el texto a enseñar' });
    }
    // Subido de 20.000 a 200.000 caracteres para que quepa el texto de un
    // Excel convertido a CSV (una hoja mediana puede pasar fácil de 20.000
    // caracteres). Si suben este número, actualicen también MAX_TEXTO en
    // sidepanel.js de la extensión para que el contador sea consistente.
    const MAX_TEXTO_CONOCIMIENTO = 200000;
    if (texto.length > MAX_TEXTO_CONOCIMIENTO) {
      return res.status(400).json({
        error: `El texto es muy largo (máx. ${MAX_TEXTO_CONOCIMIENTO.toLocaleString('es-CO')} caracteres). Divídelo en partes más cortas.`,
      });
    }
    const registro = await guardarConocimiento(titulo, texto.trim(), agregadoPor);
    await obtenerConocimientoTexto('', true); // refresca el caché de una vez
    res.json({ ok: true, id: registro.id });
  } catch (err) {
    console.error('Error guardando conocimiento:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// --- Carga en lote (ej. la guía de respuestas partida en ~78 entradas) ---
// Body: { entradas: [{titulo, texto}], agregadoPor: 'Guía V4', reemplazar: true }
// Con reemplazar=true se desactivan las entradas anteriores del mismo
// "agregadoPor", así se puede volver a cargar la guía sin duplicarla.
app.use('/api/conocimiento/lote', express.json({ limit: '10mb' }));
app.post('/api/conocimiento/lote', async (req, res) => {
  try {
    const { entradas, agregadoPor, reemplazar } = req.body || {};
    if (!Array.isArray(entradas) || entradas.length === 0) {
      return res.status(400).json({ error: 'Faltan las entradas a cargar' });
    }
    if (entradas.length > 1000) return res.status(400).json({ error: 'Máximo 1.000 entradas por lote' });
    const autor = (agregadoPor || '').toString().trim() || null;
    const filas = entradas
      .filter((e) => e && e.texto && String(e.texto).trim())
      .map((e) => ({ titulo: e.titulo ? String(e.titulo).slice(0, 200) : null, texto: String(e.texto).trim(), agregado_por: autor, activo: true }));
    if (filas.length === 0) return res.status(400).json({ error: 'Ninguna entrada tiene texto' });
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    let desactivadas = 0;
    if (reemplazar && autor) {
      const { data: prev, error: e1 } = await sb.from('conocimiento').update({ activo: false }).eq('agregado_por', autor).eq('activo', true).select('id');
      if (e1) throw e1;
      desactivadas = (prev || []).length;
    }
    const { error: e2 } = await sb.from('conocimiento').insert(filas);
    if (e2) throw e2;
    await obtenerConocimientoTexto('', true);
    res.json({ ok: true, cargadas: filas.length, desactivadas });
  } catch (err) {
    console.error('Error cargando conocimiento en lote:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// --- Ver qué se le ha enseñado a Daniela hasta ahora ---
app.get('/api/conocimiento', async (req, res) => {
  try {
    const entradas = await obtenerConocimientoReciente(50);
    res.json({ entradas, buscables: conocimientoCache.trozos.length, siempre: conocimientoCache.siempre.length });
  } catch (err) {
    console.error('Error listando conocimiento:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// Cuando un caso pasa a "Cliente", su carpeta de SharePoint se mueve de
// "00. En proceso" a su lugar definitivo. Es de mejor esfuerzo: si falla, no
// interrumpe a la asesora (se reintenta al sincronizar o al adjuntar algo).
async function moverCarpetaSiCliente(casoId) {
  try {
    if (!sharepointConfigurado() || !casoId) return;
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('id', casoId).maybeSingle();
    if (data && esClienteDefinitivo(data) && data.numero_identificacion && data.nombre_cliente) {
      await moverACliente(String(data.numero_identificacion).trim(), String(data.nombre_cliente).trim());
    }
  } catch (e) {
    console.error('No se pudo mover la carpeta de SharePoint:', e.message);
  }
}

// Mueve de una vez las carpetas de TODOS los clientes ya cerrados (lo usa el
// botón "Sincronizar carpetas" del panel). Es seguro repetirlo.
app.post('/api/sincronizar-carpetas', async (req, res) => {
  try {
    if (!sharepointConfigurado()) return res.status(503).json({ error: 'SharePoint no está configurado en el servidor.' });
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await sb.from('Perfilamiento_y_ventas_GLA').select('*').eq('estado_pipeline', 'Cliente').limit(500);
    if (error) throw error;
    const clientes = (data || []).filter((c) => esClienteDefinitivo(c) && c.numero_identificacion && c.nombre_cliente);
    let movidas = 0, sinCarpeta = 0, errores = 0;
    for (const c of clientes) {
      try {
        const r = await moverACliente(String(c.numero_identificacion).trim(), String(c.nombre_cliente).trim());
        if (r.movida) movidas++; else sinCarpeta++;
      } catch (e) { errores++; console.error('Sincronizar carpeta:', c.nombre_cliente, e.message); }
    }
    res.json({ ok: true, clientes: clientes.length, movidas, sinCarpeta, errores });
  } catch (err) {
    console.error('Error sincronizando carpetas:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// --- Adjuntar documentos del cliente (cédula, factura de compra, RUT,
// certificado UPME, soporte de pago) → carpeta "cédula - nombre" en SharePoint.
app.post('/api/adjuntar', async (req, res) => {
  try {
    const { sessionId, tipo, nombreArchivo, base64 } = req.body || {};
    if (!TIPOS_DOC[tipo]) return res.status(400).json({ error: 'Tipo de documento no válido.' });
    if (!base64) return res.status(400).json({ error: 'No llegó el archivo.' });
    if (!sharepointConfigurado()) {
      return res.status(503).json({ error: 'SharePoint todavía no está configurado en el servidor (faltan las variables de Microsoft).' });
    }
    const sesion = sesiones.get(sessionId);
    let datos = (sesion && sesion.data) || {};
    if (sesion && sesion.casoId) {
      try {
        const lista = await buscarCasoPorTermino(String(datos.numero_identificacion || datos.nombre_cliente || ''));
        const caso = Array.isArray(lista) ? lista.find((c) => String(c.id) === String(sesion.casoId)) : null;
        if (caso) datos = { ...caso, ...datos, estado_pipeline: caso.estado_pipeline, siguiente_paso: caso.siguiente_paso };
      } catch (e) { /* si falla, seguimos con lo de la sesión */ }
    }
    const cedula = String(datos.numero_identificacion || '').trim();
    const nombre = String(datos.nombre_cliente || '').trim();
    if (!cedula || !nombre) {
      return res.status(400).json({ error: 'Primero necesito el nombre y la cédula del cliente para crear su carpeta. Termina de registrarlos y vuelve a adjuntar.' });
    }
    // (Se quitó el bloqueo por "no tiene certificado UPME": si el asesor adjunta el certificado, es porque ya lo tiene.)
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'El archivo pesa más de 25 MB.' });
    const r = await subirDocumento({ cedula, nombre, tipo, nombreArchivo, buffer, esCliente: esClienteDefinitivo(datos) });
    res.json({
      ok: true,
      reply: `📎 Listo, guardé "${TIPOS_DOC[tipo]}" de ${nombre} en SharePoint, carpeta "${r.carpeta}".`,
      link: r.linkCarpeta || r.linkArchivo || null,
    });
  } catch (err) {
    console.error('Error adjuntando a SharePoint:', err);
    res.status(500).json({ error: 'No pude guardar el archivo en SharePoint. ' + (err.message || '') });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, asesor: asesorCrudo } = req.body || {};
    const asesor = asesorCrudo ? capitalizarNombrePropio(asesorCrudo) : asesorCrudo;
    let message = req.body && req.body.message;
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Falta sessionId o message' });
    }

    let sesion = sesiones.get(sessionId);
    if (!sesion) {
      sesion = nuevaSesion();
      sesiones.set(sessionId, sesion);
    }

    // --- Elegir un cliente de la lista de coincidencias ---
    const mElegir = message.trim().match(/^elegir\s+(\d+)\b/i);
    if (mElegir) {
      const elegido = (sesion.candidatosLista || [])[Number(mElegir[1]) - 1];
      if (!elegido) {
        return res.json({ reply: 'Ya no tengo esa lista a mano — dime "buscar cliente" y lo buscamos de nuevo.' });
      }
      sesion.candidatoRetomar = elegido;
      sesion.candidatosLista = null;
      return res.json({
        reply: formatearResultadosBusqueda([elegido], elegido.nombre_cliente || ''),
        opciones: ['Retomar este caso', 'Mismo cliente, otro vehículo'],
      });
    }

    // --- Cédula/NIT o placa suelta (o "cédula del cliente 123") fuera de la
    // captura de un caso: se busca directo, sin preguntar qué quiere hacer. ---
    {
      const enCaptura = /^capturando|^negociacion/.test(String(sesion.estado || ''));
      const m = message.trim();
      let terminoDirecto = null;
      if (!enCaptura) {
        if (/^\d{6,12}$/.test(m) || /^[a-z]{3}[-\s]?\d{2}[a-z0-9]$/i.test(m)) terminoDirecto = m;
        else {
          const mc = m.match(/(?:c[eé]dula|\bcc\b|\bnit\b|placa)\D{0,20}?([a-z0-9]{5,12})\s*$/i);
          if (mc && /\d/.test(mc[1])) terminoDirecto = mc[1];
        }
      }
      if (terminoDirecto) {
        try {
          const resultados = await buscarCasoPorTermino(terminoDirecto);
          if (resultados.length === 0) {
            return res.json({ reply: `No encontré ningún caso con "${terminoDirecto}". Si es un cliente nuevo, dime "tengo un cliente nuevo".`, opciones: ['Tengo un cliente nuevo', 'Buscar cliente'] });
          }
          const r = resolverBusqueda(sesion, terminoDirecto, resultados);
          return res.json(r.opciones ? { reply: r.reply, opciones: r.opciones } : { reply: r.reply });
        } catch (dbError) {
          return res.json({ reply: `No pude consultar la base de datos (${dbError.message}). Intenta de nuevo.` });
        }
      }
    }

    // --- Retomar un caso ya existente (botón que aparece cuando una
    // búsqueda encuentra exactamente un cliente): en vez de seguir pidiendo
    // datos para un caso nuevo (que duplicaría al cliente), cargamos lo que
    // el caso ya tiene y seguimos preguntando solo lo que falta.
    if (/^retomar este caso$/i.test(message.trim())) {
      const casoARetomar = sesion.candidatoRetomar;
      if (!casoARetomar) {
        return res.json({
          reply: 'Ya no tengo a mano ese caso para retomarlo — dime "buscar cliente" y lo buscamos de nuevo.',
        });
      }
      sesion.estado = 'capturando_caso';
      sesion.tipo = null;
      sesion.casoId = casoARetomar.id;
      sesion.data = datosDeCasoExistente(casoARetomar);
      sesion.stepIndex = siguienteIndicePendiente(CAMPOS.caso_nuevo, sesion.data);
      sesion.avisoDuplicadoMostrado = true;
      sesion.pendienteCierre = false;
      sesion.pendienteBusqueda = false;
      sesion.candidatoRetomar = null;
      const nombreRetomado = casoARetomar.nombre_cliente || 'este cliente';
      if (sesion.stepIndex < CAMPOS.caso_nuevo.length) {
        const siguienteRetomado = CAMPOS.caso_nuevo[sesion.stepIndex];
        return res.json(
          conOpciones(
            { reply: `✅ Retomamos el caso de ${nombreRetomado}. Sigamos completando lo que falta.\n\n${siguienteRetomado.prompt}` },
            siguienteRetomado
          )
        );
      }
      sesion.estado = 'caso_abierto';
      return res.json({
        reply: `El caso de ${nombreRetomado} ya tiene todos los datos completos (estado del pipeline: ${casoARetomar.estado_pipeline || 'sin definir'}). Pregúntame cualquier duda, o cuéntame cuando se radique o no aplique.`,
      });
    }

    // --- Mismo cliente, pero un vehículo (caso) distinto: se reutilizan sus
    // datos de contacto/identidad, pero se crea un caso NUEVO y aparte (no se
    // toca el caso ya existente), porque cada vehículo se gestiona con su
    // propio pipeline/negociación.
    if (/^mismo cliente,? otro veh[ií]culo$/i.test(message.trim())) {
      const casoBase = sesion.candidatoRetomar;
      if (!casoBase) {
        return res.json({
          reply: 'Ya no tengo a mano ese cliente — dime "buscar cliente" y lo buscamos de nuevo.',
        });
      }
      sesion.estado = 'capturando_caso';
      sesion.tipo = null;
      sesion.casoId = null;
      sesion.data = datosClienteExistente(casoBase);
      sesion.avisoDuplicadoMostrado = true;
      sesion.pendienteCierre = false;
      sesion.pendienteBusqueda = false;
      sesion.candidatoRetomar = null;
      const nombreCliente = casoBase.nombre_cliente || 'este cliente';

      let avisoGuardadoVehiculo = '';
      try {
        const registro = await crearCaso(sessionId, asesor, { ...sesion.data, estado_pipeline: 'Contacto' });
        sesion.casoId = registro.id;
        avisoGuardadoVehiculo = '✅ Ya quedó creado el caso nuevo para este vehículo (estado: Contacto), así que no se pierde aunque no completemos todo de una vez.\n\n';
      } catch (dbError) {
        console.error('Error creando el caso del segundo vehículo en Supabase:', dbError);
        avisoGuardadoVehiculo = `⚠️ No pude guardar el caso en la base de datos en este momento (${dbError.message}). Sigamos igual, pero avisa a soporte si esto se repite.\n\n`;
      }

      sesion.stepIndex = siguienteIndicePendiente(CAMPOS.caso_nuevo, sesion.data);
      if (sesion.stepIndex < CAMPOS.caso_nuevo.length) {
        const siguienteCampo = CAMPOS.caso_nuevo[sesion.stepIndex];
        return res.json(
          conOpciones(
            {
              reply: `${avisoGuardadoVehiculo}✅ Perfecto, abrimos un caso aparte para el vehículo nuevo de ${nombreCliente}. Ya tengo sus datos de contacto, así que sigamos solo con la información de este vehículo.\n\n${siguienteCampo.prompt}`,
            },
            siguienteCampo
          )
        );
      }
      sesion.estado = 'caso_abierto';
      return res.json({ reply: `${avisoGuardadoVehiculo}Listo, el caso del vehículo nuevo de ${nombreCliente} ya quedó completo.` });
    }

    // --- Detección dinámica: si el mensaje libre suena a un cambio de
    // estado ("tengo un cliente nuevo", "ya se radicó", etc.), lo tratamos
    // como si hubiera pulsado el botón correspondiente.
    const mensajeOriginal = message;
    const intencionDetectada = detectarIntencion(message, sesion);
    if (intencionDetectada) {
      message = intencionDetectada;
      req.body.message = intencionDetectada;
    }

    // --- Escalamiento a jurídico: disponible casi en cualquier momento ---
    if (message === '__escalar_juridico__') {
      sesion.pendienteEscalamiento = {
        stepIndex: 0,
        data: {},
        anterior: {
          estado: sesion.estado,
          tipo: sesion.tipo,
          stepIndex: sesion.stepIndex,
          data: sesion.data,
        },
      };
      const primerCampo = CAMPOS.escalamiento_juridico[0];
      return res.json(conOpciones({ reply: primerCampo.prompt }, primerCampo));
    }

    // --- Si hay un escalamiento en curso, todo mensaje libre va ahí ---
    if (sesion.pendienteEscalamiento) {
      const esc = sesion.pendienteEscalamiento;
      const campos = CAMPOS.escalamiento_juridico;
      const campo = campos[esc.stepIndex];

      const esDuda = pareceDuda(message);
      if (esDuda) {
        const conocimiento = await obtenerConocimientoTexto(message);
        const respuesta = await responderAyuda(
          SOP_TEXT,
          OBJECIONES_TEXT,
          message,
          {
            estado: 'escalamiento_juridico',
            campoActual: campo.prompt,
            datosCapturados: esc.data,
          },
          conocimiento
        );
        return res.json(conOpciones({ reply: `${respuesta}\n\n➡️ ${campo.prompt}` }, campo));
      }

      const resultadoCampo = validarYNormalizarCampo(campo, message);
      if (!resultadoCampo.ok) {
        return res.json(conOpciones({ reply: `⚠️ ${campo.errorMessage}\n\n${campo.prompt}` }, campo));
      }

      esc.data[campo.id] = resultadoCampo.valor;
      esc.stepIndex += 1;

      if (esc.stepIndex < campos.length) {
        const siguiente = campos[esc.stepIndex];
        return res.json(conOpciones({ reply: `✅ Anotado.\n\n${siguiente.prompt}` }, siguiente));
      }

      // Escalamiento completo: guardar y volver a donde estaba el asesor.
      try {
        await guardarEscalamientoJuridico(sessionId, asesor, sesion.casoId, esc.data);
      } catch (dbError) {
        console.error('Error guardando escalamiento:', dbError);
        return res.json({
          reply: `Se registraron los datos, pero hubo un error guardando el escalamiento: ${dbError.message}. Avisa a soporte técnico.`,
        });
      }

      const anterior = esc.anterior;
      sesion.estado = anterior.estado;
      sesion.tipo = anterior.tipo;
      sesion.stepIndex = anterior.stepIndex;
      sesion.data = anterior.data;
      sesion.pendienteEscalamiento = null;

      let mensajeRetomar = '✅ ¡Listo, quedó escalado a jurídico! Ya alguien del área correspondiente lo va a revisar. ';
      const campoPendiente = campoActualDe(sesion);
      if (campoPendiente) {
        mensajeRetomar += `Sigamos donde íbamos:\n\n${campoPendiente}`;
      } else if (sesion.estado === 'caso_abierto') {
        mensajeRetomar += 'Seguimos con el caso — cuéntame si hay otra duda o dime el resultado cuando lo sepas.';
      } else {
        mensajeRetomar += MENSAJE_INICIAL;
      }
      return res.json({ reply: mensajeRetomar });
    }

    // --- Cambiar el estado del pipeline comercial de un caso (Interesado,
    // Contacto, Cliente, Cierre perdido, En proceso UPME, En proceso DIAN,
    // Pendiente desembolso, Desembolso realizado) ---
    if (message === '__cambiar_estado__') {
      const cambio = detectarCambioEstado(mensajeOriginal);
      // No debería pasar (ya se validó en detectarIntencion), pero por si
      // acaso el mensaje cambió de forma entre medio.
      if (!cambio) {
        return res.json({
          reply: 'No logré identificar a qué estado quieres cambiarlo. Dime algo como "cambia el estado del cliente [nombre] a cliente".',
        });
      }

      let casoObjetivo = null;

      if (cambio.nombre) {
        try {
          const coincidencias = await buscarCasoPorTermino(cambio.nombre);
          if (coincidencias.length === 0) {
            return res.json({
              reply: `No encontré ningún caso registrado que coincida con "${cambio.nombre}", así que no pude cambiarle el estado. Revisa que el nombre esté bien escrito, o dime "tengo un cliente nuevo" si todavía no está registrado.`,
            });
          }
          if (coincidencias.length > 1) {
            return res.json({
              reply: `${formatearResultadosBusqueda(coincidencias, cambio.nombre)}\n\nHay más de un caso que coincide con "${cambio.nombre}" — dime la cédula/NIT o la placa exacta para saber cuál actualizar.`,
            });
          }
          casoObjetivo = coincidencias[0];
        } catch (dbError) {
          console.error('Error buscando cliente para cambiar estado:', dbError);
          return res.json({
            reply: `No pude consultar la base de datos en este momento (${dbError.message}). Intenta de nuevo en un momento.`,
          });
        }
      } else if (sesion.casoId) {
        casoObjetivo = { id: sesion.casoId, nombre_cliente: sesion.data?.nombre_cliente };
      } else {
        return res.json({
          reply: 'Dime de qué cliente quieres cambiar el estado (ej. "cambia el estado del cliente Juan Pérez a cliente").',
        });
      }

      try {
        await actualizarCaso(casoObjetivo.id, { estado_pipeline: cambio.estadoLabel });
        if (cambio.estadoLabel === 'Cliente') moverCarpetaSiCliente(casoObjetivo.id);
      } catch (dbError) {
        console.error('Error actualizando el estado del pipeline:', dbError);
        return res.json({
          reply: `No pude guardar el cambio de estado en este momento (${dbError.message}). Intenta de nuevo en un momento.`,
        });
      }

      let reply = `✅ Listo, actualicé el estado de ${casoObjetivo.nombre_cliente || 'ese caso'} a "${cambio.estadoLabel}".`;
      const campoPendienteCambio = campoActualDe(sesion);
      if (campoPendienteCambio) {
        reply += `\n\n➡️ Sigamos donde íbamos: ${campoPendienteCambio}`;
      }
      return res.json({ reply });
    }

    // --- Buscar si un cliente ya fue atendido antes / consultar el estado
    // de su caso (evitar duplicar, o simplemente responder "cómo va") ---
    if (message === '__buscar_cliente__') {
      // Si el asesor ya escribió el nombre en el mismo mensaje (ej.
      // "estado del caso del cliente michael barco"), buscamos de una vez en
      // vez de preguntarle otra vez un dato que ya dio.
      const terminoInline = extraerTerminoBusqueda(mensajeOriginal);
      if (terminoInline) {
        let reply;
        let opcionesBusqueda;
        try {
          const resultados = await buscarCasoPorTermino(terminoInline);
          const r = resolverBusqueda(sesion, terminoInline, resultados);
          reply = r.reply;
          opcionesBusqueda = r.opciones;
        } catch (dbError) {
          console.error('Error buscando cliente en Supabase:', dbError);
          reply = `No pude consultar la base de datos en este momento (${dbError.message}). Intenta de nuevo en un momento.`;
        }
        const campoPendienteInline = campoActualDe(sesion);
        if (campoPendienteInline) {
          reply += `\n\n➡️ Sigamos donde íbamos: ${campoPendienteInline}`;
        }
        return res.json(opcionesBusqueda ? { reply, opciones: opcionesBusqueda } : { reply });
      }
      sesion.pendienteBusqueda = true;
      return res.json({
        reply:
          'Claro, dime el nombre completo, la cédula/NIT o la placa del cliente y reviso si ya tiene un caso registrado.',
      });
    }

    if (sesion.pendienteBusqueda) {
      sesion.pendienteBusqueda = false;
      const termino = message.trim();
      let reply;
      let opcionesBusqueda;
      try {
        const resultados = await buscarCasoPorTermino(termino);
        const r = resolverBusqueda(sesion, termino, resultados);
        reply = r.reply;
        opcionesBusqueda = r.opciones;
      } catch (dbError) {
        console.error('Error buscando cliente en Supabase:', dbError);
        reply = `No pude consultar la base de datos en este momento (${dbError.message}). Intenta de nuevo en un momento.`;
      }
      const campoPendiente = campoActualDe(sesion);
      if (campoPendiente) {
        reply += `\n\n➡️ Sigamos donde íbamos: ${campoPendiente}`;
      }
      return res.json(opcionesBusqueda ? { reply, opciones: opcionesBusqueda } : { reply });
    }

    // --- Mensajes especiales ---

    if (message === '__inicio__') {
      const saludo = asesor ? `¡Hola, ${asesor}! ` : '¡Hola! ';
      return res.json({
        reply: `${saludo}${MENSAJE_INICIAL}`,
        opciones: ['Tengo un cliente nuevo', 'Buscar cliente'],
      });
    }

    if (message === '__nuevo_caso__') {
      sesion.estado = 'capturando_caso';
      sesion.tipo = null;
      sesion.stepIndex = 0;
      sesion.data = {};
      sesion.casoId = null;
      sesion.avisoDuplicadoMostrado = false;
      sesion.pendienteCierre = false;
      const primerCampo = CAMPOS.caso_nuevo[0];
      return res.json(conOpciones({ reply: primerCampo.prompt }, primerCampo));
    }

    if (message === '__radicado__' || message === '__no_aplica__') {
      if (sesion.estado !== 'caso_abierto') {
        return res.json({
          reply:
            'Antes de contarme el resultado, cuéntame que tienes un caso (dime algo como "tengo un cliente nuevo") para arrancar.',
        });
      }
      sesion.estado = 'capturando_resultado';
      sesion.tipo = message === '__radicado__' ? 'radicado' : 'no_aplica';
      sesion.stepIndex = 0;
      sesion.data = {};
      const primerCampo = CAMPOS[sesion.tipo][0];
      return res.json(conOpciones({ reply: primerCampo.prompt }, primerCampo));
    }

    // --- Captura de datos del caso nuevo ---
    if (sesion.estado === 'capturando_caso') {
      const campos = CAMPOS.caso_nuevo;
      const campo = campos[sesion.stepIndex];

      // El asesor está respondiendo a "¿quieres cerrar la interacción con
      // este cliente?" (esto solo se pregunta cuando "¿lograste el
      // contacto?" fue "No"). Se maneja aparte del flujo normal de campos
      // porque no es una pregunta de CAMPOS.caso_nuevo.
      // El asesor está respondiendo "¿Cuál es el nombre o razón social de la
      // empresa?" (esto solo se pregunta cuando el tipo de documento fue
      // NIT). Se maneja aparte del flujo normal de campos porque no es una
      // pregunta de CAMPOS.caso_nuevo: es un dato obligatorio derivado de
      // haber elegido NIT, no un campo saltable.
      if (sesion.pendienteNombreEmpresa) {
        const nombreEmpresaCrudo = message.trim();
        if (
          !nombreEmpresaCrudo ||
          nombreEmpresaCrudo.length < 2 ||
          normalizarTexto(nombreEmpresaCrudo).trim() === normalizarTexto(ETIQUETA_SALTAR).trim()
        ) {
          return res.json({
            reply:
              '⚠️ Escribe el nombre o razón social de la empresa (mínimo 2 caracteres) — este dato es obligatorio porque el cliente es persona jurídica (NIT).\n\n¿Cuál es el nombre o razón social de la empresa?',
          });
        }
        const nombreEmpresa = capitalizarNombrePropio(nombreEmpresaCrudo);
        sesion.data.nombre_empresa = nombreEmpresa;
        sesion.data.cuenta = nombreEmpresa;
        sesion.pendienteNombreEmpresa = false;

        if (sesion.casoId) {
          try {
            await actualizarCaso(sesion.casoId, { nombre_empresa: nombreEmpresa, cuenta: nombreEmpresa });
          } catch (dbError) {
            console.error('Error guardando el nombre de la empresa en Supabase:', dbError);
          }
        }

        sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);
        if (sesion.stepIndex < campos.length) {
          const siguienteTrasEmpresa = campos[sesion.stepIndex];
          return res.json(
            conOpciones({ reply: `✅ Anotado.\n\n${siguienteTrasEmpresa.prompt}` }, siguienteTrasEmpresa)
          );
        }
        // Caso raro: la empresa era el último dato que faltaba. Guardamos el
        // caso si aún no existía y arrancamos la confirmación de datos, igual
        // que al terminar el flujo normal de captura.
        if (!sesion.casoId) {
          try {
            const registro = await crearCaso(sessionId, asesor, sesion.data);
            sesion.casoId = registro.id;
          } catch (dbError) {
            console.error('Error guardando el caso en Supabase:', dbError);
            return res.json({
              reply: `Se capturaron todos los datos, pero hubo un error guardándolos en la base de datos: ${dbError.message}. Avisa a soporte técnico; tus datos no se perdieron:\n\n${resumenCampos(
                campos,
                sesion.data
              )}`,
            });
          }
        }
        // El caso ya tiene todos sus datos: el sistema lo categoriza solo
        // como "Interesado" (antes se quedaba pegado en "Contacto").
        try {
          await actualizarCaso(sesion.casoId, { estado_pipeline: 'Interesado' });
        } catch (dbError) {
          console.error('Error actualizando estado_pipeline a Interesado:', dbError);
        }
        sesion.estado = 'negociacion';
        sesion.negociacion = { gateIndex: 0, sub: 'confirmar_datos' };
        return res.json({
          reply: `✅ Caso completo:\n\n${resumenCampos(campos, sesion.data)}\n\n¿Estos datos están correctos, o necesitas modificar alguno?`,
          opciones: ['Están correctos', 'Modificar un dato'],
        });
      }

      // El asesor está respondiendo cuál es la línea/referencia exacta del
      // vehículo, porque lo que escribió antes coincidía igual contra varias
      // líneas distintas de la base (ver arriba). Se maneja aparte del flujo
      // normal porque no es una pregunta de CAMPOS.caso_nuevo.
      if (sesion.pendienteDesambiguarVehiculo) {
        const { candidatos } = sesion.pendienteDesambiguarVehiculo;
        const preguntaDesambiguar = construirPreguntaDesambiguarVehiculo(candidatos, asesor);

        // Si en vez de responder cuál línea es, el asesor aprovecha para
        // preguntar cualquier otra duda del proceso, se la resolvemos igual
        // que en cualquier otro punto del flujo y luego retomamos la
        // pregunta pendiente — no lo dejamos "atascado" teniendo que elegir
        // una línea antes de poder preguntar algo.
        if (pareceDuda(message)) {
          const conocimiento = await obtenerConocimientoTexto(message);
          const respuestaDuda = await responderAyuda(
            SOP_TEXT,
            OBJECIONES_TEXT,
            message,
            {
              estado: sesion.estado,
              campoActual: preguntaDesambiguar,
              datosCapturados: sesion.data,
            },
            conocimiento
          );
          return res.json({
            reply: `${respuestaDuda}\n\n➡️ ${preguntaDesambiguar}`,
            opciones: opcionesDesambiguarVehiculo(candidatos),
          });
        }

        const respuesta = (message || '').trim();

        // Ninguna de las líneas listadas es la correcta — el asesor prefiere
        // escribir la referencia completa de una vez, en vez de saltar
        // directo a preguntar la tecnología a mano. Con ese texto nuevo se
        // vuelve a intentar la búsqueda (puede salir un match único, puede
        // volver a quedar ambiguo con otras líneas, o puede no encontrarse).
        if (normalizarTexto(respuesta).trim() === normalizarTexto(ETIQUETA_OTRO_VEHICULO).trim()) {
          sesion.pendienteDesambiguarVehiculo = null;
          sesion.pendienteReferenciaVehiculo = true;
          return res.json({
            reply: 'Sin problema — escríbeme la referencia completa del vehículo (marca, línea y versión), tal como aparece en la factura o en la tarjeta de propiedad.',
          });
        }

        // El asesor no sabe cuál es la referencia/línea exacta — no lo
        // dejamos bloqueado por eso. Seguimos igual que cuando el vehículo no
        // se encuentra en la base: se pregunta la tecnología a mano y el
        // vehículo queda registrado como "no listado" para revisión.
        if (normalizarTexto(respuesta).trim() === normalizarTexto(ETIQUETA_SALTAR).trim()) {
          sesion.vehiculoSinListar = sesion.pendienteDesambiguarVehiculo.textoOriginal;
          sesion.pendienteDesambiguarVehiculo = null;
          sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);
          if (sesion.stepIndex < campos.length) {
            const siguienteTrasSaltar = campos[sesion.stepIndex];
            return res.json(
              conOpciones(
                {
                  reply: `De acuerdo, no hay problema — entonces cuéntame la tecnología a mano.\n\n${siguienteTrasSaltar.prompt}`,
                },
                siguienteTrasSaltar
              )
            );
          }
          // Caso raro: el vehículo era el último dato que faltaba.
          if (!sesion.casoId) {
            try {
              const registro = await crearCaso(sessionId, asesor, sesion.data);
              sesion.casoId = registro.id;
            } catch (dbError) {
              console.error('Error guardando el caso en Supabase:', dbError);
              return res.json({
                reply: `Se capturaron todos los datos, pero hubo un error guardándolos en la base de datos: ${dbError.message}. Avisa a soporte técnico; tus datos no se perdieron:\n\n${resumenCampos(
                  campos,
                  sesion.data
                )}`,
              });
            }
          }
          try {
            await actualizarCaso(sesion.casoId, { estado_pipeline: 'Interesado' });
          } catch (dbError) {
            console.error('Error actualizando estado_pipeline a Interesado:', dbError);
          }
          sesion.estado = 'negociacion';
          sesion.negociacion = { gateIndex: 0, sub: 'confirmar_datos' };
          return res.json({
            reply: `✅ Caso completo:\n\n${resumenCampos(campos, sesion.data)}\n\n¿Estos datos están correctos, o necesitas modificar alguno?`,
            opciones: ['Están correctos', 'Modificar un dato'],
          });
        }

        let elegido = null;

        const numero = parseInt(respuesta, 10);
        if (!isNaN(numero) && numero >= 1 && numero <= candidatos.length) {
          elegido = candidatos[numero - 1];
        } else {
          const respuestaNorm = normalizarParaComparar(respuesta);
          if (respuestaNorm) {
            elegido =
              candidatos.find((c) => normalizarParaComparar(c.modelo).includes(respuestaNorm)) ||
              candidatos.find((c) => respuestaNorm.includes(normalizarParaComparar(c.modelo)));
          }
        }

        if (!elegido) {
          return res.json({
            reply: `⚠️ No logré identificar cuál de estas líneas es.\n\n${preguntaDesambiguar}`,
            opciones: opcionesDesambiguarVehiculo(candidatos),
          });
        }

        sesion.data.tecnologia = elegido.tecnologia;
        sesion.data.vehiculo = `${elegido.marca} ${elegido.modelo}`;
        sesion.pendienteDesambiguarVehiculo = null;

        if (sesion.casoId) {
          try {
            await actualizarCaso(sesion.casoId, { vehiculo: sesion.data.vehiculo, tecnologia: sesion.data.tecnologia });
          } catch (dbError) {
            console.error('Error guardando la línea exacta del vehículo:', dbError);
          }
        }

        sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);
        if (sesion.stepIndex < campos.length) {
          const siguienteTrasVehiculo = campos[sesion.stepIndex];
          return res.json(
            conOpciones(
              {
                reply: `✅ Anotado como "${sesion.data.vehiculo}" (tecnología: ${elegido.tecnologia}).\n\n${siguienteTrasVehiculo.prompt}`,
              },
              siguienteTrasVehiculo
            )
          );
        }
        // Caso raro: el vehículo era el último dato que faltaba.
        if (!sesion.casoId) {
          try {
            const registro = await crearCaso(sessionId, asesor, sesion.data);
            sesion.casoId = registro.id;
          } catch (dbError) {
            console.error('Error guardando el caso en Supabase:', dbError);
            return res.json({
              reply: `Se capturaron todos los datos, pero hubo un error guardándolos en la base de datos: ${dbError.message}. Avisa a soporte técnico; tus datos no se perdieron:\n\n${resumenCampos(
                campos,
                sesion.data
              )}`,
            });
          }
        }
        try {
          await actualizarCaso(sesion.casoId, { estado_pipeline: 'Interesado' });
        } catch (dbError) {
          console.error('Error actualizando estado_pipeline a Interesado:', dbError);
        }
        sesion.estado = 'negociacion';
        sesion.negociacion = { gateIndex: 0, sub: 'confirmar_datos' };
        return res.json({
          reply: `✅ Caso completo:\n\n${resumenCampos(campos, sesion.data)}\n\n¿Estos datos están correctos, o necesitas modificar alguno?`,
          opciones: ['Están correctos', 'Modificar un dato'],
        });
      }

      // El asesor está escribiendo la referencia completa del vehículo,
      // porque en la desambiguación anterior le dio clic a "Otro". Se maneja
      // aparte del flujo normal porque no es una pregunta de CAMPOS.caso_nuevo:
      // con este texto nuevo se vuelve a intentar la búsqueda en la base de
      // referencia, igual que la primera vez que se captura el vehículo.
      if (sesion.pendienteReferenciaVehiculo) {
        if (pareceDuda(message)) {
          const conocimiento = await obtenerConocimientoTexto(message);
          const respuestaDuda = await responderAyuda(
            SOP_TEXT,
            OBJECIONES_TEXT,
            message,
            {
              estado: sesion.estado,
              campoActual: 'Escribe la referencia completa del vehículo',
              datosCapturados: sesion.data,
            },
            conocimiento
          );
          return res.json({
            reply: `${respuestaDuda}\n\n➡️ Escríbeme la referencia completa del vehículo (marca, línea y versión).`,
          });
        }

        const textoReferencia = (message || '').trim();
        if (textoReferencia.length < 3) {
          return res.json({
            reply: '⚠️ Escribe la referencia completa del vehículo (marca, línea y versión).',
          });
        }

        sesion.pendienteReferenciaVehiculo = false;
        let avisoReferencia = '';
        try {
          const referencia = await obtenerVehiculosReferenciaCacheada();
          const candidatos = buscarVehiculosEnReferencia(textoReferencia, referencia);
          if (candidatos.length === 1) {
            const encontrado = candidatos[0];
            sesion.data.tecnologia = encontrado.tecnologia;
            sesion.data.vehiculo = `${encontrado.marca} ${encontrado.modelo}`;
            avisoReferencia = `✅ Listo, encontré "${sesion.data.vehiculo}" en la base (tecnología: ${encontrado.tecnologia}), no hace falta preguntarla.\n\n`;
          } else if (candidatos.length > 1) {
            sesion.pendienteDesambiguarVehiculo = { candidatos, textoOriginal: textoReferencia };
            const preguntaOtraVez = construirPreguntaDesambiguarVehiculo(candidatos, asesor);
            return res.json({
              reply: preguntaOtraVez,
              opciones: opcionesDesambiguarVehiculo(candidatos),
            });
          } else {
            sesion.vehiculoSinListar = textoReferencia;
            sesion.data.vehiculo = textoReferencia;
          }
        } catch (err) {
          console.error('Error consultando la base de referencia de vehículos:', err);
          sesion.data.vehiculo = textoReferencia;
        }

        if (sesion.casoId) {
          try {
            const cambios = { vehiculo: sesion.data.vehiculo };
            if (sesion.data.tecnologia) cambios.tecnologia = sesion.data.tecnologia;
            await actualizarCaso(sesion.casoId, cambios);
          } catch (dbError) {
            console.error('Error guardando la referencia del vehículo:', dbError);
          }
        }

        sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);
        if (sesion.stepIndex < campos.length) {
          const siguienteTrasReferencia = campos[sesion.stepIndex];
          return res.json(
            conOpciones(
              { reply: `${avisoReferencia}✅ Anotado.\n\n${siguienteTrasReferencia.prompt}` },
              siguienteTrasReferencia
            )
          );
        }
        // Caso raro: el vehículo era el último dato que faltaba.
        if (!sesion.casoId) {
          try {
            const registro = await crearCaso(sessionId, asesor, sesion.data);
            sesion.casoId = registro.id;
          } catch (dbError) {
            console.error('Error guardando el caso en Supabase:', dbError);
            return res.json({
              reply: `Se capturaron todos los datos, pero hubo un error guardándolos en la base de datos: ${dbError.message}. Avisa a soporte técnico; tus datos no se perdieron:\n\n${resumenCampos(
                campos,
                sesion.data
              )}`,
            });
          }
        }
        try {
          await actualizarCaso(sesion.casoId, { estado_pipeline: 'Interesado' });
        } catch (dbError) {
          console.error('Error actualizando estado_pipeline a Interesado:', dbError);
        }
        sesion.estado = 'negociacion';
        sesion.negociacion = { gateIndex: 0, sub: 'confirmar_datos' };
        return res.json({
          reply: `${avisoReferencia}✅ Caso completo:\n\n${resumenCampos(campos, sesion.data)}\n\n¿Estos datos están correctos, o necesitas modificar alguno?`,
          opciones: ['Están correctos', 'Modificar un dato'],
        });
      }

      if (sesion.pendienteCierre) {
        const respuestaCierre = interpretarSiNo(message);
        if (!respuestaCierre) {
          return res.json({
            reply: '¿Quieres cerrar la interacción con este cliente?',
            opciones: ['Sí', 'No'],
          });
        }
        if (respuestaCierre === 'sí') {
          const nombreCerrado = sesion.data.nombre_cliente || 'el cliente';
          Object.assign(sesion, nuevaSesion());
          return res.json({
            reply: `✅ Listo, dejamos cerrada la interacción con ${nombreCerrado} — ya quedó guardado en la base de datos con estado "Contacto". Cuéntame cuando tengas otro cliente (dime "tengo un cliente nuevo") y arrancamos.`,
          });
        }
        // Sigue con las preguntas normales, desde donde iba.
        sesion.pendienteCierre = false;
        const siguienteCampo = campos[sesion.stepIndex];
        return res.json(conOpciones({ reply: `Listo, seguimos.\n\n${siguienteCampo.prompt}` }, siguienteCampo));
      }

      const esDuda = pareceDuda(message);
      if (esDuda) {
        const conocimiento = await obtenerConocimientoTexto(message);
        const respuesta = await responderAyuda(
          SOP_TEXT,
          OBJECIONES_TEXT,
          message,
          {
            estado: sesion.estado,
            campoActual: campo.prompt,
            datosCapturados: sesion.data,
          },
          conocimiento
        );
        return res.json(conOpciones({ reply: `${respuesta}\n\n➡️ ${campo.prompt}` }, campo));
      }

      const resultadoCampo = validarYNormalizarCampo(campo, message);
      if (!resultadoCampo.ok) {
        return res.json(conOpciones({ reply: `⚠️ ${campo.errorMessage}\n\n${campo.prompt}` }, campo));
      }

      sesion.data[campo.id] = resultadoCampo.valor;

      // Al responder el tipo de documento, derivamos solos si la cuenta es
      // "Persona natural" o "Empresa" (CC/CE/TI/Pasaporte -> Persona natural,
      // NIT -> Empresa), y también el nombre de cuenta unificado: para
      // persona natural es el nombre del cliente (ya lo tenemos); para
      // empresa lo pedimos aparte (ver sesion.pendienteNombreEmpresa más
      // abajo), porque el nombre de la empresa es un dato nuevo que el
      // cliente-persona-natural no tiene.
      if (campo.id === 'tipo_identificacion' && resultadoCampo.valor) {
        const esEmpresa = resultadoCampo.valor === 'NIT';
        sesion.data.tipo_cuenta = esEmpresa ? 'Empresa' : 'Persona natural';
        if (!esEmpresa) {
          sesion.data.cuenta = sesion.data.nombre_cliente || null;
        }
      }

      // Al capturar el vehículo, lo cruzamos contra la base de referencia de
      // vehículos que aplican. Si hay una sola línea que coincide, ya sabemos
      // la tecnología (nos ahorramos preguntarla) y además dejamos el dato
      // guardado con el nombre completo y correcto de la referencia (no el
      // texto suelto que haya escrito el asesor). Si el texto es ambiguo
      // (coincide igual contra varias líneas distintas, ej. "Toyota Corolla"
      // sin más detalle) le pedimos al asesor que precise cuál es, en vez de
      // adivinar. Si no coincide con nada, seguimos preguntando todo normal
      // (la base puede no estar completa) pero lo dejamos marcado para
      // avisar y registrar apenas se responda la tecnología.
      let avisoVehiculo = '';
      if (campo.id === 'vehiculo' && resultadoCampo.valor) {
        try {
          const referencia = await obtenerVehiculosReferenciaCacheada();
          const candidatos = buscarVehiculosEnReferencia(resultadoCampo.valor, referencia);
          if (candidatos.length === 1) {
            const encontrado = candidatos[0];
            sesion.data.tecnologia = encontrado.tecnologia;
            sesion.data.vehiculo = `${encontrado.marca} ${encontrado.modelo}`;
            avisoVehiculo = `✅ Ese modelo ya está en nuestra base de vehículos que aplican (tecnología: ${encontrado.tecnologia}). Lo dejamos anotado como "${sesion.data.vehiculo}" y no hace falta preguntar la tecnología.\n\n`;
          } else if (candidatos.length > 1) {
            sesion.pendienteDesambiguarVehiculo = { candidatos, textoOriginal: resultadoCampo.valor };
          } else {
            sesion.vehiculoSinListar = resultadoCampo.valor;
          }
        } catch (err) {
          console.error('Error consultando la base de referencia de vehículos:', err);
        }
      }

      // Cuando la tecnología queda capturada (a mano, porque el vehículo no
      // estaba en la base) dejamos el aviso y registramos el vehículo como
      // "no listado" para poder revisarlo después y, si aplica, agregarlo a
      // la base de referencia.
      if (campo.id === 'tecnologia' && sesion.vehiculoSinListar) {
        avisoVehiculo =
          `⚠️ Este vehículo todavía no está en nuestra base de referencia — confirma bien que SÍ aplica al beneficio antes de continuar. Queda registrado para revisión.\n\n`;
        try {
          await guardarVehiculoNoListado(sesion.casoId, sesion.vehiculoSinListar, resultadoCampo.valor, asesor);
        } catch (err) {
          console.error('Error guardando vehículo no listado:', err);
        }
        sesion.vehiculoSinListar = null;
      }

      sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);

      // Verificación automática de duplicados: apenas se captura el nombre,
      // la cédula/NIT o la placa, revisamos si ya existe un caso con ese
      // dato — así el asesor no tiene que acordarse de decir una frase
      // especial para consultarlo, se hace solo dentro del flujo normal.
      // Se avisa una sola vez por sesión para no repetir el aviso en cada
      // campo si el mismo cliente coincide en varios (nombre, cédula, placa).
      let avisoDuplicado = '';
      if (
        resultadoCampo.valor &&
        !sesion.avisoDuplicadoMostrado &&
        ['nombre_cliente', 'numero_identificacion', 'placa'].includes(campo.id)
      ) {
        try {
          const coincidencias = await buscarCasoPorTermino(resultadoCampo.valor);
          if (coincidencias.length > 0) {
            sesion.avisoDuplicadoMostrado = true;
            avisoDuplicado = `${formatearResultadosBusqueda(coincidencias, resultadoCampo.valor)}\n\nSi es el mismo cliente, mejor retoma ese caso en vez de crear uno nuevo (dime "buscar cliente" en cualquier momento si quieres revisarlo primero). Si de verdad es una gestión nueva, seguimos con los datos.\n\n`;
          }
        } catch (dbError) {
          console.error('Error verificando duplicados:', dbError);
          // No bloqueamos la captura si falla la verificación — seguimos igual.
        }
      }

      // En cuanto se responde si se logró el contacto, ya creamos el caso en
      // Supabase — así, aunque después se caiga la llamada o no se alcance a
      // llenar todo lo demás, el cliente NO se pierde: ya quedó guardado en
      // la base de datos. El sistema categoriza solo: si NO se logró el
      // contacto, el caso queda como "Registro" (no como "Contacto", que es
      // solo para cuando sí se habló con el cliente).
      let avisoGuardado = '';
      if (campo.id === 'contacto_logrado' && !sesion.casoId) {
        try {
          const estadoInicial = resultadoCampo.valor === 'No' ? 'Registro' : 'Contacto';
          const registro = await crearCaso(sessionId, asesor, { ...sesion.data, estado_pipeline: estadoInicial });
          sesion.casoId = registro.id;
          avisoGuardado =
            `✅ Ya quedó guardado en la base de datos (estado: ${estadoInicial}), así que aunque no alcancemos a completar todo, no se pierde.\n\n`;
        } catch (dbError) {
          console.error('Error creando el caso en Supabase (paso de contacto):', dbError);
          avisoGuardado = `⚠️ No pude guardar el caso en la base de datos en este momento (${dbError.message}). Sigamos igual, pero avisa a soporte si esto se repite.\n\n`;
        }
      } else if (sesion.casoId) {
        // El caso ya existe (se creó en el paso de "contacto_logrado"): cada
        // dato nuevo se va guardando de una vez, en vez de esperar a que se
        // complete todo el formulario.
        try {
          // Para vehículo guardamos sesion.data.vehiculo (no
          // resultadoCampo.valor): si hubo un match único contra la base de
          // referencia, ya quedó normalizado con el nombre completo y
          // correcto de la línea (ver arriba); si no, es el mismo texto que
          // escribió el asesor.
          const cambiosIncrementales = {
            [campo.id]: campo.id === 'vehiculo' ? sesion.data.vehiculo : resultadoCampo.valor,
          };
          if (campo.id === 'tipo_identificacion' && resultadoCampo.valor) {
            cambiosIncrementales.tipo_cuenta = sesion.data.tipo_cuenta;
            if (sesion.data.cuenta !== undefined) cambiosIncrementales.cuenta = sesion.data.cuenta;
          }
          // Si el vehículo se encontró en la base de referencia, la
          // tecnología quedó autocompletada en el mismo paso (ver arriba) y
          // ese campo se salta — así que la guardamos ya mismo, de una vez
          // con el vehículo, para que no falte en Supabase.
          if (campo.id === 'vehiculo' && sesion.data.tecnologia) {
            cambiosIncrementales.tecnologia = sesion.data.tecnologia;
          }
          await actualizarCaso(sesion.casoId, cambiosIncrementales);
        } catch (dbError) {
          console.error(`Error actualizando el campo ${campo.id} en Supabase:`, dbError);
          // No bloqueamos el flujo si falla un guardado incremental.
        }
      }

      // Si el vehículo que escribió el asesor coincide igual contra varias
      // líneas distintas de la base (ambiguo), no seguimos con las preguntas
      // normales todavía: primero pedimos que confirme cuál es la
      // referencia/línea exacta, para no adivinar y dejar un dato mal
      // parametrizado.
      if (sesion.pendienteDesambiguarVehiculo) {
        const preguntaDesambiguarInicial = construirPreguntaDesambiguarVehiculo(
          sesion.pendienteDesambiguarVehiculo.candidatos,
          asesor
        );
        return res.json({
          reply: `${avisoDuplicado}${avisoGuardado}${preguntaDesambiguarInicial}`,
          opciones: opcionesDesambiguarVehiculo(sesion.pendienteDesambiguarVehiculo.candidatos),
        });
      }

      // Si NO se logró el contacto, le preguntamos al asesor si de una vez
      // quiere cerrar la interacción con este cliente (ya quedó guardado
      // como "Contacto") o si prefiere seguir con las demás preguntas.
      if (campo.id === 'contacto_logrado' && resultadoCampo.valor === 'No') {
        sesion.pendienteCierre = true;
        return res.json({
          reply: `${avisoDuplicado}${avisoGuardado}${avisoVehiculo}¿Quieres cerrar la interacción con este cliente?`,
          opciones: ['Sí', 'No'],
        });
      }

      // Si el tipo de documento es NIT, el cliente es persona jurídica y
      // necesitamos el nombre/razón social de la empresa antes de seguir
      // (ese dato no existe todavía y es obligatorio para este tipo de
      // cliente).
      if (campo.id === 'tipo_identificacion' && resultadoCampo.valor === 'NIT') {
        sesion.pendienteNombreEmpresa = true;
        return res.json({
          reply: `${avisoDuplicado}${avisoGuardado}${avisoVehiculo}✅ Anotado.\n\n¿Cuál es el nombre o razón social de la empresa?`,
        });
      }

      if (sesion.stepIndex < campos.length) {
        const siguiente = campos[sesion.stepIndex];
        return res.json(conOpciones({ reply: `${avisoDuplicado}${avisoGuardado}${avisoVehiculo}✅ Anotado.\n\n${siguiente.prompt}` }, siguiente));
      }

      // Caso completo. Si ya se creó antes (en el paso de contacto), solo
      // falta cerrar el estado local — los datos ya se fueron guardando
      // incrementalmente. Si por algo no existiera todavía (no debería
      // pasar), lo creamos aquí como respaldo.
      if (!sesion.casoId) {
        try {
          const registro = await crearCaso(sessionId, asesor, sesion.data);
          sesion.casoId = registro.id;
        } catch (dbError) {
          console.error('Error guardando el caso en Supabase:', dbError);
          return res.json({
            reply: `Se capturaron todos los datos, pero hubo un error guardándolos en la base de datos: ${dbError.message}. Avisa a soporte técnico; tus datos no se perdieron:\n\n${resumenCampos(
              campos,
              sesion.data
            )}`,
          });
        }
      }

      // El caso ya tiene todos sus datos: el sistema lo categoriza solo
      // como "Interesado" (antes se quedaba pegado en "Contacto").
      try {
        await actualizarCaso(sesion.casoId, { estado_pipeline: 'Interesado' });
      } catch (dbError) {
        console.error('Error actualizando estado_pipeline a Interesado:', dbError);
      }

      // Antes de arrancar las preguntas de negociación, le mostramos al
      // asesor el resumen completo y le preguntamos si todo está correcto o
      // si necesita corregir algún dato — así no toca escalar a soporte por
      // un error de tipeo que se pudo arreglar ahí mismo.
      sesion.estado = 'negociacion';
      sesion.negociacion = { gateIndex: 0, sub: 'confirmar_datos' };
      return res.json({
        reply:
          `${avisoDuplicado}${avisoGuardado}${avisoVehiculo}✅ Caso completo:\n\n${resumenCampos(campos, sesion.data)}\n\n` +
          `¿Estos datos están correctos, o necesitas modificar alguno?`,
        opciones: ['Están correctos', 'Modificar un dato'],
      });
    }

    // --- Preguntas de negociación (estado de interés, negociación, cliente
    // acepta todo), una detrás de otra, una vez el caso ya tiene todos sus
    // datos. Cada una es un gate Sí/No: si es "No", pide el motivo con
    // botones y luego pregunta si cerrar la interacción; si cierra, marca el
    // caso como "Cierre perdido" (salvo el gate negociacion: Lo pensará etc.
    // deja el caso en "Negociación", no perdido). Si es "Sí", sigue con la siguiente
    // pregunta (la última, "Cliente acepta todo", en vez de eso pide el
    // siguiente paso).
    if (sesion.estado === 'negociacion' && sesion.negociacion) {
      const neg = sesion.negociacion;
      const gate = GATES_NEGOCIACION[neg.gateIndex];

      if (neg.sub === 'confirmar_datos') {
        const camposConfirmar = CAMPOS.caso_nuevo;
        const entradaConfirmar = normalizarTexto(message).trim();
        if (entradaConfirmar === normalizarTexto('Están correctos').trim() || interpretarSiNo(message) === 'sí') {
          neg.sub = 'pregunta';
          return res.json({ reply: `➡️ ${gate.pregunta}`, opciones: OPCIONES_GATE_PREGUNTA });
        }
        if (entradaConfirmar === normalizarTexto('Modificar un dato').trim()) {
          const etiquetasConfirmar = camposConfirmar
            .map((c) => c.label)
            .concat(sesion.data.nombre_empresa !== undefined ? ['Nombre de la empresa'] : []);
          neg.sub = 'pidiendo_campo_modificar';
          return res.json({ reply: '¿Cuál dato quieres corregir?', opciones: etiquetasConfirmar });
        }
        return res.json({
          reply: '⚠️ Selecciona una opción.',
          opciones: ['Están correctos', 'Modificar un dato'],
        });
      }

      if (neg.sub === 'pidiendo_campo_modificar') {
        const camposMod = CAMPOS.caso_nuevo;
        const etiquetasMod = camposMod
          .map((c) => c.label)
          .concat(sesion.data.nombre_empresa !== undefined ? ['Nombre de la empresa'] : []);
        const entradaMod = normalizarTexto(message).trim();
        const esEmpresaEspecial = entradaMod === normalizarTexto('Nombre de la empresa').trim();
        const campoAModificar = esEmpresaEspecial
          ? null
          : camposMod.find((c) => normalizarTexto(c.label).trim() === entradaMod);
        if (!campoAModificar && !esEmpresaEspecial) {
          return res.json({ reply: '⚠️ Selecciona uno de los datos de la lista.', opciones: etiquetasMod });
        }
        neg.campoModificando = esEmpresaEspecial ? '__nombre_empresa__' : campoAModificar.id;
        neg.sub = 'pidiendo_valor_modificar';
        if (esEmpresaEspecial) {
          return res.json({ reply: '¿Cuál es el nombre o razón social correcto de la empresa?' });
        }
        return res.json(conOpciones({ reply: campoAModificar.prompt }, campoAModificar));
      }

      if (neg.sub === 'pidiendo_valor_modificar') {
        const camposVal = CAMPOS.caso_nuevo;
        if (neg.campoModificando === '__nombre_empresa__') {
          const nuevoNombreCrudo = message.trim();
          if (!nuevoNombreCrudo || nuevoNombreCrudo.length < 2) {
            return res.json({ reply: '⚠️ Escribe el nombre o razón social de la empresa (mínimo 2 caracteres).' });
          }
          const nuevoNombre = capitalizarNombrePropio(nuevoNombreCrudo);
          sesion.data.nombre_empresa = nuevoNombre;
          sesion.data.cuenta = nuevoNombre;
          if (sesion.casoId) {
            try {
              await actualizarCaso(sesion.casoId, { nombre_empresa: nuevoNombre, cuenta: nuevoNombre });
            } catch (dbError) {
              console.error('Error corrigiendo el nombre de la empresa en Supabase:', dbError);
            }
          }
        } else {
          const campoMod = camposVal.find((c) => c.id === neg.campoModificando);
          const resultadoMod = validarYNormalizarCampo(campoMod, message);
          if (!resultadoMod.ok) {
            return res.json(conOpciones({ reply: `⚠️ ${campoMod.errorMessage}\n\n${campoMod.prompt}` }, campoMod));
          }
          sesion.data[campoMod.id] = resultadoMod.valor;
          // Si se corrige el tipo de documento, recalculamos tipo_cuenta y,
          // si aplica (persona natural), el nombre de cuenta unificado.
          if (campoMod.id === 'tipo_identificacion' && resultadoMod.valor) {
            const esEmpresaMod = resultadoMod.valor === 'NIT';
            sesion.data.tipo_cuenta = esEmpresaMod ? 'Empresa' : 'Persona natural';
            if (!esEmpresaMod) sesion.data.cuenta = sesion.data.nombre_cliente || null;
          }
          if (campoMod.id === 'nombre_cliente' && sesion.data.tipo_cuenta === 'Persona natural') {
            sesion.data.cuenta = resultadoMod.valor;
          }
          if (sesion.casoId) {
            try {
              const cambiosMod = { [campoMod.id]: resultadoMod.valor };
              if (campoMod.id === 'tipo_identificacion') cambiosMod.tipo_cuenta = sesion.data.tipo_cuenta;
              if (
                (campoMod.id === 'tipo_identificacion' || campoMod.id === 'nombre_cliente') &&
                sesion.data.cuenta !== undefined
              ) {
                cambiosMod.cuenta = sesion.data.cuenta;
              }
              await actualizarCaso(sesion.casoId, cambiosMod);
            } catch (dbError) {
              console.error(`Error corrigiendo el campo ${campoMod.id} en Supabase:`, dbError);
            }
          }
        }

        neg.sub = 'confirmar_datos';
        neg.campoModificando = null;
        return res.json({
          reply: `✅ Corregido.\n\n${resumenCampos(camposVal, sesion.data)}\n\n¿Estos datos están correctos, o necesitas modificar otro?`,
          opciones: ['Están correctos', 'Modificar un dato'],
        });
      }

      if (neg.sub === 'pregunta') {
        if (esCerrarInteraccion(message)) {
          const nombreCerrado = sesion.data.nombre_cliente || 'el cliente';
          Object.assign(sesion, nuevaSesion());
          return res.json({
            reply: `✅ Listo, guardé la interacción con ${nombreCerrado} tal como está — ya quedó en la base de datos, no se pierde nada. Cuéntame cuando el cliente vuelva a responder o tengas otro caso.`,
          });
        }
        const respuesta = interpretarSiNo(message);
        if (!respuesta) {
          return res.json({ reply: gate.pregunta, opciones: OPCIONES_GATE_PREGUNTA });
        }
        if (respuesta === 'sí') {
          // El sistema categoriza solo: en cuanto el cliente confirma que
          // sigue interesado (o acepta en cualquiera de las 3 preguntas),
          // el caso pasa a "Negociación" — sin que el asesor tenga que
          // cambiarlo a mano en el desplegable.
          if (sesion.casoId) {
            try {
              await actualizarCaso(sesion.casoId, { estado_pipeline: 'Negociación' });
            } catch (dbError) {
              console.error('Error actualizando estado_pipeline a Negociación:', dbError);
            }
          }
          if (gate.siguientePasoOpciones) {
            neg.sub = 'siguiente_paso';
            return res.json({
              reply: '¡Excelente! ¿Cuál es el siguiente paso con este cliente?',
              opciones: gate.siguientePasoOpciones,
            });
          }
          neg.gateIndex += 1;
          neg.sub = 'pregunta';
          const siguienteGate = GATES_NEGOCIACION[neg.gateIndex];
          return res.json({ reply: `Listo.\n\n➡️ ${siguienteGate.pregunta}`, opciones: OPCIONES_GATE_PREGUNTA });
        }
        neg.sub = 'motivo';
        return res.json({ reply: '¿Cuál es el motivo?', opciones: gate.motivos });
      }

      if (neg.sub === 'motivo') {
        const entrada = normalizarTexto(message).trim();
        const motivo = gate.motivos.find((m) => normalizarTexto(m).trim() === entrada);
        if (!motivo) {
          return res.json({ reply: '⚠️ Selecciona uno de los motivos.', opciones: gate.motivos });
        }
        if (sesion.casoId) {
          try {
            // El sistema categoriza solo: en cuanto se responde "No" a
            // cualquiera de las 3 preguntas de negociación, el caso ya queda
            // como "Cierre perdido" — sin esperar a que además confirmen
            // que quieren cerrar la interacción ahora mismo.
            // OJO: "Lo pensará / Pide volver a llamar / Va a consultar un
            // tercero" (gate negociacion) NO es una pérdida: el cliente sigue
            // en la fase Negociación. Solo se marca Cierre perdido en los
            // gates interes y acepta.
            const campos = { [gate.motivoCampo]: motivo };
            campos.estado_pipeline = gate.id === 'negociacion' ? 'Negociación' : 'Cierre perdido';
            await actualizarCaso(sesion.casoId, campos);
          } catch (dbError) {
            console.error(`Error guardando ${gate.motivoCampo} en Supabase:`, dbError);
          }
        }
        if (gate.id === 'negociacion') {
          // No se pregunta por cerrar: el caso sigue vivo en Interesado.
          sesion.estado = 'caso_abierto';
          sesion.negociacion = null;
          return res.json({ reply: `Listo, el cliente sigue en "Negociación" (${motivo}). No se marca como perdido; seguimos gestionando este caso.` });
        }
        neg.sub = 'cierre';
        return res.json({ reply: '¿Quieres cerrar la interacción con este cliente?', opciones: ['Sí', 'No'] });
      }

      if (neg.sub === 'cierre') {
        const respuesta = interpretarSiNo(message);
        if (!respuesta) {
          return res.json({ reply: '¿Quieres cerrar la interacción con este cliente?', opciones: ['Sí', 'No'] });
        }
        if (respuesta === 'sí') {
          neg.sub = 'completitud';
          return res.json({
            reply: '¿La información del caso quedó completa, o queda pendiente algún dato?',
            opciones: ['Información completa', 'Pendiente de información'],
          });
        }
        // No cierra: sigue con la siguiente pregunta igual.
        neg.gateIndex += 1;
        neg.sub = 'pregunta';
        if (neg.gateIndex >= GATES_NEGOCIACION.length) {
          sesion.estado = 'caso_abierto';
          sesion.negociacion = null;
          return res.json({ reply: 'Listo, seguimos gestionando este caso.' });
        }
        const siguienteGate = GATES_NEGOCIACION[neg.gateIndex];
        return res.json({ reply: `Listo, seguimos.\n\n➡️ ${siguienteGate.pregunta}`, opciones: OPCIONES_GATE_PREGUNTA });
      }

      if (neg.sub === 'completitud') {
        const opcionesCompletitud = ['Información completa', 'Pendiente de información'];
        const entrada = normalizarTexto(message).trim();
        const match = opcionesCompletitud.find((o) => normalizarTexto(o).trim() === entrada);
        if (!match) {
          return res.json({
            reply: '⚠️ Selecciona una opción.',
            opciones: opcionesCompletitud,
          });
        }
        const nombreCerrado = sesion.data.nombre_cliente || 'el cliente';
        if (sesion.casoId) {
          try {
            await actualizarCaso(sesion.casoId, { estado_pipeline: 'Cierre perdido', info_completa: match });
          } catch (dbError) {
            console.error('Error cerrando la negociación en Supabase:', dbError);
          }
        }
        Object.assign(sesion, nuevaSesion());
        return res.json({
          reply: `✅ Listo, dejamos cerrada la interacción con ${nombreCerrado} — quedó como "Cierre perdido" (${match}). Cuéntame cuando tengas otro cliente (dime "tengo un cliente nuevo") y arrancamos.`,
        });
      }

      if (neg.sub === 'siguiente_paso') {
        const opcionesSiguientePaso = gate.siguientePasoOpciones;
        const entrada = normalizarTexto(message).trim();
        const match = opcionesSiguientePaso.find((o) => normalizarTexto(o).trim() === entrada);
        if (!match) {
          return res.json({
            reply: '⚠️ Selecciona una opción.',
            opciones: opcionesSiguientePaso,
          });
        }
        if (sesion.casoId) {
          try {
            const cambiosPaso = { siguiente_paso: match };
            // Si ya se ejecutó todo el proceso, el sistema categoriza el
            // caso solo como "Cliente" (documentos, firma y pago listos).
            if (match === 'Proceso completado') cambiosPaso.estado_pipeline = 'Cliente';
            await actualizarCaso(sesion.casoId, cambiosPaso);
            if (match === 'Proceso completado') moverCarpetaSiCliente(sesion.casoId);
          } catch (dbError) {
            console.error('Error guardando el siguiente paso en Supabase:', dbError);
          }
        }
        if (gate.servicioOpciones) {
          neg.sub = 'servicio_contratado';
          return res.json({
            reply: `✅ Anotado: "${match}".\n\n¿Cuál es el servicio contratado?`,
            opciones: gate.servicioOpciones,
          });
        }
        sesion.estado = 'caso_abierto';
        sesion.negociacion = null;
        return res.json({
          reply: `✅ Excelente, quedó registrado: "${match}". Sigamos gestionando: cuéntame cuando el caso se radique (dime algo como "ya se radicó") o si al final no aplicó (dime "no aplica" y el motivo).`,
        });
      }

      if (neg.sub === 'servicio_contratado') {
        const opcionesServicio = gate.servicioOpciones;
        const entrada = normalizarTexto(message).trim();
        const match = opcionesServicio.find((o) => normalizarTexto(o).trim() === entrada);
        if (!match) {
          return res.json({
            reply: '⚠️ Selecciona una opción.',
            opciones: opcionesServicio,
          });
        }
        if (sesion.casoId) {
          try {
            await actualizarCaso(sesion.casoId, { servicio_contratado: match });
          } catch (dbError) {
            console.error('Error guardando el servicio contratado en Supabase:', dbError);
          }
        }
        neg.sub = 'escalar';
        return res.json({
          reply: `✅ Anotado el servicio: "${match}".\n\n¿Cómo quedan los documentos para escalar este caso?`,
          opciones: OPCIONES_ESCALAR_DOCUMENTOS,
        });
      }

      if (neg.sub === 'escalar') {
        const entrada = normalizarTexto(message).trim();
        const match = OPCIONES_ESCALAR_DOCUMENTOS.find((o) => normalizarTexto(o).trim() === entrada);
        if (!match) {
          return res.json({
            reply: '⚠️ Selecciona una opción.',
            opciones: OPCIONES_ESCALAR_DOCUMENTOS,
          });
        }
        if (sesion.casoId) {
          try {
            await actualizarCaso(sesion.casoId, { escalamiento_documentos: match });
          } catch (dbError) {
            console.error('Error guardando el escalamiento de documentos en Supabase:', dbError);
          }
        }
        neg.sub = 'cierre_final';
        return res.json({
          reply: `✅ Anotado: "${match}".\n\n¿Quieres cerrar la interacción con este cliente?`,
          opciones: ['Sí', 'No'],
        });
      }

      if (neg.sub === 'cierre_final') {
        const respuesta = interpretarSiNo(message);
        if (!respuesta) {
          return res.json({ reply: '¿Quieres cerrar la interacción con este cliente?', opciones: ['Sí', 'No'] });
        }
        const nombreCerrado = sesion.data.nombre_cliente || 'el cliente';
        sesion.estado = 'caso_abierto';
        sesion.negociacion = null;
        if (respuesta === 'sí') {
          Object.assign(sesion, nuevaSesion());
          return res.json({
            reply: `✅ Listo, dejamos cerrada la interacción con ${nombreCerrado}. Cuéntame cuando tengas otro cliente (dime "tengo un cliente nuevo") y arrancamos.`,
          });
        }
        return res.json({
          reply: `Listo, seguimos gestionando el caso de ${nombreCerrado}: cuéntame cuando se radique (dime algo como "ya se radicó") o si al final no aplicó (dime "no aplica" y el motivo).`,
        });
      }
    }

    // --- Captura del resultado final (radicado / no_aplica) ---
    if (sesion.estado === 'capturando_resultado') {
      const campos = CAMPOS[sesion.tipo];
      const campo = campos[sesion.stepIndex];

      const esDuda = pareceDuda(message);
      if (esDuda) {
        const conocimiento = await obtenerConocimientoTexto(message);
        const respuesta = await responderAyuda(
          SOP_TEXT,
          OBJECIONES_TEXT,
          message,
          {
            estado: sesion.estado,
            campoActual: campo.prompt,
            datosCapturados: sesion.data,
          },
          conocimiento
        );
        return res.json(conOpciones({ reply: `${respuesta}\n\n➡️ ${campo.prompt}` }, campo));
      }

      const resultadoCampo = validarYNormalizarCampo(campo, message);
      if (!resultadoCampo.ok) {
        return res.json(conOpciones({ reply: `⚠️ ${campo.errorMessage}\n\n${campo.prompt}` }, campo));
      }

      sesion.data[campo.id] = resultadoCampo.valor;
      sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);

      if (sesion.stepIndex < campos.length) {
        const siguiente = campos[sesion.stepIndex];
        return res.json(conOpciones({ reply: `✅ Anotado.\n\n${siguiente.prompt}` }, siguiente));
      }

      try {
        if (sesion.casoId) {
          if (sesion.tipo === 'radicado') {
            await actualizarCaso(sesion.casoId, {
              resultado: 'radicado',
              numero_radicado_dian: sesion.data.numero_radicado_dian || null,
              seccional: sesion.data.seccional || null,
              observaciones: sesion.data.observaciones || null,
            });
          } else {
            await actualizarCaso(sesion.casoId, {
              resultado: 'no_aplica',
              motivo_no_aplica: sesion.data.motivo_no_aplica || null,
              observaciones: sesion.data.observaciones || null,
            });
          }
        }
      } catch (dbError) {
        console.error('Error actualizando el caso en Supabase:', dbError);
        return res.json({
          reply: `Se capturaron todos los datos, pero hubo un error guardándolos en la base de datos: ${dbError.message}. Avisa a soporte técnico; tus datos no se perdieron:\n\n${resumenCampos(
            campos,
            sesion.data
          )}`,
          saved: false,
        });
      }

      sesion.estado = 'finalizado';
      const tituloResumen = sesion.tipo === 'radicado' ? '🎉 Caso radicado' : 'Caso cerrado sin continuar';
      return res.json({
        reply: `✅ ${tituloResumen}. Estos son los datos capturados:\n\n${resumenCampos(
          campos,
          sesion.data
        )}\n\n¡Buen trabajo! Cuéntame cuando tengas otro caso y seguimos.`,
        saved: true,
      });
    }

    // --- Mensaje libre fuera de una captura activa: dudas de proceso ---
    const conocimientoLibre = await obtenerConocimientoTexto(message);
    const respuesta = await responderAyuda(
      SOP_TEXT,
      OBJECIONES_TEXT,
      message,
      {
        estado: sesion.estado,
        campoActual: campoActualDe(sesion),
        datosCapturados: sesion.data,
      },
      conocimientoLibre
    );

    let reply = respuesta;
    const campoPendiente = campoActualDe(sesion);
    if (campoPendiente) {
      reply += `\n\n➡️ ${campoPendiente}`;
    } else if (sesion.estado === 'inactivo' || sesion.estado === 'finalizado') {
      reply += `\n\nCuéntame cuando tengas un caso nuevo y arrancamos.`;
    }
    return res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});


// ============ Usuarios y perfiles del panel (solo el perfil "admin") ============
// Un solo link para todos: cada correo tiene un perfil en la tabla panel_roles
// (admin = todo + crear usuarios, bo = back office, hace todo, cliente = solo
// Embudo y Seguimiento sin mover nada). Estas rutas crean/cambian usuarios con la llave de
// servicio de Supabase, pero SOLO si quien llama es un admin con sesión válida.
const PERFILES_VALIDOS = ['admin', 'bo', 'cliente'];

function sbServicio() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function exigirAdmin(req, res) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) { res.status(401).json({ error: 'Falta iniciar sesión' }); return null; }
    const sb = sbServicio();
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data || !data.user || !data.user.email) { res.status(401).json({ error: 'Sesión no válida' }); return null; }
    const email = data.user.email.toLowerCase();
    const { data: fila } = await sb.from('panel_roles').select('rol, activo').ilike('email', email).maybeSingle();
    if (!fila || fila.rol !== 'admin' || fila.activo === false) { res.status(403).json({ error: 'Solo un administrador puede hacer esto' }); return null; }
    return { sb, email };
  } catch (err) {
    console.error('exigirAdmin:', err);
    res.status(500).json({ error: 'No se pudo validar el usuario' });
    return null;
  }
}

async function buscarUsuarioAuth(sb, email) {
  for (let pagina = 1; pagina <= 20; pagina++) {
    const { data, error } = await sb.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) throw error;
    const u = (data.users || []).find((x) => (x.email || '').toLowerCase() === email);
    if (u) return u;
    if (!data.users || data.users.length < 200) break;
  }
  return null;
}

app.get('/api/usuarios', async (req, res) => {
  const ctx = await exigirAdmin(req, res); if (!ctx) return;
  const { data, error } = await ctx.sb.from('panel_roles').select('email, rol, nombre, activo, creado_en').order('email');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ usuarios: data || [], yo: ctx.email });
});

// Crear usuario (o, si el correo ya existe en Supabase, solo asignarle perfil)
app.post('/api/usuarios', async (req, res) => {
  const ctx = await exigirAdmin(req, res); if (!ctx) return;
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const clave = String(req.body.clave || '');
    const rol = String(req.body.rol || '').trim();
    const nombre = String(req.body.nombre || '').trim() || null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo no válido' });
    if (!PERFILES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Perfil no válido' });
    let existente = await buscarUsuarioAuth(ctx.sb, email);
    let creado = false;
    if (!existente) {
      if (clave.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
      const { error } = await ctx.sb.auth.admin.createUser({ email, password: clave, email_confirm: true });
      if (error) return res.status(400).json({ error: error.message });
      creado = true;
    }
    const { error: e2 } = await ctx.sb.from('panel_roles').upsert({ email, rol, nombre, activo: true }, { onConflict: 'email' });
    if (e2) return res.status(500).json({ error: e2.message });
    res.json({ ok: true, creado });
  } catch (err) {
    console.error('crear usuario:', err);
    res.status(500).json({ error: err.message || 'No se pudo crear el usuario' });
  }
});

// Cambiar perfil, nombre, activar/desactivar o poner nueva contraseña
app.patch('/api/usuarios', async (req, res) => {
  const ctx = await exigirAdmin(req, res); if (!ctx) return;
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta el correo' });
    const cambios = {};
    if (req.body.rol !== undefined) {
      if (!PERFILES_VALIDOS.includes(req.body.rol)) return res.status(400).json({ error: 'Perfil no válido' });
      cambios.rol = req.body.rol;
    }
    if (req.body.nombre !== undefined) cambios.nombre = String(req.body.nombre || '').trim() || null;
    if (req.body.activo !== undefined) cambios.activo = !!req.body.activo;
    if (email === ctx.email && ((cambios.rol && cambios.rol !== 'admin') || cambios.activo === false)) {
      return res.status(400).json({ error: 'No puedes quitarte el perfil admin ni desactivarte a ti mismo' });
    }
    if (Object.keys(cambios).length) {
      const { error } = await ctx.sb.from('panel_roles').update(cambios).ilike('email', email);
      if (error) return res.status(500).json({ error: error.message });
    }
    const u = (cambios.activo !== undefined || req.body.clave) ? await buscarUsuarioAuth(ctx.sb, email) : null;
    if (cambios.activo !== undefined && u) {
      const { error } = await ctx.sb.auth.admin.updateUserById(u.id, { ban_duration: cambios.activo ? 'none' : '876000h' });
      if (error) return res.status(500).json({ error: error.message });
    }
    if (req.body.clave) {
      if (String(req.body.clave).length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
      if (!u) return res.status(404).json({ error: 'Ese correo no existe en Supabase' });
      const { error } = await ctx.sb.auth.admin.updateUserById(u.id, { password: String(req.body.clave) });
      if (error) return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('editar usuario:', err);
    res.status(500).json({ error: err.message || 'No se pudo actualizar' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de Daniela (Gómez Legal Abogados) escuchando en http://localhost:${PORT}`);
});
