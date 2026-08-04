import { Router } from "express";
import { pool } from "../../db";


const router = Router();

router.get("/", (req, res) => {
    pool.query("SELECT * FROM foreign_workers_schedule.casas", (err, result) => {
        if (err) {
            console.error("Error fetching rooms:", err);
            res.status(500).json({ error: "Database error" });
        } else {
            res.json(result.rows);
        }
    })
})


router.get("/:id/workers", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT *
       FROM foreign_workers_schedule.foreign_workers_details
       WHERE casa_id = $1`,
      [id],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching workers:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

export default router