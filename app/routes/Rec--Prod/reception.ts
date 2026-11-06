import { Router, type RequestHandler } from "express";
import type { Pool, PoolClient } from "pg";

import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const readRoles = requireAppRole("reception", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("reception", ["admin", "user", "guest"]);

  const router = Router();

  // PostgreSQL BIGINT values can exceed JS's safe integer range. Keep IDs
  // as decimal strings in API responses and parameterized SQL queries.
  const positiveId = (value: unknown): string | null => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value);
    if (!/^[1-9]\d*$/.test(text)) return null;
    try {
      return BigInt(text) <= 9223372036854775807n ? text : null;
    } catch {
      return null;
    }
  };

  const positiveInt = (value: unknown): number | null => {
    if (typeof value !== "number") return null;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };

  function sendDatabaseError(res: any, error: unknown) {
    console.error("Harvest receipts database error:", error);
    return res.status(500).json({ error: "Database operation failed" });
  }

  /**
   * GET /available
   * Finalized harvesting entries with quantity still available to receive.
   * Multiple entries may have the same harvest_lot_number.
   */
  router.get("/available", readRoles, async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          h.id::text AS id,
          h.harvest_lot_number::text AS harvest_lot_number,
          h.field_id,
          h.vegetable_id,
          h.product_id,
          h.box_type_id,
          h.harvesting_date,
          h.harvesting_time,
          h.finalized_at,
          h.amount_of_boxes,
          COALESCE(received.received_boxes, 0)::integer AS already_received_boxes,
          (h.amount_of_boxes - COALESCE(received.received_boxes, 0))::integer
            AS remaining_boxes
        FROM trackability.harvesting_tracking h
        LEFT JOIN (
          SELECT harvesting_id, SUM(received_boxes) AS received_boxes
          FROM trackability.harvest_receipt_entries
          GROUP BY harvesting_id
        ) received ON received.harvesting_id = h.id
        WHERE h.status = 'finalized'
          AND h.harvest_lot_number IS NOT NULL
          AND h.amount_of_boxes > COALESCE(received.received_boxes, 0)
        ORDER BY h.finalized_at DESC NULLS LAST, h.id DESC
      `);
      return res.json(rows);
    } catch (error) {
      return sendDatabaseError(res, error);
    }
  });

  /** GET / — Recent receipts, newest first. */
  router.get("/", readRoles, async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          r.id::text AS id,
          r.harvest_lot_number,
          r.received_by_user_id,
          r.number_of_pallets,
          r.labels_per_pallet,
          (r.number_of_pallets * r.labels_per_pallet) AS number_of_labels,
          r.received_at,
          r.created_at,
          COALESCE(SUM(e.received_boxes), 0)::integer AS total_received_boxes,
          COUNT(e.id)::integer AS harvesting_entry_count
        FROM trackability.harvest_receipts r
        LEFT JOIN trackability.harvest_receipt_entries e
          ON e.receipt_id = r.id
        GROUP BY r.id
        ORDER BY r.received_at DESC, r.id DESC
        LIMIT 200
      `);
      return res.json(rows);
    } catch (error) {
      return sendDatabaseError(res, error);
    }
  });

  /** GET /:id — Receipt plus its linked harvesting entries. */
  router.get("/:id", readRoles, async (req, res) => {
    const receiptId = positiveId(req.params.id);
    if (!receiptId) return res.status(400).json({ error: "Invalid receipt id" });

    try {
      const { rows } = await pool.query(
        `
        SELECT
          r.id::text AS id,
          r.harvest_lot_number,
          r.received_by_user_id,
          r.number_of_pallets,
          r.labels_per_pallet,
          (r.number_of_pallets * r.labels_per_pallet) AS number_of_labels,
          r.received_at,
          r.created_at,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'harvesting_id', h.id::text,
                'received_boxes', e.received_boxes,
                'harvesting_date', h.harvesting_date,
                'field_id', h.field_id,
                'vegetable_id', h.vegetable_id,
                'product_id', h.product_id,
                'box_type_id', h.box_type_id
              ) ORDER BY h.id
            )
            FROM trackability.harvest_receipt_entries e
            JOIN trackability.harvesting_tracking h
              ON h.id = e.harvesting_id
            WHERE e.receipt_id = r.id
          ), '[]'::jsonb) AS harvesting_entries
        FROM trackability.harvest_receipts r
        WHERE r.id = $1
        `,
        [receiptId],
      );
      if (!rows.length) return res.status(404).json({ error: "Receipt not found" });
      return res.json(rows[0]);
    } catch (error) {
      return sendDatabaseError(res, error);
    }
  });

  /**
   * POST /
   * Body:
   * {
   *   "number_of_pallets": 10,
   *   "harvesting_entries": [
   *     { "harvesting_id": "101", "received_boxes": 140 },
   *     { "harvesting_id": "102", "received_boxes": 210 }
   *   ]
   * }
   *
   * The server derives harvest_lot_number from the selected harvest rows;
   * the client must not supply it. Receiver ID is taken from authenticated
   * req.user.id, not the request body.
   */
  router.post("/", writeRoles, async (req, res) => {
    const numberOfPallets = positiveInt(req.body?.number_of_pallets);
    const rawEntries: unknown = req.body?.harvesting_entries;

    if (!numberOfPallets) {
      return res.status(400).json({ error: "number_of_pallets must be a positive integer" });
    }
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      return res.status(400).json({ error: "harvesting_entries must be a non-empty array" });
    }
    if (rawEntries.length > 500) {
      return res.status(400).json({ error: "Too many harvesting entries" });
    }

    const entries: { harvestingId: string; receivedBoxes: number }[] = [];
    for (const entry of rawEntries) {
      if (!entry || typeof entry !== "object") {
        return res.status(400).json({ error: "Invalid harvesting entry" });
      }
      const harvestingId = positiveId(entry.harvesting_id);
      const receivedBoxes = positiveInt(entry.received_boxes);
      if (!harvestingId || !receivedBoxes) {
        return res.status(400).json({
          error: "Each entry needs a valid harvesting_id and positive received_boxes",
        });
      }
      entries.push({ harvestingId, receivedBoxes });
    }
    if (new Set(entries.map((entry) => entry.harvestingId)).size !== entries.length) {
      return res.status(400).json({ error: "Duplicate harvesting_id in request" });
    }

    // Replace/adjust this cast to match your application's authenticated
    // Request.user typing; never accept received_by_user_id from req.body.
    const authUser = (req as typeof req & { user?: { id?: unknown } }).user;
    const receivedByUserId = positiveId(authUser?.id);
    if (!receivedByUserId) {
      return res.status(401).json({ error: "Authenticated user required" });
    }

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const ids = entries.map((entry) => entry.harvestingId);
      // Lock harvesting rows in deterministic order. Concurrent receiving
      // transactions for the same harvest will serialize on these rows.
      const harvestResult = await client.query(
        `
        SELECT
          id::text AS id,
          harvest_lot_number::text AS harvest_lot_number,
          status,
          amount_of_boxes
        FROM trackability.harvesting_tracking
        WHERE id = ANY($1::bigint[])
        ORDER BY id
        FOR UPDATE
        `,
        [ids],
      );
      if (harvestResult.rows.length !== entries.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "One or more harvesting records do not exist" });
      }

      const harvestById = new Map<string, any>(
        harvestResult.rows.map((row) => [row.id, row]),
      );
      const lotNumbers = new Set<string>();
      for (const entry of entries) {
        const harvest = harvestById.get(entry.harvestingId);
        if (harvest.status !== "finalized") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: `Harvest ${entry.harvestingId} is not finalized` });
        }
        if (harvest.harvest_lot_number === null) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: `Harvest ${entry.harvestingId} has no lot number` });
        }
        lotNumbers.add(harvest.harvest_lot_number);
      }
      if (lotNumbers.size !== 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "All harvesting entries must share the same lot number" });
      }

      // Must run after locking harvest rows, inside the same transaction.
      const receivedResult = await client.query(
        `
        SELECT harvesting_id::text AS harvesting_id,
               SUM(received_boxes)::bigint AS received_boxes
        FROM trackability.harvest_receipt_entries
        WHERE harvesting_id = ANY($1::bigint[])
        GROUP BY harvesting_id
        `,
        [ids],
      );
      const previouslyReceived = new Map<string, bigint>(
        receivedResult.rows.map((row) => [row.harvesting_id, BigInt(row.received_boxes)]),
      );

      for (const entry of entries) {
        const harvested = BigInt(harvestById.get(entry.harvestingId).amount_of_boxes);
        const alreadyReceived = previouslyReceived.get(entry.harvestingId) ?? 0n;
        if (alreadyReceived + BigInt(entry.receivedBoxes) > harvested) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Receiving ${entry.receivedBoxes} boxes would exceed the remaining quantity for harvest ${entry.harvestingId}`,
          });
        }
      }

      const lotNumber = [...lotNumbers][0];
      const receiptResult = await client.query(
        `
        INSERT INTO trackability.harvest_receipts
          (harvest_lot_number, received_by_user_id, number_of_pallets)
        VALUES ($1, $2, $3)
        RETURNING id::text AS id, harvest_lot_number, received_by_user_id,
                  number_of_pallets, labels_per_pallet,
                  received_at, created_at
        `,
        [lotNumber, receivedByUserId, numberOfPallets],
      );
      const receipt = receiptResult.rows[0];

      for (const entry of entries) {
        await client.query(
          `
          INSERT INTO trackability.harvest_receipt_entries
            (receipt_id, harvesting_id, received_boxes)
          VALUES ($1, $2, $3)
          `,
          [receipt.id, entry.harvestingId, entry.receivedBoxes],
        );
      }

      await client.query("COMMIT");
      return res.status(201).json({
        ...receipt,
        number_of_labels: receipt.number_of_pallets * receipt.labels_per_pallet,
        total_received_boxes: entries.reduce((sum, entry) => sum + entry.receivedBoxes, 0),
        harvesting_entries: entries.map((entry) => ({
          harvesting_id: entry.harvestingId,
          received_boxes: entry.receivedBoxes,
        })),
      });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) {
          console.error("Harvest receipt rollback failed:", rollbackError);
        }
      }
      return sendDatabaseError(res, error);
    } finally {
      client?.release();
    }
  });

  /**
   * GET /:id/labels — Returns print metadata. Generate PDF/GS1 barcodes
   * using your selected printing library in a separate endpoint or service.
   */
  router.get("/:id/labels", readRoles, async (req, res) => {
    const receiptId = positiveId(req.params.id);
    if (!receiptId) return res.status(400).json({ error: "Invalid receipt id" });
    try {
      const { rows } = await pool.query(
        `
        SELECT id::text AS receipt_id,
               harvest_lot_number,
               number_of_pallets,
               labels_per_pallet,
               (number_of_pallets * labels_per_pallet) AS number_of_labels
        FROM trackability.harvest_receipts
        WHERE id = $1
        `,
        [receiptId],
      );
      if (!rows.length) return res.status(404).json({ error: "Receipt not found" });
      return res.json(rows[0]);
    } catch (error) {
      return sendDatabaseError(res, error);
    }
  });

  export default router;
