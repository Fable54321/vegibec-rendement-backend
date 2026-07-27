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

export default router