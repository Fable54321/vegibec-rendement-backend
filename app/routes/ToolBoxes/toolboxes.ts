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