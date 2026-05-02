import { Request, Router } from "express";
import crypto from "crypto";
import jwt, { JwtPayload } from "jsonwebtoken";
import { pool } from "../../db";
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

const getVisitorPlanBaseUrl = (req: Request) => {
  const configuredUrl = process.env.VISITOR_PLAN_PAGE_URL?.trim();

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
  const url = `${baseUrl}/plan-du-site/${token}`;

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

router.get("/plan-access", async (req, res) => {
  try {
    const token = String(req.query.token || "");

    if (!token) {
      return res.status(400).json({ valid: false, error: "Missing token" });
    }

    const decoded = jwt.verify(
      token,
      VISITOR_PLAN_TOKEN_SECRET,
    ) as JwtPayload & {
      scope?: string;
    };

    if (decoded.scope !== "visitor-plan") {
      return res
        .status(403)
        .json({ valid: false, error: "Invalid token scope" });
    }

    return res.status(200).json({
      valid: true,
      expiresAt: decoded.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : undefined,
    });
  } catch (error: any) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ valid: false, error: "Token expired" });
    }

    return res.status(401).json({ valid: false, error: "Invalid token" });
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
      wants_email,
      email,
      other_content,
    } = req.body;

    const visitorEmail = typeof email === "string" ? email.trim() : "";
    const shouldSendEmail =  visitorEmail !== "";
    let emailSent = false;

    if (shouldSendEmail) {
      const generatedUrl = generateVisitorPlanUrl(req).url;
      const planUrl = generatedUrl;
      const emailInfo = await sendEmail(
        "Vegibec - plan du site",
        `Vous trouverez le plan du site a l'adresse suivante: ${planUrl}\n\nCordialement,\nL'equipe de Vegibec`,
        visitorEmail,
      );

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
