import express from "express";
import { pool } from "../db"; // ✅ adjust path if needed
import { requireRole } from "../middleware/auth";

const router = express.Router();

//DELETE route//////////////////////////////////////////////////////////////////////

router.delete("/:id", requireRole(["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const entryId = Number(req.params.id);

    await client.query("BEGIN");

    // 1️⃣ Fetch original entry
    const { rows } = await client.query(
      `SELECT * FROM cost_entries WHERE id = $1`,
      [entryId]
    );

    if (!rows.length) {
      throw new Error("Entry not found");
    }

    const original = rows[0];

    // 2️⃣ Insert compensating entry
    await client.query(
      `
      INSERT INTO cost_entries (
        category,
        amount,
        vegetable,
        year,
        cost_domain,
        employee_name,
        description,
        is_seasonal,
        entry_type,
        corrected_entry_id,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deletion',$9,NOW())
      `,
      [
        original.category,
        -original.amount,
        original.vegetable,
        original.year,
        original.cost_domain,
        original.employee_name,
        `Deletion of entry #${original.id}`,
        original.is_seasonal,
        original.id,
      ]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  } finally {
    client.release();
  }
});

//Correction Route//////////////////////////////////////////////////////////////////////

router.post("/:id/correct", requireRole(["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const entryId = Number(req.params.id);
    const { amount, category, vegetable, year, is_seasonal } = req.body;

    await client.query("BEGIN");

    // 1️⃣ Fetch original
    const { rows } = await client.query(
      `SELECT * FROM cost_entries WHERE id = $1`,
      [entryId]
    );
    if (!rows.length) throw new Error("Entry not found");

    const original = rows[0];

    // 2️⃣ Reverse original
    await client.query(
      `
      INSERT INTO cost_entries (
        category, amount, vegetable, year, cost_domain,
        employee_name, description, is_seasonal,
        entry_type, corrected_entry_id, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'correction',$9,NOW())
      `,
      [
        original.category,
        -original.amount,
        original.vegetable,
        original.year,
        original.cost_domain,
        original.employee_name,
        `Correction of entry #${original.id}`,
        original.is_seasonal,
        original.id,
      ]
    );

    // 3️⃣ Insert corrected entry
    await client.query(
      `
      INSERT INTO cost_entries (
        category, amount, vegetable, year, cost_domain,
        employee_name, description, is_seasonal,
        entry_type, corrected_entry_id, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'addition',$9,NOW())
      `,
      [
        category,
        amount,
        vegetable,
        year,
        original.cost_domain,
        original.employee_name,
        `Corrected version of entry #${original.id}`,
        is_seasonal ?? original.is_seasonal,
        original.id,
      ]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Correction failed" });
  } finally {
    client.release();
  }
});

export default router;
