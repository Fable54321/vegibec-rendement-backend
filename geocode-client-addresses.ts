import { pool } from "./app/db"
import { geocodeAddress } from "./app/routes/Transports/geocoding.service"

async function main() {
  const result = await pool.query(`SELECT id, address, city, postal_code, province, country FROM sales.clients_addresses WHERE latitude IS NULL OR longitude IS NULL ORDER BY id`)
  let updated = 0
  const unresolved: number[] = []
  for (const [index, address] of result.rows.entries()) {
    try {
      const coordinates = await geocodeAddress(address)
      if (!coordinates) unresolved.push(Number(address.id))
      else {
        await pool.query(`UPDATE sales.clients_addresses SET latitude=$2, longitude=$3 WHERE id=$1 AND (latitude IS NULL OR longitude IS NULL)`, [address.id, coordinates.latitude, coordinates.longitude])
        updated += 1
      }
    } catch (error) {
      unresolved.push(Number(address.id))
      console.error(`Address ${address.id}:`, error instanceof Error ? error.message : error)
    }
    console.log(`${index + 1}/${result.rowCount} processed; ${updated} updated; ${unresolved.length} unresolved`)
  }
  console.log(JSON.stringify({ attempted: result.rowCount, updated, unresolved }, null, 2))
  await pool.end()
}

void main()
