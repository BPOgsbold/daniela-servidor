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
  };
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

    return (
      `• ${c.nombre_cliente || 'Sin nombre'} — ${c.tipo_identificacion || 'ID'} ${c.numero_identificacion || '—'}, ` +
      `placa ${c.placa || '—'}, vehículo ${c.vehiculo || '—'}.\n` +
      `  Última comunicación: ${fechaTexto}. Estado: ${estadoTexto}.` +
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
const REGEX_BUSCAR_CLIENTE = /(ya\s+(fue|lo|la|hab[ií]amos|est[aá]|estuvo)\s+(atendid|gestionad|contactad|llamad)|cliente\s+(repetid|duplicad)|ya\s+(ten[ií]a|tiene|hab[ií]a)\s+caso|ya\s+existe\s+(ese|el|la|este)?\s*cliente|buscar\s+(el\s+|la\s+)?cliente|buscar\s+(este|ese)\s+cliente|consultar\s+(el\s+|la\s+)?cliente|revisar\s+si\s+ya\s+(existe|est[aá]|lo\s+(tenemos|ten[ií]amos))|no\s+(quiero|queremos)\s+duplicar|ya\s+lo\s+hab[ií]amos\s+atendido|ya\s+hab[ií]amos\s+hablado\s+con|ya\s+es\s+cliente|verificar\s+si\s+ya|est[aá]\s+repetido|hist[oó]rico\s+de(l)?\s+cliente|revisar\s+(el\s+)?historial)/i;

function detectarIntencion(mensaje, sesion) {
  if (sesion.pendienteEscalamiento || sesion.pendienteBusqueda) return null;
  if (mensaje.startsWith('__')) return null; // ya es un comando literal
  // Normaliza errores de tipeo comunes ("ciente" por "cliente", etc.) antes
  // de comparar contra las frases, para que un typo no rompa la detección.
  const t = mensaje.trim().toLowerCase().replace(/\bciente\b/g, 'cliente');

  if (REGEX_ESCALAR_JURIDICO.test(t)) return '__escalar_juridico__';

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

    // --- Detección dinámica: si el mensaje libre suena a un cambio de
    // estado ("tengo un cliente nuevo", "ya se radicó", etc.), lo tratamos
    // como si hubiera pulsado el botón correspondiente.
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

    // --- Buscar si un cliente ya fue atendido antes (evitar duplicar) ---
    if (message === '__buscar_cliente__') {
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
      try {
        const resultados = await buscarCasoPorTermino(termino);
        reply = formatearResultadosBusqueda(resultados, termino);
      } catch (dbError) {
        console.error('Error buscando cliente en Supabase:', dbError);
        reply = `No pude consultar la base de datos en este momento (${dbError.message}). Intenta de nuevo en un momento.`;
      }
      const campoPendiente = campoActualDe(sesion);
      if (campoPendiente) {
        reply += `\n\n➡️ Sigamos donde íbamos: ${campoPendiente}`;
      }
      return res.json({ reply });
    }

    // --- Mensajes especiales ---

    if (message === '__inicio__') {
      const saludo = asesor ? `¡Hola, ${asesor}! ` : '¡Hola! ';
      return res.json({ reply: `${saludo}${MENSAJE_INICIAL}` });
    }

    if (message === '__nuevo_caso__') {
      sesion.estado = 'capturando_caso';
      sesion.tipo = null;
      sesion.stepIndex = 0;
      sesion.data = {};
      sesion.casoId = null;
      sesion.avisoDuplicadoMostrado = false;
      const primerCampo = CAMPOS.caso_nuevo[0];
      return res.json({ reply: primerCampo.prompt });
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

      if (sesion.stepIndex < campos.length) {
        const siguiente = campos[sesion.stepIndex];
        return res.json({ reply: `${avisoDuplicado}✅ Anotado.\n\n${siguiente.prompt}` });
      }

      // Caso completo: crear el registro y pasar a "caso_abierto".
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

      sesion.estado = 'caso_abierto';
      return res.json({
        reply:
          `${avisoDuplicado}✅ Caso registrado:\n\n${resumenCampos(campos, sesion.data)}\n\n` +
          'Sigamos gestionando: pregúntame cualquier duda del proceso, y cuéntame cuando el caso se radique ' +
          '(dime algo como "ya se radicó") o si al final no aplicó (dime "no aplica" y el motivo).',
      });
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
