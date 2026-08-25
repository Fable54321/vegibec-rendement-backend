import { randomUUID } from "crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import {
  disconnectMicrosoftAccount,
  exchangeMicrosoftCode,
  getMicrosoftAuthorizationUrl,
  getMicrosoftConnectionStatus,
  listOutlookMessages,
  saveMicrosoftConnection,
} from "../../services/microsoftGraph.services";

const router = Router();
const outlookStateSecret = process.env.JWT_SECRET || "super_secret";
const outlookFrontendUrl = () =>
  (process.env.OUTLOOK_FRONTEND_URL || "https://devis.vegibec-portail.com").replace(/\/+$/, "");

router.get("/outlook/status", async (req, res) => {
  try {
    return res.json(await getMicrosoftConnectionStatus(req.user!.id));
  } catch (error) {
    console.error("Error reading Microsoft connection status:", error);
    return res.status(500).json({ error: "Failed to read Microsoft connection status" });
  }
});

router.get("/outlook/connect", (req, res) => {
  try {
    const state = jwt.sign(
      { userId: req.user!.id, nonce: randomUUID(), purpose: "outlook-connect" },
      outlookStateSecret,
      { expiresIn: "10m" },
    );
    return res.json({ url: getMicrosoftAuthorizationUrl(state) });
  } catch (error) {
    console.error("Error starting Microsoft connection:", error);
    return res.status(500).json({ error: "Microsoft Graph integration is not configured" });
  }
});

router.get("/outlook/callback", async (req, res) => {
  const frontendUrl = outlookFrontendUrl();
  try {
    if (typeof req.query.error === "string") {
      return res.redirect(`${frontendUrl}/rfq?outlook=error`);
    }
    if (typeof req.query.code !== "string" || typeof req.query.state !== "string") {
      return res.redirect(`${frontendUrl}/rfq?outlook=error`);
    }
    const state = jwt.verify(req.query.state, outlookStateSecret) as {
      userId: number;
      purpose: string;
    };
    if (state.purpose !== "outlook-connect" || !Number.isSafeInteger(state.userId)) {
      return res.redirect(`${frontendUrl}/rfq?outlook=error`);
    }
    const connection = await exchangeMicrosoftCode(req.query.code);
    await saveMicrosoftConnection(state.userId, connection);
    return res.redirect(`${frontendUrl}/rfq?outlook=connected`);
  } catch (error) {
    console.error("Microsoft OAuth callback failed:", error);
    return res.redirect(`${frontendUrl}/rfq?outlook=error`);
  }
});

router.delete("/outlook/connection", async (req, res) => {
  try {
    await disconnectMicrosoftAccount(req.user!.id);
    return res.status(204).send();
  } catch (error) {
    console.error("Error disconnecting Microsoft account:", error);
    return res.status(500).json({ error: "Failed to disconnect Microsoft account" });
  }
});

router.get("/outlook/messages", async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.slice(0, 200) : "";
    return res.json({ messages: await listOutlookMessages(req.user!.id, search) });
  } catch (error) {
    const status = Number((error as Error & { status?: number }).status) || 500;
    console.error("Error loading Outlook messages:", error);
    return res.status(status).json({
      error: status === 409 ? "Microsoft account is not connected" : "Failed to load Outlook messages",
    });
  }
});

export default router;
