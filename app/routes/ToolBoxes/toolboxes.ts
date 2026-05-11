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


router.patch('/:toolboxId/items/:itemId', async (req, res) => {
  try {
    const toolboxId = Number(req.params.toolboxId);
    const itemId = Number(req.params.itemId);
    const { actual_quantity, status, status_note, is_checked } = req.body;

    if (!Number.isInteger(toolboxId) || toolboxId <= 0) {
      return res.status(400).json({ error: 'Invalid toolbox id' });
    }

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'Invalid item id' });
    }   

    await pool.query(
      `
      UPDATE toolboxes_inventory.toolbox_items
      SET actual_quantity = $1, status = $2, status_note = $3, is_checked = $4
      WHERE id = $5
      `,
      [actual_quantity, status, status_note, is_checked, itemId]
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