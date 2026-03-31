import express from "express";
import bcrypt from "bcrypt";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

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

router.get("/", requireAppRole("main", ["admin", "user", "guest"]), async (_req, res) => {
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

router.get("/list", requireAppRole("main", ["admin"]), async (_req, res) => {
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

router.get("/:id", requireAppRole("main", ["admin", "user", "guest" ]), async (req, res) => {
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
router.post("/", requireAppRole("main", ["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const { username, password, apps, email, name, surname } = req.body as {
      username?: string;
      password?: string;
      email?: string;
      name?: string;
      surname?: string;
      apps?: AppAccessInput[];
    };

    if (!username || !password || !email || !name || !surname) {
      return res.status(400).json({
        success: false,
        message: "Username, password, email, name and surname are required",
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
    const normalizedApps = apps.map((app) => ({
      ...app,
      slug: app.slug?.trim().toLowerCase(),
      role: app.role?.trim(),
    }));

    if (normalizedUsername.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Username too short",
      });
    }

    const hasMain = normalizedApps.some((app) => app.slug === "main");

    if (!hasMain) {
      return res.status(400).json({
        success: false,
        message: "L'application principale ne peut pas être désactivée",
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

    const seenSlugs = new Set<string>();

    

    for (const app of normalizedApps) {
      if (!app?.slug) {
        return res.status(400).json({
          success: false,
          message: "Each app entry must include a slug",
        });
      }

      const normalizedSlug = app.slug;

      if (seenSlugs.has(normalizedSlug)) {
        return res.status(400).json({
          success: false,
          message: `Duplicate app slug: ${normalizedSlug}`,
        });
      }

      seenSlugs.add(normalizedSlug);

      if (!app.role) {
        return res.status(400).json({
          success: false,
          message: `Role is required for app: ${normalizedSlug}`,
        });
      }

      if (!isValidRole(app.role)) {
        return res.status(400).json({
          success: false,
          message: `Invalid role for app: ${normalizedSlug}`,
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
  (username, password_hash, email, name, surname, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
  RETURNING id, username, role, email, name, surname, created_at, updated_at
  `,
      [
        normalizedUsername,
        passwordHash,
        normalizedEmail,
        normalizedName,
        normalizedSurname,
      ],
    );

    const newUser = userInsert.rows[0];
    const userId = newUser.id;

    if (normalizedApps.length > 0) {
      const requestedSlugs = normalizedApps.map((a) => a.slug);

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

      let shouldUseWorksheet = false;

      for (const app of normalizedApps) {
        const slug = app.slug;
        const appId = slugToId.get(slug);

        if (!appId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: `App not found: ${slug}`,
          });
        }

        const effectiveRole = app.role!;

          if (slug === "time" && (effectiveRole === "guest" || effectiveRole === "user")) {
    shouldUseWorksheet = true;
  }

        await client.query(
          `
          INSERT INTO user_app_roles (user_id, app_id, role, created_at)
          VALUES ($1, $2, $3, NOW())
          `,
          [userId, appId, effectiveRole],
        );
      }


          if (shouldUseWorksheet) {
  await client.query(
    `
    UPDATE users
    SET uses_worksheet = TRUE
    WHERE id = $1
    `,
    [userId]
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
        appAccess: normalizedApps.map((app) => ({
          slug: app.slug,
          role: app.role,
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
