CREATE TABLE IF NOT EXISTS sales.rfq_cells (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES sales.clients(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES sales.products(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  location_code VARCHAR(1) NOT NULL,
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
CREATE INDEX IF NOT EXISTS rfq_cells_client_week_idx ON sales.rfq_cells(client_id, week_start);
