import { pool } from "../../../db";
import type { PoolClient } from "pg";

import type {
  CreateSeedPurchaseInput,
  SeedInventoryAdjustment,
} from "./seedInventoryTypes";

// Convert PostgreSQL NUMERIC values into JavaScript numbers.
function normalizeNumeric<T extends Record<string, any>>(
  row: T,
  fields: string[],
): T {
  const result = { ...row };

  for (const field of fields) {
    if (result[field] !== null && result[field] !== undefined) {
      (result as any)[field] = Number(result[field]);
    }
  }

  return result;
}

const inventoryNumbers = [
  "quantity_m",
  "reserved_quantity_m",
  "available_quantity_m",
  "total_quantity_m",
];

// ==========================================
// PURCHASES
// ==========================================

export async function getPurchases() {
  const result = await pool.query(`
    SELECT
      sp.*,
      sl.id AS resolved_seed_lot_id
    FROM trackability.seed_purchases sp
    LEFT JOIN trackability.seed_lots sl
      ON sl.id = sp.seed_lot_id
    ORDER BY sp.reception_date DESC, sp.id DESC
  `);

  return result.rows.map((row) =>
    normalizeNumeric(row, [
      "quantity_m",
      "price_per_thousand",
      "total_cost",
      "germination_percentage",
      "thousand_seed_weight_grams",
    ]),
  );
}

async function findOrCreateSeedLot(
  client: PoolClient,
  input: CreateSeedPurchaseInput,
): Promise<number> {
  const supplierId = input.supplier_id;
  const supplierLot = input.supplier_lot_number.trim();

  const result = await client.query(
    `
    INSERT INTO trackability.seed_lots (
      cultivar_id,
      supplier_id,
      supplier_lot_number,
      germination_percentage,
      thousand_seed_weight_grams
    )
    VALUES ($1, $2, $3, $4, $5)

    ON CONFLICT (
      cultivar_id,
      supplier_id,
      supplier_lot_number
    )
    DO UPDATE SET
      supplier_lot_number = EXCLUDED.supplier_lot_number

    RETURNING id
    `,
    [
      input.cultivar_id,
      supplierId,
      supplierLot,
      input.germination_percentage ?? null,
      input.thousand_seed_weight_grams ?? null,
    ],
  );

  return result.rows[0].id;
}

export async function createPurchase(
  input: CreateSeedPurchaseInput,
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const seedLotId = await findOrCreateSeedLot(
      client,
      input,
    );

    const result = await client.query(
      `
      INSERT INTO trackability.seed_purchases (
        seed_lot_id,
        cultivar_id,

        purchase_number,
        purchase_date,
        reception_date,

        supplier_id,
        supplier_lot_number,

        quantity_m,
        price_per_thousand,
        total_cost,

        germination_percentage,
        thousand_seed_weight_grams,
        packaging,
        notes
      )
      VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14
      )
      RETURNING *
      `,
      [
        seedLotId,
        input.cultivar_id,

        input.purchase_number ?? null,
        input.purchase_date ?? null,
        input.reception_date,

        input.supplier_id,
        input.supplier_lot_number.trim(),

        input.quantity_m,
        input.price_per_thousand ?? null,
        input.total_cost ??
          (input.price_per_thousand != null
            ? input.quantity_m * input.price_per_thousand
            : null),

        input.germination_percentage ?? null,
        input.thousand_seed_weight_grams ?? null,
        input.packaging ?? null,
        input.notes ?? null,
      ],
    );

    // The existing PostgreSQL trigger initializes
    // seed_inventory automatically after this INSERT.
    // Do not also insert into seed_inventory here.

    await client.query("COMMIT");

    return normalizeNumeric(result.rows[0], [
      "quantity_m",
      "price_per_thousand",
      "total_cost",
      "germination_percentage",
      "thousand_seed_weight_grams",
    ]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// SUPPLIER LOTS
// ==========================================

export async function getLots() {
  const result = await pool.query(`
    SELECT
      sl.*,
      COUNT(DISTINCT sp.id)::int AS purchase_count,
      COALESCE(SUM(si.quantity_m), 0)
        AS quantity_m,
      COALESCE(SUM(si.reserved_quantity_m), 0)
        AS reserved_quantity_m

    FROM trackability.seed_lots sl

    LEFT JOIN trackability.seed_purchases sp
      ON sp.seed_lot_id = sl.id

    LEFT JOIN trackability.seed_inventory si
      ON si.seed_purchase_id = sp.id

    GROUP BY sl.id
    ORDER BY sl.cultivar_id, sl.supplier_lot_number
  `);

  return result.rows.map((row) =>
    normalizeNumeric(row, [
      "germination_percentage",
      "thousand_seed_weight_grams",
      "quantity_m",
      "reserved_quantity_m",
    ]),
  );
}

export async function getLotById(id: number) {
  const lotResult = await pool.query(
    `
    SELECT *
    FROM trackability.seed_lots
    WHERE id = $1
    `,
    [id],
  );

  if (lotResult.rowCount === 0) {
    return null;
  }

  const purchasesResult = await pool.query(
    `
    SELECT
      sp.*,
      si.quantity_m AS remaining_quantity_m,
      si.reserved_quantity_m

    FROM trackability.seed_purchases sp

    LEFT JOIN trackability.seed_inventory si
      ON si.seed_purchase_id = sp.id

    WHERE sp.seed_lot_id = $1

    ORDER BY sp.reception_date, sp.id
    `,
    [id],
  );

  return {
    ...normalizeNumeric(lotResult.rows[0], [
      "germination_percentage",
      "thousand_seed_weight_grams",
    ]),

    purchases: purchasesResult.rows.map((row) =>
      normalizeNumeric(row, [
        "quantity_m",
        "remaining_quantity_m",
        "reserved_quantity_m",
        "price_per_thousand",
        "total_cost",
        "germination_percentage",
        "thousand_seed_weight_grams",
      ]),
    ),
  };
}

// ==========================================
// INVENTORY BY CULTIVAR
// ==========================================

export async function getInventory() {
  const result = await pool.query(`
    SELECT
      si.cultivar_id,

      COALESCE(SUM(si.quantity_m), 0)
        AS total_quantity_m,

      COALESCE(SUM(si.reserved_quantity_m), 0)
        AS reserved_quantity_m,

      COALESCE(SUM(si.available_quantity_m), 0)
        AS available_quantity_m,

      COUNT(DISTINCT sp.seed_lot_id)::int
        AS number_of_lots

    FROM trackability.seed_inventory si

    JOIN trackability.seed_purchases sp
      ON sp.id = si.seed_purchase_id

    GROUP BY si.cultivar_id

    ORDER BY si.cultivar_id
  `);

  return result.rows.map((row) =>
    normalizeNumeric(row, inventoryNumbers),
  );
}

// ==========================================
// INVENTORY DETAILS BY CULTIVAR
// ==========================================

export async function getCultivarInventory(
  cultivarId: number,
) {
  const result = await pool.query(
    `
    SELECT
      sl.id AS seed_lot_id,
      sl.cultivar_id,
      sl.supplier_id,
      sl.supplier_lot_number,
      sl.germination_percentage,

      COALESCE(SUM(si.quantity_m), 0)
        AS quantity_m,

      COALESCE(SUM(si.reserved_quantity_m), 0)
        AS reserved_quantity_m,

      COALESCE(SUM(si.available_quantity_m), 0)
        AS available_quantity_m

    FROM trackability.seed_lots sl

    LEFT JOIN trackability.seed_purchases sp
      ON sp.seed_lot_id = sl.id

    LEFT JOIN trackability.seed_inventory si
      ON si.seed_purchase_id = sp.id

    WHERE sl.cultivar_id = $1

    GROUP BY sl.id

    ORDER BY sl.supplier_id, sl.supplier_lot_number
    `,
    [cultivarId],
  );

  return result.rows.map((row) =>
    normalizeNumeric(row, [
      ...inventoryNumbers,
      "germination_percentage",
    ]),
  );
}

// ==========================================
// MANUAL STOCK ADJUSTMENTS
// ==========================================

export async function adjustInventory(
  input: SeedInventoryAdjustment,
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock inventory rows to prevent concurrent stock
    // changes from producing inconsistent balances.
    const result = await client.query(
      `
      SELECT
        si.id,
        si.quantity_m,
        si.reserved_quantity_m

      FROM trackability.seed_inventory si

      JOIN trackability.seed_purchases sp
        ON sp.id = si.seed_purchase_id

      WHERE sp.seed_lot_id = $1

      ORDER BY sp.reception_date, sp.id

      FOR UPDATE OF si
      `,
      [input.seed_lot_id],
    );

    if (result.rows.length === 0) {
      throw new Error("SEED_LOT_INVENTORY_NOT_FOUND");
    }

    const adjustment = input.adjustment_m;

    if (adjustment > 0) {
      // Credit the oldest reception's inventory row.
      await client.query(
        `
        UPDATE trackability.seed_inventory
        SET
          quantity_m = quantity_m + $1,
          last_updated = NOW()
        WHERE id = $2
        `,
        [adjustment, result.rows[0].id],
      );
    } else {
      let remaining = Math.abs(adjustment);

      // Remove unreserved stock from the oldest
      // reception first.
      for (const row of result.rows) {
        if (remaining <= 0.0000001) break;

        const available =
          Number(row.quantity_m) -
          Number(row.reserved_quantity_m);

        const deduction = Math.min(
          available,
          remaining,
        );

        if (deduction <= 0) continue;

        await client.query(
          `
          UPDATE trackability.seed_inventory
          SET
            quantity_m = quantity_m - $1,
            last_updated = NOW()
          WHERE id = $2
          `,
          [deduction, row.id],
        );

        remaining = Number(
          (remaining - deduction).toFixed(3),
        );
      }

      if (remaining > 0.0000001) {
        throw new Error("INSUFFICIENT_AVAILABLE_STOCK");
      }
    }

    const balanceResult = await client.query(
      `
      SELECT
        COALESCE(SUM(si.quantity_m), 0)
          AS quantity_m,
        COALESCE(SUM(si.reserved_quantity_m), 0)
          AS reserved_quantity_m,
        COALESCE(SUM(si.available_quantity_m), 0)
          AS available_quantity_m

      FROM trackability.seed_inventory si

      JOIN trackability.seed_purchases sp
        ON sp.id = si.seed_purchase_id

      WHERE sp.seed_lot_id = $1
      `,
      [input.seed_lot_id],
    );

    await client.query("COMMIT");

    return {
      seed_lot_id: input.seed_lot_id,
      adjustment_m: adjustment,
      reason: input.reason,
      ...normalizeNumeric(balanceResult.rows[0], [
        "quantity_m",
        "reserved_quantity_m",
        "available_quantity_m",
      ]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}