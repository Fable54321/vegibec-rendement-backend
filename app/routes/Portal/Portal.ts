import express from "express";
import bcrypt from "bcrypt";
import { pool } from "../../db";
import { requireRole } from "../../middleware/auth";

const router = express.Router();

type AppAccessInput = {
  slug: string;
  role?: string;
};

const ALLOWED_ROLES = ["admin", "user", "guest"] as const;

const isValidRole = (role: string): boolean => {
  return ALLOWED_ROLES.includes(role as (typeof ALLOWED_ROLES)[number]);
};

const isValidEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

/**
 * GET /admin-users
 * Return all apps for the create-account form
 */
router.get("/", requireRole(["admin"]), async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, slug
      FROM apps
      ORDER BY name;
    `);

    return res.json({
      success: true,
      apps: result.rows,
    });
  } catch (error) {
    console.error("Error fetching apps:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/**
 * GET /admin-users/list
 * Optional: list users for admin page
 */
router.get("/list", requireRole(["admin"]), async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, email, name, surname, role, created_at, updated_at
      FROM users
      ORDER BY id ASC;
    `);

    return res.json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/**
 * GET /admin-users/:id
 * Optional: get one user and their app access
 */
router.get("/:id", requireRole(["admin"]), async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    const userResult = await pool.query(
      `
      SELECT id, username, email, name, surname, role, created_at, updated_at
      FROM users
      WHERE id = $1
      `,
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const appAccessResult = await pool.query(
      `
      SELECT a.id AS app_id, a.name, a.slug, uar.role
      FROM user_app_roles uar
      JOIN apps a ON a.id = uar.app_id
      WHERE uar.user_id = $1
      ORDER BY a.name
      `,
      [userId],
    );

    return res.json({
      success: true,
      user: userResult.rows[0],
      apps: appAccessResult.rows,
    });
  } catch (error) {
    console.error("Error fetching user details:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/**
 * POST /admin-users
 * Create a user and assign app access
 */
router.post("/", requireRole(["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const { username, password, legacyRole, apps, email, name, surname } =
      req.body as {
        username?: string;
        password?: string;
        legacyRole?: string;
        email?: string;
        name?: string;
        surname?: string;
        apps?: AppAccessInput[];
      };

    if (!username || !password || !legacyRole || !email || !name || !surname) {
      return res.status(400).json({
        success: false,
        message:
          "Username, password, legacyRole, email, name and surname are required",
      });
    }

    if (!Array.isArray(apps)) {
      return res.status(400).json({
        success: false,
        message: "Apps must be an array",
      });
    }

    const normalizedUsername = username.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    const normalizedSurname = surname.trim();
    const normalizedLegacyRole = legacyRole.trim();

    if (normalizedUsername.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Username too short",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password too short",
      });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email",
      });
    }

    if (!isValidRole(normalizedLegacyRole)) {
      return res.status(400).json({
        success: false,
        message: "Invalid legacyRole",
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

      const normalizedSlug = app.slug.trim();

      if (seenSlugs.has(normalizedSlug)) {
        return res.status(400).json({
          success: false,
          message: `Duplicate app slug: ${normalizedSlug}`,
        });
      }

      seenSlugs.add(normalizedSlug);

      if (normalizedSlug !== "rendement") {
        if (!app.role) {
          return res.status(400).json({
            success: false,
            message: `Role is required for app: ${normalizedSlug}`,
          });
        }

        if (!isValidRole(app.role.trim())) {
          return res.status(400).json({
            success: false,
            message: `Invalid role for app: ${normalizedSlug}`,
          });
        }
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

    const existingEmail = await client.query(
      `SELECT id FROM users WHERE LOWER(email) = $1`,
      [normalizedEmail],
    );

    if (existingEmail.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userInsert = await client.query(
      `
      INSERT INTO users
      (username, password_hash, role, email, name, surname, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING id, username, role, email, name, surname, created_at, updated_at
      `,
      [
        normalizedUsername,
        passwordHash,
        normalizedLegacyRole,
        normalizedEmail,
        normalizedName,
        normalizedSurname,
      ],
    );

    const newUser = userInsert.rows[0];
    const userId = newUser.id;

    if (apps.length > 0) {
      const requestedSlugs = apps.map((a) => a.slug.trim());

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

      const slugToId = new Map<string, number>(
        dbApps.map((a) => [a.slug, a.id]),
      );

      for (const app of apps) {
        const slug = app.slug.trim();
        const appId = slugToId.get(slug);

        if (!appId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: `App not found: ${slug}`,
          });
        }

        const effectiveRole =
          slug === "rendement" ? normalizedLegacyRole : app.role!.trim();

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
        email: newUser.email,
        name: newUser.name,
        surname: newUser.surname,
        legacyRole: newUser.role,
        appAccess: apps.map((app) => ({
          slug: app.slug.trim(),
          role:
            app.slug.trim() === "rendement"
              ? normalizedLegacyRole
              : app.role?.trim(),
        })),
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback error:", rollbackError);
    }

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
