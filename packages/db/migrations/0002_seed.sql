-- AutoFlow 0002 — dados de referência (configuráveis; NÃO são regras fixas no código)
-- Valores de planos/limites são PLACEHOLDERS comerciais, editáveis pelo Super Admin.

insert into reserved_slugs (slug) values
  ('admin'),('api'),('app'),('www'),('portal'),('c'),('o'),('p'),('login'),('logout'),('auth'),
  ('platform'),('static'),('assets'),('health'),('status'),('support'),('docs'),('blog'),
  ('mail'),('autoflow'),('sitemap'),('robots'),('cdn'),('dashboard'),('painel'),('suporte');

insert into features (code, kind, description) values
  ('units.max','limit','Número máximo de unidades'),
  ('users.max','limit','Número máximo de usuários (ativos + convidados)'),
  ('orders.monthly','limit','Ordens de serviço por mês'),
  ('storage.mb','limit','Armazenamento em MB'),
  ('portal','boolean','Portal privado do cliente'),
  ('website','boolean','Website público'),
  ('card','boolean','Cartão virtual'),
  ('inventory','boolean','Estoque'),
  ('team','boolean','Gestão de equipe'),
  ('crm','boolean','CRM'),
  ('whatsapp','boolean','Integração WhatsApp'),
  ('agenda','boolean','Agenda'),
  ('insurers','boolean','Seguradoras'),
  ('automation','boolean','Automações'),
  ('advanced_reports','boolean','Relatórios avançados');

insert into plans (code, name, price_cents) values
  ('ESSENCIAL','Essencial',0),
  ('PROFISSIONAL','Profissional',0),
  ('PREMIUM','Premium',0);

-- value: número = limite; null = ilimitado; true/false = recurso
insert into plan_features (plan_id, feature_code, value)
select p.id, f.code, v.value::jsonb
from plans p
join (values
  ('ESSENCIAL','units.max','1'),('ESSENCIAL','users.max','5'),('ESSENCIAL','orders.monthly','100'),('ESSENCIAL','storage.mb','1024'),
  ('ESSENCIAL','portal','false'),('ESSENCIAL','website','false'),('ESSENCIAL','card','false'),('ESSENCIAL','inventory','false'),
  ('ESSENCIAL','team','false'),('ESSENCIAL','crm','false'),('ESSENCIAL','whatsapp','false'),('ESSENCIAL','agenda','false'),
  ('ESSENCIAL','insurers','false'),('ESSENCIAL','automation','false'),('ESSENCIAL','advanced_reports','false'),

  ('PROFISSIONAL','units.max','1'),('PROFISSIONAL','users.max','20'),('PROFISSIONAL','orders.monthly','500'),('PROFISSIONAL','storage.mb','10240'),
  ('PROFISSIONAL','portal','true'),('PROFISSIONAL','website','true'),('PROFISSIONAL','card','true'),('PROFISSIONAL','inventory','true'),
  ('PROFISSIONAL','team','true'),('PROFISSIONAL','crm','true'),('PROFISSIONAL','whatsapp','true'),('PROFISSIONAL','agenda','true'),
  ('PROFISSIONAL','insurers','false'),('PROFISSIONAL','automation','false'),('PROFISSIONAL','advanced_reports','false'),

  ('PREMIUM','units.max','10'),('PREMIUM','users.max','100'),('PREMIUM','orders.monthly','null'),('PREMIUM','storage.mb','102400'),
  ('PREMIUM','portal','true'),('PREMIUM','website','true'),('PREMIUM','card','true'),('PREMIUM','inventory','true'),
  ('PREMIUM','team','true'),('PREMIUM','crm','true'),('PREMIUM','whatsapp','true'),('PREMIUM','agenda','true'),
  ('PREMIUM','insurers','true'),('PREMIUM','automation','true'),('PREMIUM','advanced_reports','true')
) as v(plan_code, feature_code, value) on v.plan_code = p.code
join features f on f.code = v.feature_code;

insert into permissions (code, description) values
  ('tenant:read','Ver dados da empresa'),
  ('tenant:manage','Editar dados da empresa'),
  ('units:read','Ver unidades'),
  ('units:manage','Criar e editar unidades'),
  ('members:read','Ver equipe'),
  ('members:manage','Convidar e gerenciar equipe'),
  ('roles:read','Ver papéis'),
  ('roles:manage','Gerenciar papéis personalizados'),
  ('audit:read','Ver auditoria'),
  ('subscription:read','Ver plano e limites');

insert into roles (key, name, is_system) values
  ('owner','Proprietário',true),('admin','Administrador',true),('manager','Gerente',true),
  ('attendant','Atendente',true),('mechanic','Mecânico',true),('bodyworker','Funileiro',true),
  ('painter','Pintor',true),('aligner','Alinhador',true),('stockkeeper','Estoquista',true),
  ('finance','Financeiro',true);

-- Matriz inicial (SECURITY.md §6), restrita às permissões existentes na Fase 1.
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'owner';

insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'admin' and p.code <> 'tenant:manage';

insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'manager'
  and p.code in ('tenant:read','units:read','members:read','roles:read','subscription:read');

insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('attendant','finance')
  and p.code in ('tenant:read','units:read','subscription:read');

insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('mechanic','bodyworker','painter','aligner','stockkeeper')
  and p.code in ('tenant:read','units:read');

-- Retenção (LEGAL_RETENTION.md §3). reviewed_by_legal_at = null: NÃO revisado pelo jurídico.
insert into retention_policies (category, trigger_event, default_period, floor_period, legal_basis, action) values
  ('financial_ledger','fato gerador / baixa', interval '5 years', interval '5 years', 'CTN 195/174; Lei 9.430 art. 37; CC 1.194; CC 206 §5º I', 'anonymize'),
  ('service_orders','entrega ou cancelamento da OS', interval '5 years', interval '5 years', 'CDC 26/27; CC 206 §3º V e §5º I', 'anonymize'),
  ('inspection_photos','entrega ou cancelamento da OS', interval '5 years', interval '5 years', 'Evidência de estado do veículo (CDC 26-27)', 'delete'),
  ('order_messages','entrega ou cancelamento da OS', interval '5 years', interval '3 years', 'Prova da relação de consumo (escolha do produto, revisar)', 'delete'),
  ('leads_unconverted','último contato', interval '12 months', interval '0', 'Necessidade/finalidade (LGPD 6º e 15)', 'delete'),
  ('consents','revogação ou vigência', interval '5 years', interval '5 years', 'Prova do consentimento (LGPD 8º §2º)', 'keep'),
  ('access_logs','evento', interval '6 months', interval '6 months', 'Marco Civil art. 15', 'delete'),
  ('audit_log','evento', interval '5 years', interval '5 years', 'Accountability; alinhado a ledger/OS', 'keep'),
  ('support_grants','evento', interval '5 years', interval '5 years', 'Accountability', 'keep'),
  ('security_incidents','registro', interval '5 years', interval '5 years', 'Res. CD/ANPD 15/2024 art. 10', 'keep'),
  ('staff_time_records','fim do vínculo', interval '5 years', interval '5 years', 'CF art. 7º XXIX; Lei 8.036 art. 23 §3º', 'anonymize'),
  ('expired_portal_tokens','expiração', interval '6 months', interval '0', 'Minimização', 'delete');
