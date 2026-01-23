import { Router } from 'express';
import User from '../models/User.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/login
 * Login with username and password
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Username and password are required'
      });
    }

    // Find user
    const user = await User.findByUsername(username);
    if (!user) {
      return res.status(401).json({
        error: 'InvalidCredentials',
        message: 'Invalid username or password'
      });
    }

    // Verify password
    if (!User.verifyPassword(user, password)) {
      return res.status(401).json({
        error: 'InvalidCredentials',
        message: 'Invalid username or password'
      });
    }

    // Update last login
    await User.updateLastLogin(user.id);

    // Create session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.userRole = user.role;

    // Explicitly save session before responding to ensure cookie is set
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({
          error: 'ServerError',
          message: 'Failed to create session'
        });
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        }
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'An error occurred during login'
    });
  }
});

/**
 * POST /api/auth/logout
 * End session
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: 'ServerError',
        message: 'Failed to logout'
      });
    }

    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

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
        lastLogin: user.last_login
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to get user info'
    });
  }
});

/**
 * POST /api/auth/change-password
 * Change current user's password
 */
router.post('/change-password', isAuthenticated, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'New password must be at least 8 characters'
      });
    }

    // Get user with password hash
    const user = await User.findByUsername(req.session.username);

    // Verify current password
    if (!User.verifyPassword(user, currentPassword)) {
      return res.status(401).json({
        error: 'InvalidPassword',
        message: 'Current password is incorrect'
      });
    }

    // Update password
    await User.updatePassword(req.session.userId, newPassword);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: err.message || 'Failed to change password'
    });
  }
});

/**
 * GET /api/auth/check
 * Check if session is valid (for frontend)
 */
router.get('/check', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      authenticated: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.userRole
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

export default router;
