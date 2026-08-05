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

  -- A drilling run is one advance of the drill string: the atomic unit of
  -- production. Samples and in-situ tests are taken *within* a run, so the run
  -- is what ties depth, date, shift, rig, method and operator together — and
  -- what every progress/production analytic is computed from.
  CREATE TABLE IF NOT EXISTS drilling_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borehole_id INTEGER NOT NULL REFERENCES boreholes(id) ON DELETE CASCADE,
    run_number INTEGER,
    depth_from REAL NOT NULL,
    depth_to REAL NOT NULL,
    date TEXT,
    shift TEXT,
    start_time TEXT,
    end_time TEXT,
    drilling_method TEXT,
    rig_name TEXT,
    operator_name TEXT,
    helper_name TEXT,
    bit_type TEXT,
    core_barrel_type TEXT,
    core_recovered_m REAL,
    rqd_pct REAL,
    penetration_rate_m_hr REAL,
    drilling_time_min REAL,
    downtime_min REAL,
    downtime_reason TEXT,
    water_loss_pct REAL,
    groundwater_obs TEXT,
    ground_conditions TEXT,
    refusal_reason TEXT,
    drilling_status TEXT,
    remarks TEXT,
    skip_reason TEXT,
    supervisor_name TEXT,
    approved_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Controlled vocabularies for the geotechnical fields operators would
  -- otherwise retype. Seeded values ship Approved; an operator's "Other"
  -- entry lands as Pending and only joins the standard list once a
  -- supervisor/admin approves it, so the vocabulary stays clean.
  CREATE TABLE IF NOT EXISTS lookup_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    value TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Approved' CHECK (status IN ('Approved', 'Pending', 'Rejected')),
    is_seed INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at TEXT,
    review_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (category, value)
  );

  -- Values the system derives (penetration rate, SPT end depth, RQD class)
  -- are not editable in the ordinary flow. When an authorised user does
  -- override one, the original computed value, the substituted value and the
  -- stated reason are all kept, so a figure that disagrees with its inputs
  -- can always be explained.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    computed_value TEXT,
    override_value TEXT,
    reason TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_boreholes_project ON boreholes(project_id);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_runs_borehole ON drilling_runs(borehole_id);
  CREATE INDEX IF NOT EXISTS idx_runs_date ON drilling_runs(date);
  CREATE INDEX IF NOT EXISTS idx_lookup_category ON lookup_options(category, status);
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

// Samples and tests are captured within a drilling run. run_id is resolved
// from the record's depth interval on write, so operators never pick it by
// hand and the link stays correct if depths are edited.
addColumnIfMissing('samples', 'run_id', 'INTEGER REFERENCES drilling_runs(id) ON DELETE SET NULL');
addColumnIfMissing('tests', 'run_id', 'INTEGER REFERENCES drilling_runs(id) ON DELETE SET NULL');

// Planned targets, so progress analytics can compare planned vs actual
// rather than only reporting what already happened.
addColumnIfMissing('boreholes', 'planned_depth', 'REAL');
addColumnIfMissing('boreholes', 'planned_start_date', 'TEXT');
addColumnIfMissing('boreholes', 'planned_end_date', 'TEXT');

// Actual SPT penetration and why it fell short of the standard 450 mm. The
// hole advances by what was actually achieved, not by the nominal drive.
addColumnIfMissing('samples', 'penetration_achieved_mm', 'REAL');
addColumnIfMissing('samples', 'short_penetration_reason', 'TEXT');

db.exec(`CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tests_run ON tests(run_id)`);

require('./lookups').seed(db);

module.exports = db;
