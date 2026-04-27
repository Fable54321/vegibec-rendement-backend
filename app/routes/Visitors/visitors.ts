import { Router } from "express";
import { pool } from "../../db";


const router = Router();


router.get("/", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM visitors");
        res.status(200).json(result.rows);
      } catch (error) {
        console.error("Error fetching visitors:", error);
        res.status(500).json({ error: "Failed to fetch visitors" });
      }
})


router.post("/start", async (req, res) => {
    try {
        const {arrival_time, full_name, company_name, visit_reason, arrival_signature_url } = req.body;
        const result = await pool.query(
          "INSERT INTO visitors ( arrival_time,visitor_name, company_name, visit_reason, arrival_signature) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [ arrival_time,full_name,company_name,visit_reason,arrival_signature_url]
        );
        res.status(200).json(result.rows[0]);
      } catch (error) {
        console.error("Error creating visitor:", error);
        res.status(500).json({ error: "Failed to create visitor" });
      }
})














export default router;