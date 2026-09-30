const { createClient } = require('@supabase/supabase-js');

// Nombre de la tabla de casos en Supabase. Si se vuelve a renombrar la
// tabla desde el panel de Supabase, solo hay que actualizar este valor
// (tiene que ser EXACTAMENTE igual a como aparece en Supabase, mayúsculas
// y guiones bajos incluidos).
const TABLA_CASOS = 'Perfilamiento_y_ventas_GLA';

let client = null;
function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el archivo .env');
    }
    client = createClient(url, key);
  }
  return client;
}

/**
 * Crea el registro inicial de un caso (nombre, teléfono, tipo de persona,
 * vehículo, valor sin IVA, si ya tiene certificado UPME).
 */
async function crearCaso(sessionId, asesor, datos) {
  const supabase = getClient();
  const row = {
    session_id: sessionId,
    asesor: asesor || null,
    nombre_cliente: datos.nombre_cliente || null,
    telefono: datos.telefono || null,
    canal: datos.canal || null,
    fuente: datos.fuente || null,
    contacto_logrado: datos.contacto_logrado || null,
    email: datos.email || null,
    id_rrss: datos.id_rrss || null,
    tipo_identificacion: datos.tipo_identificacion || null,
    numero_identificacion: datos.numero_identificacion || null,
    ciudad: datos.ciudad || null,
    departamento: datos.departamento || null,
    tipo_cuenta: datos.tipo_cuenta || null,
    nombre_empresa: datos.nombre_empresa || null,
    cuenta: datos.cuenta || null,
    tipo_persona: datos.tipo_persona || null,
    vehiculo: datos.vehiculo || null,
    tecnologia: datos.tecnologia || null,
    placa: datos.placa || null,
    fecha_compra: datos.fecha_compra || null,
    valor_sin_iva: datos.valor_sin_iva || null,
    tiene_certificado_upme: datos.tiene_certificado_upme || null,
    // Estado del pipeline comercial: por defecto arranca como "Interesado",
    // pero el caso ahora se puede crear desde antes de tener todos los
    // datos (apenas se responde si se logró el contacto), así que quien
    // llama puede pasar explícitamente estado_pipeline: 'Contacto'.
    estado_pipeline: datos.estado_pipeline || 'Interesado',
    datos,
  };
  const { data, error } = await supabase.from(TABLA_CASOS).insert(row).select().single();
  if (error) throw error;
  return data;
}

/**
 * Actualiza el resultado final de un caso ('radicado' | 'no_aplica') y los
 * campos adicionales que apliquen.
 */
async function actualizarCaso(casoId, cambios) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLA_CASOS)
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('id', casoId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Guarda un escalamiento a jurídico, enlazado opcionalmente al caso de
 * origen.
 */
async function guardarEscalamientoJuridico(sessionId, asesor, casoId, datos) {
  const supabase = getClient();
  const row = {
    session_id: sessionId,
    asesor: asesor || null,
    caso_id: casoId || null,
    ...datos,
    datos,
  };
  const { data, error } = await supabase
    .from('escalamientos_juridico')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Guarda una entrada de conocimiento adicional (texto pegado a mano o
 * contenido de un documento .txt/.md cargado desde la extensión).
 */
async function guardarConocimiento(titulo, texto, agregadoPor) {
  const supabase = getClient();
  const row = {
    titulo: titulo || null,
    texto,
    agregado_por: agregadoPor || null,
    activo: true,
  };
  const { data, error } = await supabase.from('conocimiento').insert(row).select().single();
  if (error) throw error;
  return data;
}

/**
 * Trae las entradas de conocimiento activas, más recientes primero, hasta
 * un límite (para no inflar de más el contexto que se le pasa a la IA).
 */
async function obtenerConocimientoReciente(limite = 30) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('conocimiento')
    .select('id, titulo, texto, agregado_por, created_at')
    .eq('activo', true)
    .order('created_at', { ascending: false })
    .limit(limite);
  if (error) throw error;
  return data || [];
}

// Quita tildes para comparar nombres sin importar acentos (ej. "jimenez" vs
// "Jiménez").
function normalizarTexto(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Busca casos ya registrados por nombre, número de identificación (exacto) o
 * placa (exacta), para que el asesor pueda confirmar el estado de un cliente
 * o evitar crear un caso duplicado. Devuelve los más recientemente
 * actualizados primero.
 *
 * El nombre se busca por PALABRAS, no como frase exacta: "claudia jimenez"
 * debe encontrar a "Claudia Ximena Jimenez" aunque "Ximena" quede en medio.
 * Antes se buscaba con ilike de la frase completa, así que cualquier nombre
 * de en medio (segundo nombre, apellido materno) hacía fallar la búsqueda
 * aunque el cliente sí estuviera registrado.
 */
async function buscarCasoPorTermino(termino, limite = 5) {
  const supabase = getClient();
  const term = (termino || '').trim();
  if (!term) return [];

  // El operador .or() de Supabase usa comas y paréntesis como separadores de
  // filtros, así que los quitamos del término para no romper la consulta.
  const termLimpio = term.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!termLimpio) return [];
  const termPlaca = termLimpio.toUpperCase().replace(/[\s-]+/g, '');
  const palabras = termLimpio.split(' ').filter((p) => p.length >= 2);

  const filtrosNombre = (palabras.length > 0 ? palabras : [termLimpio]).map(
    (p) => `nombre_cliente.ilike.%${p}%`
  );
  const filtros = [
    ...filtrosNombre,
    `numero_identificacion.eq.${termLimpio}`,
    `placa.eq.${termPlaca}`,
  ].join(',');

  // Traemos un grupo más amplio de candidatos (cualquiera que coincida con
  // AL MENOS una palabra) y luego, en JS, priorizamos los que tienen TODAS
  // las palabras del término, para no perder coincidencias reales por el
  // orden o por nombres de en medio.
  const { data, error } = await supabase
    .from(TABLA_CASOS)
    .select('*')
    .or(filtros)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw error;

  const palabrasNorm = palabras.map(normalizarTexto);
  const completos = [];
  const parciales = [];
  for (const c of data || []) {
    const nombreNorm = normalizarTexto(c.nombre_cliente);
    const cedulaMatch = c.numero_identificacion && c.numero_identificacion === termLimpio;
    const placaMatch = c.placa && c.placa === termPlaca;
    const todasLasPalabras =
      palabrasNorm.length > 0 && palabrasNorm.every((p) => nombreNorm.includes(p));

    if (cedulaMatch || placaMatch || todasLasPalabras) {
      completos.push(c);
    } else {
      parciales.push(c);
    }
  }

  return [...completos, ...parciales].slice(0, limite);
}

module.exports = {
  crearCaso,
  actualizarCaso,
  guardarEscalamientoJuridico,
  guardarConocimiento,
  obtenerConocimientoReciente,
  buscarCasoPorTermino,
};
