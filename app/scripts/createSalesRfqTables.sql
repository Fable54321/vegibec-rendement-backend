CREATE TABLE IF NOT EXISTS sales.rfq_cells (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES sales.clients(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES sales.products(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  location_code VARCHAR(1) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'email' CHECK (status IN ('final', 'email')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, product_id, week_start, location_code)
);
CREATE TABLE IF NOT EXISTS sales.rfq_prices (
  id BIGSERIAL PRIMARY KEY,
  cell_id BIGINT NOT NULL REFERENCES sales.rfq_cells(id) ON DELETE CASCADE,
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  price NUMERIC(12, 4) NOT NULL CHECK (price >= 0)
);
CREATE TABLE IF NOT EXISTS sales.rfq_attachments (
  id BIGSERIAL PRIMARY KEY,
  cell_id BIGINT NOT NULL REFERENCES sales.rfq_cells(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  s3_key TEXT NOT NULL UNIQUE,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sales.microsoft_connections (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  microsoft_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sales.rfq_email_links (
  id BIGSERIAL PRIMARY KEY,
  cell_id BIGINT NOT NULL REFERENCES sales.rfq_cells(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  microsoft_message_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  sender_email TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ,
  web_link TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cell_id, user_id, microsoft_message_id)
);
CREATE INDEX IF NOT EXISTS rfq_cells_client_week_idx ON sales.rfq_cells(client_id, week_start);
CREATE INDEX IF NOT EXISTS rfq_email_links_cell_idx ON sales.rfq_email_links(cell_id);
ALTER TABLE sales.rfq_cells ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'email';
DO $$ BEGIN
  ALTER TABLE sales.rfq_cells ADD CONSTRAINT rfq_cells_status_check CHECK (status IN ('final', 'email'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
