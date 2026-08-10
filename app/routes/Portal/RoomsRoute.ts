import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";


const router = Router();

router.get("/", (_req, res) => {
    pool.query("SELECT * FROM foreign_workers_schedule.casas", (err, result) => {
        if (err) {
            console.error("Error fetching rooms:", err);
            res.status(500).json({ error: "Database error" });
        } else {
            res.json(result.rows);
        }
    })
})

router.get("/total-occupation", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total_occupation
       FROM foreign_workers_schedule.foreign_workers_details
       WHERE casa_id IS NOT NULL`,
    );

    return res.status(200).json({
      totalOccupation: result.rows[0].total_occupation,
    });
  } catch (error) {
    console.error("Error fetching total room occupation:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

router.get("/cuartos", async (req, res) => {
  const casaId = req.query.casa_id === undefined
    ? null
    : Number(req.query.casa_id);

  if (casaId !== null && (!Number.isInteger(casaId) || casaId <= 0)) {
    return res.status(400).json({ error: "casa_id must be a positive integer" });
  }

  try {
    const result = await pool.query(
      `SELECT
         cuarto.id,
         cuarto.name,
         cuarto.casa_id,
         casa.name AS casa_name,
         COALESCE(cuarto.number_of_spaces, 0)::int AS number_of_spaces,
         COUNT(fwd.id)::int AS worker_count
       FROM foreign_workers_schedule.cuartos cuarto
       INNER JOIN foreign_workers_schedule.casas casa
         ON casa.id = cuarto.casa_id
       LEFT JOIN foreign_workers_schedule.foreign_workers_details fwd
         ON fwd.cuartos_id = cuarto.id
       WHERE ($1::bigint IS NULL OR cuarto.casa_id = $1)
       GROUP BY cuarto.id, cuarto.name, cuarto.casa_id, casa.name
       ORDER BY casa.name, cuarto.name`,
      [casaId],
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching cuartos:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

router.get("/cuartos/capacity", async (req, res) => {
  const casaId = req.query.casa_id === undefined
    ? null
    : Number(req.query.casa_id);

  if (casaId !== null && (!Number.isInteger(casaId) || casaId <= 0)) {
    return res.status(400).json({ error: "casa_id must be a positive integer" });
  }

  try {
    const result = await pool.query(
      `WITH room_capacity AS (
         SELECT
           cuarto.id,
           cuarto.name,
           cuarto.casa_id,
           casa.name AS casa_name,
           COALESCE(cuarto.number_of_spaces, 0)::int AS number_of_spaces,
           COUNT(fwd.id)::int AS worker_count
         FROM foreign_workers_schedule.cuartos cuarto
         INNER JOIN foreign_workers_schedule.casas casa
           ON casa.id = cuarto.casa_id
         LEFT JOIN foreign_workers_schedule.foreign_workers_details fwd
           ON fwd.cuartos_id = cuarto.id
         WHERE ($1::bigint IS NULL OR cuarto.casa_id = $1)
         GROUP BY cuarto.id, cuarto.name, cuarto.casa_id, casa.name
       )
       SELECT
         *,
         GREATEST(number_of_spaces - worker_count, 0)::int AS available_spaces
       FROM room_capacity
       ORDER BY casa_name, name`,
      [casaId],
    );

    const totals = result.rows.reduce(
      (current, room) => {
        current.totalSpaces += Number(room.number_of_spaces);
        current.totalOccupied += Number(room.worker_count);
        current.totalAvailable += Number(room.available_spaces);
        return current;
      },
      { totalSpaces: 0, totalOccupied: 0, totalAvailable: 0 },
    );

    return res.status(200).json({
      cuartos: result.rows,
      ...totals,
    });
  } catch (error) {
    console.error("Error fetching cuarto capacity:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

router.get("/occupancy-state", async (_req, res) => {
  try {
    const [casasResult, cuartosResult, workersResult] = await Promise.all([
      pool.query(
        `SELECT id, name
         FROM foreign_workers_schedule.casas
         ORDER BY name`,
      ),
      pool.query(
        `SELECT
           id,
           name,
           casa_id,
           COALESCE(number_of_spaces, 0)::int AS number_of_spaces
         FROM foreign_workers_schedule.cuartos
         ORDER BY name`,
      ),
      pool.query(
        `SELECT
           fwd.id,
           fwd.user_id,
           fwd.casa_id,
           fwd.cuartos_id,
           u.name,
           u.surname
         FROM foreign_workers_schedule.foreign_workers_details fwd
         LEFT JOIN public.users u
           ON u.id = fwd.user_id
         ORDER BY u.surname NULLS LAST, u.name NULLS LAST, fwd.user_id`,
      ),
    ]);

    const casas = casasResult.rows.map((casa) => ({
      id: casa.id,
      name: casa.name,
      workerCount: 0,
      numberOfSpaces: 0,
      availableSpaces: 0,
      cuartos: [] as Array<{
        id: unknown;
        name: string;
        numberOfSpaces: number;
        workerCount: number;
        availableSpaces: number;
        workers: typeof workersResult.rows;
      }>,
      workersWithoutCuarto: [] as typeof workersResult.rows,
    }));

    const casasById = new Map(casas.map((casa) => [String(casa.id), casa]));
    const cuartosById = new Map<string, (typeof casas)[number]["cuartos"][number]>();

    for (const cuarto of cuartosResult.rows) {
      const casa = casasById.get(String(cuarto.casa_id));
      if (!casa) continue;

      const cleanCuarto = {
        id: cuarto.id,
        name: cuarto.name,
        numberOfSpaces: Number(cuarto.number_of_spaces),
        workerCount: 0,
        availableSpaces: 0,
        workers: [] as typeof workersResult.rows,
      };

      casa.cuartos.push(cleanCuarto);
      casa.numberOfSpaces += cleanCuarto.numberOfSpaces;
      cuartosById.set(String(cuarto.id), cleanCuarto);
    }

    const workersWithoutCasa: typeof workersResult.rows = [];

    for (const worker of workersResult.rows) {
      const cleanWorker = {
        id: worker.id,
        userId: worker.user_id,
        name: worker.name,
        surname: worker.surname,
      };
      const cuarto = worker.cuartos_id === null
        ? undefined
        : cuartosById.get(String(worker.cuartos_id));

      if (cuarto) {
        cuarto.workers.push(cleanWorker);
        cuarto.workerCount += 1;
        continue;
      }

      const casa = worker.casa_id === null
        ? undefined
        : casasById.get(String(worker.casa_id));

      if (casa) {
        casa.workersWithoutCuarto.push(cleanWorker);
      } else {
        workersWithoutCasa.push(cleanWorker);
      }
    }

    for (const casa of casas) {
      for (const cuarto of casa.cuartos) {
        cuarto.availableSpaces = Math.max(
          cuarto.numberOfSpaces - cuarto.workerCount,
          0,
        );
      }

      casa.workerCount = casa.cuartos.reduce(
        (total, cuarto) => total + cuarto.workerCount,
        casa.workersWithoutCuarto.length,
      );
      casa.availableSpaces = casa.cuartos.reduce(
        (total, cuarto) => total + cuarto.availableSpaces,
        0,
      );
    }

    return res.status(200).json({
      casas,
      workersWithoutCasa,
      totals: {
        casas: casas.length,
        cuartos: cuartosResult.rows.length,
        spaces: casas.reduce((total, casa) => total + casa.numberOfSpaces, 0),
        workers: workersResult.rows.length,
        availableSpaces: casas.reduce(
          (total, casa) => total + casa.availableSpaces,
          0,
        ),
        workersWithoutCuarto: casas.reduce(
          (total, casa) => total + casa.workersWithoutCuarto.length,
          0,
        ),
        workersWithoutCasa: workersWithoutCasa.length,
      },
    });
  } catch (error) {
    console.error("Error fetching room occupancy state:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

router.patch(
  "/workers/:userId/cuarto",
  requireAppRole("main", ["admin"]),
  async (req, res) => {
    const userId = Number(req.params.userId);
    const requestedCuartoId = req.body?.cuartos_id;
    const cuartoId = requestedCuartoId === null ? null : Number(requestedCuartoId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid worker ID" });
    }

    if (
      !Object.prototype.hasOwnProperty.call(req.body ?? {}, "cuartos_id") ||
      (cuartoId !== null && (!Number.isInteger(cuartoId) || cuartoId <= 0))
    ) {
      return res.status(400).json({
        error: "cuartos_id must be a positive integer or null",
      });
    }

    try {
      const result = await pool.query(
        `UPDATE foreign_workers_schedule.foreign_workers_details fwd
         SET cuartos_id = $2,
             casa_id = cuarto.casa_id
         FROM (
           SELECT $2::bigint AS id, casa_id
           FROM foreign_workers_schedule.cuartos
           WHERE id = $2

           UNION ALL

           SELECT NULL::bigint AS id, NULL::bigint AS casa_id
           WHERE $2::bigint IS NULL
         ) cuarto
         WHERE fwd.user_id = $1
         RETURNING
           fwd.id,
           fwd.user_id,
           fwd.casa_id,
           fwd.cuartos_id`,
        [userId, cuartoId],
      );

      if (result.rows.length === 0) {
        const workerExists = await pool.query(
          `SELECT 1
           FROM foreign_workers_schedule.foreign_workers_details
           WHERE user_id = $1`,
          [userId],
        );

        if (workerExists.rows.length === 0) {
          return res.status(404).json({ error: "Worker not found" });
        }

        return res.status(404).json({ error: "Cuarto not found" });
      }

      const updatedWorker = await pool.query(
        `SELECT
           fwd.id,
           fwd.user_id,
           fwd.casa_id,
           casa.name AS casa_name,
           fwd.cuartos_id,
           cuarto.name AS cuarto_name
         FROM foreign_workers_schedule.foreign_workers_details fwd
         LEFT JOIN foreign_workers_schedule.casas casa
           ON casa.id = fwd.casa_id
         LEFT JOIN foreign_workers_schedule.cuartos cuarto
           ON cuarto.id = fwd.cuartos_id
         WHERE fwd.user_id = $1`,
        [userId],
      );

      return res.status(200).json({
        message: "Worker room updated successfully",
        worker: updatedWorker.rows[0],
      });
    } catch (error) {
      console.error("Error updating worker cuarto:", error);
      return res.status(500).json({ error: "Database error" });
    }
  },
);


router.get("/:id/workers", async (req, res) => {
  const { id } = req.params;

  try {
   const result = await pool.query(
  `SELECT
     fwd.*,
     u.name,
     u.surname,
     cuarto.name AS cuarto_name
   FROM foreign_workers_schedule.foreign_workers_details fwd
   LEFT JOIN public.users u
     ON u.id = fwd.user_id
   LEFT JOIN foreign_workers_schedule.cuartos cuarto
     ON cuarto.id = fwd.cuartos_id
   WHERE fwd.casa_id = $1
   ORDER BY u.surname, u.name`,
  [id],
);

    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching workers:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

export default router
