-- Preguntas de Daniela (Chattigo) al equipo y sus respuestas.
-- Daniela publica la pregunta en Teams con un botón "Responder a Daniela"; la respuesta queda aquí,
-- Daniela la aplica en ese chat y la usa como aprendizaje para casos parecidos.
create table if not exists chattigo_preguntas (
  id            uuid primary key default gen_random_uuid(),
  clave         text not null,              -- ficha de la conversación (chattigo-57XXXXXXXXXX)
  telefono      text,
  nombre        text,
  pregunta      text not null,
  respuesta     text,
  respondido_por text,
  creado_en     timestamptz not null default now(),
  respondido_en timestamptz,
  aplicado_en   timestamptz
);
create index if not exists chattigo_preguntas_clave on chattigo_preguntas (clave, respondido_en);
create index if not exists chattigo_preguntas_resp on chattigo_preguntas (respondido_en desc);
alter table chattigo_preguntas enable row level security;  -- solo el servidor (service role) la usa
