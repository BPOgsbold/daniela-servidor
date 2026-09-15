-- Esquema de base de datos para Daniela (Gómez Legal Abogados)
-- Ejecutar en el SQL Editor de Supabase.

create table if not exists casos (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  asesor text,
  nombre_cliente text,
  telefono text,
  tipo_persona text,
  vehiculo text,
  valor_sin_iva text,
  tiene_certificado_upme text,
  resultado text, -- 'radicado' | 'no_aplica'
  numero_radicado_dian text,
  seccional text,
  motivo_no_aplica text,
  observaciones text,
  datos jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists escalamientos_juridico (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  asesor text,
  caso_id uuid references casos(id),
  motivo_escalamiento text,
  datos jsonb,
  created_at timestamptz default now()
);

-- Índices útiles para consultar por asesor o por estado del caso.
create index if not exists idx_casos_asesor on casos(asesor);
create index if not exists idx_casos_resultado on casos(resultado);
create index if not exists idx_escalamientos_caso on escalamientos_juridico(caso_id);

-- Conocimiento adicional que el equipo le va enseñando a Daniela (texto
-- pegado a mano, o el contenido de un documento .txt/.md cargado desde la
-- extensión). Cada entrada activa se incluye en el contexto que usa la IA
-- para responder dudas, sin necesidad de reconstruir ni redesplegar nada.
create table if not exists conocimiento (
  id uuid primary key default gen_random_uuid(),
  titulo text,
  texto text not null,
  agregado_por text,
  activo boolean default true,
  created_at timestamptz default now()
);

create index if not exists idx_conocimiento_activo on conocimiento(activo, created_at desc);
