-- Términos y condiciones SURA enviados por chat y su aceptación (mensaje de datos, Ley 527 de 1999).
create table if not exists terminos_sura (
  id              bigserial primary key,
  telefono        text,
  cedula          text,
  nombre          text,
  caso_id         text,
  servicio        text not null,          -- completo | solo_dian | cita_dian
  canal           text,
  enviado_por     text,
  enviado_en      timestamptz not null default now(),
  aceptado_en     timestamptz,
  aceptado_texto  text,                   -- respuesta literal del cliente ("ACEPTO los términos…", nombre, cédula)
  aceptado_cedula text
);
create index if not exists terminos_sura_tel on terminos_sura (telefono, enviado_en desc);
alter table terminos_sura enable row level security;
