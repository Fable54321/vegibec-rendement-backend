import express from "express";
import bcrypt from "bcrypt";
import { pool } from "../../db";
import { requireRole } from "../../middleware/auth";

const router = express.Router();

type AppAccessInput = {
  slug: string;
  role: string;
};

router.get("/", requireRole(["admin"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, slug
      FROM apps
      ORDER BY name;
    `);

    res.json({
      success: true,
      apps: result.rows,
    });
  } catch (error) {
    console.error("Error fetching apps:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.post("/", requireRole(["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const { username, password, legacyRole, apps } = req.body as {
      username?: string;
      password?: string;
      legacyRole?: string;
      apps?: AppAccessInput[];
    };

    if (!username || !password || !legacyRole) {
      return res.status(400).json({
        success: false,
        message: "Username, password and legacyRole are required",
      });
    }

    if (!Array.isArray(apps)) {
      return res.status(400).json({
        success: false,
        message: "Apps must be an array",
      });
    }

    const normalizedUsername = username.trim();

    if (normalizedUsername.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Username too short",
      });
    }

    const seenSlugs = new Set<string>();
    for (const app of apps) {
      if (!app?.slug) {
        return res.status(400).json({
          success: false,
          message: "Each app entry must include a slug",
        });
      }

      if (seenSlugs.has(app.slug)) {
        return res.status(400).json({
          success: false,
          message: `Duplicate app slug: ${app.slug}`,
        });
      }

      seenSlugs.add(app.slug);

      // rendement can omit role because it inherits from legacyRole
      if (app.slug !== "rendement" && !app.role) {
        return res.status(400).json({
          success: false,
          message: `Role is required for app: ${app.slug}`,
        });
      }
    }

    await client.query("BEGIN");

    const existingUser = await client.query(
      `SELECT id FROM users WHERE username = $1`,
      [normalizedUsername],
    );

    if (existingUser.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Username already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userInsert = await client.query(
      `
      INSERT INTO users (username, password_hash, role, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, username, role, created_at, updated_at
      `,
      [normalizedUsername, passwordHash, legacyRole],
    );

    const newUser = userInsert.rows[0];
    const userId = newUser.id;

    if (apps.length > 0) {
      const requestedSlugs = apps.map((a) => a.slug);

      const appsResult = await client.query(
        `
        SELECT id, slug
        FROM apps
        WHERE slug = ANY($1::text[])
        `,
        [requestedSlugs],
      );

      const dbApps = appsResult.rows as { id: number; slug: string }[];

      if (dbApps.length !== requestedSlugs.length) {
        const foundSlugs = new Set(dbApps.map((a) => a.slug));
        const missingSlugs = requestedSlugs.filter(
          (slug) => !foundSlugs.has(slug),
        );

        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Some app slugs do not exist",
          missingSlugs,
        });
      }

      const slugToId = new Map(dbApps.map((a) => [a.slug, a.id]));

      for (const app of apps) {
        const appId = slugToId.get(app.slug);

        if (!appId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: `App not found: ${app.slug}`,
          });
        }

        const effectiveRole = app.slug === "rendement" ? legacyRole : app.role!;

        await client.query(
          `
          INSERT INTO user_app_roles (user_id, app_id, role, created_at)
          VALUES ($1, $2, $3, NOW())
          `,
          [userId, appId, effectiveRole],
        );
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      user: {
        id: newUser.id,
        username: newUser.username,
        legacyRole: newUser.role,
        appAccess: apps.map((app) => ({
          slug: app.slug,
          role: app.slug === "rendement" ? legacyRole : app.role,
        })),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating user:", error);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  } finally {
    client.release();
  }
});

export default router;
