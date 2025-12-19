import express from "express";
import { pool } from "../db"; // ✅ adjust path if needed
import { requireRole } from "../middleware/auth";

const router = express.Router();

//DELETE route//////////////////////////////////////////////////////////////////////

router.delete("/:id", requireRole(["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const entryId = Number(req.params.id);
    if (!entryId) throw new Error("Invalid entry ID");

    await client.query("BEGIN");

    // 1️⃣ Fetch original entry
    const { rows } = await client.query(
      `SELECT * FROM cost_entries WHERE id = $1`,
      [entryId]
    );

    if (!rows.length) throw new Error("Entry not found");

    const original = rows[0];
    const reversalAmount = -original.amount;
    const recordYear = original.year;

    // 2️⃣ Insert compensating journal entry
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
        business_description,
        is_seasonal,
        entry_type,
        corrected_entry_id,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'deletion',$10,NOW())
      `,
      [
        original.category,
        reversalAmount,
        original.vegetable,
        original.year,
        original.cost_domain,
        original.employee_name,
        `Suppression de l'entrée #${original.id}`, // journal description
        original.business_description ?? null, // preserve UNSPECIFIED description if present
        original.is_seasonal,
        original.id,
      ]
    );

    // 3️⃣ Apply reversal to aggregate tables
    switch (original.cost_domain) {
      case "SEMENCE":
        await client.query(
          `UPDATE seed_costs_new
           SET total_cost = total_cost + $1
           WHERE vegetable = $2 AND year = $3`,
          [reversalAmount, original.vegetable || "AUCUNE", recordYear]
        );
        break;

      case "EMBALLAGE":
        await client.query(
          `UPDATE packaging_costs_new
           SET total_cost = total_cost + $1
           WHERE vegetable = $2 AND year = $3`,
          [reversalAmount, original.vegetable || "AUCUNE", recordYear]
        );
        break;

      case "UNSPECIFIED":
        // Insert negative entry into unspecified_costs
        await client.query(
          `
          INSERT INTO unspecified_costs (
            description,
            amount,
            cost_year,
            cost_type,
            vegetable,
            created_at,
            updated_at
          )
          VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
          `,
          [
            `Suppression de l'entrée #${original.id}`,
            reversalAmount,
            recordYear,
            original.is_seasonal ? "seasonal" : "annual",
            original.vegetable || null,
          ]
        );
        break;

      default: {
        const soilCategories = [
          "Chaux calcique",
          "Engrais chimiques",
          "Engrais verts",
          "Fumier",
          "Terre et Terreaux",
        ];

        if (soilCategories.includes(original.cost_domain)) {
          await client.query(
            `UPDATE soil_products_costs_new
             SET total_cost = total_cost + $1
             WHERE vegetable = $2 AND year = $3`,
            [reversalAmount, original.vegetable || "AUCUNE", recordYear]
          );

          await client.query(
            `UPDATE soil_products_category_totals_new
             SET total_cost = total_cost + $1
             WHERE category = $2 AND year = $3`,
            [reversalAmount, original.category, recordYear]
          );
        } else {
          await client.query(
            `UPDATE other_costs_new
             SET total_cost = total_cost + $1
             WHERE category = $2 AND year = $3`,
            [reversalAmount, original.category, recordYear]
          );
        }
        break;
      }
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete failed:", err);
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

router.get("/", requireRole(["admin"]), async (req, res) => {
  try {
    const { domain, page = 1, limit = 20, year, vegetable } = req.query;

    const offset = (Number(page) - 1) * Number(limit);

    const conditions: string[] = [];
    const values: any[] = [];

    let idx = 1;

    if (domain) {
      conditions.push(`cost_domain = $${idx++}`);
      values.push(domain);
    }

    if (year) {
      conditions.push(`year = $${idx++}`);
      values.push(Number(year));
    }

    if (vegetable) {
      conditions.push(`vegetable = $${idx++}`);
      values.push(vegetable);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const dataQuery = `
      SELECT *
      FROM cost_entries
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${idx++}
      OFFSET $${idx}
    `;

    values.push(Number(limit), offset);

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM cost_entries
      ${whereClause}
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, values),
      pool.query(countQuery, values.slice(0, values.length - 2)),
    ]);

    res.json({
      entries: dataResult.rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: countResult.rows[0].total,
        totalPages: Math.ceil(countResult.rows[0].total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("Error fetching journal:", err);
    res.status(500).json({ error: "Failed to fetch journal entries" });
  }
});

export default router;
