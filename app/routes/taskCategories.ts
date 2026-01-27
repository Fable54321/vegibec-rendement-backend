import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /task-categories
 * Returns all task categories
 */
router.get("/", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name
      FROM task_categories
      ORDER BY name
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching task categories:", error);
    res.status(500).json({ error: "Failed to fetch task categories" });
  }
});

/**
 * GET /task-categories/:categoryId/subcategories
 * Returns subcategories for a given category
 */
router.get(
  "/:categoryId/subcategories",
  requireRole(["admin", "guest"]),
  async (req, res) => {
    const { categoryId } = req.params;

    try {
      const result = await pool.query(
        `
        SELECT id, name
        FROM task_subcategories
        WHERE category_id = $1
        ORDER BY name
        `,
        [categoryId],
      );

      res.status(200).json(result.rows);
    } catch (error) {
      console.error("Error fetching task subcategories:", error);
      res.status(500).json({ error: "Failed to fetch task subcategories" });
    }
  },
);

export default router;
