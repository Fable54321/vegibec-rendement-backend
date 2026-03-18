import { Router } from "express";
import { pool } from "../db";
import { requireAppRole } from "../middleware/auth";

const router = Router();

// --- GET: List all employees ---
router.get(
  "/",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT name FROM employees ORDER BY name",
      );

      // return simple array of names
      res.json(result.rows.map((row) => row.name));
    } catch (err) {
      console.error("Error fetching employees:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

router.post("/", requireAppRole("rendement", ["admin"]), async (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Employee name is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO employees (name)
       VALUES ($1)
       RETURNING name`,
      [name.trim()],
    );

    res.status(201).json(result.rows[0].name);
  } catch (err: any) {
    console.error("Error adding employee:", err);

    // Optional: handle unique constraint
    if (err.code === "23505") {
      return res.status(409).json({ error: "Employee already exists" });
    }

    res.status(500).json({ error: "Database error" });
  }
});

// --- DELETE: Remove an employee ---
router.delete(
  "/:name",
  requireAppRole("rendement", ["admin"]),
  async (req, res) => {
    const { name } = req.params;

    if (!name) {
      return res.status(400).json({ error: "Employee name is required" });
    }

    try {
      const result = await pool.query(
        `DELETE FROM employees
       WHERE name = $1
       RETURNING name`,
        [name],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Employee not found" });
      }

      res.json({ deleted: result.rows[0].name });
    } catch (err) {
      console.error("Error deleting employee:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

export default router;
