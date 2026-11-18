// Copiloto de Daniela dentro de Chattigo (cola "Beneficio tributario Autos Sura").
// Chattigo no tiene API para nosotros: la extensión de Chrome lee el chat abierto en la pantalla del agente y lo manda
// aquí. Daniela devuelve el SIGUIENTE mensaje sugerido (el agente lo revisa y lo envía él mismo) y, por detrás, crea o
// actualiza el caso, sube los documentos con su tipo y pide el contrato, igual que en WhatsApp.
// La guía de atención está en prompt_chattigo.md (base de conocimiento de Chattigo).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sincronizarTodo } = require('./wasapi_caso');
const { llamarClaude, parsearJSON, limpiarTexto, tarifaUpme } = require('./wasapi').ia;

const GUIA = fs.readFileSync(path.join(__dirname, 'prompt_chattigo.md'), 'utf8');
const CIERRE = () => String(process.env.CHATTIGO_CIERRE || 'Lina Marcela Bedoya,Lina Margod Betancur').split(',').map((x) => x.trim()).filter(Boolean);
const digitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');
const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const SALIDA = `
FORMA DE TRABAJO EN ESTA HERRAMIENTA (manda sobre la guía cuando hablen de lo mismo)
- Eres el copiloto de un agente humano de Chattigo. Tú NO envías nada: redactas el SIGUIENTE mensaje que el agente le va a enviar al cliente, como Daniela de Gómez Legal Abogados en representación de SURA. El agente lo revisa y lo envía.
- Lee TODA la conversación. Si el último mensaje es del agente y el cliente no ha respondido, sugiere un seguimiento corto o deja "respuesta" vacía si no hace falta escribir.
- Mensajes cortos, una sola pregunta, de usted, sin listas ni negritas, sin marcadores tipo [nombre].
- Si el chat no es del beneficio tributario (cita médica, técnico-mecánica, arrendamiento), accion = "no_atender".
- Si algo requiere aprobación del equipo o no está en la guía, accion = "preguntar_grupo", escribe en "nota_equipo" la pregunta para el grupo de Teams "GLA Novedades atención" y en "respuesta" un mensaje que no afirme nada sobre ese punto.
- Si el expediente está completo y en orden según la guía (factura, RUT vigente y cédula completos, sin nada que no cuadre), accion = "transferir_cierre" y "respuesta" vacía (se transfiere sin avisar al cliente).
- Si el cliente pide hablar con alguien: "respuesta" = "Un asesor del equipo se comunicará con usted." y accion = "preguntar_grupo" con la nota para el grupo.
- Si un archivo no se puede leer, usa la respuesta fija de la guía y accion = "preguntar_grupo".

RESPONDE SOLO con un JSON válido (sin texto alrededor):
{"respuesta":"mensaje sugerido para el cliente o vacío","accion":"responder|preguntar_grupo|transferir_cierre|no_atender","nota_equipo":"texto para el grupo de Teams o null","alertas":["empresa","dos_propietarios","rut_vencido","iva_19","leasing","otro..."],"faltan":["lo que falta del expediente"],"archivos_tipos":[],"datos_archivos":"resumen breve de lo leído en los archivos nuevos o null","perfil":{"nombre":null,"nombre_completo":null,"cedula":null,"correo":null,"marca_modelo":null,"tipo_vehiculo":null,"fecha_compra":null,"titular_factura":null,"tiene_certificado_upme":null,"ciudad":null,"valor_sin_iva":null,"interesado":null,"precio_informado":null,"acepta_avanzar":null,"medios_pago_informados":null,"documentos_recibidos":[],"pago_honorarios_recibido":null,"dos_propietarios":null,"notas":null}}
En "perfil" pon solo lo que sepas (se conserva lo anterior). "cedula": solo números (si la factura es de empresa, el NIT sin dígito de verificación). "fecha_compra" en formato AAAA-MM-DD si la sabes. "archivos_tipos": un tipo por cada ARCHIVO NUEVO adjunto en este mensaje, en el mismo orden: "factura", "rut", "cedula", "certificacion_bancaria", "certificado_upme", "soporte_pago" u "otro".`;

function fichaVisible(p) { const o = {}; for (const [k, v] of Object.entries(p || {})) if (!k.startsWith('_')) o[k] = v; return o; }

function transcripcion(mensajes) {
  return (mensajes || []).slice(-80).map((m) => {
    const quien = m.rol === 'cliente' ? 'CLIENTE' : m.rol === 'agente' ? 'AGENTE' : 'SISTEMA';
    return `${quien}${m.hora ? ' (' + m.hora + ')' : ''}: ${String(m.texto || '').trim() || (m.archivo ? '[envió un archivo: ' + m.archivo + ']' : '')}`;
  }).join('\n');
}

async function siguienteCierre(sb) {
  const lista = CIERRE();
  try {
    const { data } = await sb.from('wasapi_conversaciones').select('perfil').eq('wa_id', '__chattigo_turno__').maybeSingle();
    const n = Number(((data || {}).perfil || {}).n) || 0;
    await sb.from('wasapi_conversaciones').upsert({ wa_id: '__chattigo_turno__', perfil: { n: n + 1 }, estado: 'sistema', actualizado_en: new Date().toISOString() }, { onConflict: 'wa_id' });
    return lista[n % lista.length];
  } catch (_) { return lista[0]; }
}

module.exports = function montarChattigo(app, { sbServicio }) {
  app.get('/api/chattigo/salud', (req, res) => res.json({ ok: true, guia: GUIA.length, cierre: CIERRE() }));

  app.post('/api/chattigo/sugerir', async (req, res) => {
    if (process.env.CHATTIGO_TOKEN && req.get('x-copiloto-token') !== process.env.CHATTIGO_TOKEN) return res.status(401).json({ error: 'Token del copiloto no válido.' });
    const { telefono, nombre, mensajes, archivos, asesor, pedido } = req.body || {};
    if (!Array.isArray(mensajes) || !mensajes.length) return res.status(400).json({ error: 'No llegó la conversación.' });
    const tel = digitos(telefono).slice(-10);
    const clave = 'chattigo-' + (tel.length === 10 ? '57' + tel : 'n-' + crypto.createHash('sha1').update(String(nombre || '')).digest('hex').slice(0, 12));
    const sb = sbServicio();
    try {
      const { data: fila } = await sb.from('wasapi_conversaciones').select('*').eq('wa_id', clave).maybeSingle();
      const perfil = Object.assign({ origen: 'SURA' }, (fila && fila.perfil) || {});
      if (nombre && !/^\+?\d[\d\s]+$/.test(nombre) && !perfil.nombre) perfil.nombre = String(nombre).trim();
      const leidos = new Set(perfil._leidos || []);
      perfil._tipos = perfil._tipos || {};

      // Archivos: se decodifican; solo los NUEVOS van a la IA (los demás ya se leyeron antes).
      const todos = (Array.isArray(archivos) ? archivos : []).slice(-8).map((a) => {
        const buf = Buffer.from(String(a.base64 || ''), 'base64');
        const hash = a.hash || crypto.createHash('sha1').update(buf).digest('hex');
        return { buf, hash, nombre: a.nombre || 'archivo', mime: String(a.mime || '').toLowerCase() };
      }).filter((a) => a.buf.length > 0 && a.buf.length < 20 * 1024 * 1024);
      const nuevos = todos.filter((a) => !leidos.has(a.hash) && MIMES.includes(a.mime)).slice(0, 4);
      const bloques = [];
      nuevos.forEach((a, i) => {
        bloques.push({ type: 'text', text: `ARCHIVO NUEVO ${i + 1}: ${a.nombre}` });
        bloques.push(a.mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.buf.toString('base64') } }
          : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.buf.toString('base64') } });
      });

      const t = tarifaUpme(perfil.valor_sin_iva);
      const sistema = GUIA + '\n' + SALIDA +
        '\n\nFICHA ACTUAL DEL CLIENTE (JSON): ' + JSON.stringify(fichaVisible(perfil)) +
        (t ? '\nTARIFA UPME DE ESTE CLIENTE (calculadora oficial UPME): ' + t.texto + '. Úsala tal cual si hablas de la tarifa de la UPME.' : '');
      const texto = 'CONVERSACIÓN EN CHATTIGO (la más reciente al final):\n' + transcripcion(mensajes) +
        (pedido ? '\n\nINDICACIÓN DEL AGENTE PARA ESTA RESPUESTA: ' + String(pedido).slice(0, 500) : '') +
        '\n\nRedacta el siguiente mensaje del agente y responde con el JSON.';
      const bruto = await llamarClaude(sistema, [{ role: 'user', content: [...bloques, { type: 'text', text: texto }] }]);
      const j = parsearJSON(bruto) || {};

      // Ficha: se conserva lo anterior y se suma lo nuevo.
      if (j.perfil) for (const [k, v] of Object.entries(j.perfil)) if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) perfil[k] = v;
      const tipos = Array.isArray(j.archivos_tipos) ? j.archivos_tipos : [];
      nuevos.forEach((a, i) => { perfil._tipos[a.hash] = String(tipos[i] || 'otro').toLowerCase(); leidos.add(a.hash); });
      perfil._leidos = Array.from(leidos).slice(-60);
      if (j.datos_archivos) perfil.notas = String((perfil.notas ? perfil.notas + ' | ' : '') + j.datos_archivos).slice(-1500);
      if (Array.isArray(j.alertas) && j.alertas.length) perfil.alertas = Array.from(new Set([...(perfil.alertas || []), ...j.alertas.map(String)]));

      let accion = ['responder', 'preguntar_grupo', 'transferir_cierre', 'no_atender'].includes(j.accion) ? j.accion : 'responder';
      let transferirA = null;
      if (accion === 'transferir_cierre') transferirA = perfil._cierre_asignado || (perfil._cierre_asignado = await siguienteCierre(sb));

      // Igual que WhatsApp: caso, documentos con su tipo y contrato automático (solo si se conoce el celular).
      if (tel.length === 10) {
        const conTipo = todos.map((a) => ({ ...a, tipo: perfil._tipos[a.hash] })).filter((a) => a.tipo);
        await sincronizarTodo({ perfil, waId: '57' + tel, archivos: conTipo, sb, bajarArchivo: null,
          opciones: { canal: 'Chattigo', asesor: 'Daniela (Chattigo' + (asesor ? ' · ' + String(asesor).slice(0, 40) : '') + ')', prefijo: 'ct', origen: 'chattigo' } });
      }
      await sb.from('wasapi_conversaciones').upsert({ wa_id: clave, perfil, estado: 'copiloto', from_id: null, actualizado_en: new Date().toISOString(),
        mensajes: (mensajes || []).slice(-60).map((m) => ({ rol: m.rol === 'cliente' ? 'cliente' : 'agente', texto: String(m.texto || '').slice(0, 2000), hora: m.hora || null })) }, { onConflict: 'wa_id' });

      let caso = null;
      if (perfil._caso_id) {
        const { data } = await sb.from('Perfilamiento_y_ventas_GLA').select('id,nombre_cliente,estado_pipeline').eq('id', perfil._caso_id).maybeSingle();
        caso = data || null;
      }
      res.json({
        respuesta: limpiarTexto(String(j.respuesta || '')),
        accion, transferir_a: transferirA, nota_equipo: j.nota_equipo || null,
        alertas: perfil.alertas || [], faltan: Array.isArray(j.faltan) ? j.faltan : [],
        caso, documentos: perfil._docs || [], contrato_pedido: !!perfil._contrato_pedido,
        sin_telefono: tel.length !== 10, archivos_leidos: nuevos.length,
      });
    } catch (e) {
      console.error('chattigo/sugerir:', e);
      res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
  });
};
