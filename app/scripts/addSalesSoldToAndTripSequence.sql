ALTER TABLE sales.orders
ADD COLUMN IF NOT EXISTS sold_to TEXT NOT NULL DEFAULT 'CAN';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_orders_sold_to_check'
      AND conrelid = 'sales.orders'::regclass
  ) THEN
    ALTER TABLE sales.orders
    ADD CONSTRAINT sales_orders_sold_to_check CHECK (sold_to IN ('CAN', 'É-U'));
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS sales.trip_number_seq
START WITH 11626
INCREMENT BY 1;
