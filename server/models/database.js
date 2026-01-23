import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const DB_PATH = path.join(__dirname, '../../data/lighthouse.db');

// Detect serverless environment (Vercel has read-only filesystem)
// Railway and other PaaS platforms will use file persistence
const isServerless = process.env.VERCEL === '1';

// Ensure data directory exists (skip on Vercel - read-only filesystem)
const dataDir = path.dirname(DB_PATH);
if (!isServerless && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Global database instance
let db = null;
let SQL = null;

// Initialize sql.js
async function initDatabase() {
  if (db) return db;

  // Use CDN-hosted WASM only on serverless (can fetch over HTTP)
  // Railway/local use default WASM from node_modules (file system access)
  const sqlConfig = isServerless
    ? { locateFile: file => `https://sql.js.org/dist/${file}` }
    : {};

  SQL = await initSqlJs(sqlConfig);

  // Load existing database or create new one
  // On serverless: always use in-memory database (no file system access)
  if (!isServerless && fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('✓ Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log(isServerless ? '✓ Created in-memory database (serverless)' : '✓ Created new database');
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create tables
  initializeTables();

  // Seed default admin
  seedDefaultAdmin();

  // Save to disk
  saveDatabase();

  return db;
}

// Save database to disk (skip on serverless - read-only filesystem)
function saveDatabase() {
  if (!db || isServerless) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Create tables
function initializeTables() {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'editor',
      must_change_password INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER,
      last_login DATETIME
    )
  `);

  // Gallery items table
  db.run(`
    CREATE TABLE IF NOT EXISTS gallery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      filename TEXT,
      filepath TEXT,
      embed_url TEXT,
      embed_platform TEXT,
      thumbnail TEXT,
      size_class TEXT DEFAULT 'medium',
      display_order INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER
    )
  `);

  // Create index for gallery display order
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gallery_order ON gallery_items(display_order)
  `);

  // Migration: Add Railway Buckets variant columns if they don't exist
  migrateRailwayColumns();
}

/**
 * Add Railway Buckets variant columns to gallery_items table
 * SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS,
 * so we check PRAGMA table_info first
 */
function migrateRailwayColumns() {
  // Check existing columns
  const tableInfo = db.exec('PRAGMA table_info(gallery_items)');
  const existingColumns = tableInfo.length > 0
    ? tableInfo[0].values.map(row => row[1])
    : [];

  console.log('Gallery items existing columns:', existingColumns.join(', '));

  const columnsToAdd = [
    { name: 'key_sm', type: 'TEXT' },
    { name: 'key_md', type: 'TEXT' },
    { name: 'key_lg', type: 'TEXT' },
    { name: 'video_key', type: 'TEXT' },
    { name: 'thumb_key_sm', type: 'TEXT' },
    { name: 'thumb_key_md', type: 'TEXT' },
    { name: 'thumb_key_lg', type: 'TEXT' },
    { name: 'content_hash', type: 'TEXT' },
    { name: 'blur_data', type: 'TEXT' },  // Base64 blur placeholder for instant loading
  ];

  for (const column of columnsToAdd) {
    if (!existingColumns.includes(column.name)) {
      try {
        db.run(`ALTER TABLE gallery_items ADD COLUMN ${column.name} ${column.type}`);
        console.log(`✓ Added column: ${column.name}`);
        saveDatabase(); // Save immediately after adding column
      } catch (err) {
        // Column might already exist, ignore
        console.warn(`Column ${column.name} might already exist:`, err.message);
      }
    } else {
      console.log(`Column ${column.name} already exists`);
    }
  }
}

// Seed default admin user if not exists
function seedDefaultAdmin() {
  const result = db.exec('SELECT id FROM users WHERE username = ?', ['admin']);
  const adminExists = result.length > 0 && result[0].values.length > 0;

  if (!adminExists) {
    const passwordHash = bcrypt.hashSync('lighthouse@2026!', 12);
    db.run(
      `INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)`,
      ['admin', passwordHash]
    );
    saveDatabase();
    console.log('✓ Default admin user created (username: admin, password: lighthouse@2026!)');
  }
}

// Database wrapper with better-sqlite3-like API (lazy initialization)
const dbWrapper = {
  async prepare(sql) {
    if (!db) await initDatabase();
    return {
      run(...params) {
        db.run(sql, params);
        // IMPORTANT: Get last_insert_rowid BEFORE saveDatabase()
        // because db.export() in saveDatabase can reset sql.js internal state
        const lastIdResult = db.exec('SELECT last_insert_rowid()');
        const lastInsertRowid = lastIdResult[0]?.values[0]?.[0];
        saveDatabase();
        // Convert to Number in case sql.js returns BigInt
        return { lastInsertRowid: lastInsertRowid != null ? Number(lastInsertRowid) : 0 };
      },
      get(...params) {
        const result = db.exec(sql, params);
        if (result.length === 0 || result[0].values.length === 0) return null;
        const columns = result[0].columns;
        const values = result[0].values[0];
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
        return row;
      },
      all(...params) {
        const result = db.exec(sql, params);
        if (result.length === 0) return [];
        const columns = result[0].columns;
        return result[0].values.map(values => {
          const row = {};
          columns.forEach((col, i) => { row[col] = values[i]; });
          return row;
        });
      }
    };
  },
  async exec(sql) {
    if (!db) await initDatabase();
    db.run(sql);
    saveDatabase();
  },
  async transaction(fn) {
    if (!db) await initDatabase();
    return (...args) => {
      db.run('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        db.run('COMMIT');
        saveDatabase();
        return result;
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    };
  }
};

// NOTE: Database initialization is now lazy - happens on first database operation
// This prevents sql.js WASM loading when non-database routes are called

export default dbWrapper;
export { DB_PATH, saveDatabase, initDatabase };
