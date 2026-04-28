import { Router } from "express";
import { pool } from "../../db";
import crypto from "crypto";
import {
  uploadVisitorSignatureToS3,
  getSignedUrlForVisitorSignature,
} from "./Utils/s3Visitors";


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
    const {
      arrival_time,
      full_name,
      company_name,
      visit_reason,
      arrival_signature_key,
      checklist,
      wants_email,
      email,
      other_content,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO visitors (
        arrival_time,
        visitor_name,
        company_name,
        visit_reason,
        arrival_signature,
        checklist,
        wants_email,
        email,
        other_content
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        arrival_time,
        full_name,
        company_name,
        visit_reason,
        arrival_signature_key,
        checklist,        
        wants_email,
        email,
        other_content,
      ]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating visitor:", error);
    res.status(500).json({ error: "Failed to create visitor" });
  }
});


router.post("/signature", async (req, res) => {
  try {

    


    const { signatureDataUrl } = req.body || {};

    

    if (!signatureDataUrl) {
      return res.status(400).json({ error: "Signature manquante" });
    }

    const matches = signatureDataUrl.match(/^data:image\/png;base64,(.+)$/);

    if (!matches) {
      return res.status(400).json({ error: "Format de signature invalide" });
    }

  

    const buffer = Buffer.from(matches[1], "base64");

    const key = `visitor-signatures/${Date.now()}-${crypto.randomUUID()}.png`;

    await uploadVisitorSignatureToS3(key, buffer);

    console.log("getting here");

    const signedUrl = await getSignedUrlForVisitorSignature(key);

    return res.status(200).json({
      key,
      url: signedUrl,
    });
  } catch (error) {
    console.error("Error uploading visitor signature:", error);
    return res.status(500).json({ error: "Failed to upload signature" });
  }
});














export default router;