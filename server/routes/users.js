import { Router } from 'express';
import User from '../models/User.js';
import { isAdmin } from '../middleware/auth.js';

const router = Router();

// All routes require admin access
router.use(isAdmin);

/**
 * GET /api/users
 * List all users
 */
router.get('/', async (req, res) => {
  try {
    const users = await User.findAll();

    res.json({
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        role: u.role,
        createdAt: u.created_at,
        createdBy: u.created_by,
        lastLogin: u.last_login
      }))
    });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to list users'
    });
  }
});

/**
 * POST /api/users
 * Create new user
 */
router.post('/', async (req, res) => {
  try {
    const { username, password, role = 'editor' } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Username and password are required'
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Username must be at least 3 characters'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }

    const user = await User.create({
      username,
      password,
      role,
      createdBy: req.session.userId
    });

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Create user error:', err);

    if (err.message.includes('already exists')) {
      return res.status(409).json({
        error: 'DuplicateError',
        message: 'Username already exists'
      });
    }

    if (err.message.includes('at least 8')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: err.message
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to create user'
    });
  }
});

/**
 * GET /api/users/:id
 * Get single user
 */
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(parseInt(req.params.id));

    if (!user) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'User not found'
      });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.created_at,
        lastLogin: user.last_login
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to get user'
    });
  }
});

/**
 * PUT /api/users/:id
 * Update user (role or reset password)
 */
router.put('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role, newPassword } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'User not found'
      });
    }

    // Update role if provided
    if (role) {
      // Prevent demoting self
      if (userId === req.session.userId && role !== 'admin') {
        return res.status(400).json({
          error: 'ValidationError',
          message: 'Cannot demote your own account'
        });
      }

      await User.updateRole(userId, role);
    }

    // Reset password if provided
    if (newPassword) {
      await User.forcePasswordReset(userId, newPassword);
    }

    const updatedUser = await User.findById(userId);

    res.json({
      success: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role
      },
      passwordReset: !!newPassword
    });
  } catch (err) {
    console.error('Update user error:', err);

    if (err.message.includes('Invalid role')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: err.message
      });
    }

    if (err.message.includes('at least 8')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: err.message
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to update user'
    });
  }
});

/**
 * DELETE /api/users/:id
 * Delete user
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    await User.delete(userId, req.session.userId);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (err) {
    console.error('Delete user error:', err);

    if (err.message.includes('Cannot delete')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: err.message
      });
    }

    if (err.message.includes('not found')) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'User not found'
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to delete user'
    });
  }
});

export default router;
