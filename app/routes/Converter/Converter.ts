import express from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = express.Router();



router.get("/import/tables", requireAppRole("convert", ["admin"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    const tables = result.rows.map(row => row.table_name);

    res.json(tables);
  } catch (err) {
    console.error("Error fetching tables:", err);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});


export default router;