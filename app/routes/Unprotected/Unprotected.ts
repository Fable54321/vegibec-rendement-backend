import { Router } from "express";
import { pool } from "../../db";

const router = Router();



router.get(
  "/vegetables",
  async (req, res) => {
    try {
      const result = await pool.query(`
      SELECT *
      FROM vegetables
      ORDER BY vegetable
    `);

      res.status(200).json(result.rows);
    } catch (error) {
      console.error("Error fetching vegetables:", error);
      res.status(500).json({ error: "Failed to fetch vegetables" });
    }
  },
);

router.get("/clients", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sales.clients ORDER BY name");
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching clients:", error);
    res.status(500).json({ error: "Failed to fetch clients" });
  }
});

router.post("/quotations", async (req, res) => {
  try {
    const { quotation_date, price, vegetable_id, client_id } = req.body;

    if (!quotation_date) {
      return res.status(400).json({ error: "quotation_date is required" });
    }

    const parsedDate = new Date(quotation_date);

    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: "quotation_date is invalid" });
    }

    const normalizedPrice = Number(price);
    const normalizedVegetableId = Number(vegetable_id);
    const normalizedClientId = String(client_id ?? "").trim();

    if (!Number.isFinite(normalizedPrice)) {
      return res.status(400).json({ error: "price is required" });
    }

    if (!Number.isInteger(normalizedVegetableId)) {
      return res.status(400).json({ error: "vegetable_id is required" });
    }

    if (!normalizedClientId) {
      return res.status(400).json({ error: "client_id is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO sales.quotations (
        quotation_date,
        price,
        vegetable_id,
        client_id
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        quotation_date,
        normalizedPrice,
        normalizedVegetableId,
        normalizedClientId,
      ],
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating quotation:", error);
    return res.status(500).json({ error: "Failed to create quotation" });
  }
});

router.patch("/quotations/:id", async (req, res) => {
  try {
    const quotationId = Number(req.params.id);

    if (!Number.isInteger(quotationId)) {
      return res.status(400).json({ error: "Invalid quotation id" });
    }

    const { quotation_date, price, vegetable_id, client_id } = req.body;
    const fields: string[] = [];
    const values: unknown[] = [];

    const addField = (name: string, value: unknown) => {
      values.push(value);
      fields.push(`${name} = $${values.length}`);
    };

    if (quotation_date !== undefined) {
      if (!quotation_date) {
        return res.status(400).json({ error: "quotation_date is required" });
      }

      const parsedDate = new Date(quotation_date);

      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: "quotation_date is invalid" });
      }

      addField("quotation_date", quotation_date);
    }

    if (price !== undefined) {
      const normalizedPrice = Number(price);

      if (!Number.isFinite(normalizedPrice)) {
        return res.status(400).json({ error: "price is invalid" });
      }

      addField("price", normalizedPrice);
    }

    if (vegetable_id !== undefined) {
      const normalizedVegetableId = Number(vegetable_id);

      if (!Number.isInteger(normalizedVegetableId)) {
        return res.status(400).json({ error: "vegetable_id is invalid" });
      }

      addField("vegetable_id", normalizedVegetableId);
    }

    if (client_id !== undefined) {
      const normalizedClientId = String(client_id).trim();

      if (!normalizedClientId) {
        return res.status(400).json({ error: "client_id is invalid" });
      }

      addField("client_id", normalizedClientId);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(quotationId);

    const result = await pool.query(
      `
      UPDATE sales.quotations
      SET ${fields.join(", ")}
      WHERE id = $${values.length}
      RETURNING *
      `,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating quotation:", error);
    return res.status(500).json({ error: "Failed to update quotation" });
  }
});

router.delete("/quotations/:id", async (req, res) => {
  try {
    const quotationId = Number(req.params.id);

    if (!Number.isInteger(quotationId)) {
      return res.status(400).json({ error: "Invalid quotation id" });
    }

    const result = await pool.query(
      `
      DELETE FROM sales.quotations
      WHERE id = $1
      RETURNING *
      `,
      [quotationId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    return res.status(200).json({
      deleted: result.rows[0],
    });
  } catch (error) {
    console.error("Error deleting quotation:", error);
    return res.status(500).json({ error: "Failed to delete quotation" });
  }
});

export default router;
