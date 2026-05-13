import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import { getSignedUrlForVisitorSignature } from "../Visitors/Utils/s3Visitors";

const router = Router();

type VisitDetailsRow = {
  arrival_signature_key?: string | null;
  departure_signature_key?: string | null;
  [key: string]: unknown;
};

router.get("/", requireAppRole("main", ["admin"]), async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM visitors.visits_details
      ORDER BY arrival_time DESC
    `);

    const visits = await Promise.all(
      (result.rows as VisitDetailsRow[]).map(async (visit) => {
        const [
          arrivalSignatureUrl,
          departureSignatureUrl,
        ] = await Promise.all([
          visit.arrival_signature_key
            ? getSignedUrlForVisitorSignature(visit.arrival_signature_key)
            : null,
          visit.departure_signature_key
            ? getSignedUrlForVisitorSignature(visit.departure_signature_key)
            : null,
        ]);

        return {
          ...visit,
          arrival_signature_url: arrivalSignatureUrl,
          departure_signature_url: departureSignatureUrl,
        };
      }),
    );

    res.status(200).json(visits);
  } catch (error) {
    console.error("Error fetching visitors info:", error);
    res.status(500).json({ error: "Failed to fetch visitors info" });
  }
});

export default router;
