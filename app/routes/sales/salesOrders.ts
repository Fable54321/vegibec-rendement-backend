import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const readRoles = requireAppRole("rendement", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("rendement", ["admin", "user"]);
const statuses = new Set(["a-faire", "en-cours", "expedie", "facture"]);
const sellingCompanies = new Set(["Vegibec", "Vegisol"]);
const cleanText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const positiveId = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const numberInRange = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};
type ParsedItem = {
  productId: number | null; quantity: number | null; unitPrice: number | null; discount: number | null;
  glNumber: string | null; actualPallets: number | null; plannedPallets: number | null; quantityPerPallet: number | null;
  palletType: string | null; origin: string | null; packed: boolean;
};

router.get("/orders", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*,
        COALESCE(json_agg(json_build_object(
          'id', i.id, 'finished_product_id', i.finished_product_id,
          'product_name', i.product_name, 'product_code', i.product_code,
          'quantity_ordered', i.quantity_ordered, 'unit_price', i.unit_price,
          'product_weight', fp.weight,
          'discount_percent', i.discount_percent, 'line_total', i.line_total,
          'quantity_per_pallet', i.quantity_per_pallet,
          'actual_pallets', i.actual_pallets, 'planned_pallets', i.planned_pallets,
          'pallet_type', i.pallet_type, 'origin', i.origin, 'packed', i.packed
        ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
      FROM sales.orders o
      LEFT JOIN sales.order_items i ON i.order_id = o.id
      LEFT JOIN public.finished_product fp ON fp.id = i.finished_product_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 250
    `);
    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching sales orders:", error);
    return res.status(500).json({ message: "Impossible de charger le journal des ventes." });
  }
});

router.post("/orders", writeRoles, async (req, res) => {
  const db = await pool.connect();
  try {
    const clientId = positiveId(req.body?.clientId);
    const addressId = req.body?.clientAddressId ? positiveId(req.body.clientAddressId) : null;
    const manualShippingAddress = addressId ? null : cleanText(req.body?.shippingAddress);
    const status = cleanText(req.body?.status) ?? "a-faire";
    const soldBy = cleanText(req.body?.soldBy);
    const soldTo = cleanText(req.body?.soldTo) ?? "CAN";
    const orderedDate = cleanText(req.body?.orderedDate);
    const loadedDate = cleanText(req.body?.loadedDate);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!clientId || !soldBy || !sellingCompanies.has(soldBy) || !["CAN", "É-U"].includes(soldTo) || !orderedDate || !loadedDate || !statuses.has(status) || items.length === 0) {
      return res.status(400).json({ message: "Vendu au, client, date de commande, date chargée, vendu par, statut et produits sont requis." });
    }

    const parsedItems: ParsedItem[] = items.map((item: any) => ({
      productId: positiveId(item.productId),
      quantity: numberInRange(item.quantityOrdered, 0.001),
      unitPrice: numberInRange(item.unitPrice, 0),
      discount: item.discount === "" || item.discount == null ? 0 : numberInRange(item.discount, 0, 100),
      glNumber: cleanText(item.glNumber),
      actualPallets: item.actualPallets === "" || item.actualPallets == null ? null : numberInRange(item.actualPallets, 0),
      plannedPallets: item.plannedPallets === "" || item.plannedPallets == null ? null : numberInRange(item.plannedPallets, 0),
      quantityPerPallet: item.quantityPerPallet === "" || item.quantityPerPallet == null ? null : numberInRange(item.quantityPerPallet, 0),
      palletType: cleanText(item.palletType), origin: cleanText(item.origin), packed: Boolean(item.packed),
    }));
    if (parsedItems.some((item) => !item.productId || item.quantity === null || item.unitPrice === null || item.discount === null || item.actualPallets === null || !item.palletType)) {
      return res.status(400).json({ message: "Un produit contient une quantité, un prix, un nombre de palettes réel ou un type de palette invalide." });
    }

    await db.query("BEGIN");
    const client = await db.query(`
      SELECT c.id, c.name, c.client_number, c.representative,
        CASE
          WHEN $3::text IS NOT NULL THEN jsonb_build_object('manual_address', $3::text)
          WHEN a.id IS NULL THEN NULL
          ELSE jsonb_build_object('id',a.id,'site_number',a.site_number,'site_name',a.site_name,'address',a.address,'city',a.city,'postal_code',a.postal_code,'province',a.province,'country',a.country)
        END shipping_address
      FROM sales.clients c LEFT JOIN sales.clients_addresses a ON a.id=$2 AND a.client_id=c.id WHERE c.id=$1
    `, [clientId, addressId, manualShippingAddress]);
    if (!client.rowCount) { await db.query("ROLLBACK"); return res.status(404).json({ message: "Client introuvable." }); }

    const productIds = parsedItems.map((item) => item.productId);
    const products = await db.query(`
      SELECT fp.id, fp.full_name, fp.product_code, fp.product_type, fp.weight, ip.sold_qty, ip.balance_qty
      FROM public.finished_product fp
      JOIN inventory.produce ip ON ip.produce_id=fp.id
      WHERE fp.id = ANY($1::int[]) AND fp.is_active=true
      FOR UPDATE OF ip
    `, [productIds]);
    const productMap = new Map(products.rows.map((row) => [Number(row.id), row]));
    if (productMap.size !== new Set(productIds).size) {
      await db.query("ROLLBACK");
      return res.status(409).json({ message: "Un produit n'est pas actif ou n'est pas relié à l'inventaire." });
    }
    const incompatibleProducts = products.rows.filter((product) => {
      const productType = String(product.product_type ?? "").trim().toUpperCase();
      const isCabbage = productType.startsWith("CHOU");
      const isVegibecException = productType === "CHOU DE BRUXELLES" || productType === "CHOU-FLEUR";
      const belongsToVegisol = isCabbage && !isVegibecException;
      return (soldBy === "Vegisol") !== belongsToVegisol;
    });
    if (incompatibleProducts.length) {
      await db.query("ROLLBACK");
      return res.status(409).json({
        message: `Vendeur incompatible avec: ${incompatibleProducts.map((product) => product.full_name).join(", ")}.`,
      });
    }
    const subtotal = parsedItems.reduce((sum: number, item: ParsedItem) => sum + item.quantity! * item.unitPrice!, 0);
    const total = parsedItems.reduce((sum: number, item: ParsedItem) => sum + item.quantity! * item.unitPrice! * (1 - item.discount! / 100), 0);
    const refResult = await db.query("SELECT nextval('sales.order_reference_seq') AS seq, nextval('sales.trip_number_seq') AS trip_number");
    const reference = `V-${new Date().getFullYear()}-${String(refResult.rows[0].seq).padStart(6, "0")}`;
    const tripNumber = String(refResult.rows[0].trip_number);
    const c = client.rows[0];
    const order = await db.query(`
      INSERT INTO sales.orders (order_reference,client_id,client_address_id,client_name,client_number,contact,shipping_address,status,sold_by,sold_to,trip_number,customer_po,ordered_date,loaded_date,loaded_time,delivered_date,delivered_time,shipped_date,carrier,seller,transport_temperature,drop_number,subtotal,discount_total,total,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *
    `, [reference,clientId,addressId,c.name,c.client_number,c.representative,c.shipping_address,status,soldBy,soldTo,tripNumber,cleanText(req.body.reference),orderedDate,loadedDate,cleanText(req.body.loadedTime),cleanText(req.body.deliveredDate),cleanText(req.body.deliveredTime),cleanText(req.body.shippedDate),cleanText(req.body.carrier),cleanText(req.body.seller),req.body.transportTemperature === "" ? null : numberInRange(req.body.transportTemperature,-200,200),req.body.dropNumber === "" ? null : numberInRange(req.body.dropNumber,0),subtotal,subtotal-total,total,req.user?.id ?? null]);

    const savedItems = [];
    for (const item of parsedItems) {
      const product = productMap.get(item.productId!);
      const lineSubtotal = item.quantity! * item.unitPrice!;
      const lineTotal = lineSubtotal * (1 - item.discount! / 100);
      const saved = await db.query(`INSERT INTO sales.order_items (order_id,finished_product_id,product_name,product_code,quantity_ordered,unit_price,discount_percent,line_subtotal,line_total,gl_number,actual_pallets,planned_pallets,quantity_per_pallet,pallet_type,origin,packed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [order.rows[0].id,item.productId,product.full_name,product.product_code,item.quantity,item.unitPrice,item.discount,lineSubtotal,lineTotal,item.glNumber,item.actualPallets,item.plannedPallets,item.quantityPerPallet,item.palletType,item.origin,item.packed]);
      savedItems.push({ ...saved.rows[0], product_weight: product.weight });
      const updated = await db.query(`UPDATE inventory.produce SET sold_qty=sold_qty+$2, balance_qty=balance_qty-$2 WHERE produce_id=$1 RETURNING sold_qty,balance_qty`, [item.productId,item.quantity]);
      await db.query(`INSERT INTO sales.inventory_movements (order_id,order_item_id,finished_product_id,quantity,sold_qty_before,sold_qty_after,balance_qty_before,balance_qty_after,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [order.rows[0].id,saved.rows[0].id,item.productId,item.quantity,product.sold_qty,updated.rows[0].sold_qty,product.balance_qty,updated.rows[0].balance_qty,req.user?.id ?? null]);
      product.sold_qty = updated.rows[0].sold_qty; product.balance_qty = updated.rows[0].balance_qty;
    }
    await db.query(`INSERT INTO sales.order_status_history (order_id,to_status,note,changed_by_user_id) VALUES ($1,$2,'Création de la vente',$3)`, [order.rows[0].id,status,req.user?.id ?? null]);
    await db.query("COMMIT");
    return res.status(201).json({ ...order.rows[0], items: savedItems });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    console.error("Error creating sales order:", error);
    return res.status(500).json({ message: "Impossible d'enregistrer la vente." });
  } finally { db.release(); }
});

export default router;
