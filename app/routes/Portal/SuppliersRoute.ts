import { Router } from "express"
import { pool } from "../../db"
import { actionPurchaseRequestLimiter } from "./Utils/purchaseRequestLimiters"


const router = Router()



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


export default router