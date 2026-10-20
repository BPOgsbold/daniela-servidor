// Evita crear el mismo cliente dos veces: revisa por TELÉFONO y por CÉDULA/NIT
// (sin importar puntos, espacios o +57). Solo se permite un segundo caso del
// mismo cliente cuando el asesor elige "Mismo cliente, otro vehículo".
const { createClient } = require('@supabase/supabase-js');

const TABLA_CASOS = 'Perfilamiento_y_ventas_GLA';
let client = null;
function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    client = createClient(url, key);
  }
  return client;
}

const digitos = (t) => String(t || '').replace(/\D/g, '');
const tel10 = (t) => digitos(t).slice(-10); // celular colombiano: últimos 10 dígitos (ignora +57)
const ced = (t) => digitos(t).replace(/^0+/, '');

// Trae solo las columnas necesarias, por páginas (PostgREST devuelve máx. 1000 por consulta).
async function leerTodos() {
  const sb = getClient();
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from(TABLA_CASOS)
      .select('id, telefono, numero_identificacion')
      .order('id', { ascending: true })
      .range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

/**
 * Casos que ya tienen ese teléfono o esa cédula/NIT (el más reciente primero).
 * excluirId: el caso que se está trabajando ahora (no cuenta como duplicado de sí mismo).
 * Devuelve { casos: [...filas completas], campo: 'telefono' | 'numero_identificacion' | null }.
 */
async function buscarDuplicados({ telefono, numero_identificacion, excluirId }) {
  const t = digitos(telefono).length >= 7 ? tel10(telefono) : '';
  const c = digitos(numero_identificacion).length >= 5 ? ced(numero_identificacion) : '';
  if (!t && !c) return { casos: [], campo: null };

  const ids = [];
  let campo = null;
  for (const f of await leerTodos()) {
    if (excluirId && String(f.id) === String(excluirId)) continue;
    const porTel = t && digitos(f.telefono).length >= 7 && tel10(f.telefono) === t;
    const porCed = c && ced(f.numero_identificacion) === c;
    if (porTel || porCed) {
      ids.push(f.id);
      campo = campo || (porCed ? 'numero_identificacion' : 'telefono');
    }
  }
  if (!ids.length) return { casos: [], campo: null };
  const { data, error } = await getClient().from(TABLA_CASOS).select('*').in('id', ids.slice(0, 50))
    .order('updated_at', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return { casos: data || [], campo };
}

// Borra un caso "cascarón" que creó esta MISMA sesión (solo si es de esta sesión).
async function eliminarCasoDeSesion(casoId, sessionId) {
  const { error } = await getClient().from(TABLA_CASOS).delete().eq('id', casoId).eq('session_id', sessionId);
  if (error) throw error;
}

module.exports = { buscarDuplicados, eliminarCasoDeSesion };
