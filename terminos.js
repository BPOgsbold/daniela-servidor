// Términos y condiciones SURA (oferta + aceptación por mensaje de datos, Ley 527 de 1999).
// Solo para clientes SURA (Chattigo). Reemplaza el contrato en el chat: el cliente responde
// "ACEPTO los términos y condiciones", su nombre completo y su cédula, y queda registrado.
// Textos aprobados por Gómez Legal (cuenta de honorarios: Bancolombia ahorros 43600005898).

const ENCABEZADO = `Prestador del servicio: GÓMEZ LEGAL ABOGADOS S.A.S., NIT 901.964.467-0
Dirección: Cl. 12 # 31-165, El Poblado, Medellín
WhatsApp: +57 317 515 9179 · Correo: info@gomezlegalabogados.co`;

const CUENTA = 'cuenta de ahorros Bancolombia 43600005898 o en la llave @gomezlegalabogad de Bancolombia, a nombre de GÓMEZ LEGAL ABOGADOS S.A.S., NIT 901.964.467-0.\nSe aceptan pagos por tarjeta de crédito con un incremento del 3 %.';

const CASOS_NO = (conUpme) => `3. CASOS EN QUE LA DIAN NO DEVUELVE EL DINERO
La devolución no procede, o se reduce, si se presenta alguna de estas situaciones:
a) No es primer dueño: la factura de compra no está a su nombre como comprador original que pagó el IVA. Esto incluye vehículos usados, comprados a un tercero o adquiridos por leasing con la factura a nombre de la entidad financiera.
b) Vencimiento del término: pasaron más de 5 años desde la fecha de la factura de compra, que es el plazo para pedir la devolución de un pago de lo no debido (art. 2536 del Código Civil).
c) El vehículo no cumple la tecnología: no es eléctrico o híbrido, o no cumple los requisitos técnicos que exige la UPME para certificarlo.
d) Deudas con la DIAN: si usted tiene obligaciones vencidas con la DIAN, ella descuenta primero esa deuda del valor a devolver (compensación previa, art. 861 E.T.). Puede recibir menos dinero o nada.
e) Otras causas atribuibles a usted: la factura no le cobró IVA, o usted entrega información o documentos incompletos, falsos o fuera de tiempo.

En estos casos, el resultado no depende de Gómez Legal. Los honorarios no se reembolsan.${conUpme ? ' La tarifa UPME que ya se haya pagado tampoco se recupera, porque la UPME no la devuelve.' : ''}`;

const FINAL = (n) => `${n}. INICIO INMEDIATO Y RETRACTO
Usted pide que el servicio empiece apenas se reciba el pago. Una vez iniciado, no aplica el derecho de retracto (art. 47 de la Ley 1480 de 2011).

${n + 1}. DATOS PERSONALES
Usted autoriza de forma previa, expresa e informada a Gómez Legal Abogados S.A.S. para tratar sus datos personales solo para prestar este servicio (Ley 1581 de 2012). Usted puede conocer, actualizar, rectificar o suprimir sus datos, y revocar esta autorización, escribiendo a este mismo número o al correo de la firma.

${n + 2}. ACEPTACIÓN POR MENSAJE DE DATOS Y VALIDEZ LEGAL
a) Este mensaje es una oferta de servicios de Gómez Legal Abogados S.A.S. Usted la acepta respondiendo por este chat de WhatsApp con:
👉 "ACEPTO los términos y condiciones", su nombre completo y su número de cédula.
b) Su respuesta es un mensaje de datos (art. 2 de la Ley 527 de 1999). Tiene la misma validez y fuerza obligatoria que un documento escrito y firmado (arts. 5 y 6 de la Ley 527 de 1999). Con ella se celebra el contrato entre usted y Gómez Legal Abogados S.A.S. (arts. 14 y 15 de la Ley 527 de 1999).
c) Su nombre, su cédula y el número de celular desde el que responde lo identifican y muestran que usted aprueba estas condiciones. Por eso su respuesta vale como su firma electrónica (art. 7 de la Ley 527 de 1999 y Decreto 1074 de 2015).
d) Esta conversación sirve como prueba del contrato, de su fecha y de su contenido (art. 10 de la Ley 527 de 1999 y art. 247 del Código General del Proceso). Gómez Legal la conservará como soporte.
e) El pago de los honorarios confirma la aceptación.

${n + 3}. DOMICILIO Y CONTROVERSIAS
El domicilio contractual es Medellín. Las diferencias se resolverán primero por arreglo directo. Si no hay acuerdo, se acudirá a la jurisdicción ordinaria.`;

const TEXTOS = {
  completo: `TÉRMINOS Y CONDICIONES
GESTIÓN UPME Y DEVOLUCIÓN DE IVA – LEY 1715 DE 2014

${ENCABEZADO}

1. OBJETO
Gómez Legal Abogados S.A.S. gestiona por usted dos trámites:
a) El certificado de la UPME para su vehículo eléctrico o híbrido.
b) Con ese certificado, la solicitud ante la DIAN para que le devuelva el IVA que pagó al comprar el vehículo, como pago de lo no debido (art. 850 del Estatuto Tributario).
La DIAN consigna la devolución directamente en su cuenta bancaria. Gómez Legal no recibe ni maneja ese dinero.
Gómez Legal es aliado de SURA.

2. PRECIO Y FORMA DE PAGO
a) Honorarios: $600.000 + IVA del 19 % ($114.000) = $714.000. Se pagan una sola vez, al inicio, y cubren todo el trámite UPME + DIAN. Gómez Legal le enviará la factura electrónica de venta (art. 616-1 E.T.).
b) Tarifa UPME: no está incluida en los honorarios. La cobra la UPME según el vehículo, en UVT y con su calculadora oficial. Le informaremos el valor exacto antes de que pague. Usted autoriza a Gómez Legal para pagarla a su nombre y por su cuenta (mandato, arts. 2142 y siguientes del Código Civil) y le entregaremos el soporte del pago. Gómez Legal no cobra IVA ni ningún valor adicional por hacer este pago.
c) Ambos valores se consignan en la ${CUENTA}

${CASOS_NO(true)}

4. ALCANCE DEL COMPROMISO
Gómez Legal adelanta los trámites con toda su diligencia profesional, responde los requerimientos de la UPME y de la DIAN y presenta los recursos que procedan. Las decisiones finales son de esas entidades y Gómez Legal no puede garantizar su contenido, sin embargo, en caso de cumplir todas las condiciones anteriores, los resultados son de medios y de resultado.

5. TIEMPOS
Los tiempos son estimados y dependen de las entidades:
UPME: hasta 30 días hábiles desde la radicación.
DIAN: hasta 50 días hábiles desde la radicación.
En Medellín la DIAN puede demorar en asignar la cita para radicar, y eso no depende de Gómez Legal. Le informaremos el avance del trámite por este medio.

6. SUS OBLIGACIONES
Usted debe:
- Entregar la factura del vehículo, el RUT actualizado, la cédula, los documentos del vehículo y una certificación bancaria a su nombre con menos de 30 días de expedida.
- Firmar los poderes necesarios.
- Estar a paz y salvo con la DIAN.
Usted declara que toda la información que entrega es verdadera.

${FINAL(7)}`,

  solo_dian: `TÉRMINOS Y CONDICIONES
GESTIÓN DEVOLUCIÓN DE IVA – LEY 1715 DE 2014

${ENCABEZADO}

1. OBJETO
Gómez Legal Abogados S.A.S. gestiona por usted un trámite:
a) La solicitud ante la DIAN para que le devuelva el IVA que pagó al comprar el vehículo, como pago de lo no debido (art. 850 del Estatuto Tributario).
La DIAN consigna la devolución directamente en su cuenta bancaria. Gómez Legal no recibe ni maneja ese dinero.
Gómez Legal es aliado de SURA.

2. PRECIO Y FORMA DE PAGO
a) Honorarios: $300.000 + IVA del 19 % ($57.000) = $357.000. Se pagan una sola vez, al inicio, y cubren todo el trámite DIAN. Gómez Legal le enviará la factura electrónica de venta (art. 616-1 E.T.).
b) Los honorarios se consignan en la ${CUENTA}

${CASOS_NO(false)}

4. ALCANCE DEL COMPROMISO
Gómez Legal adelanta los trámites con toda su diligencia profesional, responde los requerimientos de la DIAN y presenta los recursos que procedan. Las decisiones finales son de esas entidades y Gómez Legal no puede garantizar su contenido, sin embargo, en caso de cumplir todas las condiciones anteriores, los resultados son de medios y de resultado.

5. TIEMPOS
Los tiempos son estimados y dependen de las entidades:
DIAN: hasta 50 días hábiles desde la radicación.
En Medellín la DIAN puede demorar en asignar la cita para radicar, y eso no depende de Gómez Legal. Le informaremos el avance del trámite por este medio.

6. SUS OBLIGACIONES
Usted debe:
- Entregar la factura del vehículo, el RUT actualizado, la cédula, los documentos del vehículo, el certificado UPME y una certificación bancaria a su nombre con menos de 30 días de expedida.
- Firmar los poderes necesarios.
- Estar a paz y salvo con la DIAN.
Usted declara que toda la información que entrega es verdadera.

${FINAL(7)}`,

  cita_dian: `TÉRMINOS Y CONDICIONES
GESTIÓN CITA DIAN – DEVOLUCIÓN DE IVA – LEY 1715 DE 2014

${ENCABEZADO}

1. OBJETO
Gómez Legal Abogados S.A.S. gestiona por usted un trámite:
a) Únicamente la solicitud de la cita ante la DIAN para radicar la devolución del IVA que pagó al comprar el vehículo, como pago de lo no debido (art. 850 del Estatuto Tributario).
La DIAN consigna la devolución directamente en su cuenta bancaria. Gómez Legal no recibe ni maneja ese dinero.
Gómez Legal es aliado de SURA.

2. PRECIO Y FORMA DE PAGO
a) Honorarios: $250.000 + IVA del 19 % ($47.500) = $297.500. Se pagan una sola vez, al inicio, y cubren la gestión de la cita ante la DIAN. Gómez Legal le enviará la factura electrónica de venta (art. 616-1 E.T.).
b) El valor se consigna en la ${CUENTA}

${CASOS_NO(false)}

4. ALCANCE DEL COMPROMISO
Gómez Legal adelanta el trámite con toda su diligencia profesional y únicamente agendará la cita ante la DIAN. No es responsable por el mal diligenciamiento de la información que usted deberá presentar ante la DIAN.

5. TIEMPOS
Los tiempos son estimados y dependen de las entidades:
En Medellín la DIAN puede demorar en asignar la cita para radicar, y eso no depende de Gómez Legal. Le informaremos el avance del trámite por este medio.

6. SUS OBLIGACIONES
Usted debe:
- Entregar el RUT actualizado.

${FINAL(7)}`,
};

const NOMBRES = { completo: 'Trámite completo UPME + DIAN ($714.000)', solo_dian: 'Trámite solo DIAN ($357.000)', cita_dian: 'Solo cita DIAN ($297.500)' };
const VALIDOS = Object.keys(TEXTOS);

// Servicio según la ficha: con certificado UPME → solo DIAN; si pidió solo la cita → cita DIAN; si no → completo.
function servicioSugerido(perfil = {}) {
  const s = String(perfil.servicio_terminos || perfil.servicio || '').toLowerCase();
  if (/cita/.test(s)) return 'cita_dian';
  if (/solo.?dian/.test(s)) return 'solo_dian';
  if (/^s[ií]/i.test(String(perfil.tiene_certificado_upme || '')) || perfil.tiene_certificado_upme === true) return 'solo_dian';
  return 'completo';
}

// ¿El cliente aceptó? Busca "acepto ... términos" en sus mensajes posteriores al envío.
function buscarAceptacion(mensajes = []) {
  const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const m of mensajes) {
    if (m.rol !== 'cliente') continue;
    const t = norm(m.texto);
    if (/\bacepto\b/.test(t) && /(termino|condicion)/.test(t)) {
      const ced = (String(m.texto).replace(/[.\s]/g, '').match(/\d{6,11}/) || [])[0] || null;
      return { texto: String(m.texto).slice(0, 500), cedula: ced, hora: m.hora || null };
    }
  }
  return null;
}

// WhatsApp admite hasta 4.096 caracteres por mensaje: el texto se parte entre secciones (sin cortar ninguna).
function partir(texto, max = 3800) {
  if (texto.length <= max) return [texto];
  const cortes = [...texto.matchAll(/\n\n(?=\d+\. [A-ZÁÉÍÓÚ])/g)].map((m) => m.index);
  const mitad = texto.length / 2;
  const validos = cortes.filter((c) => c <= max && texto.length - c <= max);
  const c = (validos.length ? validos : cortes).sort((x, y) => Math.abs(x - mitad) - Math.abs(y - mitad))[0];
  if (c === undefined) return [texto.slice(0, max), texto.slice(max)];
  return [texto.slice(0, c).trim() + '\n\n(continúa…)', texto.slice(c).trim()];
}
const PARTES = Object.fromEntries(Object.entries(TEXTOS).map(([k, v]) => [k, partir(v)]));

module.exports = { TEXTOS, PARTES, NOMBRES, VALIDOS, servicioSugerido, buscarAceptacion };
