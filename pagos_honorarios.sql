-- CONTROL DE PAGOS (honorarios) · Gómez Legal · 27/11/2026
-- Ejecutar UNA vez en Supabase → SQL Editor → Run.
create table if not exists pagos_honorarios (
  id                      bigserial primary key,
  sp_item_id              text unique,          -- archivo en SharePoint (no se lee dos veces)
  cliente_id              text,
  caso_id                 text,
  cedula                  text,
  nombre                  text,
  telefono                text,
  convenio                text,                 -- SURA | EPM | Confamilia | ReferiX | Redes Daniela | Otros
  fecha_lead              timestamptz,          -- cuándo entró como prospecto
  fecha_creacion_cliente  timestamptz,          -- cuándo se creó como cliente
  fecha_pago              date,
  valor                   numeric,
  medio                   text,
  referencia              text,
  archivo                 text,
  link                    text,
  carpeta_link            text,
  origen                  text default 'SharePoint',   -- SharePoint | Manual
  estado                  text default 'por_revisar',  -- por_revisar | confirmado | no_es_pago | duplicado
  nota                    text,
  leido_ia                jsonb,
  subido_en               timestamptz,
  revisado_por            text,
  revisado_en             timestamptz,
  creado_en               timestamptz not null default now()
);
create index if not exists pagos_honorarios_fecha on pagos_honorarios (fecha_pago);
create index if not exists pagos_honorarios_cedula on pagos_honorarios (cedula);
alter table pagos_honorarios enable row level security;  -- solo el servidor (clave de servicio) la lee y escribe
