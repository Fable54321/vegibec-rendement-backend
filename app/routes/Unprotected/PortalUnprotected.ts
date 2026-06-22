import { Router } from "express";
import { pool } from "../../db"

const router = Router();

router.get("/",  async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, slug
      FROM apps
      ORDER BY name;
    `);

    return res.json({
      success: true,
      apps: result.rows,
    });
  } catch (error) {
    console.error("Error fetching apps:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

export default router;