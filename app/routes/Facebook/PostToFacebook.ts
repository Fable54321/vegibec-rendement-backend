import Router from "express";
import { requireAppRole } from "../../middleware/auth";
import { postMessageToFacebook } from "../../Utils/Facebook/postMessageToFacebook";


const router = Router();

router.post("/facebook-page-posts", requireAppRole("rendement", ["admin"]), async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: "Missing title or description" });
    }

    const message = `
${title}

${description}

}
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


export default router;