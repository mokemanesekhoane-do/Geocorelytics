const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const dbPath = path.join(__dirname, '..', 'data', 'drilling.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client TEXT,
    location TEXT,
    start_date TEXT,
    status TEXT NOT NULL DEFAULT 'Active',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS boreholes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    easting REAL,
    northing REAL,
    elevation REAL,
    total_depth REAL,
    drill_method TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'Planned',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borehole_id INTEGER NOT NULL REFERENCES boreholes(id) ON DELETE CASCADE,
    depth_from REAL NOT NULL,
    depth_to REAL NOT NULL,
    description TEXT,
    uscs_class TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borehole_id INTEGER NOT NULL REFERENCES boreholes(id) ON DELETE CASCADE,
    depth REAL NOT NULL,
    sample_type TEXT,
    spt_n_value INTEGER,
    recovery_pct REAL,
    lab_status TEXT NOT NULL DEFAULT 'Pending',
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Admin', 'Field', 'Client')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hse_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'Observation',
    severity TEXT NOT NULL DEFAULT 'Low',
    description TEXT,
    corrective_action TEXT,
    reported_by TEXT,
    status TEXT NOT NULL DEFAULT 'Open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT,
    asset_tag TEXT,
    status TEXT NOT NULL DEFAULT 'Available',
    assigned_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    last_inspection_date TEXT,
    next_maintenance_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS timesheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_name TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    hours REAL NOT NULL,
    task_description TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borehole_id INTEGER NOT NULL REFERENCES boreholes(id) ON DELETE CASCADE,
    test_type TEXT NOT NULL DEFAULT 'Falling Head Test',
    date TEXT,
    depth_from REAL,
    depth_to REAL,
    result_value REAL,
    result_unit TEXT,
    conducted_by TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_boreholes_project ON boreholes(project_id);
  CREATE INDEX IF NOT EXISTS idx_logs_borehole ON log_entries(borehole_id);
  CREATE INDEX IF NOT EXISTS idx_samples_borehole ON samples(borehole_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_project_access_user ON project_access(user_id);
  CREATE INDEX IF NOT EXISTS idx_project_access_project ON project_access(project_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_hse_project ON hse_records(project_id);
  CREATE INDEX IF NOT EXISTS idx_equipment_project ON equipment(assigned_project_id);
  CREATE INDEX IF NOT EXISTS idx_timesheets_project ON timesheets(project_id);
  CREATE INDEX IF NOT EXISTS idx_tests_borehole ON tests(borehole_id);
`);

function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('hse_records', 'location', 'TEXT');
addColumnIfMissing('hse_records', 'witnesses', 'TEXT');
addColumnIfMissing('hse_records', 'immediate_action', 'TEXT');
addColumnIfMissing('hse_records', 'root_cause', 'TEXT');
addColumnIfMissing('hse_records', 'closed_date', 'TEXT');

// In-situ test type-specific parameters (Falling Head Test, Packer Test, ...)
addColumnIfMissing('tests', 'test_data', 'TEXT');
addColumnIfMissing('tests', 'skip_reason', 'TEXT');

// Depth-continuity gap justification
addColumnIfMissing('log_entries', 'skip_reason', 'TEXT');

// Expanded HSE module: category-driven records with structured per-category
// details, a shared action-tracking lifecycle (responsible person, due date,
// approval sign-off), and optional linkage from a corrective action back to
// the record that raised it.
addColumnIfMissing('hse_records', 'category', 'TEXT');
addColumnIfMissing('hse_records', 'details', 'TEXT');
addColumnIfMissing('hse_records', 'responsible_person', 'TEXT');
addColumnIfMissing('hse_records', 'due_date', 'TEXT');
addColumnIfMissing('hse_records', 'approved_by', 'TEXT');
addColumnIfMissing('hse_records', 'approved_at', 'TEXT');
addColumnIfMissing('hse_records', 'related_record_id', 'INTEGER REFERENCES hse_records(id) ON DELETE SET NULL');

db.exec(`UPDATE hse_records SET category = type WHERE category IS NULL`);
db.exec(
  `UPDATE hse_records SET category = 'Incident/Accident' WHERE category = 'Incident'`
);

// Samples become depth-interval records (like log_entries/tests) so the same
// continuity rules apply, plus a structured `sample_data` JSON blob for the
// fields specific to each sampling/testing method (SPT, Shelby, UDS, ...).
addColumnIfMissing('samples', 'depth_from', 'REAL');
addColumnIfMissing('samples', 'depth_to', 'REAL');
addColumnIfMissing('samples', 'skip_reason', 'TEXT');
addColumnIfMissing('samples', 'sample_ref', 'TEXT');
addColumnIfMissing('samples', 'date', 'TEXT');
addColumnIfMissing('samples', 'time', 'TEXT');
addColumnIfMissing('samples', 'operator_name', 'TEXT');
addColumnIfMissing('samples', 'supervisor_name', 'TEXT');
addColumnIfMissing('samples', 'approved_at', 'TEXT');
addColumnIfMissing('samples', 'groundwater_obs', 'TEXT');
addColumnIfMissing('samples', 'description', 'TEXT');
addColumnIfMissing('samples', 'sample_data', 'TEXT');

db.exec(`UPDATE samples SET depth_from = depth, depth_to = depth WHERE depth_from IS NULL`);

// Falling Head Test / Packer Test workflow additions.
addColumnIfMissing('tests', 'test_ref', 'TEXT');
addColumnIfMissing('tests', 'supervisor_name', 'TEXT');
addColumnIfMissing('tests', 'approved_at', 'TEXT');

module.exports = db;
