const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const db = require('./db');
const {
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  authMiddleware,
  requireRole,
  accessibleProjectIds,
  canAccessProject,
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 20);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function notFound(res, what) {
  return res.status(404).json({ error: `${what} not found` });
}

// Frontend forms submit structured data (test/HSE details) as a JSON string
// via a hidden input, but callers hitting the API directly may send an
// object. Accept either.
function toJsonText(val) {
  if (val === null || val === undefined || val === '') return null;
  return typeof val === 'string' ? val : JSON.stringify(val);
}

function forbidden(res) {
  return res.status(403).json({ error: 'Forbidden' });
}

const writeRoles = requireRole('Admin', 'Field');

function inClause(ids) {
  if (ids === null) return { sql: '', params: [] };
  if (ids.length === 0) return { sql: 'AND 1 = 0', params: [] };
  return { sql: `AND id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function inClauseCol(ids, column) {
  if (ids === null) return { sql: '', params: [] };
  if (ids.length === 0) return { sql: 'AND 1 = 0', params: [] };
  return { sql: `AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function getProjectIdForBorehole(boreholeId) {
  const b = db.prepare('SELECT project_id FROM boreholes WHERE id = ?').get(boreholeId);
  return b ? b.project_id : null;
}

function getProjectIdForSample(sampleId) {
  const s = db.prepare('SELECT borehole_id FROM samples WHERE id = ?').get(sampleId);
  if (!s) return null;
  return getProjectIdForBorehole(s.borehole_id);
}

function getProjectIdForTest(testId) {
  const t = db.prepare('SELECT borehole_id FROM tests WHERE id = ?').get(testId);
  if (!t) return null;
  return getProjectIdForBorehole(t.borehole_id);
}

// Enforces depth-interval continuity for a borehole's stratigraphy log or
// in-situ test entries: no reversed/zero-length intervals, no overlaps with
// existing entries, and new entries must start exactly where the last one
// ended unless a skip_reason justifies the gap. Returns an error string, or
// null if the interval is valid. `existingRows` must be the other entries
// already recorded for this borehole (excluding the row being edited, if any).
function validateDepthInterval({ depthFrom, depthTo, skipReason, existingRows }) {
  const from = Number(depthFrom);
  const to = Number(depthTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return 'depth_from and depth_to must be numbers';
  }
  if (to <= from) {
    return 'Depth To must be greater than Depth From';
  }
  for (const row of existingRows) {
    if (from < row.depth_to && to > row.depth_from) {
      return `This interval overlaps an existing entry (${row.depth_from}–${row.depth_to} m)`;
    }
  }
  if (existingRows.length > 0) {
    const lastEnd = Math.max(...existingRows.map((r) => r.depth_to));
    if (from > lastEnd && !skipReason) {
      return `There is a gap between the last recorded depth (${lastEnd} m) and this entry's start (${from} m). Provide a reason for the skipped interval to continue.`;
    }
  }
  return null;
}

// Blocking, type-specific checks that must hold regardless of what the
// client-side calculator did. `data` is the parsed sample_data object.
function validateSampleData(sampleType, data) {
  data = data || {};
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  if (sampleType === 'Shelby') {
    const recovered = n(data.recovery_length_mm);
    const penetration = n(data.penetration_length_mm);
    const tubeLength = n(data.tube_length_mm);
    if (recovered !== null && penetration !== null && recovered > penetration) {
      return 'Recovered sample length cannot exceed the penetration length';
    }
    if (recovered !== null && tubeLength !== null && recovered > tubeLength) {
      return 'Recovered sample length cannot exceed the tube length';
    }
  }

  if (sampleType === 'UDS') {
    const recovered = n(data.recovery_length_mm);
    const penetration = n(data.penetration_length_mm);
    if (recovered !== null && penetration !== null && recovered > penetration) {
      return 'Recovered sample length cannot exceed the penetration length';
    }
    if ((data.dispatched_at && !data.receiving_lab) || (!data.dispatched_at && data.receiving_lab)) {
      return 'Chain of custody requires both a dispatch date/time and a receiving laboratory';
    }
  }

  if (sampleType === 'SPT') {
    for (const key of ['seating_blows', 'blows_150_1', 'blows_150_2', 'blows_150_3']) {
      if (data[key] !== undefined && data[key] !== '' && n(data[key]) === null) {
        return `${key.replace(/_/g, ' ')} must be a number`;
      }
      if (n(data[key]) !== null && n(data[key]) < 0) {
        return `${key.replace(/_/g, ' ')} cannot be negative`;
      }
    }
  }

  return null;
}

// ---------- Auth ----------

app.get('/api/auth/status', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const user = getSessionUser(req);
  res.json({ needsSetup: userCount === 0, user });
});

app.post('/api/auth/setup', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount > 0) return res.status(400).json({ error: 'Setup already completed' });
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email.toLowerCase(), hashPassword(password), 'Admin');
  const { token, expires } = createSession(info.lastInsertRowid);
  setSessionCookie(res, token, expires);
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(user);
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const { token, expires } = createSession(row.id);
  setSessionCookie(res, token, expires);
  res.json({ id: row.id, name: row.name, email: row.email, role: row.role });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const cookies = (req.headers.cookie || '').split(';').map((c) => c.trim());
  const sessionCookie = cookies.find((c) => c.startsWith('session='));
  if (sessionCookie) {
    const token = decodeURIComponent(sessionCookie.split('=')[1]);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// All routes below require authentication.
app.use('/api', authMiddleware);

// ---------- Users (Admin only) ----------

app.get('/api/users', requireRole('Admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC').all();
  const access = db.prepare('SELECT user_id, project_id FROM project_access').all();
  const byUser = {};
  access.forEach((a) => {
    byUser[a.user_id] = byUser[a.user_id] || [];
    byUser[a.user_id].push(a.project_id);
  });
  res.json(users.map((u) => ({ ...u, project_ids: byUser[u.id] || [] })));
});

app.post('/api/users', requireRole('Admin'), (req, res) => {
  const { name, email, password, role, project_ids } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password, and role are required' });
  }
  if (!['Admin', 'Field', 'Client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  let info;
  try {
    info = db
      .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email.toLowerCase(), hashPassword(password), role);
  } catch (err) {
    return res.status(400).json({ error: 'A user with that email already exists' });
  }
  if (role === 'Client' && Array.isArray(project_ids)) {
    const stmt = db.prepare('INSERT OR IGNORE INTO project_access (project_id, user_id) VALUES (?, ?)');
    project_ids.forEach((pid) => stmt.run(pid, info.lastInsertRowid));
  }
  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(user);
});

app.put('/api/users/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'User');
  const { name, email, role, password, project_ids } = req.body;
  if (role && !['Admin', 'Field', 'Client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const newPasswordHash = password ? hashPassword(password) : existing.password_hash;
  if (password && password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  db.prepare('UPDATE users SET name = ?, email = ?, role = ?, password_hash = ? WHERE id = ?').run(
    name ?? existing.name,
    (email ?? existing.email).toLowerCase(),
    role ?? existing.role,
    newPasswordHash,
    req.params.id
  );
  if (Array.isArray(project_ids)) {
    db.prepare('DELETE FROM project_access WHERE user_id = ?').run(req.params.id);
    const stmt = db.prepare('INSERT OR IGNORE INTO project_access (project_id, user_id) VALUES (?, ?)');
    project_ids.forEach((pid) => stmt.run(pid, req.params.id));
  }
  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.params.id);
  res.json(user);
});

app.delete('/api/users/:id', requireRole('Admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'User');
  res.status(204).end();
});

// ---------- Dashboard ----------

app.get('/api/stats', (req, res) => {
  const ids = accessibleProjectIds(req.user);
  const pf = inClause(ids);
  const bf = inClauseCol(ids, 'project_id');
  const total_projects = db.prepare(`SELECT COUNT(*) as count FROM projects WHERE 1=1 ${pf.sql}`).get(...pf.params).count;
  const active_projects = db
    .prepare(`SELECT COUNT(*) as count FROM projects WHERE status = 'Active' ${pf.sql}`)
    .get(...pf.params).count;
  const total_boreholes = db
    .prepare(`SELECT COUNT(*) as count FROM boreholes WHERE 1=1 ${bf.sql}`)
    .get(...bf.params).count;
  const boreholes_in_progress = db
    .prepare(`SELECT COUNT(*) as count FROM boreholes WHERE status = 'In Progress' ${bf.sql}`)
    .get(...bf.params).count;
  const boreholes_complete = db
    .prepare(`SELECT COUNT(*) as count FROM boreholes WHERE status = 'Complete' ${bf.sql}`)
    .get(...bf.params).count;
  const boreholes_planned = db
    .prepare(`SELECT COUNT(*) as count FROM boreholes WHERE status = 'Planned' ${bf.sql}`)
    .get(...bf.params).count;
  const sf = inClauseCol(ids, 'b.project_id');
  const total_samples = db
    .prepare(`SELECT COUNT(*) as count FROM samples s JOIN boreholes b ON b.id = s.borehole_id WHERE 1=1 ${sf.sql}`)
    .get(...sf.params).count;
  const samples_pending = db
    .prepare(
      `SELECT COUNT(*) as count FROM samples s JOIN boreholes b ON b.id = s.borehole_id
       WHERE s.lab_status != 'Complete' ${sf.sql}`
    )
    .get(...sf.params).count;
  res.json({
    total_projects,
    active_projects,
    total_boreholes,
    boreholes_in_progress,
    boreholes_complete,
    boreholes_planned,
    total_samples,
    samples_pending,
  });
});

app.get('/api/search', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  if (q === '%%') return res.json({ projects: [], boreholes: [] });
  const ids = accessibleProjectIds(req.user);
  const pf = inClause(ids);
  const bf = inClauseCol(ids, 'projects.id');
  const projects = db
    .prepare(`SELECT id, name, client FROM projects WHERE (name LIKE ? OR client LIKE ?) ${pf.sql} LIMIT 5`)
    .all(q, q, ...pf.params);
  const boreholes = db
    .prepare(
      `SELECT boreholes.id, boreholes.code, projects.id as project_id, projects.name as project_name
       FROM boreholes JOIN projects ON projects.id = boreholes.project_id
       WHERE boreholes.code LIKE ? ${bf.sql} LIMIT 5`
    )
    .all(q, ...bf.params);
  res.json({ projects, boreholes });
});

// ---------- Projects ----------

app.get('/api/projects', (req, res) => {
  const ids = accessibleProjectIds(req.user);
  const pf = inClause(ids);
  const rows = db.prepare(`SELECT * FROM projects WHERE 1=1 ${pf.sql} ORDER BY created_at DESC`).all(...pf.params);
  res.json(rows);
});

app.post('/api/projects', writeRoles, (req, res) => {
  const { name, client, location, start_date, status, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare(
      `INSERT INTO projects (name, client, location, start_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, client || null, location || null, start_date || null, status || 'Active', notes || null);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  if (!canAccessProject(req.user, req.params.id)) return forbidden(res);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return notFound(res, 'Project');
  const boreholeCount = db
    .prepare('SELECT COUNT(*) as count FROM boreholes WHERE project_id = ?')
    .get(req.params.id);
  res.json({ ...project, borehole_count: boreholeCount.count });
});

app.put('/api/projects/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Project');
  const { name, client, location, start_date, status, notes } = req.body;
  db.prepare(
    `UPDATE projects SET name = ?, client = ?, location = ?, start_date = ?, status = ?, notes = ?
     WHERE id = ?`
  ).run(
    name ?? existing.name,
    client ?? null,
    location ?? null,
    start_date ?? null,
    status ?? existing.status,
    notes ?? null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

app.delete('/api/projects/:id', requireRole('Admin'), (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Project');
  res.status(204).end();
});

// ---------- Boreholes ----------

app.get('/api/projects/:projectId/boreholes', (req, res) => {
  if (!canAccessProject(req.user, req.params.projectId)) return forbidden(res);
  const rows = db
    .prepare('SELECT * FROM boreholes WHERE project_id = ? ORDER BY code ASC')
    .all(req.params.projectId);
  res.json(rows);
});

app.post('/api/projects/:projectId/boreholes', writeRoles, (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return notFound(res, 'Project');
  const { code, easting, northing, elevation, total_depth, drill_method, start_date, end_date, status, notes } =
    req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const info = db
    .prepare(
      `INSERT INTO boreholes
        (project_id, code, easting, northing, elevation, total_depth, drill_method, start_date, end_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.projectId,
      code,
      easting ?? null,
      northing ?? null,
      elevation ?? null,
      total_depth ?? null,
      drill_method || null,
      start_date || null,
      end_date || null,
      status || 'Planned',
      notes || null
    );
  const borehole = db.prepare('SELECT * FROM boreholes WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(borehole);
});

app.get('/api/boreholes/:id', (req, res) => {
  const borehole = db.prepare('SELECT * FROM boreholes WHERE id = ?').get(req.params.id);
  if (!borehole) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, borehole.project_id)) return forbidden(res);
  res.json(borehole);
});

app.put('/api/boreholes/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT * FROM boreholes WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Borehole');
  const {
    code,
    easting,
    northing,
    elevation,
    total_depth,
    drill_method,
    start_date,
    end_date,
    status,
    notes,
  } = req.body;
  db.prepare(
    `UPDATE boreholes SET code = ?, easting = ?, northing = ?, elevation = ?, total_depth = ?,
      drill_method = ?, start_date = ?, end_date = ?, status = ?, notes = ?
     WHERE id = ?`
  ).run(
    code ?? existing.code,
    easting ?? null,
    northing ?? null,
    elevation ?? null,
    total_depth ?? null,
    drill_method ?? null,
    start_date ?? null,
    end_date ?? null,
    status ?? existing.status,
    notes ?? null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM boreholes WHERE id = ?').get(req.params.id));
});

app.delete('/api/boreholes/:id', writeRoles, (req, res) => {
  const info = db.prepare('DELETE FROM boreholes WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Borehole');
  res.status(204).end();
});

// ---------- Stratigraphy log entries ----------

app.get('/api/boreholes/:boreholeId/logs', (req, res) => {
  const projectId = getProjectIdForBorehole(req.params.boreholeId);
  if (projectId === null) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, projectId)) return forbidden(res);
  const rows = db
    .prepare('SELECT * FROM log_entries WHERE borehole_id = ? ORDER BY depth_from ASC')
    .all(req.params.boreholeId);
  res.json(rows);
});

app.post('/api/boreholes/:boreholeId/logs', writeRoles, (req, res) => {
  const borehole = db.prepare('SELECT id FROM boreholes WHERE id = ?').get(req.params.boreholeId);
  if (!borehole) return notFound(res, 'Borehole');
  const { depth_from, depth_to, description, uscs_class, notes, skip_reason } = req.body;
  if (depth_from === undefined || depth_to === undefined) {
    return res.status(400).json({ error: 'depth_from and depth_to are required' });
  }
  const existingRows = db
    .prepare('SELECT depth_from, depth_to FROM log_entries WHERE borehole_id = ?')
    .all(req.params.boreholeId);
  const validationError = validateDepthInterval({ depthFrom: depth_from, depthTo: depth_to, skipReason: skip_reason, existingRows });
  if (validationError) return res.status(400).json({ error: validationError });
  const info = db
    .prepare(
      `INSERT INTO log_entries (borehole_id, depth_from, depth_to, description, uscs_class, notes, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.params.boreholeId, depth_from, depth_to, description || null, uscs_class || null, notes || null, skip_reason || null);
  const entry = db.prepare('SELECT * FROM log_entries WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(entry);
});

app.put('/api/logs/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT * FROM log_entries WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Log entry');
  const { depth_from, depth_to, description, uscs_class, notes, skip_reason } = req.body;
  const newFrom = depth_from ?? existing.depth_from;
  const newTo = depth_to ?? existing.depth_to;
  const otherRows = db
    .prepare('SELECT depth_from, depth_to FROM log_entries WHERE borehole_id = ? AND id != ?')
    .all(existing.borehole_id, req.params.id);
  const validationError = validateDepthInterval({
    depthFrom: newFrom,
    depthTo: newTo,
    skipReason: skip_reason ?? existing.skip_reason,
    existingRows: otherRows,
  });
  if (validationError) return res.status(400).json({ error: validationError });
  db.prepare(
    `UPDATE log_entries SET depth_from = ?, depth_to = ?, description = ?, uscs_class = ?, notes = ?, skip_reason = ?
     WHERE id = ?`
  ).run(
    newFrom,
    newTo,
    description ?? null,
    uscs_class ?? null,
    notes ?? null,
    skip_reason ?? null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM log_entries WHERE id = ?').get(req.params.id));
});

app.delete('/api/logs/:id', writeRoles, (req, res) => {
  const info = db.prepare('DELETE FROM log_entries WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Log entry');
  res.status(204).end();
});

// ---------- Samples ----------

function parseSampleRow(row) {
  if (!row) return row;
  let sample_data = null;
  if (row.sample_data) {
    try {
      sample_data = JSON.parse(row.sample_data);
    } catch (_) {
      sample_data = null;
    }
  }
  return { ...row, sample_data };
}

app.get('/api/samples', (req, res) => {
  const ids = accessibleProjectIds(req.user);
  const sf = inClauseCol(ids, 'b.project_id');
  const rows = db
    .prepare(
      `SELECT s.*, b.code as borehole_code, b.project_id as project_id, p.name as project_name
       FROM samples s
       JOIN boreholes b ON b.id = s.borehole_id
       JOIN projects p ON p.id = b.project_id
       WHERE 1=1 ${sf.sql}
       ORDER BY s.id DESC`
    )
    .all(...sf.params);
  res.json(rows.map(parseSampleRow));
});

app.get('/api/boreholes/:boreholeId/samples', (req, res) => {
  const projectId = getProjectIdForBorehole(req.params.boreholeId);
  if (projectId === null) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, projectId)) return forbidden(res);
  const rows = db
    .prepare('SELECT * FROM samples WHERE borehole_id = ? ORDER BY depth_from ASC, id ASC')
    .all(req.params.boreholeId);
  res.json(rows.map(parseSampleRow));
});

app.post('/api/boreholes/:boreholeId/samples', writeRoles, (req, res) => {
  const borehole = db.prepare('SELECT id FROM boreholes WHERE id = ?').get(req.params.boreholeId);
  if (!borehole) return notFound(res, 'Borehole');
  const {
    depth_from,
    depth_to,
    sample_type,
    spt_n_value,
    recovery_pct,
    lab_status,
    notes,
    skip_reason,
    sample_ref,
    date,
    time,
    operator_name,
    supervisor_name,
    groundwater_obs,
    description,
    sample_data,
  } = req.body;
  if (depth_from === undefined || depth_from === null || depth_to === undefined || depth_to === null) {
    return res.status(400).json({ error: 'depth_from and depth_to are required' });
  }
  const existingRows = db
    .prepare('SELECT depth_from, depth_to FROM samples WHERE borehole_id = ?')
    .all(req.params.boreholeId);
  const depthError = validateDepthInterval({ depthFrom: depth_from, depthTo: depth_to, skipReason: skip_reason, existingRows });
  if (depthError) return res.status(400).json({ error: depthError });
  const parsedSampleData = typeof sample_data === 'string' ? JSON.parse(sample_data || '{}') : sample_data || {};
  const dataError = validateSampleData(sample_type, parsedSampleData);
  if (dataError) return res.status(400).json({ error: dataError });
  const approvedAt = supervisor_name ? new Date().toISOString() : null;
  const info = db
    .prepare(
      `INSERT INTO samples
        (borehole_id, depth, depth_from, depth_to, sample_type, spt_n_value, recovery_pct, lab_status, notes,
         skip_reason, sample_ref, date, time, operator_name, supervisor_name, approved_at, groundwater_obs,
         description, sample_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.boreholeId,
      depth_from,
      depth_from,
      depth_to,
      sample_type || null,
      spt_n_value ?? null,
      recovery_pct ?? null,
      lab_status || 'Pending',
      notes || null,
      skip_reason || null,
      sample_ref || null,
      date || null,
      time || null,
      operator_name || null,
      supervisor_name || null,
      approvedAt,
      groundwater_obs || null,
      description || null,
      toJsonText(sample_data)
    );
  const sample = db.prepare('SELECT * FROM samples WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(parseSampleRow(sample));
});

app.put('/api/samples/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT * FROM samples WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Sample');
  const {
    depth_from,
    depth_to,
    sample_type,
    spt_n_value,
    recovery_pct,
    lab_status,
    notes,
    skip_reason,
    sample_ref,
    date,
    time,
    operator_name,
    supervisor_name,
    groundwater_obs,
    description,
    sample_data,
  } = req.body;
  const newFrom = depth_from ?? existing.depth_from;
  const newTo = depth_to ?? existing.depth_to;
  const otherRows = db
    .prepare('SELECT depth_from, depth_to FROM samples WHERE borehole_id = ? AND id != ?')
    .all(existing.borehole_id, req.params.id);
  const depthError = validateDepthInterval({
    depthFrom: newFrom,
    depthTo: newTo,
    skipReason: skip_reason ?? existing.skip_reason,
    existingRows: otherRows,
  });
  if (depthError) return res.status(400).json({ error: depthError });
  const newSampleType = sample_type ?? existing.sample_type;
  const parsedSampleData =
    sample_data !== undefined
      ? typeof sample_data === 'string'
        ? JSON.parse(sample_data || '{}')
        : sample_data || {}
      : JSON.parse(existing.sample_data || '{}');
  const dataError = validateSampleData(newSampleType, parsedSampleData);
  if (dataError) return res.status(400).json({ error: dataError });
  const approvedAt = supervisor_name ? existing.approved_at || new Date().toISOString() : null;
  db.prepare(
    `UPDATE samples SET depth = ?, depth_from = ?, depth_to = ?, sample_type = ?, spt_n_value = ?, recovery_pct = ?,
      lab_status = ?, notes = ?, skip_reason = ?, sample_ref = ?, date = ?, time = ?, operator_name = ?,
      supervisor_name = ?, approved_at = ?, groundwater_obs = ?, description = ?, sample_data = ?
     WHERE id = ?`
  ).run(
    newFrom,
    newFrom,
    newTo,
    newSampleType,
    spt_n_value ?? null,
    recovery_pct ?? null,
    lab_status ?? existing.lab_status,
    notes ?? null,
    skip_reason ?? null,
    sample_ref ?? null,
    date ?? null,
    time ?? null,
    operator_name ?? null,
    supervisor_name ?? null,
    approvedAt,
    groundwater_obs ?? null,
    description ?? null,
    sample_data !== undefined ? toJsonText(sample_data) : existing.sample_data,
    req.params.id
  );
  res.json(parseSampleRow(db.prepare('SELECT * FROM samples WHERE id = ?').get(req.params.id)));
});

app.delete('/api/samples/:id', writeRoles, (req, res) => {
  const info = db.prepare('DELETE FROM samples WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Sample');
  res.status(204).end();
});

// ---------- In-situ tests (Falling Head Test, Packer Testing) ----------

function parseTestRow(row) {
  if (!row) return row;
  let test_data = null;
  if (row.test_data) {
    try {
      test_data = JSON.parse(row.test_data);
    } catch (_) {
      test_data = null;
    }
  }
  return { ...row, test_data };
}

app.get('/api/tests', (req, res) => {
  const ids = accessibleProjectIds(req.user);
  const tf = inClauseCol(ids, 'b.project_id');
  const rows = db
    .prepare(
      `SELECT t.*, b.code as borehole_code, b.project_id as project_id, p.name as project_name
       FROM tests t
       JOIN boreholes b ON b.id = t.borehole_id
       JOIN projects p ON p.id = b.project_id
       WHERE 1=1 ${tf.sql}
       ORDER BY t.id DESC`
    )
    .all(...tf.params);
  res.json(rows.map(parseTestRow));
});

app.get('/api/boreholes/:boreholeId/tests', (req, res) => {
  const projectId = getProjectIdForBorehole(req.params.boreholeId);
  if (projectId === null) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, projectId)) return forbidden(res);
  const rows = db
    .prepare('SELECT * FROM tests WHERE borehole_id = ? ORDER BY depth_from ASC, id ASC')
    .all(req.params.boreholeId);
  res.json(rows.map(parseTestRow));
});

app.post('/api/boreholes/:boreholeId/tests', writeRoles, (req, res) => {
  const borehole = db.prepare('SELECT id FROM boreholes WHERE id = ?').get(req.params.boreholeId);
  if (!borehole) return notFound(res, 'Borehole');
  const {
    test_type,
    date,
    depth_from,
    depth_to,
    result_value,
    result_unit,
    conducted_by,
    notes,
    test_data,
    skip_reason,
    test_ref,
    supervisor_name,
  } = req.body;
  if (depth_from === undefined || depth_from === null || depth_to === undefined || depth_to === null) {
    return res.status(400).json({ error: 'depth_from and depth_to are required' });
  }
  const existingRows = db
    .prepare('SELECT depth_from, depth_to FROM tests WHERE borehole_id = ?')
    .all(req.params.boreholeId);
  const validationError = validateDepthInterval({ depthFrom: depth_from, depthTo: depth_to, skipReason: skip_reason, existingRows });
  if (validationError) return res.status(400).json({ error: validationError });
  const approvedAt = supervisor_name ? new Date().toISOString() : null;
  const info = db
    .prepare(
      `INSERT INTO tests
        (borehole_id, test_type, date, depth_from, depth_to, result_value, result_unit, conducted_by, notes,
         test_data, skip_reason, test_ref, supervisor_name, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.boreholeId,
      test_type || 'Falling Head Test',
      date || null,
      depth_from,
      depth_to,
      result_value ?? null,
      result_unit || null,
      conducted_by || null,
      notes || null,
      toJsonText(test_data),
      skip_reason || null,
      test_ref || null,
      supervisor_name || null,
      approvedAt
    );
  res.status(201).json(parseTestRow(db.prepare('SELECT * FROM tests WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/tests/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Test');
  const {
    test_type,
    date,
    depth_from,
    depth_to,
    result_value,
    result_unit,
    conducted_by,
    notes,
    test_data,
    skip_reason,
    test_ref,
    supervisor_name,
  } = req.body;
  const newFrom = depth_from ?? existing.depth_from;
  const newTo = depth_to ?? existing.depth_to;
  const otherRows = db
    .prepare('SELECT depth_from, depth_to FROM tests WHERE borehole_id = ? AND id != ?')
    .all(existing.borehole_id, req.params.id);
  const validationError = validateDepthInterval({
    depthFrom: newFrom,
    depthTo: newTo,
    skipReason: skip_reason ?? existing.skip_reason,
    existingRows: otherRows,
  });
  if (validationError) return res.status(400).json({ error: validationError });
  const approvedAt = supervisor_name ? existing.approved_at || new Date().toISOString() : null;
  db.prepare(
    `UPDATE tests SET test_type = ?, date = ?, depth_from = ?, depth_to = ?, result_value = ?,
      result_unit = ?, conducted_by = ?, notes = ?, test_data = ?, skip_reason = ?, test_ref = ?,
      supervisor_name = ?, approved_at = ? WHERE id = ?`
  ).run(
    test_type ?? existing.test_type,
    date ?? null,
    newFrom,
    newTo,
    result_value ?? null,
    result_unit ?? null,
    conducted_by ?? null,
    notes ?? null,
    test_data !== undefined ? toJsonText(test_data) : existing.test_data,
    skip_reason ?? null,
    test_ref ?? null,
    supervisor_name ?? null,
    approvedAt,
    req.params.id
  );
  res.json(parseTestRow(db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id)));
});

app.delete('/api/tests/:id', writeRoles, (req, res) => {
  const info = db.prepare('DELETE FROM tests WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Test');
  res.status(204).end();
});

// ---------- HSE register (Admin + Field only) ----------
//
// hse_records is a unified table covering every HSE category listed in the
// module spec (toolbox talks, inspections, JHA/risk assessments, incidents,
// permits, inductions, etc). `category` selects which record "shape" applies;
// category-specific fields live in the `details` JSON blob so new categories
// don't require schema migrations. Shared fields (responsible_person,
// due_date, status, approved_by/approved_at) drive the dashboard analytics
// uniformly across every category, and `related_record_id` lets a corrective
// action reference the incident/inspection that raised it.

function parseHseRow(row) {
  if (!row) return row;
  let details = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details);
    } catch (_) {
      details = null;
    }
  }
  return { ...row, details };
}

app.get('/api/hse', requireRole('Admin', 'Field'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT hse_records.*, projects.name as project_name
       FROM hse_records LEFT JOIN projects ON projects.id = hse_records.project_id
       ORDER BY date DESC, hse_records.id DESC`
    )
    .all();
  res.json(rows.map(parseHseRow));
});

app.get('/api/hse/stats', requireRole('Admin', 'Field'), (req, res) => {
  const count = (sql, ...params) => db.prepare(sql).get(...params).count;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const by_category = db
    .prepare(`SELECT category, COUNT(*) as count FROM hse_records GROUP BY category ORDER BY count DESC`)
    .all();
  const by_severity = db
    .prepare(`SELECT severity, COUNT(*) as count FROM hse_records WHERE status != 'Closed' GROUP BY severity`)
    .all();

  res.json({
    total_open: count(`SELECT COUNT(*) as count FROM hse_records WHERE status != 'Closed'`),
    overdue_actions: count(
      `SELECT COUNT(*) as count FROM hse_records WHERE status != 'Closed' AND due_date IS NOT NULL AND due_date < ?`,
      today
    ),
    high_severity_open: count(
      `SELECT COUNT(*) as count FROM hse_records WHERE status != 'Closed' AND severity IN ('High', 'Critical')`
    ),
    closed_this_month: count(
      `SELECT COUNT(*) as count FROM hse_records WHERE status = 'Closed' AND closed_date >= ?`,
      monthStart
    ),
    total_this_month: count(`SELECT COUNT(*) as count FROM hse_records WHERE date >= ?`, monthStart),
    pending_approval: count(`SELECT COUNT(*) as count FROM hse_records WHERE approved_at IS NULL AND status = 'Closed'`),
    by_category,
    by_severity,
  });
});

// Project-scoped HSE feed used by the client-facing report. Any role with
// access to the project can see it (per client requirement to surface HSE
// records in their report), not just Admin/Field who manage the register.
app.get('/api/projects/:projectId/hse', (req, res) => {
  if (!canAccessProject(req.user, req.params.projectId)) return forbidden(res);
  const rows = db
    .prepare('SELECT * FROM hse_records WHERE project_id = ? ORDER BY date DESC, id DESC')
    .all(req.params.projectId);
  res.json(rows.map(parseHseRow));
});

app.post('/api/hse', requireRole('Admin', 'Field'), (req, res) => {
  const {
    project_id,
    date,
    category,
    type,
    severity,
    description,
    location,
    witnesses,
    immediate_action,
    root_cause,
    corrective_action,
    reported_by,
    status,
    closed_date,
    details,
    responsible_person,
    due_date,
    approved_by,
    related_record_id,
  } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!category) return res.status(400).json({ error: 'category is required' });
  const approvedAt = approved_by ? new Date().toISOString() : null;
  const info = db
    .prepare(
      `INSERT INTO hse_records
        (project_id, date, category, type, severity, description, location, witnesses, immediate_action, root_cause,
         corrective_action, reported_by, status, closed_date, details, responsible_person, due_date, approved_by,
         approved_at, related_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      project_id || null,
      date,
      category,
      type || category,
      severity || 'Low',
      description || null,
      location || null,
      witnesses || null,
      immediate_action || null,
      root_cause || null,
      corrective_action || null,
      reported_by || null,
      status || 'Open',
      closed_date || null,
      toJsonText(details),
      responsible_person || null,
      due_date || null,
      approved_by || null,
      approvedAt,
      related_record_id || null
    );
  res.status(201).json(parseHseRow(db.prepare('SELECT * FROM hse_records WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/hse/:id', requireRole('Admin', 'Field'), (req, res) => {
  const existing = db.prepare('SELECT * FROM hse_records WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'HSE record');
  const {
    project_id,
    date,
    category,
    type,
    severity,
    description,
    location,
    witnesses,
    immediate_action,
    root_cause,
    corrective_action,
    reported_by,
    status,
    closed_date,
    details,
    responsible_person,
    due_date,
    approved_by,
    related_record_id,
  } = req.body;
  // Sign-off is stamped the moment an approver name is first recorded, and
  // stays put on later edits so it reflects when approval actually happened.
  const approvedAt = approved_by ? existing.approved_at || new Date().toISOString() : null;
  db.prepare(
    `UPDATE hse_records SET project_id = ?, date = ?, category = ?, type = ?, severity = ?, description = ?,
      location = ?, witnesses = ?, immediate_action = ?, root_cause = ?, corrective_action = ?,
      reported_by = ?, status = ?, closed_date = ?, details = ?, responsible_person = ?, due_date = ?,
      approved_by = ?, approved_at = ?, related_record_id = ? WHERE id = ?`
  ).run(
    project_id ?? existing.project_id,
    date ?? existing.date,
    category ?? existing.category,
    type ?? existing.type,
    severity ?? existing.severity,
    description ?? null,
    location ?? null,
    witnesses ?? null,
    immediate_action ?? null,
    root_cause ?? null,
    corrective_action ?? null,
    reported_by ?? null,
    status ?? existing.status,
    closed_date ?? null,
    details !== undefined ? toJsonText(details) : existing.details,
    responsible_person ?? null,
    due_date ?? null,
    approved_by ?? null,
    approvedAt,
    related_record_id ?? null,
    req.params.id
  );
  res.json(parseHseRow(db.prepare('SELECT * FROM hse_records WHERE id = ?').get(req.params.id)));
});

app.delete('/api/hse/:id', requireRole('Admin', 'Field'), (req, res) => {
  const info = db.prepare('DELETE FROM hse_records WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'HSE record');
  res.status(204).end();
});

// ---------- Equipment register (Admin + Field only) ----------

app.get('/api/equipment', requireRole('Admin', 'Field'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT equipment.*, projects.name as project_name
       FROM equipment LEFT JOIN projects ON projects.id = equipment.assigned_project_id
       ORDER BY equipment.name ASC`
    )
    .all();
  res.json(rows);
});

app.post('/api/equipment', requireRole('Admin', 'Field'), (req, res) => {
  const { name, type, asset_tag, status, assigned_project_id, last_inspection_date, next_maintenance_date, notes } =
    req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare(
      `INSERT INTO equipment (name, type, asset_tag, status, assigned_project_id, last_inspection_date, next_maintenance_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      type || null,
      asset_tag || null,
      status || 'Available',
      assigned_project_id || null,
      last_inspection_date || null,
      next_maintenance_date || null,
      notes || null
    );
  res.status(201).json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/equipment/:id', requireRole('Admin', 'Field'), (req, res) => {
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Equipment');
  const { name, type, asset_tag, status, assigned_project_id, last_inspection_date, next_maintenance_date, notes } =
    req.body;
  db.prepare(
    `UPDATE equipment SET name = ?, type = ?, asset_tag = ?, status = ?, assigned_project_id = ?,
      last_inspection_date = ?, next_maintenance_date = ?, notes = ? WHERE id = ?`
  ).run(
    name ?? existing.name,
    type ?? null,
    asset_tag ?? null,
    status ?? existing.status,
    assigned_project_id ?? null,
    last_inspection_date ?? null,
    next_maintenance_date ?? null,
    notes ?? null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id));
});

app.delete('/api/equipment/:id', requireRole('Admin', 'Field'), (req, res) => {
  const info = db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Equipment');
  res.status(204).end();
});

// ---------- Timesheets register (Admin + Field only) ----------

app.get('/api/timesheets', requireRole('Admin', 'Field'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT timesheets.*, projects.name as project_name
       FROM timesheets LEFT JOIN projects ON projects.id = timesheets.project_id
       ORDER BY date DESC, timesheets.id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/timesheets', requireRole('Admin', 'Field'), (req, res) => {
  const { person_name, project_id, date, hours, task_description, notes } = req.body;
  if (!person_name || !date || hours === undefined) {
    return res.status(400).json({ error: 'person_name, date, and hours are required' });
  }
  const info = db
    .prepare(
      `INSERT INTO timesheets (person_name, project_id, date, hours, task_description, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(person_name, project_id || null, date, hours, task_description || null, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM timesheets WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/timesheets/:id', requireRole('Admin', 'Field'), (req, res) => {
  const existing = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Timesheet');
  const { person_name, project_id, date, hours, task_description, notes } = req.body;
  db.prepare(
    `UPDATE timesheets SET person_name = ?, project_id = ?, date = ?, hours = ?, task_description = ?, notes = ?
     WHERE id = ?`
  ).run(
    person_name ?? existing.person_name,
    project_id ?? null,
    date ?? existing.date,
    hours ?? existing.hours,
    task_description ?? null,
    notes ?? null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM timesheets WHERE id = ?').get(req.params.id));
});

app.delete('/api/timesheets/:id', requireRole('Admin', 'Field'), (req, res) => {
  const info = db.prepare('DELETE FROM timesheets WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return notFound(res, 'Timesheet');
  res.status(204).end();
});

// ---------- Attachments ----------

const INTERNAL_ENTITY_TYPES = ['hse', 'equipment'];

function resolveProjectIdForEntity(entityType, entityId) {
  if (entityType === 'project') return Number(entityId);
  if (entityType === 'borehole') return getProjectIdForBorehole(entityId);
  if (entityType === 'sample') return getProjectIdForSample(entityId);
  if (entityType === 'test') return getProjectIdForTest(entityId);
  return null;
}

function canAccessAttachmentEntity(user, entityType, entityId) {
  if (INTERNAL_ENTITY_TYPES.includes(entityType)) {
    return user.role === 'Admin' || user.role === 'Field';
  }
  const projectId = resolveProjectIdForEntity(entityType, entityId);
  if (projectId === null) return false;
  return canAccessProject(user, projectId);
}

app.get('/api/attachments', (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id are required' });
  if (!canAccessAttachmentEntity(req.user, entity_type, entity_id)) return forbidden(res);
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_id, original_name, mime_type, size, uploaded_at
       FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY uploaded_at DESC`
    )
    .all(entity_type, entity_id);
  res.json(rows);
});

app.post('/api/attachments', writeRoles, upload.single('file'), (req, res) => {
  const { entity_type, entity_id } = req.body;
  if (!entity_type || !entity_id || !req.file) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'entity_type, entity_id, and file are required' });
  }
  if (!canAccessAttachmentEntity(req.user, entity_type, entity_id)) {
    fs.unlink(req.file.path, () => {});
    return forbidden(res);
  }
  const info = db
    .prepare(
      `INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime_type, size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(entity_type, entity_id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user.id);
  const row = db
    .prepare(
      'SELECT id, entity_type, entity_id, original_name, mime_type, size, uploaded_at FROM attachments WHERE id = ?'
    )
    .get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.get('/api/attachments/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Attachment');
  if (!canAccessAttachmentEntity(req.user, row.entity_type, row.entity_id)) return forbidden(res);
  const filePath = path.join(uploadsDir, row.filename);
  res.download(filePath, row.original_name);
});

app.delete('/api/attachments/:id', writeRoles, (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, 'Attachment');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  fs.unlink(path.join(uploadsDir, row.filename), () => {});
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Drilling management system running at http://localhost:${PORT}`);
});
