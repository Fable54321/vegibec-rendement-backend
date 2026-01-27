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

router.post("/", requireRole(["admin"]), async (req, res) => {
  const { name } = req.body;

  if (!name)
    return res.status(400).json({ error: "Category name is required" });

  try {
    const result = await pool.query(
      `INSERT INTO task_categories (name) VALUES ($1) RETURNING id, name`,
      [name],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating task category:", error);
    res.status(500).json({ error: "Failed to create task category" });
  }
});

/**
 * DELETE /task-categories/:id
 * Delete a task category (and optionally its subcategories)
 */
router.delete("/:id", requireRole(["admin"]), async (req, res) => {
  const { id } = req.params;

  try {
    // Optionally: delete subcategories first if there’s a foreign key constraint
    await pool.query(`DELETE FROM task_subcategories WHERE category_id = $1`, [
      id,
    ]);

    const result = await pool.query(
      `DELETE FROM task_categories WHERE id = $1 RETURNING id`,
      [id],
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Category not found" });

    res.status(200).json({ message: "Category deleted successfully" });
  } catch (error) {
    console.error("Error deleting task category:", error);
    res.status(500).json({ error: "Failed to delete task category" });
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

router.post(
  "/:categoryId/subcategories",
  requireRole(["admin"]),
  async (req, res) => {
    const { categoryId } = req.params;
    const { name } = req.body;

    if (!name)
      return res.status(400).json({ error: "Subcategory name is required" });

    try {
      const result = await pool.query(
        `INSERT INTO task_subcategories (category_id, name) VALUES ($1, $2) RETURNING id, name`,
        [categoryId, name],
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Error creating task subcategory:", error);
      res.status(500).json({ error: "Failed to create task subcategory" });
    }
  },
);

/**
 * DELETE /task-categories/:categoryId/subcategories/:id
 * Delete a subcategory
 */
router.delete(
  "/:categoryId/subcategories/:id",
  requireRole(["admin"]),
  async (req, res) => {
    const { id } = req.params;

    try {
      const result = await pool.query(
        `DELETE FROM task_subcategories WHERE id = $1 RETURNING id`,
        [id],
      );

      if (result.rowCount === 0)
        return res.status(404).json({ error: "Subcategory not found" });

      res.status(200).json({ message: "Subcategory deleted successfully" });
    } catch (error) {
      console.error("Error deleting task subcategory:", error);
      res.status(500).json({ error: "Failed to delete task subcategory" });
    }
  },
);

export default router;
