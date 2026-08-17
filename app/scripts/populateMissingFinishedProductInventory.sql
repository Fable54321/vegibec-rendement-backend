INSERT INTO inventory.produce (
  vegetable_id,
  full_name,
  product_code,
  bought_qty,
  sold_qty,
  in_transit_qty,
  accounting_equivalence,
  product_type,
  format,
  cup,
  on_hand_qty,
  estimated_pallet_qty,
  balance_qty,
  last_cost,
  amount,
  produce_id
)
SELECT
  fp.vegetable_id,
  fp.full_name,
  fp.product_code,
  0,
  0,
  0,
  '0',
  fp.product_type,
  fp.quantity_format,
  fp.cup,
  0,
  0,
  0,
  0,
  0,
  fp.id
FROM public.finished_product fp
WHERE NOT EXISTS (
  SELECT 1
  FROM inventory.produce ip
  WHERE ip.produce_id = fp.id
)
ON CONFLICT DO NOTHING;
