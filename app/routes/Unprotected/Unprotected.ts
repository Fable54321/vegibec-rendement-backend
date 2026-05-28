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
})

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
    const normalizedClientId = Number(client_id);

    if (!Number.isFinite(normalizedPrice)) {
      return res.status(400).json({ error: "price is required" });
    }

    if (!Number.isInteger(normalizedVegetableId)) {
      return res.status(400).json({ error: "vegetable_id is required" });
    }

    if (!Number.isInteger(normalizedClientId)) {
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

export default router;
