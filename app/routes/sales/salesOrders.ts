import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import type { PoolClient } from "pg";

type SalesLotSource = "harvesting_tracking" | "production_outputs";
class SalesError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bigintId = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "number" && !Number.isSafeInteger(v)) return null;
  const s = String(v);
  return /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n ? s : null;
};
const actorId = (v: unknown): number => {
  const id = positiveId(v);
  if (!id || id > 2147483647) throw new SalesError(401, "Utilisateur authentifié requis.");
  return id;
};
async function beginWrite(db: PoolClient) {
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await db.query("SELECT pg_advisory_xact_lock(7142, 1)");
}
function salesFailure(res: import("express").Response, error: unknown, fallback: string) {
  if (error instanceof SalesError) return res.status(error.status).json({ message: error.message });
  const pg = error as { code?: string; message?: string };
  if (pg.code === "P0001") return res.status(409).json({ message: pg.message ?? "Opération refusée." });
  if (["23505", "40001", "40P01"].includes(pg.code ?? "")) return res.status(409).json({ message: "Conflit de données. Veuillez réessayer." });
  if (["23503", "23514", "23502", "22P02", "22003", "22007", "22008"].includes(pg.code ?? "")) return res.status(400).json({ message: "Données invalides ou référence introuvable." });
  console.error(fallback, error);
  return res.status(500).json({ message: fallback });
}

const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);
const statuses = new Set(["a-faire", "en-cours", "expedie", "facture"]);
const sellingCompanies = new Set(["Vegibec", "Vegisol"]);
const cleanText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const positiveId = (value: unknown) =>
  (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : null;
const numberInRange = (
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
};
type ParsedItem = {
  productId: number | null;
  quantity: number | null;
  unitPrice: number | null;
  discount: number | null;
  glNumber: string | null;
  actualPallets: number | null;
  plannedPallets: number | null;
  quantityPerPallet: number | null;
  palletType: string | null;
  lotNumbers: string[] | null;
  lotAllocations: ParsedLotAllocation[] | null;
  packed: boolean;
};

type ParsedLotAllocation = {
  lotId: string | null;
  lotNumber: string | null;
  lotSource: SalesLotSource | null;
  quantity: number;
};

const lotSources = new Set<SalesLotSource>([
  "harvesting_tracking",
  "production_outputs",
]);

const parseLotNumbers = (value: unknown): string[] | null => {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || value.length > 100) return null;

  const lotNumbers = value.map(cleanText);
  if (lotNumbers.some((lotNumber) => !lotNumber || lotNumber.length > 255)) {
    return null;
  }
  return [...new Set(lotNumbers as string[])];
};

const parseLotAllocations = (value: unknown): ParsedLotAllocation[] | null => {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const allocations: ParsedLotAllocation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const lotId = bigintId(entry.lotId ?? entry.lot_id);
    const lotNumber = cleanText(entry.lotNumber);
    const lotSource = cleanText(entry.lotSource) as SalesLotSource | null;
    const quantity = numberInRange(entry.quantity, 1, 2147483647);
    if ((entry.lotId != null || entry.lot_id != null) && !lotId) return null;
    if ((!lotId && !lotNumber) || (lotNumber && lotNumber.length > 50) ||
        (lotSource && !lotSources.has(lotSource)) || quantity === null || !Number.isInteger(quantity)) return null;
    allocations.push({ lotId, lotNumber, lotSource, quantity });
  }
  return allocations;
};

const fetchAvailableProductLots = async (
  query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>,
  finishedProductId: number,
) => {
  const { rows } = await query(`
    SELECT lot_id::text AS lot_id, lot_id::text AS "lotId", lot_number, lot_type,
           product_id AS product_reference_id, finished_product_id,
           CASE WHEN lot_type = 'harvest' THEN 'harvesting_tracking' ELSE 'production_outputs' END AS lot_source,
           created_at AS recorded_at, available_boxes AS available_quantity,
           available_boxes, reserved_boxes
    FROM trackability.lot_balances
    WHERE finished_product_id = $1 AND available_boxes > 0
    ORDER BY lot_date DESC, lot_id DESC
  `, [finishedProductId]);
  return rows.map(lot => ({ ...lot, sources: [lot.lot_source] }));
};

async function resolveAllocations(db: PoolClient, item: ParsedItem) {
  const merged = new Map<string, { lotId: string; lotNumber: string; lotSource: SalesLotSource; quantity: number }>();
  for (const allocation of item.lotAllocations ?? []) {
    const { rows } = await db.query(`
      SELECT l.id::text AS id, l.lot_number, l.lot_type, pr.finished_product_id
      FROM trackability.lots l JOIN trackability.product_reference pr ON pr.id=l.product_id
      WHERE ($1::bigint IS NULL OR l.id=$1) AND ($2::text IS NULL OR l.lot_number=$2)
    `, [allocation.lotId, allocation.lotNumber]);
    const lot = rows[0];
    if (!lot || Number(lot.finished_product_id) !== item.productId)
      throw new SalesError(400, "Le lot sélectionné ne correspond pas au produit.");
    const lotSource: SalesLotSource = lot.lot_type === "harvest" ? "harvesting_tracking" : "production_outputs";
    if (allocation.lotSource && allocation.lotSource !== lotSource)
      throw new SalesError(400, "Source du lot invalide.");
    const quantity = (merged.get(lot.id)?.quantity ?? 0) + allocation.quantity;
    if (quantity > 2147483647) throw new SalesError(400, "Quantité du lot invalide.");
    merged.set(lot.id, { lotId: lot.id, lotNumber: lot.lot_number, lotSource, quantity });
  }
  return [...merged.values()];
}

router.get("/product-lots", readRoles, async (req, res) => {
  const finishedProductId = positiveId(req.query.finishedProductId);
  if (!finishedProductId) {
    return res
      .status(400)
      .json({ message: "Le produit sélectionné est invalide." });
  }

  try {
    const lots = await fetchAvailableProductLots(
      (text, values) => pool.query(text, values),
      finishedProductId,
    );
    return res.json(lots);
  } catch (error) {
    console.error("Error fetching sales product lots:", error);
    return res
      .status(500)
      .json({ message: "Impossible de charger les numéros de lot." });
  }
});

router.get("/orders", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*,
        COALESCE(json_agg(json_build_object(
          'id', i.id::text, 'finished_product_id', i.finished_product_id,
          'product_name', i.product_name, 'product_code', i.product_code,
          'quantity_ordered', i.quantity_ordered, 'unit_price', i.unit_price,
          'product_weight', fp.weight,
          'discount_percent', i.discount_percent, 'line_total', i.line_total,
          'quantity_per_pallet', i.quantity_per_pallet,
          'actual_pallets', i.actual_pallets, 'planned_pallets', i.planned_pallets,
          'pallet_type', i.pallet_type, 'origin', i.origin,
          'lot_numbers', COALESCE(
            (
              SELECT array_agg(DISTINCT a.lot_number ORDER BY a.lot_number)
              FROM sales.order_item_lot_allocation_balances a
              WHERE a.order_item_id = i.id AND a.reserved_boxes + a.shipped_boxes > 0
            ),
            ARRAY[]::text[]
          ),
          'lot_allocations', COALESCE(
            (
              SELECT json_agg(json_build_object(
                'id', a.allocation_id::text,
                'lotId', a.lot_id::text,
                'lotNumber', a.lot_number,
                'lotSource', CASE WHEN a.lot_type = 'harvest' THEN 'harvesting_tracking' ELSE 'production_outputs' END,
                'quantity', a.reserved_boxes + a.shipped_boxes,
                'original_quantity', a.original_quantity,
                'allocated_boxes', a.allocated_boxes,
                'reserved_boxes', a.reserved_boxes,
                'shipped_boxes', a.shipped_boxes,
                'released_boxes', a.released_boxes,
                'allocation_status', a.allocation_status
              ) ORDER BY a.allocation_id)
              FROM sales.order_item_lot_allocation_balances a
              WHERE a.order_item_id = i.id
            ),
            '[]'::json
          ),
          'packed', i.packed
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
    return res
      .status(500)
      .json({ message: "Impossible de charger le journal des ventes." });
  }
});

router.post("/orders", writeRoles, async (req, res) => {
  let db: PoolClient | undefined;
  let discard = false;
  try {
    db = await pool.connect();
    const clientId = positiveId(req.body?.clientId);
    const addressId = req.body?.clientAddressId
      ? positiveId(req.body.clientAddressId)
      : null;
    if (req.body?.clientAddressId && !addressId) {
      return res.status(400).json({ message: "Adresse invalide." });
    }
    const manualShippingAddress = addressId
      ? null
      : cleanText(req.body?.shippingAddress);
    const status = cleanText(req.body?.status) ?? "a-faire";
    const soldBy = cleanText(req.body?.soldBy);
    const soldTo = cleanText(req.body?.soldTo) ?? "CAN";
    const sellerName =
      cleanText(req.body?.sellerName) ?? cleanText(req.body?.seller);
    const soldByUserIdValue = req.body?.soldByUserId;
    const soldByUserId =
      soldByUserIdValue === "" || soldByUserIdValue == null
        ? null
        : positiveId(soldByUserIdValue);
    const orderedDate = cleanText(req.body?.orderedDate);
    const loadedDate = cleanText(req.body?.loadedDate);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (
      !clientId ||
      !soldBy ||
      !sellingCompanies.has(soldBy) ||
      !["CAN", "É-U"].includes(soldTo) ||
      !orderedDate ||
      !loadedDate ||
      !statuses.has(status) ||
      items.length === 0
    ) {
      return res.status(400).json({
        message:
          "Vendu au, client, date de commande, date chargée, vendu par, statut et produits sont requis.",
      });
    }
    if (
      soldByUserIdValue !== "" &&
      soldByUserIdValue != null &&
      !soldByUserId
    ) {
      return res
        .status(400)
        .json({ message: "Le vendeur sélectionné est invalide." });
    }

    if (items.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item))) {
      return res.status(400).json({ message: "Produit invalide." });
    }
    const userId = actorId(req.user?.id);
    const parsedItems: ParsedItem[] = items.map((item: any) => {
      const lotAllocations = parseLotAllocations(item.lotAllocations);
      const allocationLotNumbers = lotAllocations?.flatMap(
        (allocation) => allocation.lotNumber ? [allocation.lotNumber] : [],
      );

      return {
        productId: positiveId(item.productId),
        quantity: numberInRange(item.quantityOrdered, 0.001),
        unitPrice: numberInRange(item.unitPrice, 0),
        discount:
          item.discount === "" || item.discount == null
            ? 0
            : numberInRange(item.discount, 0, 100),
        glNumber: cleanText(item.glNumber),
        actualPallets:
          item.actualPallets === "" || item.actualPallets == null
            ? null
            : numberInRange(item.actualPallets, 0),
        plannedPallets:
          item.plannedPallets === "" || item.plannedPallets == null
            ? null
            : numberInRange(item.plannedPallets, 0),
        quantityPerPallet:
          item.quantityPerPallet === "" || item.quantityPerPallet == null
            ? null
            : numberInRange(item.quantityPerPallet, 0),
        palletType: cleanText(item.palletType),
        lotNumbers:
          allocationLotNumbers && allocationLotNumbers.length > 0
            ? [...new Set(allocationLotNumbers)]
            : parseLotNumbers(
                item.lotNumbers === undefined
                  ? cleanText(item.origin)
                    ? [item.origin]
                    : []
                  : item.lotNumbers,
              ),
        lotAllocations,
        packed: Boolean(item.packed),
      };
    });
    if (
      parsedItems.some(
        (item) =>
          !item.productId ||
          item.quantity === null ||
          item.unitPrice === null ||
          item.discount === null ||
          item.actualPallets === null ||
          item.lotNumbers === null ||
          item.lotAllocations === null ||
          !item.palletType,
      )
    ) {
      return res.status(400).json({
        message:
          "Un produit contient une quantité, un prix, un nombre de palettes réel ou un type de palette invalide.",
      });
    }
    const overallocatedItemIndex = parsedItems.findIndex(
      (item) =>
        (item.lotAllocations ?? []).reduce(
          (total, allocation) => total + allocation.quantity,
          0,
        ) >
        item.quantity! + 0.000001,
    );
    if (overallocatedItemIndex !== -1) {
      return res.status(400).json({
        message: `La quantité attribuée aux lots du produit ${overallocatedItemIndex + 1} dépasse la quantité commandée.`,
      });
    }

    await beginWrite(db);
    const client = await db.query(
      `
      SELECT c.id, c.name, c.client_number, c.representative,
        CASE
          WHEN $3::text IS NOT NULL THEN jsonb_build_object('manual_address', $3::text)
          WHEN a.id IS NULL THEN NULL
          ELSE jsonb_build_object('id',a.id,'site_number',a.site_number,'site_name',a.site_name,'address',a.address,'city',a.city,'postal_code',a.postal_code,'province',a.province,'country',a.country)
        END shipping_address
      FROM sales.clients c LEFT JOIN sales.clients_addresses a ON a.id=$2 AND a.client_id=c.id WHERE c.id=$1
    `,
      [clientId, addressId, manualShippingAddress],
    );
    if (!client.rowCount) {
      await db.query("ROLLBACK");
      return res.status(404).json({ message: "Client introuvable." });
    }

    if (addressId && !client.rows[0].shipping_address) {
      throw new SalesError(400, "Adresse introuvable pour ce client.");
    }
    let resolvedSellerName = sellerName;
    let resolvedSoldByUserId = soldByUserId;
    if (soldByUserId) {
      const seller = await db.query(
        `SELECT id, name, surname FROM public.users WHERE id = $1 AND is_active = true`,
        [soldByUserId],
      );
      if (!seller.rowCount) {
        await db.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: "Le vendeur sélectionné est introuvable." });
      }
      resolvedSellerName = [seller.rows[0].surname, seller.rows[0].name]
        .filter(Boolean)
        .join(" ");
    } else if (sellerName) {
      const seller = await db.query(
        `
        SELECT id, name, surname
        FROM public.users
        WHERE is_active = true
          AND (
            regexp_replace(lower(concat(surname, name)), '[[:space:]]+', '', 'g') = regexp_replace(lower($1), '[[:space:]]+', '', 'g')
            OR regexp_replace(lower(concat(name, surname)), '[[:space:]]+', '', 'g') = regexp_replace(lower($1), '[[:space:]]+', '', 'g')
          )
        ORDER BY id
        LIMIT 1
        `,
        [sellerName],
      );
      if (seller.rowCount) {
        resolvedSoldByUserId = Number(seller.rows[0].id);
        resolvedSellerName = [seller.rows[0].surname, seller.rows[0].name]
          .filter(Boolean)
          .join(" ");
      }
    }

    const productIds = parsedItems.map((item) => item.productId);
    const products = await db.query(
      `
      SELECT fp.id, fp.full_name, fp.product_code, fp.product_type, fp.weight
      FROM public.finished_product fp
      WHERE fp.id = ANY($1::int[]) AND fp.is_active=true
    `,
      [productIds],
    );
    const productMap = new Map(
      products.rows.map((row) => [Number(row.id), row]),
    );
    if (productMap.size !== new Set(productIds).size) {
      await db.query("ROLLBACK");
      return res.status(409).json({
        message:
          "Un produit est introuvable ou inactif.",
      });
    }
    const resolvedAllocations: Awaited<ReturnType<typeof resolveAllocations>>[] = [];
    for (const item of parsedItems) {
      if (!item.lotAllocations?.length && item.lotNumbers?.length)
        throw new SalesError(400, "Une quantité est requise pour chaque lot sélectionné.");
      resolvedAllocations.push(await resolveAllocations(db, item));
    }

    const incompatibleProducts = products.rows.filter((product) => {
      const productType = String(product.product_type ?? "")
        .trim()
        .toUpperCase();
      const isCabbage = productType.startsWith("CHOU");
      const isVegibecException =
        productType === "CHOU DE BRUXELLES" || productType === "CHOU-FLEUR";
      const belongsToVegisol = isCabbage && !isVegibecException;
      return (soldBy === "Vegisol") !== belongsToVegisol;
    });
    if (incompatibleProducts.length) {
      await db.query("ROLLBACK");
      return res.status(409).json({
        message: `Vendeur incompatible avec: ${incompatibleProducts.map((product) => product.full_name).join(", ")}.`,
      });
    }
    const subtotal = parsedItems.reduce(
      (sum: number, item: ParsedItem) => sum + item.quantity! * item.unitPrice!,
      0,
    );
    const total = parsedItems.reduce(
      (sum: number, item: ParsedItem) =>
        sum + item.quantity! * item.unitPrice! * (1 - item.discount! / 100),
      0,
    );
    const refResult = await db.query(
      "SELECT nextval('sales.order_reference_seq') AS seq, nextval('sales.trip_number_seq') AS trip_number",
    );
    const reference = `V-${new Date().getFullYear()}-${String(refResult.rows[0].seq).padStart(6, "0")}`;
    const tripNumber = String(refResult.rows[0].trip_number);
    const c = client.rows[0];
    const order = await db.query(
      `
      INSERT INTO sales.orders (order_reference,client_id,client_address_id,client_name,client_number,contact,shipping_address,status,sold_by,sold_to,trip_number,customer_po,ordered_date,loaded_date,loaded_time,delivered_date,delivered_time,shipped_date,carrier,transport_temperature,drop_number,subtotal,discount_total,total,seller_name,sold_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *
    `,
      [
        reference,
        clientId,
        addressId,
        c.name,
        c.client_number,
        cleanText(req.body?.contact) ?? c.representative,
        c.shipping_address,
        status,
        soldBy,
        soldTo,
        tripNumber,
        cleanText(req.body.reference),
        orderedDate,
        loadedDate,
        cleanText(req.body.loadedTime),
        cleanText(req.body.deliveredDate),
        cleanText(req.body.deliveredTime),
        cleanText(req.body.shippedDate),
        cleanText(req.body.carrier),
        req.body.transportTemperature === ""
          ? null
          : numberInRange(req.body.transportTemperature, -200, 200),
        req.body.dropNumber === ""
          ? null
          : numberInRange(req.body.dropNumber, 0),
        subtotal,
        subtotal - total,
        total,
        resolvedSellerName,
        resolvedSoldByUserId,
      ],
    );

    const savedItems = [];
    for (const [index, item] of parsedItems.entries()) {
      const allocations = resolvedAllocations[index];
      const lotNumbers = allocations.map(a => a.lotNumber);
      const product = productMap.get(item.productId!);
      const lineSubtotal = item.quantity! * item.unitPrice!;
      const lineTotal = lineSubtotal * (1 - item.discount! / 100);
      const saved = await db.query(
        `INSERT INTO sales.order_items (order_id,finished_product_id,product_name,product_code,quantity_ordered,unit_price,discount_percent,line_subtotal,line_total,gl_number,actual_pallets,planned_pallets,quantity_per_pallet,pallet_type,origin,packed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [
          order.rows[0].id,
          item.productId,
          product.full_name,
          product.product_code,
          item.quantity,
          item.unitPrice,
          item.discount,
          lineSubtotal,
          lineTotal,
          item.glNumber,
          item.actualPallets,
          item.plannedPallets,
          item.quantityPerPallet,
          item.palletType,
          lotNumbers.join(", ") || null,
          item.packed,
        ],
      );
      const savedAllocations = [];
      for (const allocation of allocations) {
        const inserted = await db.query(`
          INSERT INTO sales.order_item_lot_allocations (order_id, order_item_id, lot_id, quantity)
          VALUES ($1,$2,$3,$4) RETURNING id::text AS id
        `, [order.rows[0].id, saved.rows[0].id, allocation.lotId, allocation.quantity]);
        const allocationId = inserted.rows[0].id;
        await db.query(`SELECT sales.reserve_lot_allocation($1::bigint,$2::integer)`, [allocationId, userId]);
        savedAllocations.push({ id: allocationId, ...allocation,
          original_quantity: allocation.quantity, allocated_boxes: allocation.quantity, reserved_boxes: allocation.quantity,
          shipped_boxes: 0, released_boxes: 0, allocation_status: "reserved" });
      }
      savedItems.push({ ...saved.rows[0], lot_numbers: lotNumbers,
        lot_allocations: savedAllocations, product_weight: product.weight });
    }
    await db.query(
      `INSERT INTO sales.order_status_history (order_id,to_status,note) VALUES ($1,$2,'Création de la vente')`,
      [order.rows[0].id, status],
    );
    await db.query("COMMIT");
    return res.status(201).json({ ...order.rows[0], items: savedItems });
  } catch (error) {
    if (db) try { await db.query("ROLLBACK"); } catch { discard = true; }
    return salesFailure(res, error, "Impossible d'enregistrer la vente.");
  } finally {
    db?.release(discard);
  }
});

router.patch("/orders/:id", writeRoles, async (req, res) => {
  const orderId = bigintId(req.params.id);
  if (!orderId) {
    return res.status(400).json({ message: "Commande invalide." });
  }

  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const has = (field: string) =>
    Object.prototype.hasOwnProperty.call(body, field);
  const assignments: string[] = [];
  const values: unknown[] = [orderId];
  const addAssignment = (column: string, value: unknown, cast = "") => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };

  if (has("status")) {
    const status = cleanText(body.status);
    if (!status || !statuses.has(status)) {
      return res.status(400).json({ message: "Le statut est invalide." });
    }
    addAssignment("status", status);
  }
  if (has("contact")) addAssignment("contact", cleanText(body.contact));
  if (has("reference")) {
    addAssignment("customer_po", cleanText(body.reference));
  }
  if (has("soldTo")) {
    const soldTo = cleanText(body.soldTo);
    if (!soldTo || !["CAN", "É-U"].includes(soldTo)) {
      return res
        .status(400)
        .json({ message: "Le pays de vente est invalide." });
    }
    addAssignment("sold_to", soldTo);
  }
  if (has("soldBy")) {
    const soldBy = cleanText(body.soldBy);
    if (!soldBy || !sellingCompanies.has(soldBy)) {
      return res.status(400).json({ message: "Le vendeur est invalide." });
    }
    addAssignment("sold_by", soldBy);
  }
  if (has("carrier")) addAssignment("carrier", cleanText(body.carrier));

  if (has("transportTemperature")) {
    const temperature =
      body.transportTemperature === "" || body.transportTemperature == null
        ? null
        : numberInRange(body.transportTemperature, -200, 200);
    if (
      temperature === null &&
      body.transportTemperature !== "" &&
      body.transportTemperature != null
    ) {
      return res
        .status(400)
        .json({ message: "La température de transport est invalide." });
    }
    addAssignment("transport_temperature", temperature);
  }

  if (has("dropNumber")) {
    const dropNumber =
      body.dropNumber === "" || body.dropNumber == null
        ? null
        : numberInRange(body.dropNumber, 0);
    if (
      dropNumber === null &&
      body.dropNumber !== "" &&
      body.dropNumber != null
    ) {
      return res
        .status(400)
        .json({ message: "Le numéro de drop est invalide." });
    }
    addAssignment("drop_number", dropNumber);
  }

  const requiredDateFields = [
    ["orderedDate", "ordered_date"],
    ["loadedDate", "loaded_date"],
  ] as const;
  for (const [field, column] of requiredDateFields) {
    if (!has(field)) continue;
    const value = cleanText(body[field]);
    if (!value) {
      return res.status(400).json({
        message: "Les dates de commande et de chargement sont requises.",
      });
    }
    addAssignment(column, value);
  }

  const optionalTextFields = [
    ["loadedTime", "loaded_time"],
    ["deliveredDate", "delivered_date"],
    ["deliveredTime", "delivered_time"],
    ["shippedDate", "shipped_date"],
  ] as const;
  for (const [field, column] of optionalTextFields) {
    if (has(field)) addAssignment(column, cleanText(body[field]));
  }

  if (has("shippingAddress")) {
    const shippingAddress = cleanText(body.shippingAddress);
    addAssignment(
      "shipping_address",
      shippingAddress
        ? JSON.stringify({ manual_address: shippingAddress })
        : null,
      "::jsonb",
    );
  }

  let db: PoolClient | undefined;
  let discard = false;
  try {
    db = await pool.connect();
    await beginWrite(db);
    const currentOrder = await db.query(
      "SELECT status FROM sales.orders WHERE id = $1 FOR UPDATE",
      [orderId],
    );
    if (!currentOrder.rowCount) {
      await db.query("ROLLBACK");
      return res.status(404).json({ message: "Commande introuvable." });
    }

    if (has("seller")) {
      const sellerName = cleanText(body.seller);
      let resolvedSellerName = sellerName;
      let resolvedSoldByUserId: number | null = null;
      if (sellerName) {
        const seller = await db.query(
          `
          SELECT id, name, surname
          FROM public.users
          WHERE is_active = true
            AND (
              regexp_replace(lower(concat(surname, name)), '[[:space:]]+', '', 'g') = regexp_replace(lower($1), '[[:space:]]+', '', 'g')
              OR regexp_replace(lower(concat(name, surname)), '[[:space:]]+', '', 'g') = regexp_replace(lower($1), '[[:space:]]+', '', 'g')
            )
          ORDER BY id
          LIMIT 1
          `,
          [sellerName],
        );
        if (seller.rowCount) {
          resolvedSoldByUserId = Number(seller.rows[0].id);
          resolvedSellerName = [seller.rows[0].surname, seller.rows[0].name]
            .filter(Boolean)
            .join(" ");
        }
      }
      addAssignment("seller_name", resolvedSellerName);
      addAssignment("sold_by_user_id", resolvedSoldByUserId);
    }

    if (!assignments.length) {
      await db.query("ROLLBACK");
      return res.status(400).json({ message: "Aucune modification fournie." });
    }

    const updated = await db.query(
      `UPDATE sales.orders SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );
    if (
      has("status") &&
      updated.rows[0].status !== currentOrder.rows[0].status
    ) {
      await db.query(
        `INSERT INTO sales.order_status_history (order_id,to_status,note) VALUES ($1,$2,'Modification de la vente')`,
        [orderId, updated.rows[0].status],
      );
    }
    await db.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (error) {
    if (db) try { await db.query("ROLLBACK"); } catch { discard = true; }
    return salesFailure(res, error, "Impossible de modifier la vente.");
  } finally {
    db?.release(discard);
  }
});

export default router;
