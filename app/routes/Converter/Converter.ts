import express from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = express.Router();
const IMPORT_SCHEMA = "test";

router.get("/import/tables", requireAppRole("convert", ["admin"]), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `,
      [IMPORT_SCHEMA],
    );

    const tables = result.rows.map((row) => row.table_name);

    res.json(tables);
  } catch (err) {
    console.error("Error fetching tables:", err);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get(
  "/import/columns",
  requireAppRole("convert", ["admin"]),
  async (req, res) => {
    const tableName = (req.query.tableName as string | undefined)?.trim();

    if (!tableName) {
      return res.status(400).json({ error: "Missing tableName query parameter" });
    }

    try {
      const result = await pool.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
          ORDER BY ordinal_position
        `,
        [IMPORT_SCHEMA, tableName],
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: `No columns found for table "${tableName}"` });
      }

      const columns = result.rows.map((row) => row.column_name);

      res.json(columns);
    } catch (err) {
      console.error("Error fetching columns:", err);
      res.status(500).json({ error: "Failed to fetch columns" });
    }
  },
);


export default router;
