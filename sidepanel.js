const chatEl = document.getElementById('chat');
const formEl = document.getElementById('chatForm');
const inputEl = document.getElementById('chatInput');
const btnConfig = document.getElementById('btnConfig');
const configPanel = document.getElementById('configPanel');
const asesorNombreEl = document.getElementById('asesorNombre');
const backendUrlEl = document.getElementById('backendUrl');
const btnGuardarConfig = document.getElementById('btnGuardarConfig');
const btnReiniciar = document.getElementById('btnReiniciar');
const btnEnsenar = document.getElementById('btnEnsenar');
const ensenarPanel = document.getElementById('ensenarPanel');
const ensenarTituloEl = document.getElementById('ensenarTitulo');
const ensenarTextoEl = document.getElementById('ensenarTexto');
const ensenarArchivoEl = document.getElementById('ensenarArchivo');
const btnGuardarConocimiento = document.getElementById('btnGuardarConocimiento');
const btnVerConocimiento = document.getElementById('btnVerConocimiento');
const ensenarLista = document.getElementById('ensenarLista');

const DEFAULT_BACKEND = 'http://localhost:3000';

let state = {
  asesor: '',
  backendUrl: DEFAULT_BACKEND,
  sessionId: null,
};

function addMessage(text, role) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'typing';
  div.id = 'typingIndicator';
  div.textContent = 'El asistente está escribiendo…';
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

// Pinta botones clicables debajo del último mensaje de Daniela cuando la
// pregunta tiene opciones fijas (ej. canal, certificado UPME). Al dar clic
// en uno, se manda igual que si el asesor lo hubiera escrito a mano, y se
// deshabilitan los botones para no mandar la respuesta dos veces.
function addOpciones(opciones) {
  const cont = document.createElement('div');
  cont.className = 'opciones';
  opciones.forEach((opcion) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opcion-btn';
    btn.textContent = opcion;
    btn.addEventListener('click', async () => {
      Array.from(cont.querySelectorAll('button')).forEach((b) => (b.disabled = true));
      addMessage(opcion, 'user');
      await sendToBackend(opcion);
    });
    cont.appendChild(btn);
  });
  chatEl.appendChild(cont);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function newSessionId() {
  return 'sesion-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(['asesor', 'backendUrl', 'sessionId']);
  state.asesor = stored.asesor || '';
  state.backendUrl = stored.backendUrl || DEFAULT_BACKEND;
  state.sessionId = stored.sessionId || newSessionId();
  asesorNombreEl.value = state.asesor;
  backendUrlEl.value = state.backendUrl;
  await chrome.storage.local.set({ sessionId: state.sessionId });

  if (!state.asesor) {
    configPanel.classList.remove('hidden');
  } else {
    startConversation();
  }
}

async function saveConfig() {
  state.asesor = asesorNombreEl.value.trim();
  state.backendUrl = backendUrlEl.value.trim() || DEFAULT_BACKEND;
  await chrome.storage.local.set({ asesor: state.asesor, backendUrl: state.backendUrl });
  configPanel.classList.add('hidden');
  if (state.asesor) startConversation();
}

async function startConversation() {
  chatEl.innerHTML = '';
  await sendToBackend('__inicio__');
}

async function resetConversation() {
  state.sessionId = newSessionId();
  await chrome.storage.local.set({ sessionId: state.sessionId });
  addMessage('— Nuevo caso iniciado —', 'system');
  await sendToBackend('__inicio__');
}

async function sendToBackend(message) {
  showTyping();
  try {
    const res = await fetch(`${state.backendUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        asesor: state.asesor,
        message,
      }),
    });

    if (!res.ok) {
      throw new Error(`El servidor respondió ${res.status}`);
    }

    const data = await res.json();
    hideTyping();

    if (data.reply) addMessage(data.reply, 'agent');
    if (Array.isArray(data.opciones) && data.opciones.length > 0) addOpciones(data.opciones);
  } catch (err) {
    hideTyping();
    addMessage(
      `No pude conectar con el backend (${state.backendUrl}). Verifica que el servidor esté corriendo. Detalle: ${err.message}`,
      'error'
    );
  }
}

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  addMessage(text, 'user');
  inputEl.value = '';
  await sendToBackend(text);
});

btnConfig.addEventListener('click', () => {
  ensenarPanel.classList.add('hidden');
  configPanel.classList.toggle('hidden');
});

btnGuardarConfig.addEventListener('click', saveConfig);
btnReiniciar.addEventListener('click', resetConversation);

// --- Panel "Enseñarle a Daniela" ---

btnEnsenar.addEventListener('click', () => {
  configPanel.classList.add('hidden');
  ensenarPanel.classList.toggle('hidden');
});

// Cargar un .txt/.md llena el textarea con su contenido (no se envía solo,
// el asesor revisa y le da "Enseñarle a Daniela").
ensenarArchivoEl.addEventListener('change', () => {
  const file = ensenarArchivoEl.files && ensenarArchivoEl.files[0];
  if (!file) return;
  const nombreValido = /\.(txt|md)$/i.test(file.name);
  if (!nombreValido) {
    addMessage('Por ahora solo se pueden cargar archivos .txt o .md. Para PDF o Word, copia y pega el texto.', 'error');
    ensenarArchivoEl.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    ensenarTextoEl.value = String(reader.result || '');
    if (!ensenarTituloEl.value.trim()) {
      ensenarTituloEl.value = file.name.replace(/\.(txt|md)$/i, '');
    }
  };
  reader.onerror = () => {
    addMessage('No pude leer ese archivo. Intenta de nuevo o pega el texto directamente.', 'error');
  };
  reader.readAsText(file);
});

btnGuardarConocimiento.addEventListener('click', async () => {
  const texto = ensenarTextoEl.value.trim();
  if (!texto) {
    addMessage('Escribe o carga primero el texto que le quieres enseñar a Daniela.', 'error');
    return;
  }
  const titulo = ensenarTituloEl.value.trim();
  btnGuardarConocimiento.disabled = true;
  btnGuardarConocimiento.textContent = 'Guardando…';
  try {
    const res = await fetch(`${state.backendUrl}/api/conocimiento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto, titulo, agregadoPor: state.asesor }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `El servidor respondió ${res.status}`);
    }
    ensenarTituloEl.value = '';
    ensenarTextoEl.value = '';
    ensenarArchivoEl.value = '';
    ensenarPanel.classList.add('hidden');
    addMessage(`✅ Listo, ya le enseñé esto a Daniela${titulo ? ` ("${titulo}")` : ''}. Ya lo tiene en cuenta en sus respuestas.`, 'system');
  } catch (err) {
    addMessage(`No pude guardar el conocimiento nuevo. Detalle: ${err.message}`, 'error');
  } finally {
    btnGuardarConocimiento.disabled = false;
    btnGuardarConocimiento.textContent = 'Enseñarle a Daniela';
  }
});

btnVerConocimiento.addEventListener('click', async () => {
  const visible = !ensenarLista.classList.contains('hidden');
  if (visible) {
    ensenarLista.classList.add('hidden');
    return;
  }
  ensenarLista.innerHTML = 'Cargando…';
  ensenarLista.classList.remove('hidden');
  try {
    const res = await fetch(`${state.backendUrl}/api/conocimiento`);
    if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
    const data = await res.json();
    const entradas = data.entradas || [];
    if (entradas.length === 0) {
      ensenarLista.textContent = 'Todavía no le has enseñado nada adicional a Daniela.';
      return;
    }
    ensenarLista.innerHTML = '';
    entradas.forEach((e) => {
      const div = document.createElement('div');
      div.className = 'entrada';
      const fecha = e.created_at ? new Date(e.created_at).toLocaleDateString('es-CO') : '';
      const encabezado = [e.titulo, e.agregado_por, fecha].filter(Boolean).join(' · ');
      if (encabezado) {
        const h = document.createElement('div');
        h.className = 'entrada-titulo';
        h.textContent = encabezado;
        div.appendChild(h);
      }
      const p = document.createElement('div');
      p.textContent = e.texto;
      div.appendChild(p);
      ensenarLista.appendChild(div);
    });
  } catch (err) {
    ensenarLista.textContent = `No pude cargar lo que se le ha enseñado a Daniela. Detalle: ${err.message}`;
  }
});

loadConfig();

// ===== Adjuntar documentos del cliente → SharePoint =====
// El asesor toca el clip, elige el archivo y Daniela le pregunta qué
// documento es. Todo se arma desde aquí (no requiere cambiar el HTML).
const TIPOS_ADJUNTO = [
  ['cedula', 'Cédula'],
  ['factura', 'Factura de compra'],
  ['rut', 'RUT'],
  ['certificado_upme', 'Certificado UPME'],
  ['soporte_pago', 'Soporte de pago'],
  ['certificacion_bancaria', 'Certificación bancaria'],
  ['contrato', 'Contrato'],
];

(function iniciarAdjuntar() {
  const btnClip = document.createElement('button');
  btnClip.type = 'button';
  btnClip.id = 'btnAdjuntar';
  btnClip.title = 'Adjuntar documento del cliente';
  btnClip.textContent = '📎';
  const inputArchivo = document.createElement('input');
  inputArchivo.type = 'file';
  inputArchivo.accept = '.pdf,image/*';
  inputArchivo.style.display = 'none';
  const antes = document.getElementById('chatInput');
  formEl.insertBefore(btnClip, antes);
  formEl.appendChild(inputArchivo);
  btnClip.addEventListener('click', () => inputArchivo.click());

  const aBase64 = (file) => new Promise((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => mal(new Error('No pude leer el archivo.'));
    r.readAsDataURL(file);
  });

  inputArchivo.addEventListener('change', () => {
    const file = inputArchivo.files && inputArchivo.files[0];
    inputArchivo.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      addMessage('Ese archivo pesa más de 25 MB. Comprímelo o súbelo en partes.', 'error');
      return;
    }
    addMessage(`📎 ${file.name}`, 'user');
    addMessage('¿Qué documento es este?', 'agent');
    const cont = document.createElement('div');
    cont.className = 'opciones';
    TIPOS_ADJUNTO.forEach(([tipo, etiqueta]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opcion-btn';
      b.textContent = etiqueta;
      b.addEventListener('click', async () => {
        Array.from(cont.querySelectorAll('button')).forEach((x) => (x.disabled = true));
        addMessage(etiqueta, 'user');
        showTyping();
        try {
          const base64 = await aBase64(file);
          const res = await fetch(`${state.backendUrl}/api/adjuntar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.sessionId, tipo, nombreArchivo: file.name, mimeType: file.type, base64 }),
          });
          const data = await res.json().catch(() => ({}));
          hideTyping();
          if (!res.ok) throw new Error(data.error || `El servidor respondió ${res.status}`);
          addMessage(data.reply || '📎 Archivo guardado.', 'agent');
        } catch (err) {
          hideTyping();
          addMessage(`⚠️ ${err.message}`, 'error');
        }
      });
      cont.appendChild(b);
    });
    chatEl.appendChild(cont);
    chatEl.scrollTop = chatEl.scrollHeight;
  });

  const st = document.createElement('style');
  st.textContent = '#btnAdjuntar{background:transparent;border:1px solid #d9cfae;border-radius:8px;padding:0 10px;font-size:18px;cursor:pointer}#btnAdjuntar:hover{background:#faf3df}';
  document.head.appendChild(st);
})();
