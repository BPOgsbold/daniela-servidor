-- Base asignada por asesor (cédula): el admin la carga desde el panel y el asesor la gestiona en la página del asesor.
-- Cada fila es un cliente a llamar. El asesor ve máximo 2 a la vez; al marcar el resultado le sale el siguiente.
create table if not exists marce_base_asesor (
  id bigserial primary key,
  cedula text not null,
  asesor text,
  lote text,                       -- nombre del archivo / carga
  cargado timestamptz default now(),
  cargado_por text,
  orden integer default 0,
  telefono text,                   -- celular principal (para buscar y cruzar)
  datos jsonb not null default '{}'::jsonb,   -- nombre, teléfonos, dirección, ciudad, cuenta, OT, notas… del Excel
  estado text not null default 'pendiente',   -- pendiente · en_gestion · gestionado · no_contesto · seguimiento
  tomado_at timestamptz,
  contesto boolean,
  efectivo boolean,
  util boolean,
  interesado boolean,
  venta boolean,
  resultado text,                  -- texto final del resultado
  seguimiento_fecha date,
  nota text,
  intentos integer default 0,
  gestionado_at timestamptz
);
create index if not exists marce_base_asesor_cedula_estado on marce_base_asesor (cedula, estado, orden);
create index if not exists marce_base_asesor_lote on marce_base_asesor (lote);
alter table marce_base_asesor enable row level security;
