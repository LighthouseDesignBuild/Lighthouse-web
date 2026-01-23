import db from './database.js';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

export const User = {
  /**
   * Find user by ID
   */
  async findById(id) {
    return (await db.prepare(`
      SELECT id, username, role, must_change_password, created_at, last_login
      FROM users WHERE id = ?
    `)).get(id);
  },

  /**
   * Find user by username
   */
  async findByUsername(username) {
    return (await db.prepare('SELECT * FROM users WHERE username = ?')).get(username);
  },

  /**
   * Get all users (without password hashes)
   */
  async findAll() {
    return (await db.prepare(`
      SELECT id, username, role, must_change_password, created_at, created_by, last_login
      FROM users ORDER BY created_at DESC
    `)).all();
  },

  /**
   * Create new user
   */
  async create({ username, password, role = 'editor', createdBy = null }) {
    // Validate password length
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Hash password
    const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

    try {
      const result = (await db.prepare(`
        INSERT INTO users (username, password_hash, role, created_by, must_change_password)
        VALUES (?, ?, ?, ?, 1)
      `)).run(username, passwordHash, role, createdBy);

      return { id: result.lastInsertRowid, username, role };
    } catch (err) {
      if (err.message.includes('UNIQUE constraint')) {
        throw new Error('Username already exists');
      }
      throw err;
    }
  },

  /**
   * Verify password
   */
  verifyPassword(user, password) {
    return bcrypt.compareSync(password, user.password_hash);
  },

  /**
   * Update password
   */
  async updatePassword(id, newPassword) {
    if (newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);

    (await db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 0
      WHERE id = ?
    `)).run(passwordHash, id);

    return true;
  },

  /**
   * Update user role
   */
  async updateRole(id, role) {
    if (!['admin', 'editor'].includes(role)) {
      throw new Error('Invalid role');
    }

    (await db.prepare('UPDATE users SET role = ? WHERE id = ?')).run(role, id);
    return true;
  },

  /**
   * Update last login timestamp
   */
  async updateLastLogin(id) {
    (await db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?')).run(id);
  },

  /**
   * Delete user (cannot delete self or last admin)
   */
  async delete(id, requestingUserId) {
    // Prevent self-deletion
    if (id === requestingUserId) {
      throw new Error('Cannot delete your own account');
    }

    const user = await this.findById(id);
    if (!user) {
      throw new Error('User not found');
    }

    // Prevent deleting last admin
    if (user.role === 'admin') {
      const adminCount = (await db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?')).get('admin');
      if (adminCount.count <= 1) {
        throw new Error('Cannot delete the last admin user');
      }
    }

    (await db.prepare('DELETE FROM users WHERE id = ?')).run(id);
    return true;
  },

  /**
   * Force password reset for a user
   */
  async forcePasswordReset(id, newPassword) {
    if (newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);

    (await db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 1
      WHERE id = ?
    `)).run(passwordHash, id);

    return true;
  }
};

export default User;
