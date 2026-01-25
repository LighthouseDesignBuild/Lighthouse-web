import { Router } from 'express';
import { isAdmin } from '../middleware/auth.js';
import {
  backupDatabase,
  restoreDatabase,
  getBackupStatus,
} from '../utils/backup.js';

const router = Router();

/**
 * GET /api/admin/backup/status
 * Get backup status information (admin only)
 */
router.get('/status', isAdmin, async (req, res) => {
  try {
    const status = await getBackupStatus();
    res.json({
      success: true,
      status: {
        enabled: status.enabled,
        backupExists: status.backupExists,
        lastBackup: status.backupMetadata?.backupTimestamp || status.backupMetadata?.lastModified,
        lastBackupSize: status.backupMetadata?.size,
        localDbSize: status.localDbSize,
        localDbModified: status.localDbModified,
      },
    });
  } catch (err) {
    console.error('Backup status error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to get backup status',
    });
  }
});

/**
 * POST /api/admin/backup
 * Create a new backup (admin only)
 */
router.post('/', isAdmin, async (req, res) => {
  try {
    const result = await backupDatabase();

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        timestamp: result.timestamp,
        size: result.size,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
      });
    }
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to create backup',
    });
  }
});

/**
 * POST /api/admin/backup/restore
 * Restore database from backup (admin only)
 */
router.post('/restore', isAdmin, async (req, res) => {
  try {
    const result = await restoreDatabase();

    if (result.success) {
      // Destroy the session after restore since DB may have changed
      req.session.destroy((err) => {
        if (err) {
          console.error('Session destroy error:', err);
        }
      });

      res.json({
        success: true,
        message: result.message,
        restoredSize: result.restoredSize,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
      });
    }
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to restore database',
    });
  }
});

export default router;
