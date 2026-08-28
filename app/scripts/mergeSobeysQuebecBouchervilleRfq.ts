import { pool } from "../db";

const apply = process.argv.includes("--apply");

const run = async () => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const clientResult = await db.query(
      "SELECT id FROM sales.clients WHERE LOWER(name) = LOWER($1)",
      ["Sobeys"],
    );
    if (clientResult.rowCount !== 1) {
      throw new Error(`Expected one Sobeys client, found ${clientResult.rowCount ?? 0}`);
    }
    const clientId = clientResult.rows[0].id;

    await db.query(`
      ALTER TABLE sales.rfq_attachments
      ADD COLUMN IF NOT EXISTS region_code VARCHAR(1)
    `);
    await db.query(`
      UPDATE sales.rfq_attachments a
      SET region_code = c.location_code
      FROM sales.rfq_cells c
      WHERE c.id = a.cell_id AND a.region_code IS NULL
    `);
    // On databases where the market merge ran before region tracking was added,
    // an attachment whose S3 path names another cell came from the merged Q cell.
    await db.query(`
      UPDATE sales.rfq_attachments a
      SET region_code = 'Q'
      FROM sales.rfq_cells c
      WHERE c.id = a.cell_id AND c.client_id = $1 AND c.location_code = 'B'
        AND split_part(a.s3_key, '/', 3) <> c.id::text
    `, [clientId]);
    // These were the two Q-only cells in the production data when the initial
    // merge ran; their cell IDs did not change, so their S3 paths cannot reveal it.
    await db.query(`
      UPDATE sales.rfq_attachments a
      SET region_code = 'Q'
      FROM sales.rfq_cells c
      WHERE c.id = a.cell_id AND c.client_id = $1 AND c.id = ANY($2::bigint[])
    `, [clientId, [320, 795]]);

    const beforeResult = await db.query(`
      SELECT
        COUNT(*)::int AS cells,
        (SELECT COUNT(*)::int FROM sales.rfq_prices p
          JOIN sales.rfq_cells c ON c.id = p.cell_id
          WHERE c.client_id = $1 AND c.location_code = ANY($2::text[])) AS prices,
        (SELECT COUNT(*)::int FROM sales.rfq_attachments a
          JOIN sales.rfq_cells c ON c.id = a.cell_id
          WHERE c.client_id = $1 AND c.location_code = ANY($2::text[])) AS attachments
      FROM sales.rfq_cells
      WHERE client_id = $1 AND location_code = ANY($2::text[])
    `, [clientId, ["B", "Q"]]);

    await db.query(`
      UPDATE sales.rfq_cells b
      SET status = 'final', updated_at = NOW()
      FROM sales.rfq_cells q
      WHERE b.client_id = $1 AND b.location_code = 'B'
        AND q.client_id = b.client_id AND q.product_id = b.product_id
        AND q.week_start = b.week_start AND q.location_code = 'Q'
        AND q.status = 'final' AND b.status <> 'final'
    `, [clientId]);

    // Preserve every distinct historical price. Identical B/Q price rows become one;
    // genuinely different values remain attached to the merged market cell.
    await db.query(`
      INSERT INTO sales.rfq_prices (cell_id, quantity, price)
      SELECT b.id, qp.quantity, qp.price
      FROM sales.rfq_cells q
      JOIN sales.rfq_cells b ON b.client_id = q.client_id AND b.product_id = q.product_id
        AND b.week_start = q.week_start AND b.location_code = 'B'
      JOIN sales.rfq_prices qp ON qp.cell_id = q.id
      WHERE q.client_id = $1 AND q.location_code = 'Q'
        AND NOT EXISTS (
          SELECT 1 FROM sales.rfq_prices bp
          WHERE bp.cell_id = b.id AND bp.quantity = qp.quantity AND bp.price = qp.price
        )
    `, [clientId]);

    // Attachment rows keep their S3 keys and files; only their owning cell changes.
    await db.query(`
      UPDATE sales.rfq_attachments a
      SET cell_id = b.id
      FROM sales.rfq_cells q
      JOIN sales.rfq_cells b ON b.client_id = q.client_id AND b.product_id = q.product_id
        AND b.week_start = q.week_start AND b.location_code = 'B'
      WHERE q.client_id = $1 AND q.location_code = 'Q' AND a.cell_id = q.id
    `, [clientId]);

    await db.query(`
      DELETE FROM sales.rfq_cells q
      USING sales.rfq_cells b
      WHERE q.client_id = $1 AND q.location_code = 'Q'
        AND b.client_id = q.client_id AND b.product_id = q.product_id
        AND b.week_start = q.week_start AND b.location_code = 'B'
    `, [clientId]);

    // Q-only historical cells have no collision after paired cells are removed.
    await db.query(`
      UPDATE sales.rfq_cells
      SET location_code = 'B', updated_at = NOW()
      WHERE client_id = $1 AND location_code = 'Q'
    `, [clientId]);

    const afterResult = await db.query(`
      SELECT
        COUNT(*)::int AS cells,
        COUNT(*) FILTER (WHERE location_code = 'Q')::int AS quebec_cells,
        (SELECT COUNT(*)::int FROM sales.rfq_prices p
          JOIN sales.rfq_cells c ON c.id = p.cell_id
          WHERE c.client_id = $1 AND c.location_code = 'B') AS prices,
        (SELECT COUNT(*)::int FROM sales.rfq_attachments a
          JOIN sales.rfq_cells c ON c.id = a.cell_id
          WHERE c.client_id = $1 AND c.location_code = 'B') AS attachments
      FROM sales.rfq_cells
      WHERE client_id = $1 AND location_code = ANY($2::text[])
    `, [clientId, ["B", "Q"]]);

    const before = beforeResult.rows[0];
    const after = afterResult.rows[0];
    if (after.quebec_cells !== 0 || after.attachments !== before.attachments) {
      throw new Error(`Merge verification failed: ${JSON.stringify({ before, after })}`);
    }

    const attachmentRegions = await db.query(`
      SELECT a.region_code, COUNT(*)::int AS attachments
      FROM sales.rfq_attachments a
      JOIN sales.rfq_cells c ON c.id = a.cell_id
      WHERE c.client_id = $1 AND c.location_code = 'B'
      GROUP BY a.region_code ORDER BY a.region_code
    `, [clientId]);

    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      before,
      after,
      attachmentRegions: attachmentRegions.rows,
    }, null, 2));
    await db.query(apply ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
