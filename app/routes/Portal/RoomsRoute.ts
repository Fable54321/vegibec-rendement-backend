import { Router } from "express";
import { pool } from "../../db";


const router = Router();

router.get("/", (_req, res) => {
    pool.query("SELECT * FROM foreign_workers_schedule.casas", (err, result) => {
        if (err) {
            console.error("Error fetching rooms:", err);
            res.status(500).json({ error: "Database error" });
        } else {
            res.json(result.rows);
        }
    })
})

router.get("/total-occupation", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total_occupation
       FROM foreign_workers_schedule.foreign_workers_details
       WHERE casa_id IS NOT NULL`,
    );

    return res.status(200).json({
      totalOccupation: result.rows[0].total_occupation,
    });
  } catch (error) {
    console.error("Error fetching total room occupation:", error);
    return res.status(500).json({ error: "Database error" });
  }
});


router.get("/:id/workers", async (req, res) => {
  const { id } = req.params;

  try {
   const result = await pool.query(
  `SELECT
     fwd.*,
     u.name,
     u.surname
   FROM foreign_workers_schedule.foreign_workers_details fwd
   LEFT JOIN public.users u
     ON u.id = fwd.user_id
   WHERE fwd.casa_id = $1
   ORDER BY u.surname, u.name`,
  [id],
);

    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching workers:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

export default router
