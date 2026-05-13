import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

router.get("/", requireAppRole("main", ["admin"]), async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM visitors.visits_details
      ORDER BY arrival_time DESC
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching visitors info:", error);
    res.status(500).json({ error: "Failed to fetch visitors info" });
  }
});

export default router;
