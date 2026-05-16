import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();


router.get("/", requireAppRole("schedule", ["admin", "user", "guest"]), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                fwd.*,
                u.name AS user_name,
                u.surname AS user_surname,
                u.username AS username,
                u.email AS user_email,
                fwi.matricula AS user_matricula
            FROM foreign_workers_schedule.foreign_workers_details fwd
            LEFT JOIN public.users u
                ON u.id = fwd.user_id
            LEFT JOIN public.foreign_workers_info fwi
                ON fwi.user_id = fwd.user_id
            ORDER BY u.surname ASC, u.name ASC
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error fetching workers schedule:", error);
        res.status(500).json({ error: "Failed to fetch workers schedule" });
    }
});


router.get("/job-list", requireAppRole("schedule", ["admin", "user", "guest"]), async (req, res) => {
    try {
        const result = await pool.query(`
            djl.*
            FROM foreign_workers_schedule.detailed_job_list djl
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error fetching job list:", error);
        res.status(500).json({ error: "Failed to fetch job list" });
    }
})




export default router;
