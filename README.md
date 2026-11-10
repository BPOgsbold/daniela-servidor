# Daniela (servidor)

Backend de Daniela, asistente de Gómez Legal Abogados para el beneficio tributario de vehículos eléctricos. Wasapi sigue atendiendo WhatsApp como hasta ahora. Chattigo es un canal aparte, con la misma memoria, ficha, lectura de archivos y reglas de traspaso.

## Chattigo

Daniela entra como bot externo de **API Bot** (no es el producto Bot-Chattigo ISV, que va al revés: uno les manda el mensaje y responde el bot de ellos).

Documentación: https://development.chattigo.com/es/docs/api-bot/

Chattigo hace `POST` al webhook con el mensaje del cliente. Daniela responde con `POST {CHATTIGO_API_BASE}/outbound` usando el JWT de `POST {CHATTIGO_API_BASE}/login`.

### Variables en Render

Obligatorias para contestar:

| Variable | Para qué |
| --- | --- |
| `CHATTIGO_API_BASE` | Host de API Bot, sin barra final. Ejemplo: `https://algo.chattigo.com`. La documentación solo publica las rutas `/login` y `/outbound`, no el dominio. No uses `https://api.chattigo.com`: es de otro producto y hoy responde 404. |
| `CHATTIGO_USUARIO` | Usuario de API Bot. Lo pide el KAM de Chattigo. No es el usuario de https://login.chattigo.com. |
| `CHATTIGO_CLAVE` | Contraseña de ese usuario. |
| `CHATTIGO_WEBHOOK_TOKEN` | Secreto propio. Va en la URL del webhook (`?token=`). Si queda vacío, el webhook acepta cualquiera. |
| `ANTHROPIC_API_KEY` | La misma de Wasapi. |
| `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` | Las mismas de siempre. |

Para dejar el chat en la cola **Beneficio tributario Autos Sura**:

| Variable | Para qué |
| --- | --- |
| `CHATTIGO_ID_CAMPANA` | Id numérico de la campaña. El traspaso sale como `type: "transfer"` con ese `idCampaign` (multi-campaña, según la doc). |
| `CHATTIGO_GRUPO` | Código del grupo, solo si esa cola es un grupo. El traspaso sale como `type: "group"` y `content` es este código. |

Si no se define ni campaña ni grupo, el traspaso es mono-campaña: `type: "transfer"` sin `idCampaign`.

Opcionales:

| Variable | Default | Para qué |
| --- | --- | --- |
| `CHATTIGO_MODELO` | el de Wasapi, o `claude-sonnet-4-5` | Modelo de Claude. |
| `CHATTIGO_ESPERA_MS` | `6000` | Junta mensajes seguidos del mismo cliente, igual que Wasapi. |
| `CHATTIGO_PAUSA_MS` | `1200` | Pausa entre burbujas. |
| `CHATTIGO_NOMBRE_BOT` | `Daniela` | Campo `name` / `botName`. |
| `CHATTIGO_CANAL` | `WHATSAPP` | Solo si el webhook no trae `channel`. |
| `CHATTIGO_CHANNEL_PROVIDER` | el del mensaje entrante | `WAVY`, `APICLOUDBSP`, `BSPCHATTIGO`, etc. En el mensaje de texto, `idCampaign` se copia del webhook y, si no viene, se usa `CHATTIGO_ID_CAMPANA`. |
| `CHATTIGO_ID_NODO` / `CHATTIGO_NOMBRE_NODO` / `CHATTIGO_BOT_PROVIDER` | vacío | Solo si Chattigo exige el nodo del flujo. Si no están, no se envían. |
| `CHATTIGO_MAX_CONTENIDO` | `3000` | Tope por mensaje. El 3000 sale del webhook de canales externos, no de API Bot. `0` no parte el texto. |
| `CHATTIGO_OMITIR_ID` | vacío | `true` manda `id: null` en el outbound. |
| `CHATTIGO_CONTENIDO_TRASPASO` | el motivo (`completo` o `escalamiento:causa`) | Texto del `content` cuando el traspaso es `transfer`. En modo grupo el `content` es siempre el código del grupo. |
| `CHATTIGO_IDUSER_ES_AGENTE` | vacío | `true` hace que un `idUser` mayor que 0 se tome como agente y Daniela se calle. Apagado: la doc no dice que ese campo sea el agente. |
| `CHATTIGO_TIPOS_TOMA_HUMANO` | vacío | Lista separada por comas de `type` que significan “un humano tomó el chat”. |
| `CHATTIGO_REANUDAR_TRAS_AGENTE` | vacío | `true` vuelve a dejar el chat en el bot cuando Chattigo manda `type: "transfer"` (el agente cerró). Apagado, Daniela no retoma, igual que en Wasapi. |

Hay que crear la tabla en Supabase con el bloque `chattigo_conversaciones` de `supabase_schema.sql`. No se reutiliza la tabla de Wasapi: la clave es `chattigo:{did}:{msisdn}`.

### URL para el administrador de Chattigo

```
https://daniela-servidor.onrender.com/api/chattigo/webhook?token=EL_MISMO_VALOR_DE_CHATTIGO_WEBHOOK_TOKEN
```

Salud (no lleva token):

```
https://daniela-servidor.onrender.com/api/chattigo/salud
```

Tiene que responder 200 y mostrar qué variables están cargadas, sin las claves.

Si el token de la URL no coincide, el webhook igual responde 200 (así Chattigo no reintenta) y Daniela no contesta. En los logs queda `chattigo: token de webhook inválido`.

### Qué pedirle a Chattigo

1. Usuario y contraseña de **API Bot** para esta campaña (los crea el KAM; no sirven los del tablero de agentes).
2. La **URL base** donde viven `POST /login` y `POST /outbound`.
3. Que registren el webhook de arriba como destino de los mensajes del bot, en el canal de WhatsApp de la cola Beneficio tributario Autos Sura.
4. El **did** (número de WhatsApp), el **idCampaign** y el **channelProvider** (`WAVY`, `APICLOUDBSP`, `BSPCHATTIGO` u otro).
5. Si esa cola es un grupo, el **código del grupo**. Si no, confirmar que el traspaso es multi-campaña (`transfer` + `idCampaign`) o mono-campaña.
6. Si el outbound exige `idNode`, `nameNode` o `botProvider`.
7. Un ejemplo real del JSON cuando **un agente toma el chat o escribe**. La doc no trae ese evento. Hoy Daniela se calla al hacer ella el traspaso; un agente que entre por el tablero solo la calla si el payload coincide con `CHATTIGO_IDUSER_ES_AGENTE` o `CHATTIGO_TIPOS_TOMA_HUMANO`.
8. Si `attachment.mediaUrl` se descarga con el JWT o es una URL pública.
9. Confirmar que quieren API Bot y no Bot-Chattigo ISV.

Cada POST entrante queda recortado en los logs de Render (`chattigo webhook …`) para ajustar el parser si el JSON real no coincide con el ejemplo de la doc.

### Comprobación local

```
npm run test:chattigo
```

Simula el webhook de la documentación, sin credenciales reales de Chattigo ni de Anthropic.
