import { pool } from "../../db";

export type SalesLotSource = "harvesting_tracking" | "production_outputs";

let ensureTablePromise: Promise<void> | null = null;

export function ensureSalesLotAllocationsTable(): Promise<void> {
  if (ensureTablePromise) return ensureTablePromise;

  ensureTablePromise = pool
    .query(
      `
      CREATE TABLE IF NOT EXISTS sales.order_item_lot_allocations (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL
          REFERENCES sales.orders(id) ON DELETE CASCADE,
        order_item_id BIGINT NOT NULL
          REFERENCES sales.order_items(id) ON DELETE CASCADE,
        finished_product_id INTEGER NOT NULL
          REFERENCES public.finished_product(id),
        lot_source TEXT NOT NULL CHECK (
          lot_source IN ('harvesting_tracking', 'production_outputs')
        ),
        lot_number TEXT NOT NULL,
        quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (order_item_id, lot_source, lot_number)
      );

      CREATE INDEX IF NOT EXISTS order_item_lot_allocations_lookup_idx
        ON sales.order_item_lot_allocations (
          finished_product_id,
          lot_source,
          lot_number
        );

      CREATE INDEX IF NOT EXISTS order_item_lot_allocations_order_idx
        ON sales.order_item_lot_allocations (order_id, order_item_id);
    `,
    )
    .then(() => undefined)
    .catch((error) => {
      ensureTablePromise = null;
      throw error;
    });

  return ensureTablePromise;
}
