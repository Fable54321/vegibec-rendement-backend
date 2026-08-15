CREATE SCHEMA IF NOT EXISTS sales;

CREATE SEQUENCE IF NOT EXISTS sales.order_reference_seq START 1;

CREATE TABLE IF NOT EXISTS sales.orders (
  id BIGSERIAL PRIMARY KEY,
  order_reference TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES sales.clients(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  client_address_id INTEGER REFERENCES sales.clients_addresses(id) ON UPDATE CASCADE ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  client_number TEXT,
  contact TEXT,
  shipping_address JSONB,
  status TEXT NOT NULL DEFAULT 'a-faire',
  sold_by TEXT NOT NULL,
  trip_number TEXT,
  customer_po TEXT,
  ordered_date DATE NOT NULL,
  loaded_date DATE,
  loaded_time TIME,
  delivered_date DATE,
  delivered_time TIME,
  shipped_date DATE,
  carrier TEXT,
  seller TEXT,
  transport_temperature NUMERIC(8, 2),
  drop_number INTEGER,
  currency_code CHAR(3) NOT NULL DEFAULT 'CAD',
  subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_orders_status_check CHECK (status IN ('a-faire', 'en-cours', 'expedie', 'facture')),
  CONSTRAINT sales_orders_drop_number_check CHECK (drop_number IS NULL OR drop_number >= 0)
);

CREATE TABLE IF NOT EXISTS sales.order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES sales.orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  finished_product_id INTEGER NOT NULL REFERENCES public.finished_product(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  product_code TEXT,
  quantity_ordered NUMERIC(14, 3) NOT NULL,
  unit_price NUMERIC(14, 2) NOT NULL,
  discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0,
  line_subtotal NUMERIC(14, 2) NOT NULL,
  line_total NUMERIC(14, 2) NOT NULL,
  gl_number TEXT,
  actual_pallets INTEGER,
  planned_pallets INTEGER,
  pallet_type TEXT,
  origin TEXT,
  packed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_items_quantity_check CHECK (quantity_ordered > 0),
  CONSTRAINT sales_order_items_price_check CHECK (unit_price >= 0),
  CONSTRAINT sales_order_items_discount_check CHECK (discount_percent BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS sales.order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES sales.orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  changed_by_user_id BIGINT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales.inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES sales.orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  order_item_id BIGINT NOT NULL REFERENCES sales.order_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  finished_product_id INTEGER NOT NULL REFERENCES public.finished_product(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  movement_type TEXT NOT NULL DEFAULT 'sale',
  quantity NUMERIC(14, 3) NOT NULL,
  sold_qty_before NUMERIC(14, 3) NOT NULL,
  sold_qty_after NUMERIC(14, 3) NOT NULL,
  balance_qty_before NUMERIC(14, 3) NOT NULL,
  balance_qty_after NUMERIC(14, 3) NOT NULL,
  created_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_inventory_movements_quantity_check CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS sales_orders_created_at_idx ON sales.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS sales_orders_client_idx ON sales.orders (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_order_items_order_idx ON sales.order_items (order_id);
CREATE INDEX IF NOT EXISTS sales_order_status_history_order_idx ON sales.order_status_history (order_id, changed_at);
CREATE INDEX IF NOT EXISTS sales_inventory_movements_order_idx ON sales.inventory_movements (order_id, created_at);
