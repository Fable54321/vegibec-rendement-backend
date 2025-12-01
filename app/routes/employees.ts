import { Router } from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = Router();

// --- GET: List all employees ---
router.get("/", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const result = await pool.query("SELECT name FROM employees ORDER BY name");

    // return simple array of names
    res.json(result.rows.map((row) => row.name));
  } catch (err) {
    console.error("Error fetching employees:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
