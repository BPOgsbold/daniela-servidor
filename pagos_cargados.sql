-- Registro de soportes de pago cargados por Daniela (asistente del panel, WhatsApp y Chattigo)
-- y control del informe diario (para que salga una sola vez por día).
create table if not exists pagos_cargados (
  id          bigserial primary key,
  cedula      text,
  nombre      text,
  telefono    text,
  canal       text,          -- Asistente (panel) | WhatsApp | Chattigo
  cargado_por text,          -- asesor o "Daniela (WhatsApp)" / "Daniela (Chattigo)"
  archivo     text,
  link        text,
  caso_id     text,
  creado_en   timestamptz not null default now()
);
create index if not exists pagos_cargados_fecha on pagos_cargados (creado_en desc);
create index if not exists pagos_cargados_cedula on pagos_cargados (cedula);
alter table pagos_cargados enable row level security;

create table if not exists informes_diarios (
  tipo       text not null,
  fecha      date not null,
  enviado_en timestamptz not null default now(),
  primary key (tipo, fecha)
);
alter table informes_diarios enable row level security;
