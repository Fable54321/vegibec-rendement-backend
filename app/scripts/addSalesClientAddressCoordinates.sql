ALTER TABLE sales.clients_addresses
ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

ALTER TABLE sales.clients_addresses
DROP CONSTRAINT IF EXISTS sales_clients_addresses_latitude_check,
DROP CONSTRAINT IF EXISTS sales_clients_addresses_longitude_check;

ALTER TABLE sales.clients_addresses
ADD CONSTRAINT sales_clients_addresses_latitude_check
CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
ADD CONSTRAINT sales_clients_addresses_longitude_check
CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
