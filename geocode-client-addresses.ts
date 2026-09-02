import { pool } from "./app/db"
import { geocodeAddressDetailed } from "./app/routes/Transports/geocoding.service"

const applyChanges = process.argv.includes("--apply")

function normalizePostalCode(value: string | null): string {
  return (value ?? "").replace(/\s/g, "").toUpperCase()
}

function isHighConfidence(
  address: { postal_code: string | null },
  result: Awaited<ReturnType<typeof geocodeAddressDetailed>>,
): boolean {
  if (!result || result.matchedCountryCode?.toLowerCase() !== "ca") return false

  const expectedPostalCode = normalizePostalCode(address.postal_code)
  const matchedPostalCode = normalizePostalCode(result.matchedPostalCode)
  const exactPostalMatch =
    expectedPostalCode.length >= 6 && expectedPostalCode === matchedPostalCode
  const forwardSortationAreaMatch =
    expectedPostalCode.length >= 3 &&
    matchedPostalCode.length >= 3 &&
    expectedPostalCode.slice(0, 3) === matchedPostalCode.slice(0, 3)
  const preciseStreetMatch =
    ["full-address", "street-city", "street-postal"].includes(
      result.matchStrategy,
    ) && Boolean(result.matchedHouseNumber)

  return preciseStreetMatch && (exactPostalMatch || forwardSortationAreaMatch)
}

async function main() {
  const result = await pool.query(`SELECT id, address, city, postal_code, province, country FROM sales.clients_addresses WHERE latitude IS NULL OR longitude IS NULL ORDER BY id`)
  let updated = 0
  const unresolved: number[] = []
  const review: Array<Record<string, unknown>> = []
  const approved: Array<{ id: number; latitude: number; longitude: number }> = []
  for (const [index, address] of result.rows.entries()) {
    try {
      const coordinates = await geocodeAddressDetailed(address)
      if (!coordinates) unresolved.push(Number(address.id))
      else {
        const highConfidence = isHighConfidence(address, coordinates)
        review.push({
          id: Number(address.id),
          source: [address.address, address.city, address.postal_code, address.province, address.country]
            .filter(Boolean)
            .join(", "),
          matchedAddress: coordinates.displayName,
          matchStrategy: coordinates.matchStrategy,
          matchedPostalCode: coordinates.matchedPostalCode,
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          highConfidence,
        })
        if (highConfidence) {
          approved.push({
            id: Number(address.id),
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
          })
        }
      }
    } catch (error) {
      unresolved.push(Number(address.id))
      console.error(`Address ${address.id}:`, error instanceof Error ? error.message : error)
    }
    console.log(`${index + 1}/${result.rowCount} processed; ${updated} updated; ${unresolved.length} unresolved`)
  }

  if (applyChanges) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      for (const coordinates of approved) {
        const updateResult = await client.query(
          `UPDATE sales.clients_addresses
           SET latitude = $2, longitude = $3
           WHERE id = $1 AND (latitude IS NULL OR longitude IS NULL)`,
          [coordinates.id, coordinates.latitude, coordinates.longitude],
        )
        updated += updateResult.rowCount ?? 0
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
  console.log(JSON.stringify({ mode: applyChanges ? "apply" : "dry-run", attempted: result.rowCount, updated, unresolved, review }, null, 2))
  await pool.end()
}

void main()
