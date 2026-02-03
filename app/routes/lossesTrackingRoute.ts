import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

// GET seed quantities for loss tracking
router.get("/seeds", requireRole(["admin"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        year,
        vegetable,
        cultivar,
        units
      FROM seed_costs_new
      ORDER BY year DESC, vegetable, cultivar
    `);

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Erreur lossTracking seeds GET:", error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur",
    });
  }
});

export default router;
