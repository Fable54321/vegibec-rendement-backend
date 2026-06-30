import { Router } from "express"
import { pool } from "../../db"
import { actionPurchaseRequestLimiter } from "./Utils/purchaseRequestLimiters"

const router = Router()

const normalizeText = (value: unknown) => {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeBoolean = (value: unknown, fallback = true) => {
  if (typeof value === "boolean") return value
  return fallback
}

const isValidSupplierId = (value: unknown) => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0
}

router.get("/suppliers", actionPurchaseRequestLimiter, async (_req, res) => {
  const client = await pool.connect()

  try {
    const suppliersResult = await client.query(
      `
      SELECT
        id,
        name,
        address_snapshot,
        phone,
        email,
        contact_name,
        city,
        province,
        postal_code,
        country,
        is_active,
        created_at,
        updated_at
      FROM portal.suppliers
      WHERE is_active = true
      ORDER BY lower(name) ASC
      `,
    )

    return res.json(suppliersResult.rows)
  } catch (error) {
    console.error("Error fetching suppliers:", error)

    return res.status(500).json({
      message: "Error fetching suppliers",
    })
  } finally {
    client.release()
  }
})

router.post("/suppliers", actionPurchaseRequestLimiter, async (req, res) => {
  const client = await pool.connect()

  try {
    const name = normalizeText(req.body.name)
    const addressSnapshot = normalizeText(req.body.address_snapshot)
    const phone = normalizeText(req.body.phone)
    const email = normalizeText(req.body.email)
    const contactName = normalizeText(req.body.contact_name)
    const city = normalizeText(req.body.city)
    const province = normalizeText(req.body.province)
    const postalCode = normalizeText(req.body.postal_code)
    const country = normalizeText(req.body.country) ?? "Canada"
    const isActive = normalizeBoolean(req.body.is_active, true)

    if (!name) {
      return res.status(400).json({
        message: "Supplier name is required",
      })
    }

    const supplierResult = await client.query(
      `
      INSERT INTO portal.suppliers (
        name,
        address_snapshot,
        phone,
        email,
        contact_name,
        city,
        province,
        postal_code,
        country,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING
        id,
        name,
        address_snapshot,
        phone,
        email,
        contact_name,
        city,
        province,
        postal_code,
        country,
        is_active,
        created_at,
        updated_at
      `,
      [
        name,
        addressSnapshot,
        phone,
        email,
        contactName,
        city,
        province,
        postalCode,
        country,
        isActive,
      ],
    )

    return res.status(201).json(supplierResult.rows[0])
  } catch (error) {
    console.error("Error creating supplier:", error)

    return res.status(500).json({
      message: "Error creating supplier",
    })
  } finally {
    client.release()
  }
})

router.patch("/suppliers/:id", actionPurchaseRequestLimiter, async (req, res) => {
  const client = await pool.connect()

  try {
    const id = Number(req.params.id)

    if (!isValidSupplierId(id)) {
      return res.status(404).json({
        message: "Supplier not found",
      })
    }

    const name = normalizeText(req.body.name)
    const addressSnapshot = normalizeText(req.body.address_snapshot)
    const phone = normalizeText(req.body.phone)
    const email = normalizeText(req.body.email)
    const contactName = normalizeText(req.body.contact_name)
    const city = normalizeText(req.body.city)
    const province = normalizeText(req.body.province)
    const postalCode = normalizeText(req.body.postal_code)
    const country = normalizeText(req.body.country)
    const isActive =
      typeof req.body.is_active === "boolean" ? req.body.is_active : null

    if ("name" in req.body && !name) {
      return res.status(400).json({
        message: "Supplier name cannot be empty",
      })
    }

    const supplierResult = await client.query(
      `
      UPDATE portal.suppliers
      SET
        name = COALESCE($2, name),
        address_snapshot = COALESCE($3, address_snapshot),
        phone = COALESCE($4, phone),
        email = COALESCE($5, email),
        contact_name = COALESCE($6, contact_name),
        city = COALESCE($7, city),
        province = COALESCE($8, province),
        postal_code = COALESCE($9, postal_code),
        country = COALESCE($10, country),
        is_active = COALESCE($11, is_active),
        updated_at = now()
      WHERE id = $1
      RETURNING
        id,
        name,
        address_snapshot,
        phone,
        email,
        contact_name,
        city,
        province,
        postal_code,
        country,
        is_active,
        created_at,
        updated_at
      `,
      [
        id,
        name,
        addressSnapshot,
        phone,
        email,
        contactName,
        city,
        province,
        postalCode,
        country,
        isActive,
      ],
    )

    if (supplierResult.rowCount === 0) {
      return res.status(404).json({
        message: "Supplier not found",
      })
    }

    return res.json(supplierResult.rows[0])
  } catch (error) {
    console.error("Error updating supplier:", error)

    return res.status(500).json({
      message: "Error updating supplier",
    })
  } finally {
    client.release()
  }
})

router.delete("/suppliers/:id", actionPurchaseRequestLimiter, async (req, res) => {
  const client = await pool.connect()

  try {
    const id = Number(req.params.id)

    if (!isValidSupplierId(id)) {
      return res.status(404).json({
        message: "Supplier not found",
      })
    }

    const supplierResult = await client.query(
      `
      UPDATE portal.suppliers
      SET
        is_active = false,
        updated_at = now()
      WHERE id = $1
      RETURNING
        id,
        name,
        address_snapshot,
        phone,
        email,
        contact_name,
        city,
        province,
        postal_code,
        country,
        is_active,
        created_at,
        updated_at
      `,
      [id],
    )

    if (supplierResult.rowCount === 0) {
      return res.status(404).json({
        message: "Supplier not found",
      })
    }

    return res.json({
      message: "Supplier removed successfully",
      supplier: supplierResult.rows[0],
    })
  } catch (error) {
    console.error("Error removing supplier:", error)

    return res.status(500).json({
      message: "Error removing supplier",
    })
  } finally {
    client.release()
  }
})

export default router