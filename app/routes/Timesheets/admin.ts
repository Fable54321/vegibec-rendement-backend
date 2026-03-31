import { pool } from "../../db"
import Router from "express"
import { requireAppRole } from "../../middleware/auth";

const router = Router();




router.get("/users/with-worksheet", requireAppRole("main", ["admin"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.email,
        u.name,
        u.surname,
        u.uses_worksheet,
        COALESCE(
          json_agg(
            json_build_object(
              'app_id', a.id,
              'slug', a.slug,
              'role', uar.role
            )
          ) FILTER (WHERE a.id IS NOT NULL),
          '[]'
        ) AS app_roles
      FROM users u
      LEFT JOIN user_app_roles uar ON u.id = uar.user_id
      LEFT JOIN apps a ON uar.app_id = a.id
      WHERE u.uses_worksheet = TRUE
      GROUP BY u.id
      ORDER BY u.name, u.surname
    `);

    return res.json({
      success: true,
      users: result.rows,
    });
  } catch (err) {
    console.error("Error fetching users with worksheet:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});