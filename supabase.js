const crypto = require('crypto');
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

// Columnas fijas de cada tabla. Todo lo demás se guarda igual en "datos" (jsonb),
// así que agregar campos en config/campos.json nunca rompe el guardado.
const COLS_INTERESADO = {
  direccion: 'direccion',
  nombre_cliente: 'nombre_cliente',
  telefono: 'telefono',
  cobertura: 'cobertura_validada',
  ciudad: 'ciudad',
};
const COLS_VENTA = [
  'nombre_cliente', 'cedula', 'telefono', 'direccion', 'barrio', 'ciudad', 'plan',
  'numero_ot', 'numero_cuenta', 'fecha_agenda', 'hora_agenda', 'observaciones', 'tipo_venta',
  'servicios_vendidos', 'multiasistencia', 'multiasistencia_cual',
];

// Inicio del día de hoy en hora Colombia (UTC-5), en ISO.
function inicioDeHoy() {
  const ahora = new Date(Date.now() - 5 * 3600 * 1000);
  return `${ahora.toISOString().slice(0, 10)}T00:00:00-05:00`;
}
// Inicio de un periodo en hora Colombia: 'hoy' | 'semana' (últimos 7 días) | 'mes' (desde el 1 del mes)
function inicioDe(periodo) {
  const ahora = new Date(Date.now() - 5 * 3600 * 1000);
  if (periodo === 'todo') return '2000-01-01T00:00:00-05:00';
  if (periodo === 'mes') return `${ahora.toISOString().slice(0, 8)}01T00:00:00-05:00`;
  if (periodo === 'semana') {
    const d = new Date(ahora.getTime() - 6 * 86400000);
    return `${d.toISOString().slice(0, 10)}T00:00:00-05:00`;
  }
  return inicioDeHoy();
}

async function crearInteresado(asesor, datos) {
  const supabase = getClient();
  const row = { session_id: crypto.randomUUID(), asesor: asesor || null, datos };
  for (const [campo, col] of Object.entries(COLS_INTERESADO)) {
    if (campo in datos) row[col] = datos[campo];
  }
  const { data, error } = await supabase.from('interesados').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function actualizarInteresado(id, cambios) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('interesados')
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function guardarVenta(asesor, cliente, datos) {
  const supabase = getClient();
  const completo = {
    nombre_cliente: cliente.nombre_cliente,
    telefono: cliente.telefono,
    direccion: cliente.direccion,
    ...datos,
  };
  const row = {
    session_id: crypto.randomUUID(),
    asesor: asesor || null,
    interesado_id: cliente.id,
    datos: completo,
  };
  for (const col of COLS_VENTA) if (completo[col] != null) row[col] = completo[col];
  // Venta de un día anterior (solo si el back lo activó en el panel): queda con esa fecha.
  const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(completo.fecha_venta || '') && completo.fecha_venta < hoy) {
    row.created_at = new Date(`${completo.fecha_venta}T12:00:00-05:00`).toISOString();
    row.datos = { ...completo, registrada_el: new Date().toISOString() };
  }
  let { data, error } = await supabase.from('ventas').insert(row).select().single();
  // Si todavía falta alguna columna nueva en Supabase, se guarda igual (el dato queda en "datos").
  for (let i = 0; error && i < 6; i++) {
    const col = (error.message || '').match(/'([a-z_]+)' column|column "?([a-z_]+)"?/i);
    const nombre = col && (col[1] || col[2]);
    if (!nombre || !(nombre in row) || nombre === 'datos') break;
    delete row[nombre];
    ({ data, error } = await supabase.from('ventas').insert(row).select().single());
  }
  if (error) throw error;
  return data;
}

// Le pega a cada cliente su venta más reciente (si tiene).
async function adjuntarVentas(clientes) {
  if (!clientes.length) return clientes;
  const supabase = getClient();
  const { data, error } = await supabase
    .from('ventas')
    .select('*')
    .in('interesado_id', clientes.map((c) => c.id))
    .order('created_at', { ascending: false });
  if (error) throw error;
  return clientes.map((c) => ({ ...c, venta: (data || []).find((v) => v.interesado_id === c.id) || null }));
}

async function obtenerCliente(id) {
  const supabase = getClient();
  const { data, error } = await supabase.from('interesados').select('*').eq('id', id).single();
  if (error) throw error;
  return (await adjuntarVentas([data]))[0];
}

/**
 * Busca clientes por nombre, teléfono, dirección o cédula (la cédula vive en
 * la tabla de ventas). Devuelve hasta 5, priorizando los que coinciden con
 * todas las palabras buscadas.
 */
async function buscarClientes(termino) {
  const supabase = getClient();
  const limpio = String(termino || '').replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpio) return [];
  const digitos = limpio.replace(/\D/g, '');
  const palabras = limpio.split(' ').filter((p) => p.length >= 2);

  const filtros = palabras.map((p) => `nombre_cliente.ilike.%${p}%`);
  filtros.push(`direccion.ilike.%${limpio}%`);
  if (digitos.length >= 6) filtros.push(`telefono.ilike.%${digitos}%`); // también encuentra clientes con varios números

  const { data, error } = await supabase
    .from('interesados')
    .select('*')
    .or(filtros.join(','))
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw error;
  let filas = data || [];

  if (digitos.length >= 6) {
    // Por cédula, celular, OT o cuenta en las ventas (incluye las importadas del Excel)
    const { data: vts, error: e2 } = await supabase.from('ventas').select('id, interesado_id')
      .or(`cedula.eq.${digitos},numero_ot.eq.${digitos},numero_cuenta.eq.${digitos},telefono.ilike.%${digitos}%`).limit(10);
    if (e2) throw e2;
    // Ventas importadas sin ficha de cliente: se enlazan / se les crea la ficha para poder abrirlas
    for (const v of (vts || []).filter((x) => !x.interesado_id).slice(0, 5)) {
      try { const c = await obtenerClienteOVenta(v.id); if (c && !filas.some((f) => f.id === c.id)) filas.unshift(c); } catch (e) { console.error('ficha venta importada:', e.message); }
    }
    const ids = (vts || []).map((v) => v.interesado_id).filter((id) => id && !filas.some((f) => f.id === id));
    if (ids.length) {
      const { data: extra, error: e3 } = await supabase.from('interesados').select('*').in('id', ids);
      if (e3) throw e3;
      filas = [...(extra || []), ...filas];
    }
  }

  const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const puntaje = (f) => {
    if (digitos.length >= 6 && String(f.telefono || '').includes(digitos)) return 100;
    if (digitos.length >= 6 && f.venta && [f.venta.cedula, f.venta.numero_ot, f.venta.numero_cuenta].includes(digitos)) return 100;
    const nombre = sinTildes(f.nombre_cliente);
    return palabras.filter((p) => nombre.includes(sinTildes(p))).length;
  };
  filas.sort((a, b) => puntaje(b) - puntaje(a));
  return adjuntarVentas(filas.slice(0, 5));
}

async function buscarPorTelefono(telefono) {
  const supabase = getClient();
  // Puede venir uno o varios números ("3001234567 / 3109876543"): se busca cualquiera de ellos
  const nums = String(telefono || '').split('/').map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 7);
  if (!nums.length) return [];
  const { data, error } = await supabase
    .from('interesados')
    .select('*')
    .or(nums.map((n) => `telefono.ilike.%${n}%`).join(','))
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Clientes registrados hoy por el asesor (los más recientes primero). */
async function clientesDeHoy(asesor, periodo = 'semana') {
  const supabase = getClient();
  let q = supabase.from('interesados').select('*').gte('created_at', inicioDe(periodo)).order('created_at', { ascending: false }).limit(periodo === 'hoy' ? 60 : 150);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Rellamadas pendientes del asesor (de hoy, atrasadas y próximas), en orden de fecha. */
async function rellamadasPendientes(asesor) {
  const supabase = getClient();
  let q = supabase
    .from('interesados')
    .select('*')
    .eq('resultado', 'volver_llamar')
    .order('rellamar_fecha', { ascending: true })
    .limit(40);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Escalamientos del asesor: todos los pendientes + resueltos de los últimos 7 días. */
async function escalamientosDeAsesor(asesor) {
  const supabase = getClient();
  const hace7 = new Date(Date.now() - 7 * 86400000).toISOString();
  let q = supabase
    .from('interesados')
    .select('*')
    .not('escalamiento_tipo', 'is', null)
    .or(`escalamiento_estado.eq.pendiente,escalamiento_resuelto_fecha.gte.${hace7}`)
    .order('escalamiento_fecha', { ascending: false })
    .limit(40);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Ventas del asesor de los últimos 45 días (con su estado de instalación). */
async function ventasDeAsesor(asesor) {
  const supabase = getClient();
  const desde = new Date(Date.now() - 45 * 86400000).toISOString();
  let q = supabase.from('ventas').select('*').gte('created_at', desde).order('created_at', { ascending: false }).limit(80);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function obtenerVenta(id) {
  const { data, error } = await getClient().from('ventas').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function actualizarVenta(id, cambios) {
  const supabase = getClient();
  const { data, error } = await supabase.from('ventas').update(cambios).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

/** Clientes del asesor con OT activa (activas + liberadas en los últimos 7 días). */
async function otActivasDeAsesor(asesor) {
  const supabase = getClient();
  const hace7 = new Date(Date.now() - 7 * 86400000).toISOString();
  let q = supabase
    .from('interesados')
    .select('*')
    .not('ot_activa_numero', 'is', null)
    .or(`ot_activa_estado.eq.activa,ot_activa_liberada_fecha.gte.${hace7}`)
    .order('ot_activa_fecha', { ascending: false })
    .limit(60);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Números de hoy. Si se pasa asesor, solo los de ese asesor. */
async function resumenDeHoy(asesor, periodo = 'hoy') {
  const supabase = getClient();
  const desde = inicioDe(periodo);

  let q1 = supabase.from('interesados').select('cobertura_validada,resultado').gte('created_at', desde);
  if (asesor) q1 = q1.eq('asesor', asesor);
  const { data: ints, error: e1 } = await q1;
  if (e1) throw e1;

  let q2 = supabase.from('ventas').select('id', { count: 'exact', head: true }).gte('created_at', desde);
  if (asesor) q2 = q2.eq('asesor', asesor);
  const { count: ventas, error: e2 } = await q2;
  if (e2) throw e2;

  const lista = ints || [];
  const esSi = (v) => /^s[ií]$/i.test(String(v || ''));
  return {
    interesados: lista.length,
    conCobertura: lista.filter((i) => esSi(i.cobertura_validada)).length,
    sinCobertura: lista.filter((i) => String(i.cobertura_validada || '').toLowerCase() === 'no').length,
    ventas: ventas || 0,
    noVenta: lista.filter((i) => i.resultado === 'no_venta').length,
    enGestion: lista.filter((i) => !i.resultado || i.resultado === 'en_gestion').length,
    porRellamar: lista.filter((i) => i.resultado === 'volver_llamar').length,
  };
}

// ---------------------------------------------------------------------------
// Panel web (back office)
// ---------------------------------------------------------------------------

/** Interesados (con su venta) y ventas creados entre dos fechas ISO. */
async function panelDatos(desde, hasta) {
  const supabase = getClient();
  const traer = async (tabla) => {
    let filas = [];
    for (let desdeFila = 0; desdeFila < 20000; desdeFila += 1000) {
      const { data, error } = await supabase
        .from(tabla)
        .select('*')
        .gte('created_at', desde)
        .lt('created_at', hasta)
        .order('created_at', { ascending: false })
        .range(desdeFila, desdeFila + 999);
      if (error) throw error;
      filas = filas.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return filas;
  };
  const [interesados, ventas] = await Promise.all([traer('interesados'), traer('ventas')]);
  // Ventas de cualquier fecha para los interesados del rango (para mostrar su estado completo).
  const conVenta = [];
  for (let i = 0; i < interesados.length; i += 300) {
    conVenta.push(...(await adjuntarVentas(interesados.slice(i, i + 300))));
  }
  const { data: rell, error: eR } = await supabase
    .from('interesados')
    .select('*')
    .eq('resultado', 'volver_llamar')
    .order('rellamar_fecha', { ascending: true })
    .limit(3000);
  if (eR) throw eR;
  const { data: esc, error: eE } = await supabase
    .from('interesados')
    .select('*')
    .not('escalamiento_tipo', 'is', null)
    .order('escalamiento_fecha', { ascending: false })
    .limit(3000);
  if (eE) throw eE;
  const { data: vPend, error: eV } = await supabase
    .from('ventas')
    .select('*')
    .or('estado_instalacion.is.null,estado_instalacion.eq.pendiente')
    .order('created_at', { ascending: false })
    .limit(3000);
  if (eV) throw eV;
  const { data: ots, error: eO } = await supabase
    .from('interesados')
    .select('*')
    .not('ot_activa_numero', 'is', null)
    .order('ot_activa_fecha', { ascending: false })
    .limit(3000);
  if (eO) throw eO;
  return { interesados: conVenta, ventas, rellamadas: rell || [], escalamientos: esc || [], ventasPendientes: vPend || [], otActivas: ots || [] };
}

// ---------------------------------------------------------------------------
// Interruptores del panel (tabla marce_config)
// ---------------------------------------------------------------------------
async function leerConfig() {
  const { data, error } = await getClient().from('marce_config').select('*');
  if (error) throw error;
  const cfg = {};
  for (const f of data || []) cfg[f.clave] = { valor: f.valor, por: f.por, actualizado: f.actualizado };
  return cfg;
}
async function guardarConfig(clave, valor, por) {
  const { data, error } = await getClient()
    .from('marce_config')
    .upsert({ clave, valor, por: por || null, actualizado: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Eliminar registros mal subidos (solo desde el panel)
// ---------------------------------------------------------------------------
async function eliminarVenta(id) {
  const supabase = getClient();
  const { data: v, error: e1 } = await supabase.from('ventas').select('id, interesado_id').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!v) return { ok: true };
  const { error: e2 } = await supabase.from('ventas').delete().eq('id', id);
  if (e2) throw e2;
  if (v.interesado_id) {
    const { count } = await supabase.from('ventas').select('id', { count: 'exact', head: true }).eq('interesado_id', v.interesado_id);
    if (!count) {
      const { data: i } = await supabase.from('interesados').select('resultado').eq('id', v.interesado_id).maybeSingle();
      if (i?.resultado === 'venta') await actualizarInteresado(v.interesado_id, { resultado: 'en_gestion' });
    }
  }
  return { ok: true };
}
async function eliminarInteresado(id) {
  const supabase = getClient();
  const { error: e1 } = await supabase.from('ventas').delete().eq('interesado_id', id);
  if (e1) throw e1;
  const { error: e2 } = await supabase.from('interesados').delete().eq('id', id);
  if (e2) throw e2;
  return { ok: true };
}

/** Clientes que el asesor marcó SIN cobertura y el back confirmó que SÍ tienen (alertas). */
async function alertasCobertura(asesor) {
  let q = getClient()
    .from('interesados')
    .select('*')
    .eq('auditoria_cobertura', 'confirmada')
    .ilike('cobertura_validada', 'no')
    .order('auditoria_fecha', { ascending: false })
    .limit(60);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// Asesores (cada uno entra con su cédula)
// ---------------------------------------------------------------------------
async function buscarAsesor(cedula) {
  const { data, error } = await getClient().from('asesores').select('*').eq('cedula', String(cedula)).maybeSingle();
  if (error) throw error;
  return data || null;
}
async function listarAsesores() {
  const { data, error } = await getClient().from('asesores').select('*').order('nombre', { ascending: true }).limit(2000);
  if (error) throw error;
  return data || [];
}
async function guardarAsesor({ cedula, nombre, campana, activo }) {
  const fila = { cedula: String(cedula), nombre, campana: campana || null, actualizado: new Date().toISOString() };
  if (activo !== undefined) fila.activo = Boolean(activo);
  const { data, error } = await getClient().from('asesores').upsert(fila).select().single();
  if (error) throw error;
  return data;
}
/** Pasa todos los registros de un nombre de asesor a otro (unir nombres repetidos o renombrar). */
async function renombrarAsesor(de, a) {
  const supabase = getClient();
  const r1 = await supabase.from('interesados').update({ asesor: a }).eq('asesor', de).select('id');
  if (r1.error) throw r1.error;
  const r2 = await supabase.from('ventas').update({ asesor: a }).eq('asesor', de).select('id');
  if (r2.error) throw r2.error;
  return { interesados: (r1.data || []).length, ventas: (r2.data || []).length };
}
/** Cuántos interesados y ventas tiene cada nombre de asesor (de todos los tiempos). */
async function conteoPorAsesor() {
  const supabase = getClient();
  const contar = async (tabla) => {
    const cuenta = {};
    for (let desde = 0; desde < 100000; desde += 1000) {
      const { data, error } = await supabase.from(tabla).select('asesor').range(desde, desde + 999);
      if (error) throw error;
      for (const f of data || []) cuenta[f.asesor || ''] = (cuenta[f.asesor || ''] || 0) + 1;
      if (!data || data.length < 1000) break;
    }
    return cuenta;
  };
  const [interesados, ventas] = await Promise.all([contar('interesados'), contar('ventas')]);
  return { interesados, ventas };
}

/** Copia cambios (nombre, teléfono, dirección, asesor…) a las ventas de un interesado. */
async function actualizarVentasDeInteresado(interesadoId, cambios) {
  if (!Object.keys(cambios).length) return;
  const { error } = await getClient().from('ventas').update(cambios).eq('interesado_id', interesadoId);
  if (error) throw error;
}

/** Todas las direcciones guardadas (interesados y ventas), para homologarlas. */
async function todasLasDirecciones() {
  const supabase = getClient();
  const out = [];
  for (const tabla of ['interesados', 'ventas']) {
    for (let desde = 0; desde < 100000; desde += 1000) {
      const { data, error } = await supabase.from(tabla).select('id, direccion').range(desde, desde + 999);
      if (error) throw error;
      for (const f of data || []) out.push({ tabla, id: f.id, direccion: f.direccion });
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}
/** Cambia solo la dirección (sin tocar updated_at, para no alterar las alertas). */
async function actualizarDireccion(tabla, id, direccion) {
  const { error } = await getClient().from(tabla).update({ direccion }).eq('id', id);
  if (error) throw error;
}

/** Ventas con instalación agendada (o reagendada por la torre) para un día. fecha = AAAA-MM-DD */
async function agendaDelDia(fecha) {
  const supabase = getClient();
  const [a, m, d] = fecha.split('-');
  const formatos = [...new Set([`${d}/${m}/${a}`, `${+d}/${+m}/${a}`, `${d}/${+m}/${a}`, `${+d}/${m}/${a}`])];
  const { data, error } = await supabase.from('ventas').select('*').in('fecha_agenda', formatos).limit(3000);
  if (error) throw error;
  let filas = data || [];
  // Reagendadas por la torre para ese día (si ya existe la columna)
  const r = await supabase.from('ventas').select('*').eq('torre_fecha_reagenda', fecha).limit(3000);
  if (!r.error) for (const v of r.data || []) if (!filas.some((x) => x.id === v.id)) filas.push({ ...v, _reagendadaParaHoy: true });
  return filas;
}
/** Ventas registradas en un día (hora Colombia). */
async function ventasDelDia(fecha) {
  const desde = new Date(`${fecha}T00:00:00-05:00`).toISOString();
  const hasta = new Date(new Date(desde).getTime() + 86400000).toISOString();
  const { data, error } = await getClient().from('ventas').select('*').gte('created_at', desde).lt('created_at', hasta).limit(3000);
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// Usuarios del panel e historial de cambios
// ---------------------------------------------------------------------------
async function buscarUsuario(usuario) {
  const { data, error } = await getClient().from('panel_usuarios').select('*').eq('usuario', usuario).maybeSingle();
  if (error) throw error;
  return data;
}
async function listarUsuarios() {
  const { data, error } = await getClient().from('panel_usuarios').select('usuario, nombre, perfil, activo, ultimo_ingreso, creado').order('nombre');
  if (error) throw error;
  return data || [];
}
async function guardarUsuario(fila) {
  const { data, error } = await getClient().from('panel_usuarios').upsert({ ...fila, actualizado: new Date().toISOString() }).select('usuario, nombre, perfil, activo').single();
  if (error) throw error;
  return data;
}
async function marcarIngreso(usuario) {
  await getClient().from('panel_usuarios').update({ ultimo_ingreso: new Date().toISOString() }).eq('usuario', usuario);
}
async function registrarHistorial(fila) {
  const { error } = await getClient().from('marce_historial').insert(fila);
  if (error) throw error;
}
async function leerHistorial({ desde, hasta, usuario }) {
  let q = getClient().from('marce_historial').select('*').order('fecha', { ascending: false }).limit(3000);
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lt('fecha', hasta);
  if (usuario) q = q.eq('usuario', usuario);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/** Registra la auditoría de cobertura hecha por el back office. */
async function auditarCobertura(id, { resultado, nota, auditor }) {
  return actualizarInteresado(id, {
    auditoria_cobertura: resultado, // 'confirmada' | 'sin_cobertura' | 'pendiente'
    auditoria_nota: nota || null,
    auditoria_por: auditor || null,
    auditoria_fecha: resultado === 'pendiente' ? null : new Date().toISOString(),
  });
}


// ---------- Importar historial (Excel) ----------
const soloDigitos = (x) => String(x || '').replace(/\D/g, '');
/** Llaves de las ventas que ya están en la base: OT y cuenta+cédula (para no repetir). */
async function llavesVentas() {
  const supabase = getClient();
  const ots = new Set(), cuentas = new Set(), cedDia = new Set();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from('ventas').select('numero_ot, numero_cuenta, cedula, created_at').range(desde, desde + 999);
    if (error) throw error;
    for (const v of data || []) {
      if (soloDigitos(v.numero_ot)) ots.add(soloDigitos(v.numero_ot));
      if (soloDigitos(v.numero_cuenta)) cuentas.add(soloDigitos(v.numero_cuenta) + '|' + soloDigitos(v.cedula));
      if (soloDigitos(v.cedula) && v.created_at) cedDia.add(soloDigitos(v.cedula) + '|' + new Date(new Date(v.created_at).getTime() - 5 * 3600e3).toISOString().slice(0, 10));
    }
    if (!data || data.length < 1000) break;
  }
  return { ots, cuentas, cedDia };
}
/** Inserta varias ventas de una vez. Si falta una columna en Supabase, se guarda igual (queda en "datos"). */
async function insertarVentasLote(filas) {
  if (!filas.length) return 0;
  const supabase = getClient();
  let rows = filas.map((f) => ({ ...f }));
  let { error } = await supabase.from('ventas').insert(rows);
  for (let i = 0; error && i < 10; i++) {
    const col = (error.message || '').match(/'([a-z_]+)' column|column "?([a-z_]+)"?/i);
    const nombre = col && (col[1] || col[2]);
    if (!nombre || nombre === 'datos' || !rows.some((r) => nombre in r)) break;
    rows = rows.map((r) => { const x = { ...r }; delete x[nombre]; return x; });
    ({ error } = await supabase.from('ventas').insert(rows));
  }
  if (error) throw error;
  return rows.length;
}
/** Borra solo lo que entró por la importación (session_id empieza por "import-"). */
async function deshacerImportacion() {
  const { data, error } = await getClient().from('ventas').delete().like('session_id', 'import-%').select('id');
  if (error) throw error;
  await getClient().from('interesados').delete().like('session_id', 'import-%'); // fichas creadas al abrir ventas importadas
  return (data || []).length;
}
async function contarImportadas() {
  const { count, error } = await getClient().from('ventas').select('id', { count: 'exact', head: true }).like('session_id', 'import-%');
  if (error) throw error;
  return count || 0;
}


// ---------- Campaña por día (un asesor que ese día trabajó en otra campaña) ----------
async function leerCampanasDia(desde, hasta) {
  let q = getClient().from('marce_campana_dia').select('*').order('fecha', { ascending: false }).limit(5000);
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lte('fecha', hasta);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
async function guardarCampanaDia(fecha, asesor, campana, por) {
  const t = getClient().from('marce_campana_dia');
  if (!campana) { const { error } = await t.delete().eq('fecha', fecha).eq('asesor', asesor); if (error) throw error; return null; }
  const { data, error } = await t.upsert({ fecha, asesor, campana, por: por || null, actualizado: new Date().toISOString() }).select().single();
  if (error) throw error;
  return data;
}


// ---------- 📉 Embudo de gestión: base diaria del marcador OCM ----------
async function guardarOcmDia(fila) {
  // Al volver a subir un día se borra su resumen histórico para recalcularlo (si la columna aún no existe, se guarda sin ella)
  const subir = (f) => getClient().from('marce_ocm_dia').upsert({ ...f, actualizado: new Date().toISOString() }).select('dia, campana, archivo, cargado_por, actualizado').single();
  let { data, error } = await subir({ ...fila, resumen: null });
  if (error && /resumen/.test(error.message)) ({ data, error } = await subir(fila));
  if (error) throw error;
  return data;
}
// ---------- Histórico del embudo: un resumen pequeño por día y campaña ----------
async function leerOcmResumenes(hasta) {
  const { data, error } = await getClient().from('marce_ocm_dia').select('dia, campana, total, resumen').lte('dia', hasta).order('dia').limit(2000);
  if (error) throw error;
  return data || [];
}
async function leerOcmFila(dia, campana) {
  const { data, error } = await getClient().from('marce_ocm_dia').select('*').eq('dia', dia).eq('campana', campana || '').single();
  if (error) throw error;
  return data;
}
async function guardarOcmResumen(dia, campana, resumen) {
  const { error } = await getClient().from('marce_ocm_dia').update({ resumen }).eq('dia', dia).eq('campana', campana || '');
  if (error) throw error;
}
// Ventas registradas en Marce entre dos instantes (solo id, celular y fecha)
async function ventasCreadasEntre(desde, hasta) {
  let filas = [];
  for (let i = 0; i < 20000; i += 1000) {
    const { data, error } = await getClient().from('ventas').select('id, telefono, created_at').gte('created_at', desde).lt('created_at', hasta).range(i, i + 999);
    if (error) throw error;
    filas = filas.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return filas;
}
async function leerOcmDias(desde, hasta) {
  const { data, error } = await getClient().from('marce_ocm_dia').select('*').gte('dia', desde).lte('dia', hasta).order('dia').limit(400);
  if (error) throw error;
  return data || [];
}
async function borrarOcmDia(dia, campana) {
  const { error } = await getClient().from('marce_ocm_dia').delete().eq('dia', dia).eq('campana', campana || '');
  if (error) throw error;
}
// Registros de Marce (interesados y ventas) que tienen alguno de estos celulares (10 dígitos)
async function marcePorTelefonos(tels) {
  const supabase = getClient();
  const unicos = [...new Set(tels.map((t) => String(t).replace(/\D/g, '').slice(-10)).filter((t) => t.length >= 7))];
  const ints = []; const vts = [];
  for (let i = 0; i < unicos.length; i += 40) {
    const or = unicos.slice(i, i + 40).map((n) => `telefono.ilike.%${n}%`).join(',');
    const [a, b] = await Promise.all([
      supabase.from('interesados').select('id, telefono, asesor, resultado, created_at, nombre_cliente').or(or).limit(1000),
      supabase.from('ventas').select('id, telefono, asesor, created_at, nombre_cliente, numero_ot, interesado_id, estado_instalacion, torre_salida, fecha_agenda').or(or).limit(1000),
    ]);
    if (a.error) throw a.error;
    if (b.error) throw b.error;
    ints.push(...(a.data || [])); vts.push(...(b.data || []));
  }
  return { interesados: ints, ventas: vts };
}

// ---------- 🗂 Gestión base de datos: bases preparadas por día y archivo ----------
async function guardarBaseDia(fila) {
  const { data, error } = await getClient().from('marce_base_dia').upsert({ ...fila, actualizado: new Date().toISOString() }).select('dia, archivo, fuente, total').single();
  if (error) throw error;
  return data;
}
async function leerBasesDia(dia) {
  const { data, error } = await getClient().from('marce_base_dia').select('*').eq('dia', dia).limit(200);
  if (error) throw error;
  return data || [];
}
async function diasBases() {
  const { data, error } = await getClient().from('marce_base_dia').select('dia, archivo, fuente, total').order('dia', { ascending: false }).limit(3000);
  if (error) throw error;
  return data || [];
}
async function borrarBaseDia(dia, archivo) {
  let q = getClient().from('marce_base_dia').delete().eq('dia', dia);
  if (archivo) q = q.eq('archivo', archivo);
  const { error } = await q;
  if (error) throw error;
}
async function interesadosDelDia(fecha) {
  const desde = new Date(`${fecha}T00:00:00-05:00`).toISOString();
  const hasta = new Date(new Date(desde).getTime() + 86400000).toISOString();
  const { data, error } = await getClient().from('interesados').select('id, telefono, asesor, resultado').gte('created_at', desde).lt('created_at', hasta).limit(5000);
  if (error) throw error;
  return data || [];
}
async function diasOcm() {
  const { data, error } = await getClient().from('marce_ocm_dia').select('dia, campana, total, actualizado').order('dia', { ascending: false }).limit(120);
  if (error) throw error;
  return data || [];
}
async function leerOcmDia(dia) {
  const { data, error } = await getClient().from('marce_ocm_dia').select('*').eq('dia', dia);
  if (error) throw error;
  return data || [];
}

/** Ventas con fecha de instalación (agenda o reagenda) entre dos días AAAA-MM-DD, sin importar cuándo se vendieron. */
async function ventasPorAgenda(desde, hasta) {
  const supabase = getClient();
  const dias = [];
  for (let d = new Date(desde + 'T12:00:00Z'), fin = new Date(hasta + 'T12:00:00Z'); d <= fin && dias.length < 400; d.setUTCDate(d.getUTCDate() + 1)) dias.push(d.toISOString().slice(0, 10));
  const formatos = (f) => { const [a, m, d] = f.split('-'); return [...new Set([`${d}/${m}/${a}`, `${+d}/${+m}/${a}`, `${d}/${+m}/${a}`, `${+d}/${m}/${a}`, f])]; };
  const m = new Map();
  for (let i = 0; i < dias.length; i += 15) {
    const lote = dias.slice(i, i + 15).flatMap(formatos);
    for (let desdeFila = 0; desdeFila < 20000; desdeFila += 1000) {
      const { data, error } = await supabase.from('ventas').select('*').in('fecha_agenda', lote).range(desdeFila, desdeFila + 999);
      if (error) throw error;
      for (const v of data || []) m.set(v.id, v);
      if (!data || data.length < 1000) break;
    }
  }
  const r = await supabase.from('ventas').select('*').gte('torre_fecha_reagenda', desde).lte('torre_fecha_reagenda', hasta).limit(5000);
  if (!r.error) for (const v of r.data || []) m.set(v.id, v);
  return [...m.values()];
}


/** Ventas que la torre o el BO gestionaron en un día (cualquier fecha de agenda). */
async function ventasGestionadasDia(fecha) {
  const desde = new Date(`${fecha}T00:00:00-05:00`).toISOString();
  const hasta = new Date(new Date(desde).getTime() + 86400000).toISOString();
  const m = new Map();
  for (const col of ['torre_fecha', 'instalacion_fecha']) {
    const { data, error } = await getClient().from('ventas').select('*').gte(col, desde).lt(col, hasta).limit(3000);
    if (!error) for (const v of data || []) m.set(v.id, v);
  }
  return [...m.values()];
}


/** Abre un cliente por id de interesado o de venta. Las ventas importadas del Excel no tienen ficha de cliente:
 *  la primera vez que se abren se le crea su ficha y se enlaza la venta (no cambia nada más de la venta). */
async function obtenerClienteOVenta(id) {
  const supabase = getClient();
  const { data: i, error: e1 } = await supabase.from('interesados').select('*').eq('id', id).maybeSingle();
  if (e1 && !/uuid/i.test(e1.message)) throw e1;
  if (i) return (await adjuntarVentas([i]))[0];
  const { data: v, error: e2 } = await supabase.from('ventas').select('*').eq('id', id).maybeSingle();
  if (e2) throw e2;
  if (!v) throw new Error('ese cliente ya no existe');
  if (v.interesado_id) return obtenerCliente(v.interesado_id);
  // ¿Ya existía el interesado (mismo celular)? Se enlaza a ese en vez de crear otro
  const previo = interesadoDeVenta(v, await mapaInteresadosPorCelular());
  if (previo) {
    await supabase.from('ventas').update({ interesado_id: previo.id }).eq('id', v.id);
    if (previo.resultado !== 'venta') await supabase.from('interesados').update({ resultado: 'venta', updated_at: new Date().toISOString() }).eq('id', previo.id);
    return obtenerCliente(previo.id);
  }
  const fila = {
    session_id: 'import-' + v.id, asesor: v.asesor || null, nombre_cliente: v.nombre_cliente || null, telefono: v.telefono || null,
    direccion: v.direccion || null, ciudad: v.ciudad || null, cobertura_validada: 'Sí', resultado: 'venta',
    datos: { origen: 'ficha_de_venta_importada', venta_id: v.id }, created_at: v.created_at, updated_at: new Date().toISOString(),
  };
  const { data: nuevo, error: e3 } = await supabase.from('interesados').insert(fila).select().single();
  if (e3) throw e3;
  await supabase.from('ventas').update({ interesado_id: nuevo.id }).eq('id', v.id);
  return (await adjuntarVentas([nuevo]))[0];
}


// ---------- Enlazar ventas importadas con el interesado que ya existía (mismo celular) ----------
const digTel = (t) => String(t || '').split('/').map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10);
/** Mapa celular → interesados (todos), para encontrar la ficha de una venta importada. */
async function mapaInteresadosPorCelular() {
  const m = new Map();
  for (let desde = 0; desde < 100000; desde += 1000) {
    const { data, error } = await getClient().from('interesados').select('id, telefono, asesor, resultado, created_at').order('created_at', { ascending: false }).range(desde, desde + 999);
    if (error) throw error;
    for (const i of data || []) for (const t of digTel(i.telefono)) { if (!m.has(t)) m.set(t, []); m.get(t).push(i); }
    if (!data || data.length < 1000) break;
  }
  return m;
}
/** El interesado de una venta: mismo celular; si hay varios, el del mismo asesor y el más reciente. */
function interesadoDeVenta(v, mapa) {
  const cands = digTel(v.telefono).flatMap((t) => mapa.get(t) || []);
  if (!cands.length) return null;
  return cands.find((i) => i.asesor && v.asesor && i.asesor.toLowerCase() === v.asesor.toLowerCase()) || cands[0];
}
/** Enlaza las ventas importadas que aún no tienen ficha con su interesado y lo marca como "venta". */
async function enlazarVentasImportadas() {
  const supabase = getClient();
  const mapa = await mapaInteresadosPorCelular();
  let revisadas = 0, enlazadas = 0;
  const pendientes = [];
  for (let desde = 0; desde < 50000; desde += 1000) {
    const { data, error } = await supabase.from('ventas').select('id, telefono, asesor, interesado_id').like('session_id', 'import-%').is('interesado_id', null).order('id').range(desde, desde + 999);
    if (error) throw error;
    pendientes.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const marcar = new Set();
  for (const v of pendientes) {
    revisadas += 1;
    const i = interesadoDeVenta(v, mapa);
    if (!i) continue;
    const { error: e } = await supabase.from('ventas').update({ interesado_id: i.id }).eq('id', v.id);
    if (e) throw e;
    if (i.resultado !== 'venta') { marcar.add(i.id); i.resultado = 'venta'; }
    enlazadas += 1;
  }
  if (marcar.size) await marcarInteresadosVenta([...marcar]);
  return { revisadas, enlazadas };
}


async function marcarInteresadosVenta(ids) {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await getClient().from('interesados').update({ resultado: 'venta', updated_at: new Date().toISOString() }).in('id', ids.slice(i, i + 200));
    if (error) throw error;
  }
}


// ---------- 👤 Base asignada por asesor (cédula) ----------
const BA = 'marce_base_asesor';
async function insertarBaseAsesor(filas) {
  let n = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await getClient().from(BA).insert(filas.slice(i, i + 500));
    if (error) throw error;
    n += Math.min(500, filas.length - i);
  }
  return n;
}
// Máximo 2 clientes a la vez: los que ya tiene en gestión + los siguientes pendientes
async function tomarBaseAsesor(cedula, max = 2) {
  const c = getClient();
  const { data: actuales, error } = await c.from(BA).select('*').eq('cedula', cedula).eq('estado', 'en_gestion').order('id').limit(max);
  if (error) throw error;
  const lista = actuales || [];
  if (lista.length < max) {
    const { data: nuevos, error: e2 } = await c.from(BA).select('id').eq('cedula', cedula).eq('estado', 'pendiente').order('id').limit(max - lista.length);
    if (e2) throw e2;
    const ids = (nuevos || []).map((x) => x.id);
    if (ids.length) {
      const { data: tomados, error: e3 } = await c.from(BA).update({ estado: 'en_gestion', tomado_at: new Date().toISOString() }).in('id', ids).eq('estado', 'pendiente').select('*');
      if (e3) throw e3;
      lista.push(...(tomados || []));
    }
  }
  return lista;
}
async function leerBaseAsesorCampos(cedula, campos) {
  let filas = [];
  for (let i = 0; i < 50000; i += 1000) {
    let q = getClient().from(BA).select(campos).order('id').range(i, i + 999);
    if (cedula) q = q.eq('cedula', cedula);
    const { data, error } = await q;
    if (error) throw error;
    filas = filas.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return filas;
}
async function seguimientosBaseAsesor(cedula) {
  const { data, error } = await getClient().from(BA).select('*').eq('cedula', cedula).eq('estado', 'seguimiento').order('seguimiento_fecha', { ascending: true, nullsFirst: false }).limit(300);
  if (error) throw error;
  return data || [];
}
async function gestionadosBaseAsesor(cedula, desdeIso) {
  const { data, error } = await getClient().from(BA).select('*').eq('cedula', cedula).gte('gestionado_at', desdeIso).order('gestionado_at', { ascending: false }).limit(300);
  if (error) throw error;
  return data || [];
}
async function guardarResultadoBase(id, cedula, campos) {
  const { data, error } = await getClient().from(BA).update(campos).eq('id', id).eq('cedula', cedula).select('*').maybeSingle();
  if (error) throw error;
  return data;
}
async function leerFilaBase(id) {
  const { data, error } = await getClient().from(BA).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function detalleBaseAsesor(cedula, lote) {
  let filas = [];
  for (let i = 0; i < 20000; i += 1000) {
    let q = getClient().from(BA).select('*').order('id').range(i, i + 999);
    if (cedula) q = q.eq('cedula', cedula);
    if (lote) q = q.eq('lote', lote);
    const { data, error } = await q;
    if (error) throw error;
    filas = filas.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return filas;
}
async function accionBaseAsesor(accion, { cedula, lote, aCedula, aNombre }) {
  const c = getClient();
  let q;
  if (accion === 'reciclar') q = c.from(BA).update({ estado: 'pendiente', tomado_at: null }).eq('cedula', cedula).eq('estado', 'no_contesto');
  else if (accion === 'liberar') q = c.from(BA).update({ estado: 'pendiente', tomado_at: null }).eq('cedula', cedula).eq('estado', 'en_gestion');
  else if (accion === 'quitar') q = c.from(BA).delete().eq('cedula', cedula).eq('estado', 'pendiente');
  else if (accion === 'reasignar') q = c.from(BA).update({ cedula: aCedula, asesor: aNombre || null }).eq('cedula', cedula).in('estado', ['pendiente', 'en_gestion']);
  else throw new Error('Acción no válida');
  if (lote) q = q.eq('lote', lote);
  const { data, error } = await q.select('id');
  if (error) throw error;
  return (data || []).length;
}

module.exports = {
  insertarBaseAsesor, tomarBaseAsesor, leerBaseAsesorCampos, seguimientosBaseAsesor, gestionadosBaseAsesor, guardarResultadoBase, leerFilaBase, detalleBaseAsesor, accionBaseAsesor,
  marcarInteresadosVenta,
  mapaInteresadosPorCelular, interesadoDeVenta, enlazarVentasImportadas,
  obtenerClienteOVenta,
  ventasGestionadasDia,
  ventasPorAgenda,
  leerCampanasDia, guardarCampanaDia,
  guardarOcmDia, leerOcmDias, borrarOcmDia, marcePorTelefonos, leerOcmResumenes, leerOcmFila, guardarOcmResumen, ventasCreadasEntre,
  guardarBaseDia, leerBasesDia, diasBases, borrarBaseDia, leerOcmDia, diasOcm, interesadosDelDia,
  llavesVentas, insertarVentasLote, deshacerImportacion, contarImportadas,
  panelDatos,
  auditarCobertura,
  crearInteresado,
  actualizarInteresado,
  guardarVenta,
  obtenerCliente,
  buscarClientes,
  buscarPorTelefono,
  resumenDeHoy,
  clientesDeHoy,
  rellamadasPendientes,
  escalamientosDeAsesor,
  ventasDeAsesor,
  actualizarVenta,
  obtenerVenta,
  otActivasDeAsesor,
  leerConfig,
  guardarConfig,
  eliminarVenta,
  eliminarInteresado,
  alertasCobertura,
  buscarAsesor,
  listarAsesores,
  guardarAsesor,
  renombrarAsesor,
  conteoPorAsesor,
  actualizarVentasDeInteresado,
  todasLasDirecciones,
  actualizarDireccion,
  agendaDelDia,
  buscarUsuario,
  listarUsuarios,
  guardarUsuario,
  marcarIngreso,
  registrarHistorial,
  leerHistorial,
  ventasDelDia,
};
