ALTER TABLE toolboxes_inventory.pictures
  ADD COLUMN IF NOT EXISTS order_group_id uuid;

CREATE INDEX IF NOT EXISTS pictures_order_group_id_idx
  ON toolboxes_inventory.pictures (order_group_id)
  WHERE order_group_id IS NOT NULL;
