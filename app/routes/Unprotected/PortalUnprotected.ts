import { Router } from "express";
import { pool } from "../../db"

const router = Router();

router.get("/list", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, email, name, surname, role, created_at, updated_at, is_office
      FROM users
      ORDER BY id ASC;
    `);

    return res.json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

export default router;