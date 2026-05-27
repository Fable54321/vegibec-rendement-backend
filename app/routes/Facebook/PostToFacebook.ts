import Router from "express";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { requireAppRole } from "../../middleware/auth";
import { postMessageToFacebook, postPictureToFacebook } from "../../Utils/Facebook/postMessageToFacebook";


const router = Router();
export const publicFacebookRouter = Router();

type SharePagePayload = {
  title: string;
  description: string;
  imageUrl: string;
  createdAt: string;
};

const getPublicBaseUrl = () => process.env.PUBLIC_BACKEND_URL?.replace(/\/+$/, "");
const getSharePagesDir = () => path.join(process.cwd(), "public", "generated", "facebook-share-pages");

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toAbsolutePublicUrl = (url: string) => {
  const trimmedUrl = url.trim();

  if (/^https?:\/\//i.test(trimmedUrl)) {
    return trimmedUrl;
  }

  const publicBaseUrl = getPublicBaseUrl();
  if (!publicBaseUrl) {
    throw new Error("PUBLIC_BACKEND_URL is not configured");
  }

  return `${publicBaseUrl}/${trimmedUrl.replace(/^\/+/, "")}`;
};

const getFacebookShareUrl = (shareUrl: string) =>
  `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;

publicFacebookRouter.get("/share/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");

    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      return res.status(404).send("Share page not found");
    }

    const filePath = path.join(getSharePagesDir(), `${id}.json`);
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as SharePagePayload;
    const publicBaseUrl = getPublicBaseUrl();
    const shareUrl = publicBaseUrl
      ? `${publicBaseUrl}/facebook/share/${id}`
      : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const facebookShareUrl = getFacebookShareUrl(shareUrl);

    const title = escapeHtml(payload.title);
    const description = escapeHtml(payload.description);
    const imageUrl = escapeHtml(toAbsolutePublicUrl(payload.imageUrl));
    const escapedShareUrl = escapeHtml(shareUrl);
    const escapedFacebookShareUrl = escapeHtml(facebookShareUrl);

    res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${escapedShareUrl}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:image:secure_url" content="${imageUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:url" content="${escapedShareUrl}">
  <meta property="og:locale" content="fr_CA">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${imageUrl}">
  <style>
    :root {
      color-scheme: light;
      font-family: Arial, Helvetica, sans-serif;
      color: #18202a;
      background: #f4f7f9;
    }

    body {
      margin: 0;
    }

    main {
      width: min(720px, calc(100% - 32px));
      margin: 32px auto;
    }

    img {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 8px;
      background: #ffffff;
    }

    h1 {
      margin: 24px 0 12px;
      font-size: 28px;
      line-height: 1.2;
    }

    p {
      margin: 0 0 20px;
      font-size: 16px;
      line-height: 1.5;
      white-space: pre-line;
    }

    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 0 18px;
      border-radius: 6px;
      color: #ffffff;
      background: #1877f2;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <img src="${imageUrl}" alt="${title}">
    <h1>${title}</h1>
    <p>${description}</p>
    <a href="${escapedFacebookShareUrl}" target="_blank" rel="noopener noreferrer">Partager sur Facebook</a>
  </main>
</body>
</html>`);
  } catch (error) {
    console.error("Error serving Facebook share page:", error);
    return res.status(404).send("Share page not found");
  }
});

router.post("/facebook-share-pages", requireAppRole("rendement", ["admin"]), async (req, res) => {
  try {
    const { title, description, imageUrl } = req.body;

    if (!title || !description || !imageUrl) {
      return res.status(400).json({ error: "Missing title, description, or imageUrl" });
    }

    const publicBaseUrl = getPublicBaseUrl();
    if (!publicBaseUrl) {
      return res.status(500).json({ error: "PUBLIC_BACKEND_URL is not configured" });
    }

    const payload: SharePagePayload = {
      title: String(title).trim(),
      description: String(description).trim(),
      imageUrl: toAbsolutePublicUrl(String(imageUrl)),
      createdAt: new Date().toISOString(),
    };

    if (!payload.title || !payload.description || !payload.imageUrl) {
      return res.status(400).json({ error: "Title, description, and imageUrl cannot be empty" });
    }

    const id = crypto.randomUUID();
    const outputDir = getSharePagesDir();
    const outputPath = path.join(outputDir, `${id}.json`);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");

    const shareUrl = `${publicBaseUrl}/facebook/share/${id}`;

    return res.status(201).json({
      success: true,
      id,
      shareUrl,
      facebookShareUrl: getFacebookShareUrl(shareUrl),
    });
  } catch (error) {
    console.error("Error creating Facebook share page:", error);
    return res.status(500).json({ error: "Failed to create Facebook share page" });
  }
});

router.post("/facebook-page-posts", requireAppRole("rendement", ["admin"]), async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: "Missing title or description" });
    }

    const message = `
${title}

${description}

    `.trim();

    const facebookResult = await postMessageToFacebook(message);

    return res.status(201).json({
      success: true,
      facebookPostId: facebookResult.id,
    });
  } catch (error) {
    console.error("Error creating Facebook post:", error);
    return res.status(500).json({
      error: "Failed to create Facebook post",
    });
  }
});


router.post("/facebook-page-pictures", requireAppRole("rendement", ["admin"]), async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Missing url" });
    }

    const facebookResult = await postPictureToFacebook(url);

    return res.status(201).json({
      success: true,
      facebookPostId: facebookResult.id,
    });
  } catch (error) {
    console.error("Error creating Facebook post:", error);
    return res.status(500).json({
      error: "Failed to create Facebook post",
    });
  }
});



export default router;
