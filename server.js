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
} = require('./supabase');

const app = express();
app.use(cors());
app.use(express.json());

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
  };
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

function normalizarValorCampo(campoId, valorCrudo) {
  const valor = valorCrudo.trim();
  if (campoId === 'tipo_persona') {
    return TIPO_PERSONA_MAP[valor.toLowerCase()] || valor;
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

function detectarIntencion(mensaje, sesion) {
  if (sesion.pendienteEscalamiento) return null;
  if (mensaje.startsWith('__')) return null; // ya es un comando literal
  const t = mensaje.trim().toLowerCase();

  if (REGEX_ESCALAR_JURIDICO.test(t)) return '__escalar_juridico__';

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
    if (texto.length > 20000) {
      return res.status(400).json({
        error: 'El texto es muy largo (máx. 20.000 caracteres). Divídelo en partes más cortas.',
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

      const pareceDuda = message.trim().endsWith('?');
      if (pareceDuda) {
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

      const pareceDuda = message.trim().endsWith('?');
      if (pareceDuda) {
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
          `✅ Caso registrado:\n\n${resumenCampos(campos, sesion.data)}\n\n` +
          'Sigamos gestionando: pregúntame cualquier duda del proceso, y cuéntame cuando el caso se radique ' +
          '(dime algo como "ya se radicó") o si al final no aplicó (dime "no aplica" y el motivo).',
      });
    }

    // --- Captura del resultado final (radicado / no_aplica) ---
    if (sesion.estado === 'capturando_resultado') {
      const campos = CAMPOS[sesion.tipo];
      const campo = campos[sesion.stepIndex];

      const pareceDuda = message.trim().endsWith('?');
      if (pareceDuda) {
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
