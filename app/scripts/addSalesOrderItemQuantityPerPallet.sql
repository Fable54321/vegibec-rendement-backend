ALTER TABLE sales.order_items
ADD COLUMN IF NOT EXISTS quantity_per_pallet NUMERIC(14, 3);

ALTER TABLE sales.order_items
DROP CONSTRAINT IF EXISTS sales_order_items_quantity_per_pallet_check;

ALTER TABLE sales.order_items
ADD CONSTRAINT sales_order_items_quantity_per_pallet_check
CHECK (quantity_per_pallet IS NULL OR quantity_per_pallet >= 0);
