CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE auth_sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE email_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX projects_org_updated_idx ON projects(organization_id, updated_at DESC);

CREATE TABLE datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  column_count integer NOT NULL DEFAULT 0 CHECK (column_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX datasets_org_idx ON datasets(organization_id);

CREATE TABLE dataset_columns (
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  column_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  type text NOT NULL CHECK (type IN ('text', 'category', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'unknown')),
  PRIMARY KEY(dataset_id, column_id),
  UNIQUE(dataset_id, position)
);

CREATE TABLE dataset_rows (
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  row_index integer NOT NULL CHECK (row_index >= 0),
  "values" jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  PRIMARY KEY(dataset_id, row_index)
);

CREATE TABLE visualizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, project_id, position),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX visualizations_project_idx ON visualizations(organization_id, project_id, position);

CREATE TABLE project_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE plans (
  id text PRIMARY KEY CHECK (id IN ('FREE', 'PRO', 'BUSINESS')),
  name text NOT NULL,
  entitlements jsonb NOT NULL CHECK (jsonb_typeof(entitlements) = 'object'),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plans(id),
  provider text NOT NULL CHECK (provider IN ('stripe', 'manual')),
  provider_customer_id text UNIQUE,
  provider_subscription_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('free', 'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN', 'MEMBER', 'VIEWER')),
  token_hash bytea NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_idx ON invitations(organization_id, status);

CREATE TABLE share_links (
  token_hash bytea PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  access text NOT NULL CHECK (access IN ('PUBLIC', 'LINK_ONLY')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE billing_events (
  provider_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs(organization_id, created_at DESC);

CREATE TABLE usage_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_key text NOT NULL,
  period_start date NOT NULL,
  amount bigint NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (organization_id, usage_key, period_start)
);

INSERT INTO plans (id, name, entitlements, limits) VALUES
  ('FREE', 'Free',
    '{"projects.create":true,"datasets.import":true,"dashboard.create":true,"export.csv":true,"export.png":true,"export.svg":true,"export.pdf":true,"share.public":true,"team.members":false,"custom_branding":false,"api.access":false}',
    '{"maxProjects":3,"maxDatasets":3,"maxMembers":1,"maxStorage":52428800,"maxRowsPerDataset":10000,"maxDashboards":1,"maxExportsPerMonth":100}'),
  ('PRO', 'Pro',
    '{"projects.create":true,"datasets.import":true,"dashboard.create":true,"export.csv":true,"export.png":true,"export.svg":true,"export.pdf":true,"share.public":true,"team.members":true,"custom_branding":false,"api.access":false}',
    '{"maxProjects":100,"maxDatasets":100,"maxMembers":10,"maxStorage":5368709120,"maxRowsPerDataset":1000000,"maxDashboards":20,"maxExportsPerMonth":10000}'),
  ('BUSINESS', 'Business',
    '{"projects.create":true,"datasets.import":true,"dashboard.create":true,"export.csv":true,"export.png":true,"export.svg":true,"export.pdf":true,"share.public":true,"team.members":true,"custom_branding":true,"api.access":true}',
    '{"maxProjects":-1,"maxDatasets":-1,"maxMembers":-1,"maxStorage":107374182400,"maxRowsPerDataset":5000000,"maxDashboards":-1,"maxExportsPerMonth":-1}')
ON CONFLICT (id) DO NOTHING;
