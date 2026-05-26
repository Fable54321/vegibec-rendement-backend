import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import Router from "express";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

router.post(
  "/generated-images",
  requireAppRole("rendement", ["admin"]),
  async (req, res) => {
    try {
      const { imageDataUrl } = req.body;

      if (!imageDataUrl?.startsWith("data:image/png;base64,")) {
        return res.status(400).json({ error: "Missing PNG image data" });
      }

      const base64 = imageDataUrl.replace("data:image/png;base64,", "");
      const buffer = Buffer.from(base64, "base64");

      const fileName = `facebook-weather-${Date.now()}-${crypto.randomUUID()}.png`;
      const outputDir = path.join(process.cwd(), "public", "generated");
      const outputPath = path.join(outputDir, fileName);

      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(outputPath, buffer);

      const publicBaseUrl = process.env.PUBLIC_BACKEND_URL;
      if (!publicBaseUrl) {
        return res.status(500).json({ error: "PUBLIC_BACKEND_URL is not configured" });
      }

      const generatedUrl = `${publicBaseUrl}/generated/${fileName}`;
      console.log("Generated Facebook image URL:", generatedUrl);

      return res.status(201).json({
        url: generatedUrl,
      });
    } catch (error) {
      console.error("Error saving generated image:", error);
      return res.status(500).json({ error: "Failed to save generated image" });
    }
  },
);


export default router;
