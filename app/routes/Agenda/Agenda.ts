import { Router } from "express"
import { pool } from "../../db"
import webpush, { type PushSubscription } from "web-push"
import type { PoolClient } from "pg"

const router = Router()

type RecurrenceType = "none" | "daily" | "weekly" | "monthly" | "yearly"

type PushSubscriptionBody = PushSubscription & {
  keys?: {
    p256dh?: string
    auth?: string
  }
}

let hasEnsuredPushSchema = false
let notificationWorkerHandle: NodeJS.Timeout | null = null

const vapidPublicKey = process.env.AGENDA_VAPID_PUBLIC_KEY || ""
const vapidPrivateKey = process.env.AGENDA_VAPID_PRIVATE_KEY || ""
const vapidSubject =
  process.env.AGENDA_VAPID_SUBJECT || "mailto:admin@vegibec-portail.com"
const agendaApiBaseUrl =
  process.env.AGENDA_API_BASE_URL || "https://api.vegibec-portail.com"

const isPushConfigured = Boolean(vapidPublicKey && vapidPrivateKey)

if (isPushConfigured) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
}

const VALID_ICONS = new Set([
  "shopping",
  "call",
  "delivery",
  "payment",
  "reminder",
])

const VALID_RECURRENCE_TYPES = new Set([
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
])

const getUserId = (req: any) => {
  return req.user?.id
}

const isValidDateString = (value: unknown) => {
  if (typeof value !== "string") return false

  const date = new Date(`${value}T00:00:00`)
  return !Number.isNaN(date.getTime())
}

const isValidTimeString = (value: unknown) => {
  if (value === null || value === undefined || value === "") return true
  if (typeof value !== "string") return false

  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

const toDateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
}

const addMonthsSafe = (date: Date, monthsToAdd: number) => {
  const originalDay = date.getDate()

  const result = new Date(date)
  result.setMonth(result.getMonth() + monthsToAdd)

  if (result.getDate() !== originalDay) {
    result.setDate(0)
  }

  return result
}

const addYearsSafe = (date: Date, yearsToAdd: number) => {
  const result = new Date(date)
  result.setFullYear(result.getFullYear() + yearsToAdd)

  return result
}

const getNextOccurrenceDate = (
  currentDate: Date,
  recurrenceType: RecurrenceType,
  recurrenceInterval: number,
) => {
  const nextDate = new Date(currentDate)

  if (recurrenceType === "daily") {
    nextDate.setDate(nextDate.getDate() + recurrenceInterval)
    return nextDate
  }

  if (recurrenceType === "weekly") {
    nextDate.setDate(nextDate.getDate() + recurrenceInterval * 7)
    return nextDate
  }

  if (recurrenceType === "monthly") {
    return addMonthsSafe(nextDate, recurrenceInterval)
  }

  if (recurrenceType === "yearly") {
    return addYearsSafe(nextDate, recurrenceInterval)
  }

  return nextDate
}

const combineDateAndTime = (dateKey: string, time: string | null) => {
  const reminderTime = time || "09:00"

  return `${dateKey}T${reminderTime}:00`
}

const ensurePushSchema = async () => {
  if (hasEnsuredPushSchema) return

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda.push_subscriptions (
      id bigserial PRIMARY KEY,
      user_id integer NOT NULL,
      endpoint text NOT NULL UNIQUE,
      p256dh text NOT NULL,
      auth text NOT NULL,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_success_at timestamptz,
      last_error text
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
    ON agenda.push_subscriptions (user_id)
  `)

  hasEnsuredPushSchema = true
}

const getMonthRange = (year: number, month: number) => {
  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0)

  return {
    monthStart: toDateKey(start),
    monthEnd: toDateKey(end),
  }
}

const buildOccurrencesForMonth = (task: any, monthStart: string, monthEnd: string) => {
  const occurrenceDates: string[] = []

  const recurrenceType = task.recurrence_type as RecurrenceType
  const recurrenceInterval = Number(task.recurrence_interval || 1)

  const startDate = new Date(`${task.start_date}T00:00:00`)
  const rangeStart = new Date(`${monthStart}T00:00:00`)
  const rangeEnd = new Date(`${monthEnd}T00:00:00`)

  const recurrenceEndDate = task.recurrence_end_date
    ? new Date(`${task.recurrence_end_date}T00:00:00`)
    : null

  if (recurrenceType === "none") {
    if (startDate >= rangeStart && startDate <= rangeEnd) {
      occurrenceDates.push(toDateKey(startDate))
    }

    return occurrenceDates
  }

  let currentDate = new Date(startDate)

  while (currentDate <= rangeEnd) {
    const isAfterStart = currentDate >= rangeStart
    const isBeforeEnd = !recurrenceEndDate || currentDate <= recurrenceEndDate

    if (isAfterStart && isBeforeEnd) {
      occurrenceDates.push(toDateKey(currentDate))
    }

    currentDate = getNextOccurrenceDate(
      currentDate,
      recurrenceType,
      recurrenceInterval,
    )
  }

  return occurrenceDates
}

const ensureOccurrencesForRange = async (
  client: PoolClient,
  rangeStart: string,
  rangeEnd: string,
) => {
  const tasksResult = await client.query(
    `
    SELECT
      id,
      user_id,
      task_description,
      task_icon,
      start_date::text,
      reminder_time::text,
      recurrence_type,
      recurrence_interval,
      recurrence_end_date::text,
      is_active,
      created_at,
      updated_at
    FROM agenda.agenda_tasks
    WHERE is_active = true
      AND (
        start_date <= $2::date
        AND (
          recurrence_end_date IS NULL
          OR recurrence_end_date >= $1::date
        )
      )
    ORDER BY start_date ASC, id ASC
    `,
    [rangeStart, rangeEnd],
  )

  for (const task of tasksResult.rows) {
    const dates = buildOccurrencesForMonth(task, rangeStart, rangeEnd)

    for (const occurrenceDate of dates) {
      await client.query(
        `
        INSERT INTO agenda.agenda_task_occurrences (
          task_id,
          occurrence_date,
          scheduled_for,
          next_reminder_at
        )
        VALUES ($1, $2, $3, $3)
        ON CONFLICT (task_id, occurrence_date)
        DO NOTHING
        `,
        [
          task.id,
          occurrenceDate,
          combineDateAndTime(occurrenceDate, task.reminder_time),
        ],
      )
    }
  }
}

const getUpcomingOccurrenceRange = () => {
  const start = new Date()
  const end = new Date()
  end.setDate(end.getDate() + 7)

  return {
    rangeStart: toDateKey(start),
    rangeEnd: toDateKey(end),
  }
}

const buildNotificationPayload = (occurrence: any) => {
  return JSON.stringify({
    title: "Rappel agenda",
    body: occurrence.task_description,
    url: `/?occurrence=${occurrence.id}`,
    tag: `agenda-occurrence-${occurrence.id}`,
    occurrenceId: occurrence.id,
    taskId: occurrence.task_id,
    apiBaseUrl: agendaApiBaseUrl,
  })
}

/**
 * GET /agenda/month?year=2026&month=7
 *
 * Returns all tasks/occurrences that should appear in a given month.
 */
router.get("/month", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const year = Number(req.query.year)
    const month = Number(req.query.month)

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" })
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ message: "Invalid month" })
    }

    const { monthStart, monthEnd } = getMonthRange(year, month)

    await client.query("BEGIN")

    const tasksResult = await client.query(
      `
      SELECT
        id,
        user_id,
        task_description,
        task_icon,
        start_date::text,
        reminder_time::text,
        recurrence_type,
        recurrence_interval,
        recurrence_end_date::text,
        is_active,
        created_at,
        updated_at
      FROM agenda.agenda_tasks
      WHERE user_id = $1
        AND is_active = true
        AND (
          start_date <= $3::date
          AND (
            recurrence_end_date IS NULL
            OR recurrence_end_date >= $2::date
          )
        )
      ORDER BY start_date ASC, id ASC
      `,
      [userId, monthStart, monthEnd],
    )

    const occurrenceInputs: {
      taskId: number
      occurrenceDate: string
      scheduledFor: string
    }[] = []

    for (const task of tasksResult.rows) {
      const dates = buildOccurrencesForMonth(task, monthStart, monthEnd)

      for (const occurrenceDate of dates) {
        occurrenceInputs.push({
          taskId: task.id,
          occurrenceDate,
          scheduledFor: combineDateAndTime(
            occurrenceDate,
            task.reminder_time,
          ),
        })
      }
    }

    for (const occurrence of occurrenceInputs) {
      await client.query(
        `
        INSERT INTO agenda.agenda_task_occurrences (
          task_id,
          occurrence_date,
          scheduled_for,
          next_reminder_at
        )
        VALUES ($1, $2, $3, $3)
        ON CONFLICT (task_id, occurrence_date)
        DO NOTHING
        `,
        [
          occurrence.taskId,
          occurrence.occurrenceDate,
          occurrence.scheduledFor,
        ],
      )
    }

    const occurrencesResult = await client.query(
      `
      SELECT
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.completed_at,
        ato.dismissed_at,
        ato.snooze_count,
        ato.last_snoozed_at,

        at.task_description,
        at.task_icon,
        at.start_date::text,
        at.reminder_time::text,
        at.recurrence_type,
        at.recurrence_interval,
        at.recurrence_end_date::text
      FROM agenda.agenda_task_occurrences ato
      JOIN agenda.agenda_tasks at
        ON at.id = ato.task_id
      WHERE at.user_id = $1
        AND at.is_active = true
        AND ato.occurrence_date BETWEEN $2::date AND $3::date
      ORDER BY ato.occurrence_date ASC, ato.next_reminder_at ASC, ato.id ASC
      `,
      [userId, monthStart, monthEnd],
    )

    await client.query("COMMIT")

    return res.json({
      tasks: tasksResult.rows,
      occurrences: occurrencesResult.rows,
    })
  } catch (error) {
    await client.query("ROLLBACK")
    console.error("Agenda month fetch failed:", error)

    return res.status(500).json({
      message: "Unable to fetch agenda month",
    })
  } finally {
    client.release()
  }
})

/**
 * POST /agenda/tasks
 *
 * Creates a task.
 */
router.post("/tasks", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const {
      task_description,
      task_icon,
      start_date,
      reminder_time,
      recurrence_type = "none",
      recurrence_interval = 1,
      recurrence_end_date,
    } = req.body

    if (
      typeof task_description !== "string" ||
      task_description.trim().length === 0
    ) {
      return res.status(400).json({
        message: "Task description is required",
      })
    }

    if (!VALID_ICONS.has(task_icon)) {
      return res.status(400).json({
        message: "Invalid task icon",
      })
    }

    if (!isValidDateString(start_date)) {
      return res.status(400).json({
        message: "Invalid start date",
      })
    }

    if (!isValidTimeString(reminder_time)) {
      return res.status(400).json({
        message: "Invalid reminder time",
      })
    }

    if (!VALID_RECURRENCE_TYPES.has(recurrence_type)) {
      return res.status(400).json({
        message: "Invalid recurrence type",
      })
    }

    const parsedInterval = Number(recurrence_interval)

    if (!Number.isInteger(parsedInterval) || parsedInterval < 1) {
      return res.status(400).json({
        message: "Invalid recurrence interval",
      })
    }

    if (
      recurrence_end_date &&
      !isValidDateString(recurrence_end_date)
    ) {
      return res.status(400).json({
        message: "Invalid recurrence end date",
      })
    }

    const result = await client.query(
      `
      INSERT INTO agenda.agenda_tasks (
        user_id,
        task_description,
        task_icon,
        start_date,
        reminder_time,
        recurrence_type,
        recurrence_interval,
        recurrence_end_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        user_id,
        task_description,
        task_icon,
        start_date::text,
        reminder_time::text,
        recurrence_type,
        recurrence_interval,
        recurrence_end_date::text,
        is_active,
        created_at,
        updated_at
      `,
      [
        userId,
        task_description.trim(),
        task_icon,
        start_date,
        reminder_time || null,
        recurrence_type,
        parsedInterval,
        recurrence_end_date || null,
      ],
    )

    return res.status(201).json({
      task: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda task create failed:", error)

    return res.status(500).json({
      message: "Unable to create agenda task",
    })
  } finally {
    client.release()
  }
})

/**
 * PATCH /agenda/tasks/:id
 *
 * Updates the base task definition.
 */
router.patch("/tasks/:id", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Task not found",
      })
    }

    const {
      task_description,
      task_icon,
      start_date,
      reminder_time,
      recurrence_type,
      recurrence_interval,
      recurrence_end_date,
      is_active,
    } = req.body

    if (
      task_description !== undefined &&
      (typeof task_description !== "string" ||
        task_description.trim().length === 0)
    ) {
      return res.status(400).json({
        message: "Invalid task description",
      })
    }

    if (task_icon !== undefined && !VALID_ICONS.has(task_icon)) {
      return res.status(400).json({
        message: "Invalid task icon",
      })
    }

    if (start_date !== undefined && !isValidDateString(start_date)) {
      return res.status(400).json({
        message: "Invalid start date",
      })
    }

    if (
      reminder_time !== undefined &&
      !isValidTimeString(reminder_time)
    ) {
      return res.status(400).json({
        message: "Invalid reminder time",
      })
    }

    if (
      recurrence_type !== undefined &&
      !VALID_RECURRENCE_TYPES.has(recurrence_type)
    ) {
      return res.status(400).json({
        message: "Invalid recurrence type",
      })
    }

    if (recurrence_interval !== undefined) {
      const parsedInterval = Number(recurrence_interval)

      if (!Number.isInteger(parsedInterval) || parsedInterval < 1) {
        return res.status(400).json({
          message: "Invalid recurrence interval",
        })
      }
    }

    if (
      recurrence_end_date !== undefined &&
      recurrence_end_date !== null &&
      recurrence_end_date !== "" &&
      !isValidDateString(recurrence_end_date)
    ) {
      return res.status(400).json({
        message: "Invalid recurrence end date",
      })
    }

    if (
      is_active !== undefined &&
      typeof is_active !== "boolean"
    ) {
      return res.status(400).json({
        message: "Invalid active status",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_tasks
      SET
        task_description = COALESCE($3, task_description),
        task_icon = COALESCE($4, task_icon),
        start_date = COALESCE($5, start_date),
        reminder_time = CASE
          WHEN $6::text = '__KEEP__' THEN reminder_time
          WHEN $6::text = '' THEN NULL
          ELSE $6::time
        END,
        recurrence_type = COALESCE($7, recurrence_type),
        recurrence_interval = COALESCE($8, recurrence_interval),
        recurrence_end_date = CASE
          WHEN $9::text = '__KEEP__' THEN recurrence_end_date
          WHEN $9::text = '' THEN NULL
          ELSE $9::date
        END,
        is_active = COALESCE($10, is_active),
        updated_at = now()
      WHERE id = $1
        AND user_id = $2
      RETURNING
        id,
        user_id,
        task_description,
        task_icon,
        start_date::text,
        reminder_time::text,
        recurrence_type,
        recurrence_interval,
        recurrence_end_date::text,
        is_active,
        created_at,
        updated_at
      `,
      [
        id,
        userId,
        task_description?.trim() ?? null,
        task_icon ?? null,
        start_date ?? null,
        reminder_time === undefined ? "__KEEP__" : reminder_time || "",
        recurrence_type ?? null,
        recurrence_interval ?? null,
        recurrence_end_date === undefined
          ? "__KEEP__"
          : recurrence_end_date || "",
        is_active ?? null,
      ],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Task not found",
      })
    }

    return res.json({
      task: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda task update failed:", error)

    return res.status(500).json({
      message: "Unable to update agenda task",
    })
  } finally {
    client.release()
  }
})

/**
 * DELETE /agenda/tasks/:id
 *
 * Soft deletes a task.
 */
router.delete("/tasks/:id", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Task not found",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_tasks
      SET
        is_active = false,
        updated_at = now()
      WHERE id = $1
        AND user_id = $2
      RETURNING id
      `,
      [id, userId],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Task not found",
      })
    }

    return res.json({
      message: "Task deleted",
    })
  } catch (error) {
    console.error("Agenda task delete failed:", error)

    return res.status(500).json({
      message: "Unable to delete agenda task",
    })
  } finally {
    client.release()
  }
})

/**
 * PATCH /agenda/occurrences/:id/complete
 */
router.patch("/occurrences/:id/complete", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_task_occurrences ato
      SET
        status = 'completed',
        completed_at = now(),
        updated_at = now()
      FROM agenda.agenda_tasks at
      WHERE ato.task_id = at.id
        AND ato.id = $1
        AND at.user_id = $2
      RETURNING
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.completed_at,
        ato.dismissed_at,
        ato.snooze_count,
        ato.last_snoozed_at
      `,
      [id, userId],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    return res.json({
      occurrence: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda occurrence complete failed:", error)

    return res.status(500).json({
      message: "Unable to complete occurrence",
    })
  } finally {
    client.release()
  }
})

/**
 * PATCH /agenda/occurrences/:id/dismiss
 */
router.patch("/occurrences/:id/dismiss", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_task_occurrences ato
      SET
        status = 'dismissed',
        dismissed_at = now(),
        updated_at = now()
      FROM agenda.agenda_tasks at
      WHERE ato.task_id = at.id
        AND ato.id = $1
        AND at.user_id = $2
      RETURNING
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.completed_at,
        ato.dismissed_at,
        ato.snooze_count,
        ato.last_snoozed_at
      `,
      [id, userId],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    return res.json({
      occurrence: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda occurrence dismiss failed:", error)

    return res.status(500).json({
      message: "Unable to dismiss occurrence",
    })
  } finally {
    client.release()
  }
})

/**
 * PATCH /agenda/occurrences/:id/snooze
 *
 * Body:
 * {
 *   "snooze_type": "minutes" | "tomorrow",
 *   "minutes": 5
 * }
 */
router.patch("/occurrences/:id/snooze", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    const { snooze_type, minutes } = req.body

    let intervalExpression = "interval '5 minutes'"

    if (snooze_type === "minutes") {
      const parsedMinutes = Number(minutes)

      if (
        !Number.isInteger(parsedMinutes) ||
        parsedMinutes < 1 ||
        parsedMinutes > 1440
      ) {
        return res.status(400).json({
          message: "Invalid snooze minutes",
        })
      }

      intervalExpression = `make_interval(mins => ${parsedMinutes})`
    } else if (snooze_type === "tomorrow") {
      intervalExpression = "interval '1 day'"
    } else {
      return res.status(400).json({
        message: "Invalid snooze type",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_task_occurrences ato
      SET
        status = 'snoozed',
        next_reminder_at = ato.next_reminder_at + ${intervalExpression},
        snooze_count = ato.snooze_count + 1,
        last_snoozed_at = now(),
        updated_at = now()
      FROM agenda.agenda_tasks at
      WHERE ato.task_id = at.id
        AND ato.id = $1
        AND at.user_id = $2
      RETURNING
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.completed_at,
        ato.dismissed_at,
        ato.snooze_count,
        ato.last_snoozed_at
      `,
      [id, userId],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    return res.json({
      occurrence: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda occurrence snooze failed:", error)

    return res.status(500).json({
      message: "Unable to snooze occurrence",
    })
  } finally {
    client.release()
  }
})

/**
 * PATCH /agenda/occurrences/:id/reschedule
 *
 * Body:
 * {
 *   "next_reminder_at": "2026-07-02T14:30:00-04:00"
 * }
 */
router.patch("/occurrences/:id/reschedule", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    const { next_reminder_at } = req.body

    if (
      typeof next_reminder_at !== "string" ||
      Number.isNaN(new Date(next_reminder_at).getTime())
    ) {
      return res.status(400).json({
        message: "Invalid next reminder date",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_task_occurrences ato
      SET
        status = 'snoozed',
        next_reminder_at = $3,
        snooze_count = ato.snooze_count + 1,
        last_snoozed_at = now(),
        updated_at = now()
      FROM agenda.agenda_tasks at
      WHERE ato.task_id = at.id
        AND ato.id = $1
        AND at.user_id = $2
      RETURNING
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.completed_at,
        ato.dismissed_at,
        ato.snooze_count,
        ato.last_snoozed_at
      `,
      [id, userId, next_reminder_at],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    return res.json({
      occurrence: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda occurrence reschedule failed:", error)

    return res.status(500).json({
      message: "Unable to reschedule occurrence",
    })
  } finally {
    client.release()
  }
})

/**
 * GET /agenda/due
 *
 * Useful later for notification checks.
 */
router.get("/due", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const result = await client.query(
      `
      SELECT
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.snooze_count,
        ato.last_snoozed_at,

        at.task_description,
        at.task_icon,
        at.user_id
      FROM agenda.agenda_task_occurrences ato
      JOIN agenda.agenda_tasks at
        ON at.id = ato.task_id
      WHERE at.user_id = $1
        AND at.is_active = true
        AND ato.status IN ('pending', 'snoozed')
        AND ato.next_reminder_at <= now()
      ORDER BY ato.next_reminder_at ASC
      `,
      [userId],
    )

    return res.json({
      due_occurrences: result.rows,
    })
  } catch (error) {
    console.error("Agenda due occurrences fetch failed:", error)

    return res.status(500).json({
      message: "Unable to fetch due occurrences",
    })
  } finally {
    client.release()
  }
})

/**
 * PATCH /agenda/occurrences/:id/notified
 *
 * Mark an occurrence as notified after the frontend/backend sends a notification.
 */
router.patch("/occurrences/:id/notified", async (req, res) => {
  const client = await pool.connect()

  try {
    const userId = getUserId(req)
    const id = Number(req.params.id)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    const result = await client.query(
      `
      UPDATE agenda.agenda_task_occurrences ato
      SET
        status = 'notified',
        notified_at = now(),
        updated_at = now()
      FROM agenda.agenda_tasks at
      WHERE ato.task_id = at.id
        AND ato.id = $1
        AND at.user_id = $2
      RETURNING
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.completed_at,
        ato.dismissed_at,
        ato.snooze_count,
        ato.last_snoozed_at
      `,
      [id, userId],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Occurrence not found",
      })
    }

    return res.json({
      occurrence: result.rows[0],
    })
  } catch (error) {
    console.error("Agenda occurrence notified update failed:", error)

    return res.status(500).json({
      message: "Unable to update occurrence notification status",
    })
  } finally {
    client.release()
  }
})

/**
 * GET /agenda/notifications/vapid-public-key
 *
 * The frontend needs this key before it can subscribe the device/browser
 * to native Web Push notifications.
 */
router.get("/notifications/vapid-public-key", (_req, res) => {
  return res.json({
    publicKey: vapidPublicKey,
    isConfigured: isPushConfigured,
  })
})

/**
 * POST /agenda/notifications/subscriptions
 *
 * Stores the current browser/device push subscription for the authenticated user.
 */
router.post("/notifications/subscriptions", async (req, res) => {
  const client = await pool.connect()

  try {
    await ensurePushSchema()

    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    if (!isPushConfigured) {
      return res.status(503).json({
        message: "Agenda push notifications are not configured",
      })
    }

    const subscription = req.body?.subscription as PushSubscriptionBody
    const endpoint = subscription?.endpoint
    const p256dh = subscription?.keys?.p256dh
    const auth = subscription?.keys?.auth

    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({
        message: "Invalid push subscription",
      })
    }

    await client.query(
      `
      INSERT INTO agenda.push_subscriptions (
        user_id,
        endpoint,
        p256dh,
        auth,
        user_agent
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        updated_at = now(),
        last_error = NULL
      `,
      [
        userId,
        endpoint,
        p256dh,
        auth,
        req.get("user-agent") || null,
      ],
    )

    return res.status(201).json({
      message: "Push subscription saved",
    })
  } catch (error) {
    console.error("Agenda push subscription save failed:", error)

    return res.status(500).json({
      message: "Unable to save push subscription",
    })
  } finally {
    client.release()
  }
})

/**
 * DELETE /agenda/notifications/subscriptions
 *
 * Removes the current browser/device push subscription for the authenticated user.
 */
router.delete("/notifications/subscriptions", async (req, res) => {
  const client = await pool.connect()

  try {
    await ensurePushSchema()

    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const endpoint = req.body?.endpoint

    if (typeof endpoint !== "string" || endpoint.length === 0) {
      return res.status(400).json({
        message: "Invalid push subscription endpoint",
      })
    }

    await client.query(
      `
      DELETE FROM agenda.push_subscriptions
      WHERE user_id = $1
        AND endpoint = $2
      `,
      [userId, endpoint],
    )

    return res.json({
      message: "Push subscription removed",
    })
  } catch (error) {
    console.error("Agenda push subscription delete failed:", error)

    return res.status(500).json({
      message: "Unable to remove push subscription",
    })
  } finally {
    client.release()
  }
})

export const processDueAgendaNotifications = async () => {
  if (!isPushConfigured) return

  await ensurePushSchema()

  const client = await pool.connect()

  try {
    const { rangeStart, rangeEnd } = getUpcomingOccurrenceRange()

    await client.query("BEGIN")
    await ensureOccurrencesForRange(client, rangeStart, rangeEnd)

    const occurrencesResult = await client.query(
      `
      SELECT
        ato.id,
        ato.task_id,
        ato.occurrence_date::text,
        ato.status,
        ato.scheduled_for,
        ato.next_reminder_at,
        ato.notified_at,
        ato.snooze_count,
        ato.last_snoozed_at,

        at.task_description,
        at.task_icon,
        at.user_id
      FROM agenda.agenda_task_occurrences ato
      JOIN agenda.agenda_tasks at
        ON at.id = ato.task_id
      WHERE at.is_active = true
        AND ato.status IN ('pending', 'snoozed')
        AND ato.next_reminder_at <= now()
      ORDER BY ato.next_reminder_at ASC
      LIMIT 100
      `,
    )

    await client.query("COMMIT")

    for (const occurrence of occurrencesResult.rows) {
      const subscriptionsResult = await pool.query(
        `
        SELECT id, endpoint, p256dh, auth
        FROM agenda.push_subscriptions
        WHERE user_id = $1
        `,
        [occurrence.user_id],
      )

      if (subscriptionsResult.rowCount === 0) {
        continue
      }

      const payload = buildNotificationPayload(occurrence)
      let sentCount = 0

      for (const subscription of subscriptionsResult.rows) {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth,
              },
            },
            payload,
          )

          sentCount += 1

          await pool.query(
            `
            UPDATE agenda.push_subscriptions
            SET
              last_success_at = now(),
              last_error = NULL,
              updated_at = now()
            WHERE id = $1
            `,
            [subscription.id],
          )
        } catch (error: any) {
          const statusCode = Number(error?.statusCode)

          if (statusCode === 404 || statusCode === 410) {
            await pool.query(
              "DELETE FROM agenda.push_subscriptions WHERE id = $1",
              [subscription.id],
            )
          } else {
            await pool.query(
              `
              UPDATE agenda.push_subscriptions
              SET
                last_error = $2,
                updated_at = now()
              WHERE id = $1
              `,
              [subscription.id, error?.message || "Push send failed"],
            )
          }
        }
      }

      if (sentCount > 0) {
        await pool.query(
          `
          UPDATE agenda.agenda_task_occurrences
          SET
            status = 'notified',
            notified_at = now(),
            updated_at = now()
          WHERE id = $1
            AND status IN ('pending', 'snoozed')
          `,
          [occurrence.id],
        )
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    console.error("Agenda due notification processing failed:", error)
  } finally {
    client.release()
  }
}

export const startAgendaNotificationWorker = () => {
  if (notificationWorkerHandle) return

  if (!isPushConfigured) {
    console.warn(
      "Agenda push notifications disabled: missing AGENDA_VAPID_PUBLIC_KEY or AGENDA_VAPID_PRIVATE_KEY",
    )
    return
  }

  processDueAgendaNotifications().catch((error) => {
    console.error("Initial agenda notification processing failed:", error)
  })

  notificationWorkerHandle = setInterval(() => {
    processDueAgendaNotifications().catch((error) => {
      console.error("Agenda notification worker failed:", error)
    })
  }, 60_000)
}

export default router
