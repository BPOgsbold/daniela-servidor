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
} = require('./supabase');

const app = express();
app.use(cors());
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
let conocimientoCacheTexto = '';
let conocimientoCacheAt = 0;
const CONOCIMIENTO_TTL_MS = 60 * 1000;

function formatearConocimiento(entradas) {
  if (!entradas || entradas.length === 0) return '';
  return entradas
    .map((e) => {
      const fecha = e.created_at ? new Date(e.created_at).toLocaleDateString('es-CO') : '';
      const encabezado = [e.titulo, e.agregado_por, fecha].filter(Boolean).join(' · ');
      return encabezado ? `### ${encabezado}\n${e.texto}` : e.texto;
    })
    .join('\n\n');
}

async function obtenerConocimientoTexto(forzar = false) {
  const ahora = Date.now();
  if (!forzar && ahora - conocimientoCacheAt < CONOCIMIENTO_TTL_MS) {
    return conocimientoCacheTexto;
  }
  try {
    const entradas = await obtenerConocimientoReciente(30);
    conocimientoCacheTexto = formatearConocimiento(entradas);
    conocimientoCacheAt = ahora;
  } catch (err) {
    console.error('No se pudo cargar el conocimiento adicional:', err.message);
    // Si falla, seguimos con lo último que teníamos en caché en vez de tumbar el chat.
  }
  return conocimientoCacheTexto;
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
    siguientePasoOpciones: ['Pendiente de contrato', 'Pendiente de firma', 'Pendiente de pago'],
    servicioOpciones: ['Solo DIAN', 'Servicio completo', 'Solo UPME'],
  },
];

// Última pregunta del flujo de negociación: cómo quedan los documentos del
// cliente al momento de escalar el caso (una vez ya se registró el servicio
// contratado).
const OPCIONES_ESCALAR_DOCUMENTOS = ['Escalar con documentos completos', 'Escalar con documentos pendientes'];

// Convierte un registro ya guardado en Supabase de vuelta al formato de
// `sesion.data` (id de campo -> valor), para poder "retomar" un caso
// existente sin volver a preguntar los datos que ya tiene. Solo se incluyen
// los campos que sí tienen valor: los que falten quedan pendientes, tal como
// los detecta `siguienteIndicePendiente`.
const CAMPOS_RETOMABLES = [
  'canal', 'origen_cliente', 'nombre_cliente', 'telefono', 'contacto_logrado',
  'numero_identificacion', 'email', 'id_rrss', 'tipo_identificacion',
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

function siguienteIndicePendiente(campos, data) {
  const idx = campos.findIndex((c) => !(c.id in data));
  return idx === -1 ? campos.length : idx;
}

function resumenCampos(campos, data) {
  return campos.map((c) => `• ${c.label}: ${data[c.id] ?? '—'}`).join('\n');
}

// Cuando el campo que se le está preguntando al asesor tiene opciones fijas
// (tipo "botones"/"botones_opcional"), se las mandamos a la extensión en
// `opciones` para que las pinte como botones clicables, además del texto.
function conOpciones(base, campo) {
  return campo && campo.opciones ? { ...base, opciones: campo.opciones } : base;
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
};

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
const ESTADOS_PIPELINE = [
  {
    label: 'Interesado',
    frases: ['interesado'],
    descripcion: 'es el que llega y ya se completaron todos los datos que el cliente brinda.',
  },
  {
    label: 'Contacto',
    frases: ['contacto'],
    descripcion: 'el cliente se comunicó pero no brindó todos los datos.',
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
  {
    label: 'En proceso UPME',
    frases: ['proceso upme', 'tramite upme', 'en upme'],
    descripcion: 'el cliente está en trámite del estado UPME.',
  },
  {
    label: 'En proceso DIAN',
    frases: ['proceso dian', 'tramite dian', 'en dian'],
    descripcion: 'el cliente está en trámite ante la DIAN, pendiente de agendamiento de cita.',
  },
  {
    label: 'Pendiente desembolso',
    frases: ['pendiente desembolso', 'pdt desembolso'],
    descripcion: 'está en espera de desembolso por parte de la DIAN.',
  },
  {
    label: 'Desembolso realizado',
    frases: ['desembolso realizado'],
    descripcion: 'el cliente confirmó que el pago ya fue realizado.',
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
    await obtenerConocimientoTexto(true); // refresca el caché de una vez
    res.json({ ok: true, id: registro.id });
  } catch (err) {
    console.error('Error guardando conocimiento:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// --- Ver qué se le ha enseñado a Daniela hasta ahora ---
app.get('/api/conocimiento', async (req, res) => {
  try {
    const entradas = await obtenerConocimientoReciente(50);
    res.json({ entradas });
  } catch (err) {
    console.error('Error listando conocimiento:', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, asesor } = req.body || {};
    let message = req.body && req.body.message;
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Falta sessionId o message' });
    }

    let sesion = sesiones.get(sessionId);
    if (!sesion) {
      sesion = nuevaSesion();
      sesiones.set(sessionId, sesion);
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
      return res.json({ reply: primerCampo.prompt });
    }

    // --- Si hay un escalamiento en curso, todo mensaje libre va ahí ---
    if (sesion.pendienteEscalamiento) {
      const esc = sesion.pendienteEscalamiento;
      const campos = CAMPOS.escalamiento_juridico;
      const campo = campos[esc.stepIndex];

      const esDuda = pareceDuda(message);
      if (esDuda) {
        const conocimiento = await obtenerConocimientoTexto();
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
        return res.json({ reply: `${respuesta}\n\n➡️ ${campo.prompt}` });
      }

      const resultadoCampo = validarYNormalizarCampo(campo, message);
      if (!resultadoCampo.ok) {
        return res.json({ reply: `⚠️ ${campo.errorMessage}\n\n${campo.prompt}` });
      }

      esc.data[campo.id] = resultadoCampo.valor;
      esc.stepIndex += 1;

      if (esc.stepIndex < campos.length) {
        const siguiente = campos[esc.stepIndex];
        return res.json({ reply: `✅ Anotado.\n\n${siguiente.prompt}` });
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
          reply = formatearResultadosBusqueda(resultados, terminoInline);
          if (resultados.length === 1) {
            sesion.candidatoRetomar = resultados[0];
            opcionesBusqueda = ['Retomar este caso'];
          } else {
            sesion.candidatoRetomar = null;
          }
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
        reply = formatearResultadosBusqueda(resultados, termino);
        if (resultados.length === 1) {
          sesion.candidatoRetomar = resultados[0];
          opcionesBusqueda = ['Retomar este caso'];
        } else {
          sesion.candidatoRetomar = null;
        }
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
      return res.json({ reply: primerCampo.prompt });
    }

    // --- Captura de datos del caso nuevo ---
    if (sesion.estado === 'capturando_caso') {
      const campos = CAMPOS.caso_nuevo;
      const campo = campos[sesion.stepIndex];

      // El asesor está respondiendo a "¿quieres cerrar la interacción con
      // este cliente?" (esto solo se pregunta cuando "¿lograste el
      // contacto?" fue "No"). Se maneja aparte del flujo normal de campos
      // porque no es una pregunta de CAMPOS.caso_nuevo.
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
        const conocimiento = await obtenerConocimientoTexto();
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

      // Verificación automática de duplicados: apenas se captura el nombre,
      // la cédula/NIT o la placa, revisamos si ya existe un caso con ese
      // dato — así el asesor no tiene que acordarse de decir una frase
      // especial para consultarlo, se hace solo dentro del flujo normal.
      // Se avisa una sola vez por sesión para no repetir el aviso en cada
      // campo si el mismo cliente coincide en varios (nombre, cédula, placa).
      let avisoDuplicado = '';
      if (!sesion.avisoDuplicadoMostrado && ['nombre_cliente', 'numero_identificacion', 'placa'].includes(campo.id)) {
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
      // Supabase con estado "Contacto" — así, aunque después se caiga la
      // llamada o no se alcance a llenar todo lo demás, el cliente NO se
      // pierde: ya quedó guardado en la base de datos.
      let avisoGuardado = '';
      if (campo.id === 'contacto_logrado' && !sesion.casoId) {
        try {
          const registro = await crearCaso(sessionId, asesor, { ...sesion.data, estado_pipeline: 'Contacto' });
          sesion.casoId = registro.id;
          avisoGuardado =
            '✅ Ya quedó guardado en la base de datos (estado: Contacto), así que aunque no alcancemos a completar todo, no se pierde.\n\n';
        } catch (dbError) {
          console.error('Error creando el caso en Supabase (paso de contacto):', dbError);
          avisoGuardado = `⚠️ No pude guardar el caso en la base de datos en este momento (${dbError.message}). Sigamos igual, pero avisa a soporte si esto se repite.\n\n`;
        }
      } else if (sesion.casoId) {
        // El caso ya existe (se creó en el paso de "contacto_logrado"): cada
        // dato nuevo se va guardando de una vez, en vez de esperar a que se
        // complete todo el formulario.
        try {
          await actualizarCaso(sesion.casoId, { [campo.id]: resultadoCampo.valor });
        } catch (dbError) {
          console.error(`Error actualizando el campo ${campo.id} en Supabase:`, dbError);
          // No bloqueamos el flujo si falla un guardado incremental.
        }
      }

      // Si NO se logró el contacto, le preguntamos al asesor si de una vez
      // quiere cerrar la interacción con este cliente (ya quedó guardado
      // como "Contacto") o si prefiere seguir con las demás preguntas.
      if (campo.id === 'contacto_logrado' && resultadoCampo.valor === 'No') {
        sesion.pendienteCierre = true;
        return res.json({
          reply: `${avisoDuplicado}${avisoGuardado}¿Quieres cerrar la interacción con este cliente?`,
          opciones: ['Sí', 'No'],
        });
      }

      if (sesion.stepIndex < campos.length) {
        const siguiente = campos[sesion.stepIndex];
        return res.json(conOpciones({ reply: `${avisoDuplicado}${avisoGuardado}✅ Anotado.\n\n${siguiente.prompt}` }, siguiente));
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

      // En vez de terminar aquí, arrancamos las 3 preguntas de negociación
      // (estado de interés, negociación, cliente acepta todo) para ir
      // registrando cómo avanza la venta.
      sesion.estado = 'negociacion';
      sesion.negociacion = { gateIndex: 0, sub: 'pregunta' };
      const primerGate = GATES_NEGOCIACION[0];
      return res.json({
        reply:
          `${avisoDuplicado}${avisoGuardado}✅ Caso completo:\n\n${resumenCampos(campos, sesion.data)}\n\n` +
          `➡️ ${primerGate.pregunta}`,
        opciones: ['Sí', 'No'],
      });
    }

    // --- Preguntas de negociación (estado de interés, negociación, cliente
    // acepta todo), una detrás de otra, una vez el caso ya tiene todos sus
    // datos. Cada una es un gate Sí/No: si es "No", pide el motivo con
    // botones y luego pregunta si cerrar la interacción; si cierra, marca el
    // caso como "Cierre perdido". Si es "Sí", sigue con la siguiente
    // pregunta (la última, "Cliente acepta todo", en vez de eso pide el
    // siguiente paso).
    if (sesion.estado === 'negociacion' && sesion.negociacion) {
      const neg = sesion.negociacion;
      const gate = GATES_NEGOCIACION[neg.gateIndex];

      if (neg.sub === 'pregunta') {
        const respuesta = interpretarSiNo(message);
        if (!respuesta) {
          return res.json({ reply: gate.pregunta, opciones: ['Sí', 'No'] });
        }
        if (respuesta === 'sí') {
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
          return res.json({ reply: `Listo.\n\n➡️ ${siguienteGate.pregunta}`, opciones: ['Sí', 'No'] });
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
            await actualizarCaso(sesion.casoId, { [gate.motivoCampo]: motivo });
          } catch (dbError) {
            console.error(`Error guardando ${gate.motivoCampo} en Supabase:`, dbError);
          }
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
        return res.json({ reply: `Listo, seguimos.\n\n➡️ ${siguienteGate.pregunta}`, opciones: ['Sí', 'No'] });
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
            await actualizarCaso(sesion.casoId, { siguiente_paso: match });
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
        const conocimiento = await obtenerConocimientoTexto();
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
        return res.json({ reply: `${respuesta}\n\n➡️ ${campo.prompt}` });
      }

      const resultadoCampo = validarYNormalizarCampo(campo, message);
      if (!resultadoCampo.ok) {
        return res.json({ reply: `⚠️ ${campo.errorMessage}\n\n${campo.prompt}` });
      }

      sesion.data[campo.id] = resultadoCampo.valor;
      sesion.stepIndex = siguienteIndicePendiente(campos, sesion.data);

      if (sesion.stepIndex < campos.length) {
        const siguiente = campos[sesion.stepIndex];
        return res.json({ reply: `✅ Anotado.\n\n${siguiente.prompt}` });
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
    const conocimientoLibre = await obtenerConocimientoTexto();
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

app.listen(PORT, () => {
  console.log(`Servidor de Daniela (Gómez Legal Abogados) escuchando en http://localhost:${PORT}`);
});
