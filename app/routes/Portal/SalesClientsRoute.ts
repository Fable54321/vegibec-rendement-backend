import { Router } from "express"
import type { PoolClient } from "pg"
import { pool } from "../../db"
import { actionPurchaseRequestLimiter } from "./Utils/purchaseRequestLimiters"

const router = Router()
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null
const validId = (value: unknown) => Number.isInteger(Number(value)) && Number(value) > 0

type AddressPayload = {
  address?: unknown
  city?: unknown
  postal_code?: unknown
  province?: unknown
  country?: unknown
}

const selectClients = `
  SELECT c.id, c.name, c.client_number, c.country, c.representative, c.client_type,
    COALESCE(json_agg(json_build_object(
      'id', a.id, 'client_id', a.client_id, 'address', a.address, 'city', a.city,
      'postal_code', a.postal_code, 'province', a.province, 'country', a.country
    ) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS addresses
  FROM sales.clients c
  LEFT JOIN sales.clients_addresses a ON a.client_id = c.id
`

router.get("/clients", actionPurchaseRequestLimiter, async (_req, res) => {
  try {
    const result = await pool.query(`${selectClients} GROUP BY c.id ORDER BY lower(c.name) ASC`)
    return res.json(result.rows)
  } catch (error) {
    console.error("Error fetching sales clients:", error)
    return res.status(500).json({ message: "Error fetching sales clients" })
  }
})

const saveAddresses = async (db: PoolClient, clientId: number, addresses: AddressPayload[]) => {
  for (const item of addresses) {
    const values = [text(item.address), text(item.city), text(item.postal_code), text(item.province), text(item.country)]
    if (values.every((value) => value === null)) continue
    await db.query(
      `INSERT INTO sales.clients_addresses (client_id, address, city, postal_code, province, country)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [clientId, ...values],
    )
  }
}

router.post("/clients", actionPurchaseRequestLimiter, async (req, res) => {
  const db = await pool.connect()
  try {
    const name = text(req.body.name)
    if (!name) return res.status(400).json({ message: "Client name is required" })
    const addresses = Array.isArray(req.body.addresses) ? req.body.addresses : []
    await db.query("BEGIN")
    const result = await db.query(
      `INSERT INTO sales.clients (name, client_number, country, representative, client_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, text(req.body.client_number), text(req.body.country), text(req.body.representative), text(req.body.client_type)],
    )
    await saveAddresses(db, result.rows[0].id, addresses)
    await db.query("COMMIT")
    const saved = await pool.query(`${selectClients} WHERE c.id = $1 GROUP BY c.id`, [result.rows[0].id])
    return res.status(201).json(saved.rows[0])
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    console.error("Error creating sales client:", error)
    return res.status(500).json({ message: "Error creating sales client" })
  } finally { db.release() }
})

router.put("/clients/:id", actionPurchaseRequestLimiter, async (req, res) => {
  const db = await pool.connect()
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: "Client not found" })
    const id = Number(req.params.id)
    const name = text(req.body.name)
    if (!name) return res.status(400).json({ message: "Client name is required" })
    const addresses = Array.isArray(req.body.addresses) ? req.body.addresses : []
    await db.query("BEGIN")
    const updated = await db.query(
      `UPDATE sales.clients SET name=$2, client_number=$3, country=$4, representative=$5, client_type=$6 WHERE id=$1 RETURNING id`,
      [id, name, text(req.body.client_number), text(req.body.country), text(req.body.representative), text(req.body.client_type)],
    )
    if (!updated.rowCount) { await db.query("ROLLBACK"); return res.status(404).json({ message: "Client not found" }) }
    await db.query("DELETE FROM sales.clients_addresses WHERE client_id = $1", [id])
    await saveAddresses(db, id, addresses)
    await db.query("COMMIT")
    const saved = await pool.query(`${selectClients} WHERE c.id = $1 GROUP BY c.id`, [id])
    return res.json(saved.rows[0])
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    console.error("Error updating sales client:", error)
    return res.status(500).json({ message: "Error updating sales client" })
  } finally { db.release() }
})

export default router
