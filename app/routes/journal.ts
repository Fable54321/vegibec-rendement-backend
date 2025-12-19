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

    // 1️⃣ Fetch original journal entry
    const { rows } = await client.query(
      `SELECT * FROM cost_entries WHERE id = $1`,
      [entryId]
    );

    if (!rows.length) {
      throw new Error("Entry not found");
    }

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
        is_seasonal,
        entry_type,
        corrected_entry_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'suppression',$9)
      `,
      [
        original.category,
        reversalAmount,
        original.vegetable,
        original.year,
        original.cost_domain,
        original.employee_name,
        `Supression de l'entrée #${original.id}`,
        original.is_seasonal,
        original.id,
      ]
    );

    // 3️⃣ Update the appropriate table
    switch (original.cost_domain) {
      case "SEMENCE":
        await client.query(
          `
          UPDATE seed_costs_new
          SET total_cost = total_cost + $1
          WHERE vegetable = $2 AND year = $3
          `,
          [reversalAmount, original.vegetable || "AUCUNE", recordYear]
        );
        break;

      case "EMBALLAGE":
        await client.query(
          `
          UPDATE packaging_costs_new
          SET total_cost = total_cost + $1
          WHERE vegetable = $2 AND year = $3
          `,
          [reversalAmount, original.vegetable || "AUCUNE", recordYear]
        );
        break;

      case "UNSPECIFIED":
        // Delete the specific row from unspecified_costs
        await client.query(
          `
          DELETE FROM unspecified_costs
          WHERE cost_year = $1
            AND vegetable = $2
            AND description = $3
          `,
          [
            recordYear,
            original.vegetable || null,
            original.business_description || original.description,
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
            `
            UPDATE soil_products_costs_new
            SET total_cost = total_cost + $1
            WHERE vegetable = $2 AND year = $3
            `,
            [reversalAmount, original.vegetable || "AUCUNE", recordYear]
          );

          await client.query(
            `
            UPDATE soil_products_category_totals_new
            SET total_cost = total_cost + $1
            WHERE category = $2 AND year = $3
            `,
            [reversalAmount, original.category, recordYear]
          );
        } else {
          await client.query(
            `
            UPDATE other_costs_new
            SET total_cost = total_cost + $1
            WHERE category = $2 AND year = $3
            `,
            [reversalAmount, original.category, recordYear]
          );
        }
      }
    }

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

    // 1️⃣ Fetch original journal entry
    const { rows } = await client.query(
      `SELECT * FROM cost_entries WHERE id = $1`,
      [entryId]
    );
    if (!rows.length) throw new Error("Entry not found");

    const original = rows[0];

    // 2️⃣ Determine corrected/fallback values
    const correctedAmount = amount ?? original.amount;
    const correctedCategory = category ?? original.category ?? "UNSPECIFIED";
    const correctedVegetable = vegetable ?? original.vegetable ?? "AUCUNE";
    const correctedYear = year ?? original.year;
    const correctedIsSeasonal = is_seasonal ?? original.is_seasonal;

    const reversalAmount = -original.amount;

    // 3️⃣ Insert reversal in journal
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
        reversalAmount,
        original.vegetable,
        original.year,
        original.cost_domain,
        original.employee_name,
        `Correction de l'entrée #${original.id}`,
        original.is_seasonal,
        original.id,
      ]
    );

    // 4️⃣ Insert corrected entry in journal
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
        correctedCategory,
        correctedAmount,
        correctedVegetable,
        correctedYear,
        original.cost_domain,
        original.employee_name,
        `Valeur corrigée de l'entrée #${original.id}`,
        correctedIsSeasonal,
        original.id,
      ]
    );

    // 5️⃣ Reverse original in target tables
    switch (original.cost_domain) {
      case "SEMENCE":
        await client.query(
          `UPDATE seed_costs_new
           SET total_cost = total_cost + $1
           WHERE vegetable = $2 AND year = $3`,
          [reversalAmount, original.vegetable || "AUCUNE", original.year]
        );

        // Apply corrected amount
        await client.query(
          `UPDATE seed_costs_new
           SET total_cost = total_cost + $1
           WHERE vegetable = $2 AND year = $3`,
          [correctedAmount, correctedVegetable, correctedYear]
        );
        break;

      case "EMBALLAGE":
        await client.query(
          `UPDATE packaging_costs_new
           SET total_cost = total_cost + $1
           WHERE vegetable = $2 AND year = $3`,
          [reversalAmount, original.vegetable || "AUCUNE", original.year]
        );

        await client.query(
          `UPDATE packaging_costs_new
           SET total_cost = total_cost + $1
           WHERE vegetable = $2 AND year = $3`,
          [correctedAmount, correctedVegetable, correctedYear]
        );
        break;

      case "UNSPECIFIED":
        // Reverse original
        await client.query(
          `UPDATE unspecified_costs
           SET amount = amount + $1
           WHERE cost_year = $2 AND vegetable = $3 AND description = $4`,
          [
            reversalAmount,
            original.year,
            original.vegetable || null,
            original.business_description ?? original.description,
          ]
        );

        // Insert corrected entry
        await client.query(
          `INSERT INTO unspecified_costs
             (description, amount, cost_year, cost_type, vegetable, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
          [
            `Correction of entry #${original.id}`,
            correctedAmount,
            correctedYear,
            correctedIsSeasonal ? "seasonal" : "annual",
            correctedVegetable || null,
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
          // Reverse original
          await client.query(
            `UPDATE soil_products_costs_new
             SET total_cost = total_cost + $1
             WHERE vegetable = $2 AND year = $3`,
            [reversalAmount, original.vegetable || "AUCUNE", original.year]
          );

          await client.query(
            `UPDATE soil_products_category_totals_new
             SET total_cost = total_cost + $1
             WHERE category = $2 AND year = $3`,
            [reversalAmount, original.category, original.year]
          );

          // Apply corrected
          await client.query(
            `UPDATE soil_products_costs_new
             SET total_cost = total_cost + $1
             WHERE vegetable = $2 AND year = $3`,
            [correctedAmount, correctedVegetable, correctedYear]
          );

          await client.query(
            `UPDATE soil_products_category_totals_new
             SET total_cost = total_cost + $1
             WHERE category = $2 AND year = $3`,
            [correctedAmount, correctedCategory, correctedYear]
          );
        } else {
          // Reverse original
          await client.query(
            `UPDATE other_costs_new
             SET total_cost = total_cost + $1
             WHERE category = $2 AND year = $3`,
            [reversalAmount, original.category, original.year]
          );

          // Apply corrected
          await client.query(
            `UPDATE other_costs_new
             SET total_cost = total_cost + $1
             WHERE category = $2 AND year = $3`,
            [correctedAmount, correctedCategory, correctedYear]
          );
        }
      }
    }

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
