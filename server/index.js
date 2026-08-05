const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const db = require('./db');
const analytics = require('./analytics');
const { CATEGORIES: LOOKUP_CATEGORIES } = require('./lookups');
// Same module the browser loads, so a value shown live in the form and the
// value stored here are computed by identical code.
const derive = require('../public/derive');
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

// Lives under data/ so a single persistent volume mount (data/) covers both
// the SQLite database and uploaded files on hosts with ephemeral filesystems.
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
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
function validateDepthInterval({ depthFrom, depthTo, skipReason, existingRows, gapIsDrilled }) {
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
    // Samples and tests are taken at intervals with drilling in between, so a
    // gap only means something is missing if that ground was never drilled.
    // `gapIsDrilled` is supplied for those records; drilling runs pass nothing
    // and keep the strict rule, since a gap between runs is unexplained depth.
    const explained = skipReason || (gapIsDrilled ? gapIsDrilled(lastEnd, from) : false);
    if (from > lastEnd + 1e-9 && !explained) {
      return `There is a gap between the last recorded depth (${lastEnd} m) and this entry's start (${from} m), and that interval has not been drilled. Record the drilling run, or give a reason for the skipped interval.`;
    }
  }
  return null;
}

// An SPT drive that stops short of the standard 450 mm has to say why —
// refusal, obstruction, dense material and so on — because the shortfall is
// itself a ground observation, and the hole only advances by what was
// actually achieved. Also checks the stated penetration agrees with the
// recorded interval, so the two cannot drift apart.
function validatePenetration(sampleType, body, depthFrom, depthTo) {
  if (sampleType !== 'SPT') return null;
  const achieved = Number(body.penetration_achieved_mm);
  if (!Number.isFinite(achieved)) return null;
  if (achieved <= 0) return 'Penetration achieved must be greater than zero';
  if (achieved > derive.SPT_STANDARD_PENETRATION_MM) {
    return `Penetration achieved (${achieved} mm) exceeds the standard SPT drive of ${derive.SPT_STANDARD_PENETRATION_MM} mm`;
  }
  if (achieved < derive.SPT_STANDARD_PENETRATION_MM && !body.short_penetration_reason) {
    return `The drive stopped at ${achieved} mm of the standard ${derive.SPT_STANDARD_PENETRATION_MM} mm. Record why (${derive.SHORT_PENETRATION_REASONS.join(', ')}).`;
  }
  const expectedTo = Number(depthFrom) + achieved / 1000;
  if (Math.abs(Number(depthTo) - expectedTo) > 0.005) {
    return `Depth To (${depthTo} m) does not match ${achieved} mm driven from ${depthFrom} m — expected ${expectedTo.toFixed(3)} m`;
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

// Accounts are provisioned by an Admin via /api/users — there is deliberately
// no public registration endpoint, so the only ways in are the first-run setup
// and an account an administrator created.

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
  const {
    code, easting, northing, elevation, total_depth, drill_method, start_date, end_date, status, notes,
    planned_depth, planned_start_date, planned_end_date,
  } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const info = db
    .prepare(
      `INSERT INTO boreholes
        (project_id, code, easting, northing, elevation, total_depth, drill_method, start_date, end_date, status, notes,
         planned_depth, planned_start_date, planned_end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      notes || null,
      planned_depth ?? null,
      planned_start_date || null,
      planned_end_date || null
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
    code, easting, northing, elevation, total_depth, drill_method, start_date, end_date, status, notes,
    planned_depth, planned_start_date, planned_end_date,
  } = req.body;
  db.prepare(
    `UPDATE boreholes SET code = ?, easting = ?, northing = ?, elevation = ?, total_depth = ?,
      drill_method = ?, start_date = ?, end_date = ?, status = ?, notes = ?,
      planned_depth = ?, planned_start_date = ?, planned_end_date = ?
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
    planned_depth ?? null,
    planned_start_date ?? null,
    planned_end_date ?? null,
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
  const validationError = validateDepthInterval({
    depthFrom: depth_from, depthTo: depth_to, skipReason: skip_reason, existingRows,
    gapIsDrilled: (a, b) => intervalIsCovered(req.params.boreholeId, a, b),
  });
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

// ---------- Drilling runs ----------
//
// The run is the unit of production and the anchor every sample/test hangs
// off. Runs own depth continuity for the hole; samples and tests are then
// validated against the run they fall inside.

// Finds the drilling run a sample or test belongs to.
//
// Resolution order matters. A sampler is driven ahead of the hole bottom, so
// an interval that crosses a run boundary was taken while the *earlier* run
// was in progress — the start depth is what identifies the run, not whichever
// side of the boundary happens to contain more of the interval. Picking by
// largest overlap would assign an SPT at 14.8–15.25 m to the run starting at
// 15 m, which is a run that had not begun when the sample was taken.
function resolveRunForDepth(boreholeId, depthFrom, depthTo) {
  const from = Number(depthFrom);
  const to = Number(depthTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const runs = db.prepare('SELECT id, depth_from, depth_to FROM drilling_runs WHERE borehole_id = ?').all(boreholeId);

  // 1. A run that fully contains the interval — the ordinary case.
  const contains = runs.find((r) => from >= r.depth_from - 1e-9 && to <= r.depth_to + 1e-9);
  if (contains) return contains.id;

  // 2. Straddling a boundary: the run that was being drilled at the start depth.
  const atStart = runs.find((r) => from >= r.depth_from - 1e-9 && from < r.depth_to - 1e-9);
  if (atStart) return atStart.id;

  // 3. Driven from the bottom of the hole. An SPT starts exactly where
  //    drilling stopped and penetrates below it, so it belongs to the run
  //    that got the hole there.
  const deepest = runs.reduce((a, r) => (!a || r.depth_to > a.depth_to ? r : a), null);
  if (deepest && Math.abs(from - deepest.depth_to) < 1e-6) return deepest.id;

  // 3. Last resort — any overlap at all, largest first.
  let best = null;
  let bestOverlap = 0;
  for (const r of runs) {
    const overlap = Math.min(to, r.depth_to) - Math.max(from, r.depth_from);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = r.id;
    }
  }
  return bestOverlap > 0 ? best : null;
}

// Checks that apply to any depth-interval record measured against the hole
// itself: inside the borehole's drilled/planned range, and (for samples and
// tests) covered by a drilling run.
function validateAgainstBorehole(boreholeId, depthFrom, depthTo, { requireRun } = {}) {
  const bh = db.prepare('SELECT total_depth, planned_depth, code FROM boreholes WHERE id = ?').get(boreholeId);
  if (!bh) return 'Borehole not found';
  const from = Number(depthFrom);
  const to = Number(depthTo);
  const limit = bh.total_depth ?? bh.planned_depth ?? null;
  if (limit !== null && to > limit + 1e-9) {
    return `Depth ${to} m is beyond the borehole's recorded depth (${limit} m). Extend the borehole depth first or correct this entry.`;
  }
  if (from < -1e-9) return 'Depth From cannot be negative';
  if (requireRun) {
    const runCount = db.prepare('SELECT COUNT(*) AS c FROM drilling_runs WHERE borehole_id = ?').get(boreholeId).c;
    if (!runCount) {
      return `No drilling run has been recorded for ${bh.code} yet. Capture the drilling run covering ${from}–${to} m before adding this record.`;
    }
    // Two legitimate starting points: inside ground a run has already cut, or
    // exactly at the bottom of the hole, where the sampler is driven ahead of
    // the bit. The bottom includes earlier samples, since those advanced the
    // hole too. Anything else is either below the hole or inside a stretch
    // that was skipped rather than drilled.
    const bottom = holeBottom(boreholeId).depth;
    if (from > bottom + 1e-9) {
      return `The hole has only reached ${bottom} m. Record the drilling run that reaches ${from} m before adding this record.`;
    }
    const atBottom = Math.abs(from - bottom) < 1e-6;
    if (!atBottom && resolveRunForDepth(boreholeId, from, to) === null) {
      return `No drilling run covers ${from} m, and it is not at the bottom of the hole (${bottom} m). Record the drilling run for this interval first.`;
    }
  }
  return null;
}

// True when every metre between `from` and `to` is accounted for by some
// record of the hole being advanced.
//
// Drilling runs and samples both advance the hole: the bit cuts, and a sampler
// driven from the bottom penetrates below it. So the two chains interleave —
// a run legitimately starts where an SPT finished, and a sample legitimately
// starts where a run finished. Judging either chain on its own reports the
// other's advance as a gap, which is why coverage is taken across all three
// record types together.
function intervalIsCovered(boreholeId, from, to) {
  if (to <= from + 1e-9) return true;
  const spans = db
    .prepare(
      `SELECT depth_from, depth_to FROM drilling_runs WHERE borehole_id = ?
       UNION ALL SELECT depth_from, depth_to FROM samples WHERE borehole_id = ?
       UNION ALL SELECT depth_from, depth_to FROM tests WHERE borehole_id = ?
       ORDER BY depth_from ASC`
    )
    .all(boreholeId, boreholeId, boreholeId);
  let covered = from;
  for (const s of spans) {
    if (s.depth_to <= covered + 1e-9) continue;
    if (s.depth_from > covered + 1e-9) break; // an unaccounted-for stretch
    covered = s.depth_to;
    if (covered >= to - 1e-9) return true;
  }
  return covered >= to - 1e-9;
}

// Records an authorised departure from a computed value. The reason is
// mandatory at the call site — an override without one is rejected before it
// reaches here.
function recordOverride(entityType, entityId, field, computedValue, overrideValue, reason, userId) {
  db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, field, computed_value, override_value, reason, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId, field, computedValue === null || computedValue === undefined ? null : String(computedValue),
    overrideValue === null || overrideValue === undefined ? null : String(overrideValue), reason, userId);
}

// Applies the derived fields to a run payload and returns the values to store
// plus any override that needs auditing. The client's penetration_rate is
// ignored unless it is an explicit, justified override.
function deriveRunValues(body) {
  const computedRate = derive.penetrationRate(body.depth_from, body.depth_to, body.drilling_time_min);
  const override = body.penetration_rate_override;
  if (override !== undefined && override !== null && override !== '') {
    if (!body.override_reason) {
      return { error: 'Adjusting the calculated penetration rate requires a reason' };
    }
    return {
      penetration_rate_m_hr: Number(override),
      audit: { field: 'penetration_rate_m_hr', computed: computedRate, value: Number(override), reason: body.override_reason },
    };
  }
  return { penetration_rate_m_hr: computedRate };
}

function validateRunData(body, interval) {
  const cored = Number(body.core_recovered_m);
  if (Number.isFinite(cored)) {
    if (cored < 0) return 'Core recovered cannot be negative';
    if (cored > interval + 1e-6) {
      return `Core recovered (${cored} m) cannot exceed the drilled interval (${interval.toFixed(2)} m)`;
    }
  }
  const rqd = Number(body.rqd_pct);
  if (Number.isFinite(rqd) && (rqd < 0 || rqd > 100)) return 'RQD must be between 0 and 100%';
  const water = Number(body.water_loss_pct);
  if (Number.isFinite(water) && (water < 0 || water > 100)) return 'Water loss must be between 0 and 100%';
  for (const key of ['drilling_time_min', 'downtime_min']) {
    const v = Number(body[key]);
    if (Number.isFinite(v) && v < 0) return `${key.replace(/_/g, ' ')} cannot be negative`;
  }
  return null;
}

// Adds the values the system derives, so every consumer — register, report,
// analytics, the form — sees the same classification without recomputing it.
function parseRunRow(row) {
  if (!row) return row;
  return {
    ...row,
    depth_drilled_m: derive.depthDrilled(row.depth_from, row.depth_to),
    rqd_classification: derive.rqdClassification(row.rqd_pct),
  };
}

const RUN_FIELDS = [
  'run_number', 'depth_from', 'depth_to', 'date', 'shift', 'start_time', 'end_time',
  'drilling_method', 'rig_name', 'operator_name', 'helper_name', 'bit_type', 'core_barrel_type',
  'core_recovered_m', 'rqd_pct', 'penetration_rate_m_hr', 'drilling_time_min', 'downtime_min',
  'downtime_reason', 'water_loss_pct', 'groundwater_obs', 'ground_conditions', 'refusal_reason',
  'drilling_status', 'remarks', 'skip_reason', 'supervisor_name',
];

// The deepest point the hole has actually reached, across drilling runs and
// anything driven below them. Reported with its source so the form can tell
// the operator why the next run starts where it does.
function holeBottom(boreholeId) {
  const run = db.prepare('SELECT MAX(depth_to) AS d FROM drilling_runs WHERE borehole_id = ?').get(boreholeId).d || 0;
  const sample = db.prepare('SELECT MAX(depth_to) AS d FROM samples WHERE borehole_id = ?').get(boreholeId).d || 0;
  const test = db.prepare('SELECT MAX(depth_to) AS d FROM tests WHERE borehole_id = ?').get(boreholeId).d || 0;
  const depth = Math.max(run, sample, test);
  const source = depth === 0 ? 'start of hole' : sample >= run && sample >= test ? 'end of last sample' : test > run ? 'end of last test' : 'end of last drilling run';
  return { depth: Number(depth.toFixed(3)), source, drilled: run };
}

// Relinks every sample/test in a borehole to the run covering it. Called after
// any run is created, edited or deleted so the linkage can never drift.
function relinkBorehole(boreholeId) {
  for (const table of ['samples', 'tests']) {
    const rows = db.prepare(`SELECT id, depth_from, depth_to FROM ${table} WHERE borehole_id = ?`).all(boreholeId);
    const update = db.prepare(`UPDATE ${table} SET run_id = ? WHERE id = ?`);
    for (const row of rows) {
      update.run(resolveRunForDepth(boreholeId, row.depth_from, row.depth_to), row.id);
    }
  }
}

app.get('/api/runs', (req, res) => {
  const ids = accessibleProjectIds(req.user);
  const sf = inClauseCol(ids, 'b.project_id');
  const rows = db
    .prepare(
      `SELECT r.*, b.code AS borehole_code, b.project_id, p.name AS project_name
       FROM drilling_runs r
       JOIN boreholes b ON b.id = r.borehole_id
       JOIN projects p ON p.id = b.project_id
       WHERE 1=1 ${sf.sql}
       ORDER BY r.date DESC, r.id DESC`
    )
    .all(...sf.params);
  res.json(rows.map(parseRunRow));
});

app.get('/api/boreholes/:boreholeId/runs', (req, res) => {
  const projectId = getProjectIdForBorehole(req.params.boreholeId);
  if (projectId === null) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, projectId)) return forbidden(res);
  res.json(
    db.prepare('SELECT * FROM drilling_runs WHERE borehole_id = ? ORDER BY depth_from ASC, id ASC')
      .all(req.params.boreholeId)
      .map(parseRunRow)
  );
});

// Everything the capture form needs to prefill itself: where the hole is at,
// what the last run used, and the next run number.
app.get('/api/boreholes/:boreholeId/next-run', (req, res) => {
  const projectId = getProjectIdForBorehole(req.params.boreholeId);
  if (projectId === null) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, projectId)) return forbidden(res);
  const bh = db.prepare('SELECT * FROM boreholes WHERE id = ?').get(req.params.boreholeId);
  const last = db
    .prepare('SELECT * FROM drilling_runs WHERE borehole_id = ? ORDER BY depth_to DESC, id DESC LIMIT 1')
    .get(req.params.boreholeId);
  const maxRunNo = db
    .prepare('SELECT MAX(run_number) AS n FROM drilling_runs WHERE borehole_id = ?')
    .get(req.params.boreholeId).n;
  // The hole bottom is the deepest point reached by anything — a sampler
  // driven below the last run advanced the hole, so drilling resumes from
  // where the sampler finished, not from where drilling stopped.
  const bottom = holeBottom(req.params.boreholeId);
  res.json({
    run_number: (maxRunNo || 0) + 1,
    depth_from: bottom.depth,
    depth_from_source: bottom.source,
    drilled_to: last ? last.depth_to : 0,
    target_depth: bh.planned_depth ?? bh.total_depth ?? null,
    defaults: {
      drilling_method: last?.drilling_method ?? bh.drill_method ?? null,
      rig_name: last?.rig_name ?? null,
      operator_name: last?.operator_name ?? null,
      helper_name: last?.helper_name ?? null,
      shift: last?.shift ?? null,
      bit_type: last?.bit_type ?? null,
      core_barrel_type: last?.core_barrel_type ?? null,
    },
    last_run: last || null,
  });
});

// Where the next sample/test should start, and which run covers it.
app.get('/api/boreholes/:boreholeId/next-interval', (req, res) => {
  const projectId = getProjectIdForBorehole(req.params.boreholeId);
  if (projectId === null) return notFound(res, 'Borehole');
  if (!canAccessProject(req.user, projectId)) return forbidden(res);
  const runs = db.prepare('SELECT * FROM drilling_runs WHERE borehole_id = ? ORDER BY depth_from ASC').all(req.params.boreholeId);
  const bottom = holeBottom(req.params.boreholeId);

  // A sampler is driven from the bottom of the hole, so the next sample or
  // test starts exactly where the hole currently ends — not where the last
  // sample finished. That is what links the SPT to its drilling run.
  const suggested = bottom.depth;
  const lastRun = runs.reduce((a, r) => (!a || r.depth_to > a.depth_to ? r : a), null);
  const run =
    runs.find((r) => suggested >= r.depth_from - 1e-9 && suggested < r.depth_to - 1e-9) ||
    (lastRun && Math.abs(suggested - lastRun.depth_to) < 1e-6 ? lastRun : null);

  const standard = derive.sptInterval(suggested, derive.SPT_STANDARD_PENETRATION_MM);
  res.json({
    suggested_from: suggested,
    suggested_source: bottom.source,
    drilled_to: bottom.drilled,
    // The standard 450 mm drive, pre-computed so the form does not have to.
    standard_penetration_mm: derive.SPT_STANDARD_PENETRATION_MM,
    suggested_to: standard ? standard.depth_to : null,
    short_penetration_reasons: derive.SHORT_PENETRATION_REASONS,
    run,
    runs,
    defaults: run
      ? { operator_name: run.operator_name, date: run.date, drilling_method: run.drilling_method, rig_name: run.rig_name, shift: run.shift }
      : {},
  });
});

// Audit trail for a record, so a value that disagrees with its inputs can be
// traced to who changed it and why.
app.get('/api/audit/:entityType/:entityId', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS user_name FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC`
    )
    .all(req.params.entityType, req.params.entityId);
  res.json(rows);
});

app.post('/api/boreholes/:boreholeId/runs', writeRoles, (req, res) => {
  const borehole = db.prepare('SELECT id FROM boreholes WHERE id = ?').get(req.params.boreholeId);
  if (!borehole) return notFound(res, 'Borehole');
  const { depth_from, depth_to, skip_reason } = req.body;
  if (depth_from === undefined || depth_from === null || depth_to === undefined || depth_to === null) {
    return res.status(400).json({ error: 'depth_from and depth_to are required' });
  }
  const existingRows = db
    .prepare('SELECT depth_from, depth_to FROM drilling_runs WHERE borehole_id = ?')
    .all(req.params.boreholeId);
  // A run may start where a sampler left off, so coverage is judged across
  // every record that advanced the hole, not just the previous runs.
  const depthError = validateDepthInterval({
    depthFrom: depth_from, depthTo: depth_to, skipReason: skip_reason, existingRows,
    gapIsDrilled: (a, b) => intervalIsCovered(req.params.boreholeId, a, b),
  });
  if (depthError) return res.status(400).json({ error: depthError });
  const rangeError = validateAgainstBorehole(req.params.boreholeId, depth_from, depth_to, { requireRun: false });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const dataError = validateRunData(req.body, Number(depth_to) - Number(depth_from));
  if (dataError) return res.status(400).json({ error: dataError });

  // Penetration rate is computed from depth and active drilling time; a value
  // sent by the client is ignored unless it is a justified override.
  const derived = deriveRunValues(req.body);
  if (derived.error) return res.status(400).json({ error: derived.error });

  const payload = { ...req.body, penetration_rate_m_hr: derived.penetration_rate_m_hr };
  const values = RUN_FIELDS.map((f) => (payload[f] === undefined || payload[f] === '' ? null : payload[f]));
  const info = db
    .prepare(
      `INSERT INTO drilling_runs (borehole_id, ${RUN_FIELDS.join(', ')}, approved_at, created_by)
       VALUES (?, ${RUN_FIELDS.map(() => '?').join(', ')}, ?, ?)`
    )
    .run(req.params.boreholeId, ...values, req.body.supervisor_name ? new Date().toISOString() : null, req.user.id);
  if (derived.audit) {
    recordOverride('run', info.lastInsertRowid, derived.audit.field, derived.audit.computed, derived.audit.value, derived.audit.reason, req.user.id);
  }
  relinkBorehole(req.params.boreholeId);
  res.status(201).json(parseRunRow(db.prepare('SELECT * FROM drilling_runs WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/runs/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT * FROM drilling_runs WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Drilling run');
  const newFrom = req.body.depth_from ?? existing.depth_from;
  const newTo = req.body.depth_to ?? existing.depth_to;
  const otherRows = db
    .prepare('SELECT depth_from, depth_to FROM drilling_runs WHERE borehole_id = ? AND id != ?')
    .all(existing.borehole_id, req.params.id);
  const depthError = validateDepthInterval({
    depthFrom: newFrom,
    depthTo: newTo,
    skipReason: req.body.skip_reason ?? existing.skip_reason,
    existingRows: otherRows,
    gapIsDrilled: (a, b) => intervalIsCovered(existing.borehole_id, a, b),
  });
  if (depthError) return res.status(400).json({ error: depthError });
  const rangeError = validateAgainstBorehole(existing.borehole_id, newFrom, newTo, { requireRun: false });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const dataError = validateRunData({ ...existing, ...req.body }, Number(newTo) - Number(newFrom));
  if (dataError) return res.status(400).json({ error: dataError });

  const merged = { ...existing, ...req.body, depth_from: newFrom, depth_to: newTo };
  const derived = deriveRunValues(merged);
  if (derived.error) return res.status(400).json({ error: derived.error });
  const payload = { ...req.body, penetration_rate_m_hr: derived.penetration_rate_m_hr };

  const values = RUN_FIELDS.map((f) =>
    f === 'penetration_rate_m_hr' ? payload[f] : payload[f] === undefined ? existing[f] : payload[f] === '' ? null : payload[f]
  );
  const supervisor = req.body.supervisor_name ?? existing.supervisor_name;
  db.prepare(
    `UPDATE drilling_runs SET ${RUN_FIELDS.map((f) => `${f} = ?`).join(', ')}, approved_at = ? WHERE id = ?`
  ).run(...values, supervisor ? existing.approved_at || new Date().toISOString() : null, req.params.id);
  if (derived.audit) {
    recordOverride('run', req.params.id, derived.audit.field, derived.audit.computed, derived.audit.value, derived.audit.reason, req.user.id);
  }
  relinkBorehole(existing.borehole_id);
  res.json(parseRunRow(db.prepare('SELECT * FROM drilling_runs WHERE id = ?').get(req.params.id)));
});

app.delete('/api/runs/:id', writeRoles, (req, res) => {
  const existing = db.prepare('SELECT borehole_id FROM drilling_runs WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Drilling run');
  db.prepare('DELETE FROM drilling_runs WHERE id = ?').run(req.params.id);
  relinkBorehole(existing.borehole_id);
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
  const depthError = validateDepthInterval({
    depthFrom: depth_from,
    depthTo: depth_to,
    skipReason: skip_reason,
    existingRows,
    gapIsDrilled: (a, b) => intervalIsCovered(req.params.boreholeId, a, b),
  });
  if (depthError) return res.status(400).json({ error: depthError });
  const rangeError = validateAgainstBorehole(req.params.boreholeId, depth_from, depth_to, { requireRun: true });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const parsedSampleData = typeof sample_data === 'string' ? JSON.parse(sample_data || '{}') : sample_data || {};
  const dataError = validateSampleData(sample_type, parsedSampleData);
  if (dataError) return res.status(400).json({ error: dataError });
  const penError = validatePenetration(sample_type, req.body, depth_from, depth_to);
  if (penError) return res.status(400).json({ error: penError });
  const runId = resolveRunForDepth(req.params.boreholeId, depth_from, depth_to);
  const approvedAt = supervisor_name ? new Date().toISOString() : null;
  const info = db
    .prepare(
      `INSERT INTO samples
        (borehole_id, depth, depth_from, depth_to, sample_type, spt_n_value, recovery_pct, lab_status, notes,
         skip_reason, sample_ref, date, time, operator_name, supervisor_name, approved_at, groundwater_obs,
         description, sample_data, run_id, penetration_achieved_mm, short_penetration_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      toJsonText(sample_data),
      runId,
      req.body.penetration_achieved_mm ?? null,
      req.body.short_penetration_reason || null
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
    gapIsDrilled: (a, b) => intervalIsCovered(existing.borehole_id, a, b),
  });
  if (depthError) return res.status(400).json({ error: depthError });
  const rangeError = validateAgainstBorehole(existing.borehole_id, newFrom, newTo, { requireRun: true });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const newSampleType = sample_type ?? existing.sample_type;
  const penError = validatePenetration(newSampleType, { ...existing, ...req.body }, newFrom, newTo);
  if (penError) return res.status(400).json({ error: penError });
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
      supervisor_name = ?, approved_at = ?, groundwater_obs = ?, description = ?, sample_data = ?, run_id = ?,
      penetration_achieved_mm = ?, short_penetration_reason = ?
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
    resolveRunForDepth(existing.borehole_id, newFrom, newTo),
    req.body.penetration_achieved_mm ?? existing.penetration_achieved_mm ?? null,
    req.body.short_penetration_reason ?? existing.short_penetration_reason ?? null,
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
  const validationError = validateDepthInterval({
    depthFrom: depth_from, depthTo: depth_to, skipReason: skip_reason, existingRows,
    gapIsDrilled: (a, b) => intervalIsCovered(req.params.boreholeId, a, b),
  });
  if (validationError) return res.status(400).json({ error: validationError });
  const rangeError = validateAgainstBorehole(req.params.boreholeId, depth_from, depth_to, { requireRun: true });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const approvedAt = supervisor_name ? new Date().toISOString() : null;
  const info = db
    .prepare(
      `INSERT INTO tests
        (borehole_id, test_type, date, depth_from, depth_to, result_value, result_unit, conducted_by, notes,
         test_data, skip_reason, test_ref, supervisor_name, approved_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      approvedAt,
      resolveRunForDepth(req.params.boreholeId, depth_from, depth_to)
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
    gapIsDrilled: (a, b) => intervalIsCovered(existing.borehole_id, a, b),
  });
  if (validationError) return res.status(400).json({ error: validationError });
  const rangeError = validateAgainstBorehole(existing.borehole_id, newFrom, newTo, { requireRun: true });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const approvedAt = supervisor_name ? existing.approved_at || new Date().toISOString() : null;
  db.prepare(
    `UPDATE tests SET test_type = ?, date = ?, depth_from = ?, depth_to = ?, result_value = ?,
      result_unit = ?, conducted_by = ?, notes = ?, test_data = ?, skip_reason = ?, test_ref = ?,
      supervisor_name = ?, approved_at = ?, run_id = ? WHERE id = ?`
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
    resolveRunForDepth(existing.borehole_id, newFrom, newTo),
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

// ---------- Controlled vocabularies ----------
//
// Approved values are what operators pick from. An operator choosing "Other"
// submits a Pending value: it is stored and usable on that record immediately
// (the field work must not block on an approval), but it stays out of everyone
// else's dropdown until a supervisor approves it.

app.get('/api/lookups', (req, res) => {
  const rows = db
    .prepare(`SELECT id, category, value, status, is_seed, usage_count FROM lookup_options WHERE status = 'Approved' ORDER BY category, sort_order, value`)
    .all();
  const grouped = {};
  for (const row of rows) {
    (grouped[row.category] = grouped[row.category] || []).push(row);
  }
  res.json({ categories: LOOKUP_CATEGORIES, options: grouped });
});

app.get('/api/lookups/pending', requireRole('Admin', 'Field'), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT l.*, u.name AS created_by_name
         FROM lookup_options l LEFT JOIN users u ON u.id = l.created_by
         WHERE l.status = 'Pending' ORDER BY l.created_at DESC`
      )
      .all()
  );
});

app.post('/api/lookups', writeRoles, (req, res) => {
  const { category, value } = req.body;
  if (!category || !value) return res.status(400).json({ error: 'category and value are required' });
  if (!LOOKUP_CATEGORIES[category]) return res.status(400).json({ error: `Unknown lookup category "${category}"` });
  const clean = String(value).trim();
  if (!clean) return res.status(400).json({ error: 'Value cannot be blank' });
  const existing = db.prepare('SELECT * FROM lookup_options WHERE category = ? AND value = ? COLLATE NOCASE').get(category, clean);
  if (existing) {
    return res.status(existing.status === 'Approved' ? 200 : 409).json(
      existing.status === 'Approved'
        ? existing
        : { error: `"${clean}" has already been submitted and is awaiting approval`, option: existing }
    );
  }
  // Admins curate the vocabulary, so their additions are approved on the spot.
  const autoApprove = req.user.role === 'Admin';
  const info = db
    .prepare(
      `INSERT INTO lookup_options (category, value, status, is_seed, created_by, approved_by, approved_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      category,
      clean,
      autoApprove ? 'Approved' : 'Pending',
      req.user.id,
      autoApprove ? req.user.id : null,
      autoApprove ? new Date().toISOString() : null
    );
  res.status(201).json(db.prepare('SELECT * FROM lookup_options WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/lookups/:id/review', requireRole('Admin'), (req, res) => {
  const { decision, review_note } = req.body;
  if (!['Approved', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "Approved" or "Rejected"' });
  }
  const existing = db.prepare('SELECT * FROM lookup_options WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Lookup option');
  db.prepare(`UPDATE lookup_options SET status = ?, approved_by = ?, approved_at = ?, review_note = ? WHERE id = ?`).run(
    decision,
    req.user.id,
    new Date().toISOString(),
    review_note || null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM lookup_options WHERE id = ?').get(req.params.id));
});

app.delete('/api/lookups/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT is_seed FROM lookup_options WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res, 'Lookup option');
  if (existing.is_seed) return res.status(400).json({ error: 'Standard seeded values cannot be deleted' });
  db.prepare('DELETE FROM lookup_options WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Analytics ----------

app.get('/api/analytics', (req, res) => {
  const filters = {};
  for (const key of ['project_id', 'borehole_id', 'rig', 'operator', 'shift', 'drilling_method', 'date_from', 'date_to', 'sample_type', 'test_type']) {
    if (req.query[key]) filters[key] = req.query[key];
  }
  res.json(analytics.compute(db, filters, accessibleProjectIds(req.user)));
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
