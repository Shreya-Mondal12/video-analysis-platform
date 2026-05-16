const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'video_analysis.db');

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS videos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      filename       TEXT NOT NULL,
      original_name  TEXT NOT NULL,
      file_size      INTEGER,
      duration       REAL,
      width          INTEGER,
      height         INTEGER,
      fps            REAL,
      file_path      TEXT NOT NULL,
      thumbnail_path TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS processing_jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id         INTEGER NOT NULL REFERENCES videos(id),
      status           TEXT DEFAULT 'pending',
      total_frames     INTEGER DEFAULT 0,
      processed_frames INTEGER DEFAULT 0,
      error_message    TEXT,
      started_at       TEXT,
      completed_at     TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS frame_predictions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id     INTEGER NOT NULL REFERENCES videos(id),
      timestamp    REAL NOT NULL,
      frame_number INTEGER NOT NULL,
      label        TEXT NOT NULL,
      confidence   REAL,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  saveDb();
}

// ── Query helpers ──────────────────────────────────────────────────────────────

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  // Get last insert rowid
  const result = dbGet('SELECT last_insert_rowid() as id');
  saveDb();
  return result ? result.id : null;
}

module.exports = { getDb, saveDb, dbAll, dbGet, dbRun };
