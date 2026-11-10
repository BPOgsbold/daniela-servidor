// Simula el webhook de API Bot sin credenciales reales.
// Uso: node scripts/probar_chattigo_webhook.js
const express = require('express');
const { interpretarSalida, FRASE_TRASPASO } = require('../atencion_comun');

process.env.CHATTIGO_WEBHOOK_TOKEN = 'tok-prueba';
process.env.CHATTIGO_API_BASE = 'https://chattigo-api.ejemplo';
process.env.CHATTIGO_USUARIO = 'bot';
process.env.CHATTIGO_CLAVE = 'clave-secreta';
process.env.CHATTIGO_ESPERA_MS = '30';
process.env.CHATTIGO_PAUSA_MS = '0';
process.env.CHATTIGO_ID_CAMPANA = '';
process.env.CHATTIGO_GRUPO = '';
process.env.ANTHROPIC_API_KEY = 'test-no-real';
process.env.WASAPI_ESPERA_MS = '600000';
delete process.env.CHATTIGO_CONTENIDO_TRASPASO;
delete process.env.CHATTIGO_IDUSER_ES_AGENTE;
delete process.env.CHATTIGO_REANUDAR_TRAS_AGENTE;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert falló');
}

const PERFIL_OK = {
  nombre: 'Ana Ruiz',
  marca_modelo: 'BYD Seagull',
  tipo_vehiculo: 'automovil',
  compro_nuevo: true,
  primer_dueno: true,
  fecha_compra: '2024-01-01',
  titular_factura: 'Ana',
  tiene_certificado_upme: 'si',
  ciudad: 'Medellin',
  saldos_dian: 'no',
  origen: 'SURA',
  acepta_avanzar: true,
  documentos_recibidos: ['factura', 'rut', 'cedula'],
};

function probarTraspaso() {
  const incompleto = interpretarSalida({
    bruto: JSON.stringify({ respuesta: '****', traspasar: true, motivo_traspaso: 'completo', perfil: {} }),
    perfilPrevio: {},
    prefijo: 'test',
  });
  assert(incompleto.estado === 'bot', 'una ficha vacía no se traspasa');
  assert(/nombre/.test(incompleto.partes[0]), 'pregunta el primer dato que falta: ' + incompleto.partes[0]);

  const causaMala = interpretarSalida({
    bruto: JSON.stringify({ respuesta: 'sigo con usted', traspasar: true, motivo_traspaso: 'escalamiento', causa_escalamiento: 'inventada', perfil: {} }),
    perfilPrevio: {},
    prefijo: 'test',
  });
  assert(causaMala.estado === 'bot', 'una causa de escalamiento desconocida no traspasa');
  assert(causaMala.partes[0] === 'sigo con usted', causaMala.partes[0]);

  const completo = interpretarSalida({
    bruto: JSON.stringify({ respuesta: '', traspasar: true, motivo_traspaso: 'completo', perfil: PERFIL_OK }),
    perfilPrevio: {},
    prefijo: 'test',
  });
  assert(completo.estado === 'humano', 'la ficha completa sí se traspasa');
  assert(completo.partes[0].includes('Ana') && !completo.partes[0].includes('Ruiz'), completo.partes[0]);
  assert(completo.partes[1] === FRASE_TRASPASO, 'cierra con la frase de traspaso');
}

function memoria() {
  const tablas = new Map();
  function filas(tabla) {
    if (!tablas.has(tabla)) tablas.set(tabla, []);
    return tablas.get(tabla);
  }
  return {
    filas,
    from(tabla) {
      const estado = { filtros: [] };
      const api = {
        select() { return api; },
        eq(col, val) { estado.filtros.push([col, val]); return api; },
        maybeSingle: async () => {
          const row = filas(tabla).find((r) => estado.filtros.every(([c, v]) => r[c] === v));
          return { data: row ? JSON.parse(JSON.stringify(row)) : null, error: null };
        },
        upsert: async (row) => {
          const rows = filas(tabla);
          const i = rows.findIndex((r) => r.id === row.id);
          const copia = JSON.parse(JSON.stringify(row));
          if (i >= 0) rows[i] = copia;
          else rows.push(copia);
          return { data: copia, error: null };
        },
      };
      return api;
    },
  };
}

function respuestaHttp(status, obj) {
  const texto = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => texto,
    arrayBuffer: async () => Buffer.from(texto),
  };
}

const llamadas = [];
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return fetchReal(url, opts);
  llamadas.push({ url: u, opts });
  if (u.includes('api.anthropic.com')) {
    const plano = String(opts.body || '');
    let salida;
    if (plano.includes('__CASO_TRASPASO__')) salida = { respuesta: '', traspasar: true, motivo_traspaso: 'completo', perfil: PERFIL_OK };
    else if (plano.includes('__CASO_ESCALA__')) salida = { respuesta: 'entendido', traspasar: true, motivo_traspaso: 'escalamiento', causa_escalamiento: 'pide_llamada', perfil: {} };
    else if (plano.includes('__CASO_INCOMPLETO__')) salida = { respuesta: '', traspasar: true, motivo_traspaso: 'completo', perfil: {} };
    else salida = { respuesta: 'Hola, le ayudo con el beneficio.\n\n¿Me confirma su nombre?', traspasar: false, perfil: {} };
    return respuestaHttp(200, { content: [{ type: 'text', text: JSON.stringify(salida) }] });
  }
  if (u.endsWith('/login')) return respuestaHttp(200, { access_token: 'jwt-prueba' });
  if (u.endsWith('/outbound')) return respuestaHttp(200, { code: '200', message: 'Message sent' });
  if (u.startsWith('https://archivos.ejemplo/')) {
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => String(h).toLowerCase() === 'content-type' ? 'application/pdf' : null },
      arrayBuffer: async () => Buffer.from('%PDF-1.4 factura de Ana'),
      text: async () => '',
      json: async () => ({}),
    };
  }
  return respuestaHttp(404, { error: 'no' });
};

function entrada(over) {
  return Object.assign({
    id: 364096945,
    idChat: 29289561,
    did: '573175180237',
    msisdn: '573127439126',
    idUser: 0,
    type: 'Text',
    channel: 'WHATSAPP',
    channelProvider: 'WAVY',
    content: 'Hola, quiero el beneficio',
    name: 'Camila Ochoa',
    idCampaign: 597,
    isAttachment: false,
    attachment: null,
    message: null,
  }, over);
}

function outs(desde) {
  return llamadas.slice(desde).filter((l) => l.url.endsWith('/outbound')).map((l) => JSON.parse(l.opts.body));
}
function nAnthropic(desde) {
  return llamadas.slice(desde).filter((l) => l.url.includes('api.anthropic.com')).length;
}
async function hasta(fn, que) {
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout: ' + que);
}
async function post(port, path, body) {
  const r = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  probarTraspaso();
  const sb = memoria();
  const deps = { obtenerConocimientoTexto: async () => '', sbServicio: () => sb };
  const app = express();
  app.use(express.json());
  require('../chattigo')(app, deps);
  require('../wasapi')(app, deps);

  const port = await new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv.address().port));
  });

  const salud = await (await fetch('http://127.0.0.1:' + port + '/api/chattigo/salud')).json();
  assert(salud.ok === true, 'salud ok');
  assert(salud.api_base === 'https://chattigo-api.ejemplo', 'salud publica la base, no la clave');
  assert(salud.clave_configurada === true && salud.usuario_configurado === true, 'salud marca credenciales');
  assert(!JSON.stringify(salud).includes('clave-secreta'), 'salud no filtra la clave');
  assert(salud.rutas.outbound === 'POST {CHATTIGO_API_BASE}/outbound');
  const saludWasapi = await (await fetch('http://127.0.0.1:' + port + '/api/wasapi/salud')).json();
  assert(saludWasapi.ok === true, 'wasapi salud sigue viva');
  const ping = await post(port, '/api/wasapi/webhook', { event: 'ping' });
  assert(ping.status === 200, 'wasapi webhook sigue respondiendo 200');

  const tok = '/api/chattigo/webhook?token=tok-prueba';
  let desde = llamadas.length;
  const primero = await post(port, tok, entrada({}));
  assert(primero.status === 200 && primero.json.ok === true, 'webhook 200');
  await hasta(() => outs(desde).length >= 2, 'dos burbujas de texto');
  const textos = outs(desde);
  assert(textos.length === 2, 'solo dos envíos, sin traspaso: ' + textos.map((t) => t.type).join(','));
  assert(textos.every((t) => t.type === 'text'), 'type text');
  assert(textos[0].content.includes('beneficio') && textos[1].content.includes('nombre'), textos.map((t) => t.content).join(' | '));
  assert(textos[0].did === '573175180237' && textos[0].msisdn === '573127439126', 'did y msisdn');
  assert(textos[0].channel === 'WHATSAPP' && textos[0].channelProvider === 'WAVY', 'canal');
  assert(textos[0].id === 364096945 && textos[0].idChat === 29289561 && textos[0].idCampaign === 597, 'ids del ejemplo');
  assert(textos[0].name === 'Daniela' && textos[0].botName === 'Daniela', 'nombre del bot');
  const login = llamadas.slice(desde).find((l) => l.url === 'https://chattigo-api.ejemplo/login');
  assert(login && JSON.parse(login.opts.body).username === 'bot' && JSON.parse(login.opts.body).password === 'clave-secreta', 'login documentado');
  assert(llamadas.slice(desde).find((l) => l.url.endsWith('/outbound')).opts.headers.Authorization === 'Bearer jwt-prueba', 'Bearer JWT');
  const fila = sb.filas('chattigo_conversaciones').find((r) => r.id === 'chattigo:573175180237:573127439126');
  assert(fila && fila.estado === 'bot' && fila.mensajes.some((m) => m.rol === 'daniela'), 'guarda la conversación aparte de Wasapi');
  assert(sb.filas('wasapi_conversaciones').length === 0, 'no escribe en la tabla de Wasapi');

  const antesDedupe = llamadas.filter((l) => l.url.endsWith('/outbound')).length;
  await post(port, tok, entrada({}));
  await new Promise((r) => setTimeout(r, 200));
  assert(llamadas.filter((l) => l.url.endsWith('/outbound')).length === antesDedupe, 'dedupe por id');

  desde = llamadas.length;
  const malo = await post(port, '/api/chattigo/webhook?token=otro', entrada({ id: 2, content: 'no deberías leerme' }));
  assert(malo.status === 200, 'token malo igual responde 200, como Wasapi, y no procesa');
  await new Promise((r) => setTimeout(r, 200));
  assert(outs(desde).length === 0 && nAnthropic(desde) === 0, 'token malo no llama a Claude ni a Chattigo');

  desde = llamadas.length;
  await post(port, tok, entrada({
    id: 3,
    msisdn: '573000000002',
    type: 'media',
    isAttachment: true,
    content: 'le dejo la factura',
    attachment: { mediaUrl: 'https://archivos.ejemplo/factura.pdf', mimeType: 'application/pdf', fileName: 'factura.pdf' },
  }));
  await hasta(() => outs(desde).length >= 1, 'respuesta al pdf');
  const iaPdf = llamadas.slice(desde).find((l) => l.url.includes('api.anthropic.com'));
  assert(iaPdf && iaPdf.opts.body.includes('"type":"document"') && iaPdf.opts.body.includes('application/pdf'), 'el PDF se lee como documento');

  desde = llamadas.length;
  await post(port, tok, entrada({ id: 4, msisdn: '573000000003', content: '__CASO_ESCALA__ por favor' }));
  await hasta(() => outs(desde).some((o) => o.type === 'transfer'), 'traspaso mono-campaña');
  const escala = outs(desde);
  assert(escala.map((o) => o.type).join(',') === 'text,internal,transfer', escala.map((o) => o.type).join(','));
  assert(escala[0].content === FRASE_TRASPASO, 'el cliente recibe la frase de traspaso');
  assert(escala[1].type === 'internal' && escala[1].content.includes('pide_llamada'), 'la nota interna no va al cliente');
  assert(!Object.prototype.hasOwnProperty.call(escala[2], 'idCampaign'), 'mono-campaña no manda idCampaign');
  assert(escala[2].content === 'escalamiento:pide_llamada', escala[2].content);
  assert(sb.filas('chattigo_conversaciones').find((r) => r.msisdn === '573000000003').estado === 'humano');

  desde = llamadas.length;
  await post(port, tok, entrada({ id: 5, msisdn: '573000000003', content: 'sigo aquí' }));
  await new Promise((r) => setTimeout(r, 250));
  assert(nAnthropic(desde) === 0 && outs(desde).length === 0, 'con el chat en humano no contesta');
  assert(sb.filas('chattigo_conversaciones').find((r) => r.msisdn === '573000000003').mensajes.some((m) => m.rol === 'cliente' && m.texto === 'sigo aquí'), 'sí archiva lo que escribe el cliente');

  process.env.CHATTIGO_GRUPO = 'BENEFICIO_SURA';
  process.env.CHATTIGO_ID_CAMPANA = '597';
  desde = llamadas.length;
  await post(port, tok, entrada({ id: 6, msisdn: '573000000004', content: '__CASO_TRASPASO__ de una vez' }));
  await hasta(() => outs(desde).some((o) => o.type === 'group'), 'traspaso a grupo');
  const grupo = outs(desde);
  assert(grupo.map((o) => o.type).join(',') === 'text,text,internal,group', grupo.map((o) => o.type).join(','));
  assert(grupo[0].content.includes('Ana') && !grupo[0].content.includes('Ruiz'), grupo[0].content);
  assert(grupo[3].content === 'BENEFICIO_SURA' && grupo[3].idCampaign === 597, 'group usa el código y la campaña');
  assert(sb.filas('chattigo_conversaciones').find((r) => r.msisdn === '573000000004').perfil.origen === 'SURA');

  desde = llamadas.length;
  await post(port, tok, { data: entrada({ id: 7, msisdn: '573000000005', content: 'desde data' }) });
  await hasta(() => outs(desde).length >= 1, 'envoltorio data');
  assert(outs(desde)[0].type === 'text' && outs(desde)[0].msisdn === '573000000005', 'acepta body.data y lo deja registrado');

  desde = llamadas.length;
  await post(port, tok, entrada({ id: 8, msisdn: '573000000006', idUser: 99, content: 'soy el cliente' }));
  await hasta(() => outs(desde).length >= 1, 'idUser distinto de cero');
  assert(outs(desde)[0].type === 'text', 'sin CHATTIGO_IDUSER_ES_AGENTE un idUser > 0 sigue siendo el cliente');

  desde = llamadas.length;
  await post(port, tok, entrada({ id: 9, msisdn: '573000000007', chatType: 'OUTBOUND', content: 'eco del bot' }));
  await new Promise((r) => setTimeout(r, 200));
  assert(outs(desde).length === 0 && nAnthropic(desde) === 0, 'chatType OUTBOUND no se contesta');

  console.log('chattigo: simulación del webhook correcta');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
