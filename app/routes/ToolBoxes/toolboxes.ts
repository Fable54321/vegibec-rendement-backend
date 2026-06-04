import { Router } from 'express';
import { pool } from '../../db';
import { uploadBufferToS3, getSignedUrlForKey } from '../../services/s3.services';



const router = Router();

// Get all toolboxes
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM toolboxes_inventory.toolboxes');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching toolboxes:', error);
    res.status(500).json({ error: 'Failed to fetch toolboxes' });
  }
});


router.patch('/:toolboxId', async (req, res) => {
  try {
    const toolboxId = Number(req.params.toolboxId);

    const {
      inventory_done,
      verified_at,
      signature_key,
    } = req.body;

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
    }

    await pool.query(
      `
      UPDATE toolboxes_inventory.toolboxes
      SET
        inventory_done = $1,
        verified_at = $2,
        signature_key = $3
      WHERE id = $4
      `,
      [inventory_done, verified_at, signature_key, toolboxId]
    );

    res.status(200).json({
      message: 'Toolbox updated successfully',
    });
  } catch (error) {
    console.error('Error updating toolbox:', error);
    res.status(500).json({
      error: 'Failed to update toolbox',
    });
  }
});

// Get full toolbox inventory by toolbox id
router.get('/:toolboxId/items', async (req, res) => {
  try {
    const toolboxId = Number(req.params.toolboxId);

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
    }

    const result = await pool.query(
      `
      SELECT
        tb.id AS toolbox_id,
        tb.code AS toolbox_code,
        tb.name AS toolbox_name,

        s.id AS section_id,
        s.name AS section_name,
        s.section_type,
        s.position_order AS section_order,

        g.id AS group_id,
        g.name AS group_name,
        g.position_order AS group_order,

        ti.id AS item_id,
        ti.raw_description,
        ti.expected_quantity,
        ti.actual_quantity,
        ti.status,
        ti.status_note,
        ti.position_order AS item_order,
        ti.is_checked,

        tv.id AS tool_variant_id,
        tv.variant_name,
        tv.spanish_description,
        tv.french_description,
        tv.drive_size,
        tv.measurement,
        tv.length_type,
        tv.impact,
        tv.brand,

        t.id AS tool_id,
        t.spanish_name AS tool_spanish_name,
        t.french_name AS tool_french_name

      FROM toolboxes_inventory.toolbox_items ti
      JOIN toolboxes_inventory.toolboxes tb
        ON tb.id = ti.toolbox_id
      JOIN toolboxes_inventory.toolbox_sections s
        ON s.id = ti.section_id
      LEFT JOIN toolboxes_inventory.toolbox_groups g
        ON g.id = ti.group_id
      LEFT JOIN toolboxes_inventory.tool_variants tv
        ON tv.id = ti.tool_variant_id
      LEFT JOIN toolboxes_inventory.tools t
        ON t.id = tv.tool_id

      WHERE ti.toolbox_id = $1
      ORDER BY
        s.position_order,
        g.position_order NULLS FIRST,
        ti.position_order
      `,
      [toolboxId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching toolbox items:', error);
    res.status(500).json({ error: 'Failed to fetch toolbox items' });
  }
});


router.post([
  '/:toolboxId/sections/:sectionId/groups/:groupId/items',
  '/:toolboxId/sections/:sectionId/items',
], async (req, res) => {
  const client = await pool.connect();

  try {
    const toolboxId = Number(req.params.toolboxId);
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
      tool_variant_id,
      raw_description,
      expected_quantity,
      actual_quantity,
      status,
      status_note,
      position_order,
      is_checked,
    } = req.body;

    const toolVariantId =
      tool_variant_id === undefined || tool_variant_id === null
        ? null
        : Number(tool_variant_id);

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

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
    }

    if (!Number.isInteger(sectionId) || sectionId <= 0) {
      return res.status(400).json({ error: 'Invalid section id' });
    }

    if (groupId !== null && (!Number.isInteger(groupId) || groupId <= 0)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }

    if (toolVariantId !== null && (!Number.isInteger(toolVariantId) || toolVariantId <= 0)) {
      return res.status(400).json({ error: 'Invalid tool variant id' });
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

    if (
      toolVariantId === null &&
      (typeof raw_description !== 'string' || raw_description.trim() === '')
    ) {
      return res.status(400).json({
        error: 'tool_variant_id or raw_description is required',
      });
    }

    await client.query('BEGIN');

    const locationResult = await client.query(
      groupId === null
        ? `
        SELECT
          tb.id AS toolbox_id,
          s.id AS section_id,
          NULL::int AS group_id
        FROM toolboxes_inventory.toolboxes tb
        JOIN toolboxes_inventory.toolbox_sections s
          ON s.id = $2
        WHERE tb.id = $1
        `
        : `
        SELECT
          tb.id AS toolbox_id,
          s.id AS section_id,
          g.id AS group_id
        FROM toolboxes_inventory.toolboxes tb
        JOIN toolboxes_inventory.toolbox_sections s
          ON s.id = $2
        JOIN toolboxes_inventory.toolbox_groups g
          ON g.id = $3
         AND g.section_id = s.id
        WHERE tb.id = $1
        `,
      groupId === null ? [toolboxId, sectionId] : [toolboxId, sectionId, groupId]
    );

    if (locationResult.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Toolbox, section, or group not found',
      });
    }

    if (toolVariantId !== null) {
      const toolVariantResult = await client.query(
        `
        SELECT id
        FROM toolboxes_inventory.tool_variants
        WHERE id = $1
        `,
        [toolVariantId]
      );

      if (toolVariantResult.rowCount === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Tool variant not found',
        });
      }
    }

    const nextPositionResult = await client.query(
      `
      SELECT COALESCE(MAX(position_order), 0) + 1 AS next_position_order
      FROM toolboxes_inventory.toolbox_items
      WHERE toolbox_id = $1
        AND section_id = $2
        AND group_id IS NOT DISTINCT FROM $3
      `,
      [toolboxId, sectionId, groupId]
    );

    const itemPositionOrder =
      positionOrder ?? nextPositionResult.rows[0].next_position_order;

    const insertedItemResult = await client.query(
      `
      INSERT INTO toolboxes_inventory.toolbox_items (
        toolbox_id,
        section_id,
        group_id,
        tool_variant_id,
        raw_description,
        expected_quantity,
        actual_quantity,
        status,
        status_note,
        position_order,
        is_checked
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
      `,
      [
        toolboxId,
        sectionId,
        groupId,
        toolVariantId,
        typeof raw_description === 'string' ? raw_description.trim() : null,
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
      message: 'Tool added to toolbox group successfully',
      item: insertedItemResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error adding toolbox item:', error);

    res.status(500).json({
      error: 'Failed to add toolbox item',
    });
  } finally {
    client.release();
  }
});


router.post('/:toolboxId/sections/:sectionId/groups', async (req, res) => {
  const client = await pool.connect();

  try {
    const toolboxId = Number(req.params.toolboxId);
    const sectionId = Number(req.params.sectionId);
    const { name, position_order } = req.body;

    const positionOrder =
      position_order === undefined || position_order === null
        ? null
        : Number(position_order);

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
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
        tb.id AS toolbox_id,
        s.id AS section_id
      FROM toolboxes_inventory.toolboxes tb
      JOIN toolboxes_inventory.toolbox_sections s
        ON s.id = $2
      WHERE tb.id = $1
      `,
      [toolboxId, sectionId]
    );

    if (locationResult.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Toolbox or section not found',
      });
    }

    const nextPositionResult = await client.query(
      `
      SELECT COALESCE(MAX(position_order), 0) + 1 AS next_position_order
      FROM toolboxes_inventory.toolbox_groups
      WHERE section_id = $1
      `,
      [sectionId]
    );

    const groupPositionOrder =
      positionOrder ?? nextPositionResult.rows[0].next_position_order;

    const insertedGroupResult = await client.query(
      `
      INSERT INTO toolboxes_inventory.toolbox_groups (
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
      message: 'Toolbox group added successfully',
      group: insertedGroupResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error adding toolbox group:', error);

    res.status(500).json({
      error: 'Failed to add toolbox group',
    });
  } finally {
    client.release();
  }
});


router.patch('/:toolboxId/items/reorder', async (req, res) => {
  const client = await pool.connect();

  try {
    const toolboxId = Number(req.params.toolboxId);
    const { item_ids } = req.body;

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
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
      FROM toolboxes_inventory.toolbox_items
      WHERE toolbox_id = $1
        AND id = ANY($2::int[])
      `,
      [toolboxId, itemIds]
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
      UPDATE toolboxes_inventory.toolbox_items
      SET position_order = ordered_items.position_order
      FROM unnest($1::int[]) WITH ORDINALITY AS ordered_items(id, position_order)
      WHERE toolbox_items.id = ordered_items.id
        AND toolbox_items.toolbox_id = $2
      `,
      [itemIds, toolboxId]
    );

    await client.query('COMMIT');

    res.status(200).json({ message: 'Items reordered successfully' });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error reordering toolbox items:', error);
    res.status(500).json({ error: 'Failed to reorder toolbox items' });
  } finally {
    client.release();
  }
});


router.patch('/:toolboxId/items/:itemId', async (req, res) => {
  try {
    const toolboxId = Number(req.params.toolboxId);
    const itemId = Number(req.params.itemId);
    const {
      expected_quantity,
      actual_quantity,
      status,
      status_note,
      is_checked,
    } = req.body;

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
    }

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'Invalid item id' });
    }   

    await pool.query(
      `
      UPDATE toolboxes_inventory.toolbox_items
      SET
        expected_quantity = $1,
        actual_quantity = $2,
        status = $3,
        status_note = $4,
        is_checked = $5
      WHERE id = $6
        AND toolbox_id = $7
      `,
      [
        expected_quantity,
        actual_quantity,
        status,
        status_note,
        is_checked,
        itemId,
        toolboxId,
      ]
    );

    res.status(200).json({ message: 'Item updated successfully' });
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});




router.post("/:toolboxId/signature", async (req, res) => {
  try {
    const toolboxId = Number(req.params.toolboxId);
    const { signatureBase64 } = req.body;

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: "Invalid toolbox id" });
    }

    if (!signatureBase64) {
      return res.status(400).json({ error: "Signature is required" });
    }

    const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, "");
    const signatureBuffer = Buffer.from(base64Data, "base64");

    const signatureKey = `toolboxes/${toolboxId}/signatures/${Date.now()}.png`;

    await uploadBufferToS3({
      key: signatureKey,
      buffer: signatureBuffer,
      contentType: "image/png",
    });

    res.status(200).json({
      signature_key: signatureKey,
    });
  } catch (error) {
    console.error("Error uploading toolbox signature:", error);
    res.status(500).json({ error: "Failed to upload signature" });
  }
});

router.get('/:toolboxId/verification', async (req, res) => {
  try {
    const toolboxId = Number(req.params.toolboxId);

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
    }

    const toolboxResult = await pool.query(
      `
      SELECT
        id,
        verified_at,
        signature_key
      FROM toolboxes_inventory.toolboxes
      WHERE id = $1
      `,
      [toolboxId]
    );

    if (toolboxResult.rowCount === 0) {
      return res.status(404).json({ error: 'Toolbox not found' });
    }

    const countsResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_items,

        COUNT(*) FILTER (
          WHERE is_checked = true
        )::int AS checked_items

      FROM toolboxes_inventory.toolbox_items
      WHERE toolbox_id = $1
      `,
      [toolboxId]
    );

    const toolbox = toolboxResult.rows[0];
    const counts = countsResult.rows[0];

    let signature_url: string | null = null;

    if (toolbox.signature_key) {
      signature_url = await getSignedUrlForKey(toolbox.signature_key);
    }

    res.status(200).json({
      toolbox_id: toolbox.id,

      verified_at: toolbox.verified_at,

      signature_key: toolbox.signature_key,

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
    console.error('Error fetching toolbox verification:', error);

    res.status(500).json({
      error: 'Failed to fetch toolbox verification',
    });
  }
});



export default router;

