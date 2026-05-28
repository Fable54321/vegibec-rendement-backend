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

export default router;