import { Router } from 'express';
import { pool } from '../../db';
import { uploadBufferToS3, getSignedUrlForKey } from '../../services/s3.services';

const router = Router();

// Get all vehicles
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vehicles_inventory.vehicles');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching vehicles:', error);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

router.patch('/:vehicleId', async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);

    const {
      inventory_done,
      verified_at,
      signature_key,
    } = req.body;

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    await pool.query(
      `
      UPDATE vehicles_inventory.vehicles
      SET
        inventory_done = $1,
        verified_at = $2,
        signature_key = $3
      WHERE id = $4
      `,
      [inventory_done, verified_at, signature_key, vehicleId]
    );

    res.status(200).json({
      message: 'Vehicle updated successfully',
    });
  } catch (error) {
    console.error('Error updating vehicle:', error);
    res.status(500).json({
      error: 'Failed to update vehicle',
    });
  }
});


router.get('/:vehicleId/pictures', async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        s3_key,
        description,
        equipment_name,
        toolbox_id,
        vehicle_id,
        created_at
      FROM toolboxes_inventory.pictures
      WHERE vehicle_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [vehicleId]
    );

    const pictures = await Promise.all(
      result.rows.map(async (picture) => ({
        ...picture,
        signed_url: await getSignedUrlForKey(picture.s3_key, {
          expiresIn: 60 * 5,
        }),
      }))
    );

    res.status(200).json(pictures);
  } catch (error) {
    console.error('Error fetching vehicle pictures:', error);
    res.status(500).json({
      error: 'Failed to fetch vehicle pictures',
    });
  }
});

// Get full vehicle inventory by vehicle id
router.get('/:vehicleId/items', async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    const result = await pool.query(
      `
      SELECT
        v.id AS vehicle_id,
        v.code AS vehicle_code,
        v.name AS vehicle_name,

        s.id AS section_id,
        s.name AS section_name,
        s.section_type,
        s.position_order AS section_order,

        g.id AS group_id,
        g.name AS group_name,
        g.position_order AS group_order,

        vi.id AS item_id,
        vi.raw_description,
        vi.expected_quantity,
        vi.actual_quantity,
        vi.status,
        vi.status_note,
        vi.position_order AS item_order,
        vi.is_checked

      FROM vehicles_inventory.vehicle_items vi
      JOIN vehicles_inventory.vehicles v
        ON v.id = vi.vehicle_id
      JOIN vehicles_inventory.vehicle_sections s
        ON s.id = vi.section_id
      LEFT JOIN vehicles_inventory.vehicle_groups g
        ON g.id = vi.group_id

      WHERE vi.vehicle_id = $1
      ORDER BY
        s.position_order,
        g.position_order NULLS FIRST,
        vi.position_order
      `,
      [vehicleId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching vehicle items:', error);
    res.status(500).json({ error: 'Failed to fetch vehicle items' });
  }
});

router.post([
  '/:vehicleId/sections/:sectionId/groups/:groupId/items',
  '/:vehicleId/sections/:sectionId/items',
], async (req, res) => {
  const client = await pool.connect();

  try {
    const vehicleId = Number(req.params.vehicleId);
    const sectionId = Number(req.params.sectionId);
    const groupIdParam = req.params.groupId?.trim().toLowerCase();
    const groupId =
      groupIdParam === undefined ||
      groupIdParam === 'null' ||
      groupIdParam === 'none' ||
      groupIdParam === 'undefined'
        ? null
        : Number(req.params.groupId);

    const {
      raw_description,
      expected_quantity,
      actual_quantity,
      status,
      status_note,
      position_order,
      is_checked,
    } = req.body;

    const expectedQuantity =
      expected_quantity === undefined || expected_quantity === null
        ? 1
        : Number(expected_quantity);

    const actualQuantity =
      actual_quantity === undefined || actual_quantity === null
        ? null
        : Number(actual_quantity);

    const positionOrder =
      position_order === undefined || position_order === null
        ? null
        : Number(position_order);

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    if (!Number.isInteger(sectionId) || sectionId <= 0) {
      return res.status(400).json({ error: 'Invalid section id' });
    }

    if (groupId !== null && (!Number.isInteger(groupId) || groupId <= 0)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }

    if (!Number.isFinite(expectedQuantity) || expectedQuantity < 0) {
      return res.status(400).json({ error: 'Invalid expected quantity' });
    }

    if (actualQuantity !== null && (!Number.isFinite(actualQuantity) || actualQuantity < 0)) {
      return res.status(400).json({ error: 'Invalid actual quantity' });
    }

    if (positionOrder !== null && (!Number.isInteger(positionOrder) || positionOrder <= 0)) {
      return res.status(400).json({ error: 'Invalid position order' });
    }

    if (typeof raw_description !== 'string' || raw_description.trim() === '') {
      return res.status(400).json({
        error: 'raw_description is required',
      });
    }

    await client.query('BEGIN');

    const locationResult = await client.query(
      groupId === null
        ? `
        SELECT
          v.id AS vehicle_id,
          s.id AS section_id,
          NULL::int AS group_id
        FROM vehicles_inventory.vehicles v
        JOIN vehicles_inventory.vehicle_sections s
          ON s.id = $2
        WHERE v.id = $1
        `
        : `
        SELECT
          v.id AS vehicle_id,
          s.id AS section_id,
          g.id AS group_id
        FROM vehicles_inventory.vehicles v
        JOIN vehicles_inventory.vehicle_sections s
          ON s.id = $2
        JOIN vehicles_inventory.vehicle_groups g
          ON g.id = $3
         AND g.section_id = s.id
        WHERE v.id = $1
        `,
      groupId === null ? [vehicleId, sectionId] : [vehicleId, sectionId, groupId]
    );

    if (locationResult.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Vehicle, section, or group not found',
      });
    }

    const nextPositionResult = await client.query(
      `
      SELECT COALESCE(MAX(position_order), 0) + 1 AS next_position_order
      FROM vehicles_inventory.vehicle_items
      WHERE vehicle_id = $1
        AND section_id = $2
        AND group_id IS NOT DISTINCT FROM $3
      `,
      [vehicleId, sectionId, groupId]
    );

    const itemPositionOrder =
      positionOrder ?? nextPositionResult.rows[0].next_position_order;

    const insertedItemResult = await client.query(
      `
      INSERT INTO vehicles_inventory.vehicle_items (
        vehicle_id,
        section_id,
        group_id,
        raw_description,
        expected_quantity,
        actual_quantity,
        status,
        status_note,
        position_order,
        is_checked
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        vehicleId,
        sectionId,
        groupId,
        raw_description.trim(),
        expectedQuantity,
        actualQuantity,
        status ?? null,
        status_note ?? null,
        itemPositionOrder,
        is_checked ?? false,
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Item added to vehicle group successfully',
      item: insertedItemResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error adding vehicle item:', error);

    res.status(500).json({
      error: 'Failed to add vehicle item',
    });
  } finally {
    client.release();
  }
});

router.post('/:vehicleId/sections/:sectionId/groups', async (req, res) => {
  const client = await pool.connect();

  try {
    const vehicleId = Number(req.params.vehicleId);
    const sectionId = Number(req.params.sectionId);
    const { name, position_order } = req.body;

    const positionOrder =
      position_order === undefined || position_order === null
        ? null
        : Number(position_order);

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    if (!Number.isInteger(sectionId) || sectionId <= 0) {
      return res.status(400).json({ error: 'Invalid section id' });
    }

    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Group name is required' });
    }

    if (positionOrder !== null && (!Number.isInteger(positionOrder) || positionOrder <= 0)) {
      return res.status(400).json({ error: 'Invalid position order' });
    }

    await client.query('BEGIN');

    const locationResult = await client.query(
      `
      SELECT
        v.id AS vehicle_id,
        s.id AS section_id
      FROM vehicles_inventory.vehicles v
      JOIN vehicles_inventory.vehicle_sections s
        ON s.id = $2
      WHERE v.id = $1
      `,
      [vehicleId, sectionId]
    );

    if (locationResult.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Vehicle or section not found',
      });
    }

    const nextPositionResult = await client.query(
      `
      SELECT COALESCE(MAX(position_order), 0) + 1 AS next_position_order
      FROM vehicles_inventory.vehicle_groups
      WHERE section_id = $1
      `,
      [sectionId]
    );

    const groupPositionOrder =
      positionOrder ?? nextPositionResult.rows[0].next_position_order;

    const insertedGroupResult = await client.query(
      `
      INSERT INTO vehicles_inventory.vehicle_groups (
        section_id,
        name,
        position_order
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [sectionId, name.trim(), groupPositionOrder]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Vehicle group added successfully',
      group: insertedGroupResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error adding vehicle group:', error);

    res.status(500).json({
      error: 'Failed to add vehicle group',
    });
  } finally {
    client.release();
  }
});

router.patch('/:vehicleId/items/reorder', async (req, res) => {
  const client = await pool.connect();

  try {
    const vehicleId = Number(req.params.vehicleId);
    const { item_ids } = req.body;

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ error: 'Item ids are required' });
    }

    const itemIds = item_ids.map(Number);
    const uniqueItemIds = new Set(itemIds);

    if (
      itemIds.some((itemId) => !Number.isInteger(itemId) || itemId <= 0) ||
      uniqueItemIds.size !== itemIds.length
    ) {
      return res.status(400).json({ error: 'Invalid item ids' });
    }

    await client.query('BEGIN');

    const existingItemsResult = await client.query(
      `
      SELECT id, section_id, group_id
      FROM vehicles_inventory.vehicle_items
      WHERE vehicle_id = $1
        AND id = ANY($2::int[])
      `,
      [vehicleId, itemIds]
    );

    if (existingItemsResult.rowCount !== itemIds.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({ error: 'One or more items were not found' });
    }

    const firstItem = existingItemsResult.rows[0];
    const allSameGroup = existingItemsResult.rows.every(
      (item) =>
        item.section_id === firstItem.section_id &&
        item.group_id === firstItem.group_id
    );

    if (!allSameGroup) {
      await client.query('ROLLBACK');

      return res.status(400).json({ error: 'Items must belong to the same group' });
    }

    await client.query(
      `
      UPDATE vehicles_inventory.vehicle_items
      SET position_order = ordered_items.position_order
      FROM unnest($1::int[]) WITH ORDINALITY AS ordered_items(id, position_order)
      WHERE vehicle_items.id = ordered_items.id
        AND vehicle_items.vehicle_id = $2
      `,
      [itemIds, vehicleId]
    );

    await client.query('COMMIT');

    res.status(200).json({ message: 'Items reordered successfully' });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error reordering vehicle items:', error);
    res.status(500).json({ error: 'Failed to reorder vehicle items' });
  } finally {
    client.release();
  }
});

router.patch('/:vehicleId/items/:itemId', async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);
    const itemId = Number(req.params.itemId);
    const {
      expected_quantity,
      actual_quantity,
      status,
      status_note,
      is_checked,
    } = req.body;

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'Invalid item id' });
    }

    await pool.query(
      `
      UPDATE vehicles_inventory.vehicle_items
      SET
        expected_quantity = $1,
        actual_quantity = $2,
        status = $3,
        status_note = $4,
        is_checked = $5
      WHERE id = $6
        AND vehicle_id = $7
      `,
      [
        expected_quantity,
        actual_quantity,
        status,
        status_note,
        is_checked,
        itemId,
        vehicleId,
      ]
    );

    res.status(200).json({ message: 'Item updated successfully' });
  } catch (error) {
    console.error('Error updating vehicle item:', error);
    res.status(500).json({ error: 'Failed to update vehicle item' });
  }
});

router.post('/:vehicleId/signature', async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);
    const { signatureBase64 } = req.body;

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    if (!signatureBase64) {
      return res.status(400).json({ error: 'Signature is required' });
    }

    const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, '');
    const signatureBuffer = Buffer.from(base64Data, 'base64');

    const signatureKey = `vehicles/${vehicleId}/signatures/${Date.now()}.png`;

    await uploadBufferToS3({
      key: signatureKey,
      buffer: signatureBuffer,
      contentType: 'image/png',
    });

    res.status(200).json({
      signature_key: signatureKey,
    });
  } catch (error) {
    console.error('Error uploading vehicle signature:', error);
    res.status(500).json({ error: 'Failed to upload signature' });
  }
});

router.get('/:vehicleId/verification', async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle id' });
    }

    const vehicleResult = await pool.query(
      `
      SELECT
        id,
        verified_at,
        signature_key
      FROM vehicles_inventory.vehicles
      WHERE id = $1
      `,
      [vehicleId]
    );

    if (vehicleResult.rowCount === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    const countsResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_items,

        COUNT(*) FILTER (
          WHERE is_checked = true
        )::int AS checked_items

      FROM vehicles_inventory.vehicle_items
      WHERE vehicle_id = $1
      `,
      [vehicleId]
    );

    const vehicle = vehicleResult.rows[0];
    const counts = countsResult.rows[0];

    let signature_url: string | null = null;

    if (vehicle.signature_key) {
      signature_url = await getSignedUrlForKey(vehicle.signature_key);
    }

    res.status(200).json({
      vehicle_id: vehicle.id,

      verified_at: vehicle.verified_at,

      signature_key: vehicle.signature_key,

      signature_url,

      checked_items: counts.checked_items,
      total_items: counts.total_items,

      completion_percentage:
        counts.total_items > 0
          ? Math.round(
              (counts.checked_items / counts.total_items) * 100
            )
          : 0,
    });
  } catch (error) {
    console.error('Error fetching vehicle verification:', error);

    res.status(500).json({
      error: 'Failed to fetch vehicle verification',
    });
  }
});

export default router;
