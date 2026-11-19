-- Encargos del equipo a Daniela en Chattigo: "escríbele X", "hazle seguimiento cada N horas", etc.
create table if not exists chattigo_encargos (
  id             uuid primary key default gen_random_uuid(),
  telefono       text not null,           -- 57 + celular (10 dígitos)
  nombre         text,
  instruccion    text not null,
  tipo           text not null default 'una_vez',   -- una_vez | seguimiento
  cada_horas     int,                      -- seguimiento: cada cuántas horas
  hasta          timestamptz,              -- seguimiento: hasta cuándo
  proximo_en     timestamptz not null default now(),
  estado         text not null default 'pendiente', -- pendiente | hecho | fallido | cancelado
  veces          int not null default 0,
  creado_por     text,
  resultado      text,
  avisado_bandeja boolean not null default false,
  creado_en      timestamptz not null default now(),
  hecho_en       timestamptz
);
create index if not exists chattigo_encargos_pend on chattigo_encargos (estado, proximo_en);
alter table chattigo_encargos enable row level security;  -- solo el servidor (service role) la usa
