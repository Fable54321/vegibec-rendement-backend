import { Router } from 'express';
import { pool } from '../../db';



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


export default router;