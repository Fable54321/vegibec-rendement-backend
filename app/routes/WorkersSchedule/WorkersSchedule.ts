import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import crypto from "crypto";
import path from "path";
import { uploadBufferToS3 } from "../../services/s3.services";
import multer from "multer";

const router = Router();


router.get("/", requireAppRole("schedule", ["admin", "user", "guest"]), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                fwd.*,
                u.name AS user_name,
                u.surname AS user_surname,
                u.username AS username,
                u.email AS user_email,
                fwi.matricula AS user_matricula
            FROM foreign_workers_schedule.foreign_workers_details fwd
            LEFT JOIN public.users u
                ON u.id = fwd.user_id
            LEFT JOIN public.foreign_workers_info fwi
                ON fwi.user_id = fwd.user_id
            ORDER BY u.surname ASC, u.name ASC
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error fetching workers schedule:", error);
        res.status(500).json({ error: "Failed to fetch workers schedule" });
    }
});


router.get("/job-list", requireAppRole("schedule", ["admin", "user", "guest"]), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
              djl.*
            FROM foreign_workers_schedule.detailed_job_list djl
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error fetching job list:", error);
        res.status(500).json({ error: "Failed to fetch job list" });
    }
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per picture
  },
});

const allowedImageMimeTypes = ["image/jpeg", "image/png", "image/webp"];


router.post(
  "/foreign-workers/personal-pictures/bulk-by-matricula",
  requireAppRole("main", ["admin"]),
  upload.array("pictures", 500),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const files = req.files as Express.Multer.File[] | undefined;

      if (!files || files.length === 0) {
        return res.status(400).json({ error: "Aucune image envoyée" });
      }

      const extensionFromMime: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
      };

      const results: {
        fileName: string;
        matricula?: string;
        userId?: number;
        status: "success" | "error";
        message: string;
        key?: string;
      }[] = [];

      const validFiles: {
        file: Express.Multer.File;
        matricula: string;
        extension: string;
      }[] = [];

      for (const file of files) {
        if (!allowedImageMimeTypes.includes(file.mimetype)) {
          results.push({
            fileName: file.originalname,
            status: "error",
            message: "Type de fichier invalide",
          });
          continue;
        }

        const fileNameWithoutExtension = path.parse(file.originalname).name;

        // Example:
        // 609.jpg -> 609
        // 00609.jpg -> 609
        // matricula-609.jpg -> 609
        const match = fileNameWithoutExtension.match(/\d+/);

        if (!match) {
          results.push({
            fileName: file.originalname,
            status: "error",
            message: "Aucune matricula trouvée dans le nom du fichier",
          });
          continue;
        }

        let matricula = match[0].trim();

        // Remove leading zeroes so "00609" becomes "609"
        matricula = matricula.replace(/^0+/, "");

        // Avoid empty string if filename was "00000.jpg"
        if (matricula === "") {
          matricula = "0";
        }

        const extension =
          extensionFromMime[file.mimetype] ||
          path.extname(file.originalname).toLowerCase() ||
          ".jpg";

        validFiles.push({
          file,
          matricula,
          extension,
        });
      }

      if (validFiles.length === 0) {
        return res.status(400).json({
          error: "Aucune image valide à traiter",
          results,
        });
      }

      const matriculas = validFiles.map((item) => item.matricula);

      const workersResult = await client.query(
        `
        SELECT
          fwi.user_id,
          COALESCE(NULLIF(LTRIM(fwi.matricula, '0'), ''), '0') AS normalized_matricula,
          fwi.matricula AS db_matricula,
          fwd.id AS details_id
        FROM public.foreign_workers_info fwi
        INNER JOIN foreign_workers_schedule.foreign_workers_details fwd
          ON fwd.user_id = fwi.user_id
        WHERE COALESCE(NULLIF(LTRIM(fwi.matricula, '0'), ''), '0') = ANY($1::text[])
        `,
        [matriculas]
      );

      const workerByMatricula = new Map<
        string,
        {
          userId: number;
          dbMatricula: string;
          detailsId: number;
        }
      >();

      for (const row of workersResult.rows) {
        workerByMatricula.set(row.normalized_matricula, {
          userId: Number(row.user_id),
          dbMatricula: row.db_matricula,
          detailsId: Number(row.details_id),
        });
      }

      const updates: {
        userId: number;
        personalPictureKey: string;
      }[] = [];

      for (const item of validFiles) {
        const worker = workerByMatricula.get(item.matricula);

        if (!worker) {
          results.push({
            fileName: item.file.originalname,
            matricula: item.matricula,
            status: "error",
            message: "Aucun travailleur trouvé pour cette matricula",
          });
          continue;
        }

        const personalPictureKey =
          `foreign-workers/personal-pictures/` +
          `matricula-${item.matricula}-user-${worker.userId}-${crypto.randomUUID()}${item.extension}`;

        await uploadBufferToS3({
          key: personalPictureKey,
          buffer: item.file.buffer,
          contentType: item.file.mimetype,
        });

        updates.push({
          userId: worker.userId,
          personalPictureKey,
        });

        results.push({
          fileName: item.file.originalname,
          matricula: item.matricula,
          userId: worker.userId,
          status: "success",
          message: "Image téléversée avec succès",
          key: personalPictureKey,
        });
      }

      if (updates.length > 0) {
        await client.query("BEGIN");

        const valuesSql = updates
          .map(
            (_, index) =>
              `($${index * 2 + 1}::int, $${index * 2 + 2}::text)`
          )
          .join(", ");

        const valuesParams = updates.flatMap((item) => [
          item.userId,
          item.personalPictureKey,
        ]);

        await client.query(
          `
          UPDATE foreign_workers_schedule.foreign_workers_details AS fwd
          SET personal_picture_key = bulk.personal_picture_key
          FROM (
            VALUES ${valuesSql}
          ) AS bulk(user_id, personal_picture_key)
          WHERE fwd.user_id = bulk.user_id
          `,
          valuesParams
        );

        await client.query("COMMIT");
      }

      return res.status(200).json({
        message: "Téléversement massif terminé",
        totalFiles: files.length,
        validFiles: validFiles.length,
        successCount: results.filter((r) => r.status === "success").length,
        errorCount: results.filter((r) => r.status === "error").length,
        results,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Error bulk uploading personal pictures by matricula:", err);

      return res.status(500).json({
        error: "Erreur lors du téléversement massif des photos",
      });
    } finally {
      client.release();
    }
  }
);




export default router;
