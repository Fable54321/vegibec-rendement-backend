import { Request, Router } from "express";
import crypto from "crypto";
import jwt, { JwtPayload } from "jsonwebtoken";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import { sendEmail } from "./Utils/testSMTP";
import {
  getSignedUrlForVisitorSignature,
  uploadVisitorSignatureToS3,
} from "./Utils/s3Visitors";

const router = Router();
const VISITOR_PLAN_TOKEN_SECRET =
  process.env.VISITOR_PLAN_TOKEN_SECRET ||
  process.env.JWT_SECRET ||
  "super_secret";
const VISITOR_PLAN_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 12;
const MAX_VERIFICATION_NOTES_LENGTH = 5000;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

const isValidDateOnly = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

const decodePngDataUrl = (value: unknown) => {
  if (typeof value !== "string") return null;

  const matches = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!matches) return null;

  const buffer = Buffer.from(matches[1], "base64");
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  if (
    buffer.length === 0 ||
    buffer.length > MAX_SIGNATURE_BYTES ||
    !buffer.subarray(0, pngHeader.length).equals(pngHeader)
  ) {
    return null;
  }

  return buffer;
};

type VerificationPeriodStart = {
  period_start: string;
  source: "last_verification" | "first_visit" | "today";
};

const getNextVerificationPeriodStart = async () => {
  const result = await pool.query<VerificationPeriodStart>(`
    WITH verification_bounds AS (
      SELECT
        (
          SELECT MAX(period_end)
          FROM visitors.visitors_registry_verification
        ) AS last_period_end,
        (
          SELECT MIN(arrival_time)::date
          FROM visitors.visits_details
        ) AS first_visit_date
    )
    SELECT
      COALESCE(last_period_end, first_visit_date, CURRENT_DATE)::text
        AS period_start,
      CASE
        WHEN last_period_end IS NOT NULL THEN 'last_verification'
        WHEN first_visit_date IS NOT NULL THEN 'first_visit'
        ELSE 'today'
      END AS source
    FROM verification_bounds
  `);

  return result.rows[0];
};

const getVisitorPlanBaseUrl = (req: Request) => {
  const configuredUrl =
  process.env.VISITOR_PLAN_PAGE_URL?.trim() ||
  (process.env.NODE_ENV !== "production" ? "http://localhost:5173" : "");

  if (configuredUrl) {
    // If configured, assume it's the full base URL
    return configuredUrl;
  }

  const signatureBase = process.env.SIGNATURE_APP_BASE_URL?.trim();

  if (signatureBase) {
    return signatureBase;
  }

  const origin = req.get("origin");

  if (origin) {
    return origin.replace(/\/$/, "");
  }

  throw new Error("VISITOR_PLAN_PAGE_URL or SIGNATURE_APP_BASE_URL is not defined");
};

const generateVisitorPlanUrl = (req: Request) => {
  const expiresAt = new Date(
    Date.now() + VISITOR_PLAN_TOKEN_EXPIRES_IN_SECONDS * 1000,
  ).toISOString();
  const token = jwt.sign(
    {
      scope: "visitor-plan",
      jti: crypto.randomUUID(),
    },
    VISITOR_PLAN_TOKEN_SECRET,
    { expiresIn: VISITOR_PLAN_TOKEN_EXPIRES_IN_SECONDS },
  );
  const baseUrl = getVisitorPlanBaseUrl(req);
  const url = `${baseUrl}/plan/${token}`;

  return {
    url,
    token,
    expiresIn: VISITOR_PLAN_TOKEN_EXPIRES_IN_SECONDS,
    expiresAt,
  };
};

router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM visitors");
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching visitors:", error);
    res.status(500).json({ error: "Failed to fetch visitors" });
  }
});

router.get("/plan-url", async (req, res) => {
  try {
    return res.status(200).json(generateVisitorPlanUrl(req));
  } catch (error) {
    console.error("Error generating visitor plan URL:", error);
    return res.status(500).json({ error: "Failed to generate plan URL" });
  }
});






router.post("/start", async (req, res) => {
  try {
    const {
      arrival_time,
      full_name,
      company_name,
      visit_reason,
      arrival_signature_key,
      checklist,
      email,
      other_content,
    } = req.body;

    const visitorEmail = typeof email === "string" ? email.trim() : "";
    const shouldSendEmail =  visitorEmail !== "";
    let emailSent = false;

    if (shouldSendEmail) {
      const generatedUrl = generateVisitorPlanUrl(req).url;
      const planUrl = generatedUrl;
const emailInfo = await sendEmail({
  to: visitorEmail,
  fromLabel: "Vegibec - Visiteurs",
  subject: "Vegibec - plan du site",
  text: `Vous trouverez le plan du site à l'adresse suivante: ${planUrl}\n\nCordialement,\nL'équipe de Vegibec`,
});

      emailSent = emailInfo.accepted.includes(visitorEmail);

      console.log("Visitor plan email relay response:", {
        messageId: emailInfo.messageId,
        accepted: emailInfo.accepted,
        rejected: emailInfo.rejected,
        response: emailInfo.response, 
      });
    }




    const result = await pool.query(
      `
      INSERT INTO visitors.visits_details (
        arrival_time,
        full_name,
        company_name,
        visit_reason,
        arrival_signature_key,
        checklist,
        email,
        other_content
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        arrival_time,
        full_name,
        company_name,
        visit_reason,
        arrival_signature_key,
        checklist,
        visitorEmail || null,
        other_content,
      ],
    );

    res.status(200).json({
      ...result.rows[0],
      emailSent,
    });
  } catch (error) {
    console.error("Error creating visitor:", error);
    res.status(500).json({ error: "Failed to create visitor" });
  }
});

router.post("/end", async (req, res) => {
  try {
    const { id, departure_time, departure_signature_key } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: "Missing visitor visit id" });
    }

    if (!departure_time) {
      return res.status(400).json({ error: "Missing departure_time" });
    }

    if (!departure_signature_key) {
      return res
        .status(400)
        .json({ error: "Missing departure_signature_key" });
    }

    const result = await pool.query(
      `
      UPDATE visitors.visits_details
      SET
        departure_time = $1,
        departure_signature_key = $2,
        departure_auto_closed = false
      WHERE id = $3
        AND departure_time IS NULL
      RETURNING *
      `,
      [departure_time, departure_signature_key, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Active visitor visit not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error ending visitor visit:", error);
    return res.status(500).json({ error: "Failed to end visitor visit" });
  }
});


router.get("/active", async (req, res) => {
  try {
    await pool.query(`
      UPDATE visitors.visits_details
      SET
        departure_time = arrival_time + INTERVAL '18 hours',
        departure_auto_closed = true
      WHERE departure_time IS NULL
        AND arrival_time < NOW() - INTERVAL '18 hours'
    `);

    const result = await pool.query(`
      SELECT 
        id,
        arrival_time,
        full_name,
        company_name,
        visit_reason
      FROM visitors.visits_details
      WHERE departure_time IS NULL
      ORDER BY arrival_time DESC
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching active visits:", error);
    res.status(500).json({ error: "Failed to fetch active visits" });
  }
});

router.post(
  "/registry-verifications",
  requireAppRole("main", ["admin"]),
  async (req, res) => {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ error: "Utilisateur non authentifi\u00e9" });
      }

      const {
        period_start,
        period_end,
        verification_date,
        is_compliant,
        notes,
        signatureDataUrl,
      } = req.body || {};

      if (
        !isValidDateOnly(period_start) ||
        !isValidDateOnly(period_end) ||
        !isValidDateOnly(verification_date)
      ) {
        return res.status(400).json({ error: "Les dates sont invalides" });
      }

      if (period_start > period_end) {
        return res.status(400).json({
          error: "La date de d\u00e9but doit pr\u00e9c\u00e9der la date de fin",
        });
      }

      if (typeof is_compliant !== "boolean") {
        return res.status(400).json({
          error: "Le r\u00e9sultat de la v\u00e9rification est requis",
        });
      }

      const normalizedNotes = typeof notes === "string" ? notes.trim() : "";
      if (normalizedNotes.length > MAX_VERIFICATION_NOTES_LENGTH) {
        return res.status(400).json({
          error: `Les notes ne peuvent pas d\u00e9passer ${MAX_VERIFICATION_NOTES_LENGTH} caract\u00e8res`,
        });
      }

      const signatureBuffer = decodePngDataUrl(signatureDataUrl);
      if (!signatureBuffer) {
        return res.status(400).json({
          error: "La signature PNG est manquante, invalide ou trop volumineuse",
        });
      }

      const signatureKey = `visitor-registry-verifications/${Date.now()}-${crypto.randomUUID()}.png`;
      await uploadVisitorSignatureToS3(signatureKey, signatureBuffer);

      const result = await pool.query(
        `
        INSERT INTO visitors.visitors_registry_verification (
          verifier_user_id,
          period_start,
          period_end,
          verification_date,
          is_compliant,
          notes,
          signature_url,
          signed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
        `,
        [
          req.user.id,
          period_start,
          period_end,
          verification_date,
          is_compliant,
          normalizedNotes || null,
          // Store the durable object key; presigned URLs expire after one hour.
          signatureKey,
        ],
      );

      const signatureUrl = await getSignedUrlForVisitorSignature(signatureKey);

      return res.status(201).json({
        ...result.rows[0],
        verifier_username: req.user.username,
        signature_url: signatureUrl,
        signature_key: signatureKey,
      });
    } catch (error) {
      console.error("Error creating visitor registry verification:", error);
      return res.status(500).json({
        error: "Impossible d'enregistrer la v\u00e9rification du registre",
      });
    }
  },
);

router.get(
  "/registry-verifications/next-period-start",
  requireAppRole("main", ["admin"]),
  async (_req, res) => {
    try {
      return res.status(200).json(await getNextVerificationPeriodStart());
    } catch (error) {
      console.error("Error fetching verification period start:", error);
      return res.status(500).json({
        error: "Impossible de calculer le d\u00e9but de la p\u00e9riode",
      });
    }
  },
);

router.get(
  "/registry-verifications",
  requireAppRole("main", ["admin"]),
  async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          verification.*,
          users.username AS verifier_username
        FROM visitors.visitors_registry_verification verification
        LEFT JOIN public.users users
          ON users.id = verification.verifier_user_id
        ORDER BY
          verification.verification_date DESC,
          verification.signed_at DESC NULLS LAST,
          verification.created_at DESC,
          verification.id DESC
      `);

      const verifications = await Promise.all(
        result.rows.map(async (verification) => {
          const storedSignature = verification.signature_url as string | null;
          const signatureIsDirectUrl =
            storedSignature?.startsWith("http://") ||
            storedSignature?.startsWith("https://") ||
            storedSignature?.startsWith("data:");
          const signatureUrl =
            storedSignature && !signatureIsDirectUrl
              ? await getSignedUrlForVisitorSignature(storedSignature)
              : storedSignature;

          return {
            ...verification,
            verifier_username:
              verification.verifier_username ||
              `Utilisateur #${verification.verifier_user_id}`,
            signature_key: signatureIsDirectUrl ? null : storedSignature,
            signature_url: signatureUrl,
          };
        }),
      );

      return res.status(200).json(verifications);
    } catch (error) {
      console.error("Error fetching visitor registry verifications:", error);
      return res.status(500).json({
        error: "Impossible de charger l'historique des v\u00e9rifications",
      });
    }
  },
);

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
