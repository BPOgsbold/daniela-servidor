const { createClient } = require('@supabase/supabase-js');

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
    tipo_persona: datos.tipo_persona || null,
    vehiculo: datos.vehiculo || null,
    valor_sin_iva: datos.valor_sin_iva || null,
    tiene_certificado_upme: datos.tiene_certificado_upme || null,
    datos,
  };
  const { data, error } = await supabase.from('casos').insert(row).select().single();
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
    .from('casos')
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

module.exports = {
  crearCaso,
  actualizarCaso,
  guardarEscalamientoJuridico,
  guardarConocimiento,
  obtenerConocimientoReciente,
};
