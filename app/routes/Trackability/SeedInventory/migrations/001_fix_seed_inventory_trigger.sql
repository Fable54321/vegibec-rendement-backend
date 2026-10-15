CREATE OR REPLACE FUNCTION trackability.initialize_seed_inventory()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO trackability.seed_inventory (
    seed_purchase_id,
    cultivar_id,
    quantity_m
  )
  SELECT
    NEW.id,
    seed_lots.cultivar_id,
    NEW.quantity_m
  FROM trackability.seed_lots
  WHERE seed_lots.id = NEW.seed_lot_id;

  RETURN NEW;
END;
$function$;
