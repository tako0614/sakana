import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { OPERATIONAL_SETTING_DEFAULTS } from './config.js';
import { DAY_MS, canonicalJson, policyHash, sha256, validateConstitutionPolicy } from './policy.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_guilds (
    guild_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    enforcement_mode TEXT NOT NULL DEFAULT 'shadow',
    trusted_role_id TEXT NOT NULL,
    appeal_role_id TEXT NOT NULL,
    legislature_role_id TEXT NOT NULL DEFAULT '',
    judiciary_role_id TEXT NOT NULL DEFAULT '',
    category_id TEXT,
    parliament_forum_id TEXT NOT NULL,
    court_forum_id TEXT NOT NULL,
    court_chat_channel_id TEXT NOT NULL,
    statute_forum_id TEXT NOT NULL DEFAULT '',
    gazette_channel_id TEXT NOT NULL,
    active_constitution_id INTEGER,
    last_weekly_scan_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_constitutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    enacted_by TEXT NOT NULL,
    enacted_at INTEGER NOT NULL,
    proposal_id INTEGER,
    UNIQUE (guild_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_constitution_active ON governance_constitutions(guild_id, status);

  CREATE TABLE IF NOT EXISTS governance_settings (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  CREATE TABLE IF NOT EXISTS governance_activity (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    parent_id TEXT,
    user_id TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_activity_user ON governance_activity(guild_id, user_id, created_at);

  CREATE TABLE IF NOT EXISTS governance_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body_json TEXT,
    status TEXT NOT NULL,
    proposer_id TEXT,
    constitution_id INTEGER NOT NULL,
    vote_scope TEXT NOT NULL DEFAULT 'all',
    forum_thread_id TEXT,
    forum_message_id TEXT,
    stage_started_at INTEGER,
    stage_ends_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_proposal_status ON governance_proposals(guild_id, status, stage_ends_at);

  CREATE TABLE IF NOT EXISTS governance_proposal_voters (
    proposal_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    eligible_general INTEGER NOT NULL,
    trusted INTEGER NOT NULL,
    snapshotted_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS governance_votes (
    proposal_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    cast_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS governance_vote_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    old_choice TEXT,
    new_choice TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_laws (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    proposal_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    provisions_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    constitution_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    effective_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (guild_id, code, effective_at)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_laws_active ON governance_laws(guild_id, status, effective_at);

  CREATE TABLE IF NOT EXISTS governance_statute_publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    instrument_type TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    forum_thread_id TEXT NOT NULL,
    forum_message_id TEXT NOT NULL,
    publication_status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (guild_id, instrument_type, instrument_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_statute_publications
    ON governance_statute_publications(guild_id, instrument_type, instrument_id);

  CREATE TABLE IF NOT EXISTS governance_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    panel_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    seat INTEGER NOT NULL,
    model TEXT NOT NULL,
    verdict TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    citations_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (panel_id, seat)
  );

  CREATE TABLE IF NOT EXISTS governance_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    accused_id TEXT,
    law_id INTEGER,
    offense_code TEXT,
    challenged_type TEXT,
    challenged_id TEXT,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    public_thread_id TEXT,
    private_thread_id TEXT,
    defense_until INTEGER,
    alleged_at INTEGER,
    panel_id TEXT,
    verdict_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finalized_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gov_cases_status ON governance_cases(guild_id, status, defense_until);

  CREATE TABLE IF NOT EXISTS governance_case_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL,
    submitted_by TEXT NOT NULL,
    message_id TEXT,
    channel_id TEXT,
    author_id TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    occurred_at INTEGER,
    disclosed_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_case_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_case_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL,
    panel_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    seat INTEGER NOT NULL,
    model TEXT NOT NULL,
    verdict TEXT NOT NULL,
    law_id INTEGER,
    offense_code TEXT,
    sanction_json TEXT,
    evidence_ids_json TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (panel_id, seat)
  );

  CREATE TABLE IF NOT EXISTS governance_case_approvals (
    case_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (case_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS governance_sanctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    duration_seconds INTEGER,
    status TEXT NOT NULL,
    required_approvals INTEGER NOT NULL,
    appealable INTEGER NOT NULL,
    appeal_deadline INTEGER,
    restriction_started_at INTEGER,
    executed_at INTEGER,
    reversed_at INTEGER,
    execution_key TEXT NOT NULL UNIQUE,
    execution_detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gov_sanctions_status ON governance_sanctions(guild_id, status, appeal_deadline);

  CREATE TABLE IF NOT EXISTS governance_appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL UNIQUE,
    appellant_id TEXT NOT NULL,
    grounds TEXT NOT NULL,
    status TEXT NOT NULL,
    panel_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS governance_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_audit_guild ON governance_audit(guild_id, created_at);

  CREATE TABLE IF NOT EXISTS governance_administrative_acts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    reversed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gov_admin_acts ON governance_administrative_acts(guild_id, created_at);

  CREATE TABLE IF NOT EXISTS governance_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_id TEXT,
    payload_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gov_outbox_pending ON governance_outbox(status, created_at);

  CREATE TABLE IF NOT EXISTS governance_ai_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_hash TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS governance_agent_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    trusted INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'agent',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_agent_attempts ON governance_agent_attempts(guild_id, user_id, created_at);
`);

db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_sanction_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    law_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    profile_hash TEXT NOT NULL,
    maximum_duration_seconds INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    UNIQUE (law_id, code)
  );

  CREATE TABLE IF NOT EXISTS governance_active_restrictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sanction_id INTEGER NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    definition_id INTEGER NOT NULL,
    profile_json TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_gov_restrictions_user
    ON governance_active_restrictions(guild_id, user_id, status, ends_at);

  CREATE TABLE IF NOT EXISTS governance_restriction_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restriction_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (restriction_id, kind, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_restriction_usage_window
    ON governance_restriction_usage(restriction_id, kind, created_at);
`);

if (!db.pragma('table_info(governance_sanctions)').some((row) => row.name === 'definition_code')) {
  db.exec('ALTER TABLE governance_sanctions ADD COLUMN definition_code TEXT');
}
if (!db.pragma('table_info(governance_sanctions)').some((row) => row.name === 'profile_json')) {
  db.exec('ALTER TABLE governance_sanctions ADD COLUMN profile_json TEXT');
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (2, ?)').run(Date.now());

for (const [table, columns] of Object.entries({
  governance_proposals: [
    ['retry_after', 'INTEGER'],
    ['failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_error', 'TEXT']
  ],
  governance_cases: [
    ['retry_after', 'INTEGER'],
    ['failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_error', 'TEXT']
  ]
})) {
  const existing = new Set(db.pragma(`table_info(${table})`).map((row) => row.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (3, ?)').run(Date.now());

{
  const existing = new Set(db.pragma('table_info(governance_guilds)').map((row) => row.name));
  for (const [name, definition] of [
    ['weekly_retry_after', 'INTEGER'],
    ['weekly_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['weekly_last_error', 'TEXT']
  ]) {
    if (!existing.has(name)) db.exec(`ALTER TABLE governance_guilds ADD COLUMN ${name} ${definition}`);
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (4, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_trusted_mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    desired INTEGER NOT NULL,
    authorized_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gov_trusted_mutation
    ON governance_trusted_mutations(guild_id, user_id, role_id, desired, expires_at);
`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (5, ?)').run(Date.now());

for (const [table, columns] of Object.entries({
  governance_activity: [['content', "TEXT NOT NULL DEFAULT ''"], ['parent_id', 'TEXT']],
  governance_proposals: [['vote_scope', "TEXT NOT NULL DEFAULT 'all'"]],
  governance_cases: [['alleged_at', 'INTEGER']],
  governance_case_evidence: [['disclosed_at', 'INTEGER']],
  governance_agent_attempts: [['kind', "TEXT NOT NULL DEFAULT 'agent'"]]
})) {
  const existing = new Set(db.pragma(`table_info(${table})`).map((row) => row.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (6, ?)').run(Date.now());

{
  const existing = new Set(db.pragma('table_info(governance_guilds)').map((row) => row.name));
  for (const [name, definition] of [
    ['legislature_role_id', "TEXT NOT NULL DEFAULT ''"],
    ['judiciary_role_id', "TEXT NOT NULL DEFAULT ''"]
  ]) {
    if (!existing.has(name)) db.exec(`ALTER TABLE governance_guilds ADD COLUMN ${name} ${definition}`);
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS governance_intakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    action TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL UNIQUE,
    response_message_id TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at INTEGER NOT NULL,
    result_type TEXT,
    result_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_intakes_pending
    ON governance_intakes(guild_id, requester_id, status, expires_at);
`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (7, ?)').run(Date.now());

{
  const existing = new Set(db.pragma('table_info(governance_guilds)').map((row) => row.name));
  if (!existing.has('statute_forum_id')) {
    db.exec("ALTER TABLE governance_guilds ADD COLUMN statute_forum_id TEXT NOT NULL DEFAULT ''");
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS governance_statute_publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    instrument_type TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    forum_thread_id TEXT NOT NULL,
    forum_message_id TEXT NOT NULL,
    publication_status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (guild_id, instrument_type, instrument_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_statute_publications
    ON governance_statute_publications(guild_id, instrument_type, instrument_id);
`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (8, ?)').run(Date.now());

{
  const guildColumns = new Set(db.pragma('table_info(governance_guilds)').map((row) => row.name));
  for (const [name, definition] of [
    ['guide_channel_id', "TEXT NOT NULL DEFAULT ''"],
    ['guide_message_id', "TEXT NOT NULL DEFAULT ''"],
    ['admin_channel_id', "TEXT NOT NULL DEFAULT ''"],
    ['admin_dashboard_message_id', "TEXT NOT NULL DEFAULT ''"]
  ]) {
    if (!guildColumns.has(name)) db.exec(`ALTER TABLE governance_guilds ADD COLUMN ${name} ${definition}`);
  }
  const publicationColumns = new Set(db.pragma('table_info(governance_statute_publications)').map((row) => row.name));
  if (!publicationColumns.has('detail_message_id')) {
    db.exec("ALTER TABLE governance_statute_publications ADD COLUMN detail_message_id TEXT NOT NULL DEFAULT ''");
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS governance_setup_sessions (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    constitution_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    resources_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_setup_guild
    ON governance_setup_sessions(guild_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS governance_legacy_message_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_id TEXT,
    content TEXT NOT NULL DEFAULT '',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    content_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    message_created_at INTEGER,
    archived_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE (guild_id, channel_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_legacy_archive
    ON governance_legacy_message_archive(guild_id, channel_id, archived_at);
`);
if (!db.pragma('table_info(governance_legacy_message_archive)').some((row) => row.name === 'message_created_at')) {
  db.exec('ALTER TABLE governance_legacy_message_archive ADD COLUMN message_created_at INTEGER');
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (9, ?)').run(Date.now());

// 単一bot processが前提。前回processが外部操作の途中で落ちたrunning actionを
// idempotency key付きoutboxから再試行できる状態へ戻す。
db.prepare("UPDATE governance_outbox SET status = 'error', last_error = 'interrupted before completion' WHERE status = 'running'").run();

function parseJson(value, fallback = null) {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateGuild(row) {
  return row ?? null;
}

function hydrateConstitution(row) {
  return row ? { ...row, policy: parseJson(row.policy_json, {}) } : null;
}

function hydrateProposal(row) {
  return row ? { ...row, body: parseJson(row.body_json, null) } : null;
}

function hydrateLaw(row) {
  return row ? { ...row, provisions: parseJson(row.provisions_json, {}) } : null;
}

function hydrateCase(row) {
  return row ? { ...row, verdict: parseJson(row.verdict_json, null) } : null;
}

function hydrateAdministrativeAct(row) {
  return row ? { ...row, detail: parseJson(row.detail_json, {}) } : null;
}

function hydrateIntake(row) {
  return row ? { ...row, payload: parseJson(row.payload_json, {}) } : null;
}

function hydrateSetupSession(row) {
  return row ? { ...row, resources: parseJson(row.resources_json, {}) } : null;
}

export function getGovernanceGuild(guildId) {
  return hydrateGuild(db.prepare('SELECT * FROM governance_guilds WHERE guild_id = ?').get(String(guildId)));
}

export function listGovernanceGuilds() {
  return db.prepare('SELECT * FROM governance_guilds ORDER BY created_at').all().map(hydrateGuild);
}

export const bootstrapGovernanceGuild = db.transaction((input) => {
  if (getGovernanceGuild(input.guildId)) throw new Error('このサーバーは初期化済みです。');
  validateConstitutionPolicy(input.policy);
  const now = Date.now();
  const contentHash = sha256(input.constitution);
  const pHash = policyHash(input.policy);
  const inserted = db.prepare(`
    INSERT INTO governance_constitutions
      (guild_id, version, content, policy_json, content_hash, policy_hash, status, enacted_by, enacted_at)
    VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    input.guildId,
    input.constitution,
    canonicalJson(input.policy),
    contentHash,
    pHash,
    input.enactedBy,
    now
  );
  const constitutionId = Number(inserted.lastInsertRowid);
  db.prepare(`
    INSERT INTO governance_guilds (
      guild_id, status, enforcement_mode, trusted_role_id, appeal_role_id,
      legislature_role_id, judiciary_role_id, category_id,
      parliament_forum_id, court_forum_id, court_chat_channel_id, statute_forum_id, gazette_channel_id,
      guide_channel_id, admin_channel_id,
      active_constitution_id, created_at, updated_at
    ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId,
    input.enforcementMode,
    input.trustedRoleId,
    input.appealRoleId,
    input.legislatureRoleId ?? '',
    input.judiciaryRoleId ?? '',
    input.categoryId ?? null,
    input.parliamentForumId,
    input.courtForumId,
    input.courtChatChannelId,
    input.statuteForumId ?? '',
    input.gazetteChannelId,
    input.guideChannelId ?? '',
    input.adminChannelId ?? '',
    constitutionId,
    now,
    now
  );
  for (const [key, value] of Object.entries(OPERATIONAL_SETTING_DEFAULTS)) {
    db.prepare(`INSERT INTO governance_settings (guild_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.guildId, key, value, input.enactedBy, now);
  }
  writeAudit({
    guildId: input.guildId,
    actorType: 'operator',
    actorId: input.enactedBy,
    action: 'governance.bootstrap',
    targetType: 'constitution',
    targetId: constitutionId,
    detail: { contentHash, policyHash: pHash, trustedRoleId: input.trustedRoleId }
  });
  return { guild: getGovernanceGuild(input.guildId), constitution: getConstitution(constitutionId) };
});

export function updateGovernanceGuild(guildId, patch) {
  const allowed = new Set([
    'status', 'enforcement_mode', 'trusted_role_id', 'appeal_role_id',
    'legislature_role_id', 'judiciary_role_id', 'category_id',
    'parliament_forum_id', 'court_forum_id', 'court_chat_channel_id', 'statute_forum_id', 'gazette_channel_id',
    'guide_channel_id', 'guide_message_id', 'admin_channel_id', 'admin_dashboard_message_id',
    'active_constitution_id', 'last_weekly_scan_at', 'weekly_retry_after',
    'weekly_failure_count', 'weekly_last_error'
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getGovernanceGuild(guildId);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_guilds SET ${sql}, updated_at = @updated_at WHERE guild_id = @guild_id`)
    .run({ guild_id: guildId, updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getGovernanceGuild(guildId);
}

export function getConstitution(id) {
  return hydrateConstitution(db.prepare('SELECT * FROM governance_constitutions WHERE id = ?').get(Number(id)));
}

export function getActiveConstitution(guildId) {
  return hydrateConstitution(db.prepare(`
    SELECT c.* FROM governance_guilds g
    JOIN governance_constitutions c ON c.id = g.active_constitution_id
    WHERE g.guild_id = ?
  `).get(String(guildId)));
}

export function listConstitutions(guildId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT * FROM governance_constitutions
    WHERE guild_id = ?
    ORDER BY version DESC
    LIMIT ?
  `).all(String(guildId), Number(limit)).map(hydrateConstitution);
}

export const enactConstitution = db.transaction((input) => {
  validateConstitutionPolicy(input.policy);
  const current = getActiveConstitution(input.guildId);
  if (!current) throw new Error('有効な憲法がありません。');
  const now = input.enactedAt ?? Date.now();
  db.prepare("UPDATE governance_constitutions SET status = 'superseded' WHERE id = ?").run(current.id);
  const inserted = db.prepare(`
    INSERT INTO governance_constitutions
      (guild_id, version, content, policy_json, content_hash, policy_hash, status, enacted_by, enacted_at, proposal_id)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    input.guildId,
    current.version + 1,
    input.content,
    canonicalJson(input.policy),
    sha256(input.content),
    policyHash(input.policy),
    input.enactedBy ?? 'vote',
    now,
    input.proposalId ?? null
  );
  const id = Number(inserted.lastInsertRowid);
  updateGovernanceGuild(input.guildId, { active_constitution_id: id });
  writeAudit({ guildId: input.guildId, actorType: 'system', action: 'constitution.enacted', targetType: 'constitution', targetId: id, detail: { version: current.version + 1, proposalId: input.proposalId } });
  return getConstitution(id);
});

export function getOperationalSetting(guildId, key) {
  const row = db.prepare('SELECT value FROM governance_settings WHERE guild_id = ? AND key = ?').get(guildId, key);
  return Number.isFinite(row?.value) ? row.value : OPERATIONAL_SETTING_DEFAULTS[key];
}

export function setOperationalSetting(guildId, key, value, actorId) {
  db.prepare(`
    INSERT INTO governance_settings (guild_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, key, value, actorId, Date.now());
  writeAudit({ guildId, actorType: 'operator', actorId, action: 'setting.update', targetType: 'setting', targetId: key, detail: { value } });
}

export function listOperationalSettings(guildId) {
  return Object.keys(OPERATIONAL_SETTING_DEFAULTS).map((key) => ({ key, value: getOperationalSetting(guildId, key) }));
}

export function createGovernanceIntake(input) {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO governance_intakes
      (guild_id, branch, action, requester_id, channel_id, source_message_id,
       payload_json, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    String(input.guildId), String(input.branch), String(input.action), String(input.requesterId),
    String(input.channelId), String(input.sourceMessageId), canonicalJson(input.payload ?? {}),
    Number(input.expiresAt), now, now
  );
  return hydrateIntake(db.prepare('SELECT * FROM governance_intakes WHERE source_message_id = ?')
    .get(String(input.sourceMessageId)));
}

export function getGovernanceIntake(id) {
  return hydrateIntake(db.prepare('SELECT * FROM governance_intakes WHERE id = ?').get(Number(id)));
}

export function updateGovernanceIntake(id, patch) {
  const allowed = new Set([
    'response_message_id', 'payload_json', 'status', 'expires_at', 'result_type',
    'result_id', 'last_error'
  ]);
  const normalized = { ...patch };
  if ('payload' in normalized) {
    normalized.payload_json = canonicalJson(normalized.payload);
    delete normalized.payload;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getGovernanceIntake(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_intakes SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: Number(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getGovernanceIntake(id);
}

export function claimGovernanceIntake(id, requesterId, now = Date.now()) {
  const result = db.prepare(`
    UPDATE governance_intakes
    SET status = 'processing', updated_at = ?
    WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?
  `).run(now, Number(id), String(requesterId), now);
  return result.changes === 1 ? getGovernanceIntake(id) : null;
}

export function expireGovernanceIntakes(now = Date.now()) {
  const rows = db.prepare(`
    SELECT * FROM governance_intakes
    WHERE status = 'pending' AND expires_at <= ?
    ORDER BY id
  `).all(now).map(hydrateIntake);
  if (rows.length > 0) {
    db.prepare(`
      UPDATE governance_intakes SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
  }
  return rows;
}

export function createGovernanceSetupSession(input) {
  const now = Date.now();
  db.prepare(`
    UPDATE governance_setup_sessions SET status = 'expired', updated_at = ?
    WHERE guild_id = ? AND status = 'preview'
  `).run(now, String(input.guildId));
  const id = randomUUID();
  db.prepare(`
    INSERT INTO governance_setup_sessions
      (id, guild_id, requested_by, constitution_hash, policy_hash, status,
       resources_json, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'preview', '{}', ?, ?, ?)
  `).run(
    id, String(input.guildId), String(input.requestedBy), String(input.constitutionHash),
    String(input.policyHash), Number(input.expiresAt), now, now
  );
  return getGovernanceSetupSession(id);
}

export function getGovernanceSetupSession(id) {
  return hydrateSetupSession(db.prepare('SELECT * FROM governance_setup_sessions WHERE id = ?').get(String(id)));
}

export function getResumableGovernanceSetup(guildId) {
  return hydrateSetupSession(db.prepare(`
    SELECT * FROM governance_setup_sessions
    WHERE guild_id = ? AND status IN ('provisioning', 'failed')
    ORDER BY updated_at DESC LIMIT 1
  `).get(String(guildId)));
}

export function claimGovernanceSetupSession(id, requestedBy, now = Date.now()) {
  const result = db.prepare(`
    UPDATE governance_setup_sessions
    SET status = 'provisioning', last_error = NULL, updated_at = ?
    WHERE id = ? AND requested_by = ? AND status IN ('preview', 'failed')
      AND (expires_at > ? OR resources_json <> '{}')
  `).run(now, String(id), String(requestedBy), now);
  return result.changes === 1 ? getGovernanceSetupSession(id) : null;
}

export function updateGovernanceSetupSession(id, patch) {
  const normalized = { ...patch };
  if ('resources' in normalized) {
    normalized.resources_json = canonicalJson(normalized.resources ?? {});
    delete normalized.resources;
  }
  const allowed = new Set(['status', 'resources_json', 'last_error', 'expires_at', 'requested_by']);
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getGovernanceSetupSession(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_setup_sessions SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: String(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getGovernanceSetupSession(id);
}

export function archiveLegacyGovernanceMessage(input) {
  const attachments = input.attachments ?? [];
  const content = String(input.content ?? '');
  db.prepare(`
    INSERT INTO governance_legacy_message_archive
      (guild_id, channel_id, message_id, author_id, content, attachments_json,
       content_hash, reason, message_created_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id, message_id) DO NOTHING
  `).run(
    String(input.guildId), String(input.channelId), String(input.messageId),
    input.authorId ? String(input.authorId) : null, content, canonicalJson(attachments),
    sha256(canonicalJson({ content, attachments })), String(input.reason),
    input.createdAt === undefined ? null : Number(input.createdAt), Date.now()
  );
  return db.prepare(`
    SELECT * FROM governance_legacy_message_archive
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?
  `).get(String(input.guildId), String(input.channelId), String(input.messageId));
}

export function markLegacyGovernanceMessageDeleted(guildId, channelId, messageId) {
  db.prepare(`
    UPDATE governance_legacy_message_archive SET deleted_at = ?
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?
  `).run(Date.now(), String(guildId), String(channelId), String(messageId));
}

export function listLegacyGovernanceMessageArchive(guildId) {
  return db.prepare(`
    SELECT * FROM governance_legacy_message_archive
    WHERE guild_id = ? ORDER BY id
  `).all(String(guildId)).map((row) => ({ ...row, attachments: parseJson(row.attachments_json, []) }));
}

export function authorizeTrustedMutation({ guildId, userId, roleId, desired, authorizedBy, ttlMs = 60_000 }) {
  const result = db.prepare(`
    INSERT INTO governance_trusted_mutations
      (guild_id, user_id, role_id, desired, authorized_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, roleId, desired ? 1 : 0, authorizedBy, Date.now() + ttlMs);
  return Number(result.lastInsertRowid);
}

export function consumeTrustedMutation({ guildId, userId, roleId, desired }) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT * FROM governance_trusted_mutations
    WHERE guild_id = ? AND user_id = ? AND role_id = ? AND desired = ?
      AND consumed_at IS NULL AND expires_at >= ?
    ORDER BY id LIMIT 1
  `).get(guildId, userId, roleId, desired ? 1 : 0, now);
  if (!row) return null;
  db.prepare('UPDATE governance_trusted_mutations SET consumed_at = ? WHERE id = ?').run(now, row.id);
  return row;
}

const insertActivityStmt = db.prepare(`
  INSERT OR IGNORE INTO governance_activity
    (message_id, guild_id, channel_id, parent_id, user_id, activity_date, content_hash, content, created_at)
  VALUES (@messageId, @guildId, @channelId, @parentId, @userId, @activityDate, @contentHash, @content, @createdAt)
`);

export function recordActivity(row) {
  if (!row) return false;
  return insertActivityStmt.run(row).changes > 0;
}

export const recordActivities = db.transaction((rows) => {
  let count = 0;
  for (const row of rows) count += insertActivityStmt.run(row).changes;
  return count;
});

export function deleteActivity(messageId) {
  return db.prepare('DELETE FROM governance_activity WHERE message_id = ?').run(String(messageId)).changes > 0;
}

export function activityCounts(guildId, userId, since) {
  return db.prepare(`
    SELECT activity_date, COUNT(DISTINCT content_hash) AS unique_count
    FROM governance_activity
    WHERE guild_id = ? AND user_id = ? AND created_at >= ?
    GROUP BY activity_date
    ORDER BY activity_date
  `).all(guildId, userId, since).map((row) => ({ date: row.activity_date, count: row.unique_count }));
}

export function recentGovernanceMessages(guildId, since, channelIds, limit = 300) {
  if (!channelIds.length) return [];
  const marks = channelIds.map(() => '?').join(',');
  const newestFirst = db.prepare(`
    SELECT message_id, channel_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND created_at >= ?
      AND (channel_id IN (${marks}) OR parent_id IN (${marks})) AND content <> ''
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(String(guildId), Number(since), ...channelIds.map(String), ...channelIds.map(String), Number(limit));
  const seen = new Set();
  return newestFirst.filter((row) => {
    if (seen.has(row.content_hash)) return false;
    seen.add(row.content_hash);
    return true;
  }).reverse();
}

export function createProposal(input) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO governance_proposals
      (guild_id, kind, source, title, summary, body_json, status, proposer_id, constitution_id,
       vote_scope, stage_started_at, stage_ends_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId,
    input.kind ?? 'law',
    input.source,
    input.title,
    input.summary,
    input.body ? canonicalJson(input.body) : null,
    input.status ?? 'drafting',
    input.proposerId ?? null,
    input.constitutionId,
    input.voteScope ?? 'all',
    input.stageStartedAt ?? now,
    input.stageEndsAt ?? null,
    now,
    now
  );
  const proposal = getProposal(Number(result.lastInsertRowid));
  writeAudit({ guildId: input.guildId, actorType: input.source === 'weekly' ? 'ai' : 'member', actorId: input.proposerId, action: 'proposal.created', targetType: 'proposal', targetId: proposal.id, detail: { kind: proposal.kind, source: proposal.source, voteScope: proposal.vote_scope } });
  return proposal;
}

export function getProposal(id) {
  return hydrateProposal(db.prepare('SELECT * FROM governance_proposals WHERE id = ?').get(Number(id)));
}

export function findActiveProposalByNormalizedTitle(guildId, normalizedTitle) {
  return hydrateProposal(db.prepare(`
    SELECT * FROM governance_proposals
    WHERE guild_id = ? AND lower(trim(title)) = ?
      AND status IN ('drafting', 'draft', 'constitutional_review', 'debate', 'voting')
    ORDER BY id DESC LIMIT 1
  `).get(String(guildId), String(normalizedTitle).trim().toLowerCase()));
}

export function listProposals(guildId, { statuses = null, limit = 25 } = {}) {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM governance_proposals WHERE guild_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT ?`)
      .all(guildId, ...statuses, limit).map(hydrateProposal);
  }
  return db.prepare('SELECT * FROM governance_proposals WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit).map(hydrateProposal);
}

export function updateProposal(id, patch) {
  const allowed = new Set([
    'title', 'summary', 'body_json', 'status', 'forum_thread_id', 'forum_message_id',
    'stage_started_at', 'stage_ends_at', 'revision', 'retry_after', 'failure_count', 'last_error'
  ]);
  const normalized = { ...patch };
  if ('body' in normalized) {
    normalized.body_json = canonicalJson(normalized.body);
    delete normalized.body;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getProposal(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_proposals SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: Number(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getProposal(id);
}

export const snapshotProposalVoters = db.transaction((proposalId, rows) => {
  db.prepare('DELETE FROM governance_proposal_voters WHERE proposal_id = ?').run(proposalId);
  const insert = db.prepare(`
    INSERT INTO governance_proposal_voters (proposal_id, user_id, eligible_general, trusted, snapshotted_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const row of rows) insert.run(proposalId, row.userId, row.eligibleGeneral ? 1 : 0, row.trusted ? 1 : 0, now);
  return rows.length;
});

export function proposalVoter(proposalId, userId) {
  return db.prepare('SELECT * FROM governance_proposal_voters WHERE proposal_id = ? AND user_id = ?')
    .get(Number(proposalId), String(userId)) ?? null;
}

export const castProposalVote = db.transaction((proposalId, userId, choice) => {
  if (!['yes', 'no', 'abstain'].includes(choice)) throw new Error('無効な票です。');
  const voter = proposalVoter(proposalId, userId);
  if (!voter?.eligible_general) throw new Error('この投票scopeの有権者ではありません。');
  const proposal = getProposal(proposalId);
  if (!proposal || proposal.status !== 'voting' || Number(proposal.stage_ends_at) <= Date.now()) {
    throw new Error('この投票は受付中ではありません。');
  }
  const old = db.prepare('SELECT choice FROM governance_votes WHERE proposal_id = ? AND user_id = ?')
    .get(proposalId, userId)?.choice ?? null;
  const now = Date.now();
  db.prepare(`
    INSERT INTO governance_votes (proposal_id, user_id, choice, cast_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(proposal_id, user_id) DO UPDATE SET choice = excluded.choice, updated_at = excluded.updated_at
  `).run(proposalId, userId, choice, now, now);
  db.prepare('INSERT INTO governance_vote_history (proposal_id, user_id, old_choice, new_choice, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(proposalId, userId, old, choice, now);
  return { proposal, voter, oldChoice: old, choice };
});

export function proposalVoteSummary(proposalId) {
  const counts = Object.fromEntries(db.prepare(`
    SELECT v.choice, COUNT(*) AS count
    FROM governance_votes v
    JOIN governance_proposal_voters e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
    WHERE v.proposal_id = ? AND e.eligible_general = 1
    GROUP BY v.choice
  `).all(proposalId).map((row) => [row.choice, row.count]));
  const snapshot = db.prepare(`
    SELECT
      SUM(CASE WHEN eligible_general = 1 THEN 1 ELSE 0 END) AS electorate,
      SUM(CASE WHEN trusted = 1 THEN 1 ELSE 0 END) AS trusted_electorate
    FROM governance_proposal_voters WHERE proposal_id = ?
  `).get(proposalId);
  const trustedCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN v.choice = 'yes' THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN v.choice = 'no' THEN 1 ELSE 0 END) AS no,
      SUM(CASE WHEN v.choice = 'abstain' THEN 1 ELSE 0 END) AS abstain
    FROM governance_votes v
    JOIN governance_proposal_voters e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
    WHERE v.proposal_id = ? AND e.trusted = 1 AND e.eligible_general = 1
  `).get(proposalId);
  const trustedYes = trustedCounts?.yes ?? 0;
  const trustedNo = trustedCounts?.no ?? 0;
  const trustedAbstain = trustedCounts?.abstain ?? 0;
  return {
    yes: counts.yes ?? 0,
    no: counts.no ?? 0,
    abstain: counts.abstain ?? 0,
    electorate: snapshot?.electorate ?? 0,
    // trusted拒否権の分母は有権者数ではなく、有効票（yes + no）。棄権は含めない。
    trustedTotal: trustedYes + trustedNo,
    trustedElectorate: snapshot?.trusted_electorate ?? 0,
    trustedYes,
    trustedNo,
    trustedAbstain
  };
}

export function proposalElectorate(proposalId) {
  return db.prepare(`
    SELECT user_id, eligible_general, trusted
    FROM governance_proposal_voters
    WHERE proposal_id = ?
    ORDER BY user_id
  `).all(Number(proposalId));
}

export function listProposalVotes(proposalId) {
  return db.prepare(`
    SELECT v.user_id, v.choice, v.updated_at, e.trusted
    FROM governance_votes v
    JOIN governance_proposal_voters e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
    WHERE v.proposal_id = ? ORDER BY v.updated_at, v.user_id
  `).all(proposalId);
}

export const enactLaw = db.transaction((input) => {
  const text = String(input.text);
  const provisions = input.provisions;
  const result = db.prepare(`
    INSERT INTO governance_laws
      (guild_id, proposal_id, code, title, text, provisions_json, content_hash, constitution_id, status, effective_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    input.guildId,
    input.proposalId,
    input.code,
    input.title,
    text,
    canonicalJson(provisions),
    sha256(`${text}\n${canonicalJson(provisions)}`),
    input.constitutionId,
    input.effectiveAt ?? Date.now()
  );
  const law = getLaw(Number(result.lastInsertRowid));
  registerSanctionDefinitions(law);
  return law;
});

export const registerSanctionDefinitions = db.transaction((law) => {
  const definitions = Array.isArray(law?.provisions?.sanctionDefinitions)
    ? law.provisions.sanctionDefinitions
    : [];
  const insert = db.prepare(`
    INSERT INTO governance_sanction_definitions
      (guild_id, law_id, code, title, profile_json, profile_hash, maximum_duration_seconds, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `);
  for (const definition of definitions) {
    const profile = { code: definition.code, rules: definition.rules };
    insert.run(
      law.guild_id,
      law.id,
      definition.code,
      definition.title,
      canonicalJson(profile),
      sha256(canonicalJson(profile)),
      Number(definition.maximumDurationSeconds),
      Date.now()
    );
  }
  return definitions.length;
});

export function getSanctionDefinition(lawId, code) {
  const row = db.prepare(`
    SELECT * FROM governance_sanction_definitions
    WHERE law_id = ? AND code = ? AND status = 'active'
  `).get(Number(lawId), String(code));
  return row ? { ...row, profile: parseJson(row.profile_json, null) } : null;
}

export function getLaw(id) {
  return hydrateLaw(db.prepare('SELECT * FROM governance_laws WHERE id = ?').get(Number(id)));
}

export function updateLaw(id, patch) {
  const allowed = new Set(['status', 'ended_at']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getLaw(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_laws SET ${sql} WHERE id = @id`)
    .run({ id: Number(id), ...Object.fromEntries(entries) });
  return getLaw(id);
}

export function listLaws(guildId, { activeOnly = true, limit = 50 } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM governance_laws WHERE guild_id = ? AND status = 'active' ORDER BY effective_at DESC LIMIT ?"
    : 'SELECT * FROM governance_laws WHERE guild_id = ? ORDER BY effective_at DESC LIMIT ?';
  return db.prepare(sql).all(guildId, limit).map(hydrateLaw);
}

export function getStatutePublication(guildId, instrumentType, instrumentId) {
  return db.prepare(`
    SELECT * FROM governance_statute_publications
    WHERE guild_id = ? AND instrument_type = ? AND instrument_id = ?
  `).get(String(guildId), String(instrumentType), String(instrumentId)) ?? null;
}

export function listStatutePublications(guildId) {
  return db.prepare(`
    SELECT * FROM governance_statute_publications
    WHERE guild_id = ?
    ORDER BY instrument_type, id
  `).all(String(guildId));
}

export function upsertStatutePublication(input) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO governance_statute_publications
      (guild_id, instrument_type, instrument_id, forum_thread_id, forum_message_id, detail_message_id,
       publication_status, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, instrument_type, instrument_id) DO UPDATE SET
      forum_thread_id = excluded.forum_thread_id,
      forum_message_id = excluded.forum_message_id,
      detail_message_id = excluded.detail_message_id,
      publication_status = excluded.publication_status,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(
    String(input.guildId), String(input.instrumentType), String(input.instrumentId),
    String(input.forumThreadId), String(input.forumMessageId), String(input.detailMessageId ?? ''), String(input.publicationStatus),
    String(input.contentHash), now, now
  );
  return getStatutePublication(input.guildId, input.instrumentType, input.instrumentId);
}

export function lawAtTime(id, occurredAt) {
  return hydrateLaw(db.prepare(`
    SELECT * FROM governance_laws
    WHERE id = ? AND effective_at <= ? AND (ended_at IS NULL OR ended_at > ?)
      AND status IN ('active', 'repealed', 'unconstitutional')
  `).get(Number(id), Number(occurredAt), Number(occurredAt)));
}

export function recordReview(input) {
  db.prepare(`
    INSERT INTO governance_reviews
      (guild_id, target_type, target_id, panel_id, phase, seat, model, verdict, reasons_json,
       citations_json, input_hash, output_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId, input.targetType, String(input.targetId), input.panelId, input.phase, input.seat,
    input.model, input.verdict, canonicalJson(input.reasons ?? []), canonicalJson(input.citations ?? []),
    input.inputHash, canonicalJson(input.output), Date.now()
  );
}

export function createCase(input) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO governance_cases
      (guild_id, kind, reporter_id, accused_id, law_id, offense_code, challenged_type, challenged_id,
       summary, status, defense_until, alleged_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId, input.kind ?? 'criminal', input.reporterId, input.accusedId ?? null,
    input.lawId ?? null, input.offenseCode ?? null, input.challengedType ?? null,
    input.challengedId === null || input.challengedId === undefined ? null : String(input.challengedId),
    input.summary, input.status ?? 'filed', input.defenseUntil ?? null,
    input.allegedAt ?? null,
    now, now
  );
  const created = getCase(Number(result.lastInsertRowid));
  writeAudit({ guildId: input.guildId, actorType: 'member', actorId: input.reporterId, action: 'case.filed', targetType: 'case', targetId: created.id, detail: { kind: created.kind, accusedId: created.accused_id } });
  return created;
}

export function getCase(id) {
  return hydrateCase(db.prepare('SELECT * FROM governance_cases WHERE id = ?').get(Number(id)));
}

export function getCaseByPublicThread(threadId) {
  return hydrateCase(db.prepare('SELECT * FROM governance_cases WHERE public_thread_id = ?').get(String(threadId)));
}

export function listCases(guildId, { statuses = null, limit = 25 } = {}) {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM governance_cases WHERE guild_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT ?`)
      .all(guildId, ...statuses, limit).map(hydrateCase);
  }
  return db.prepare('SELECT * FROM governance_cases WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit).map(hydrateCase);
}

export function findOpenConstitutionalCase(guildId, challengedType, challengedId) {
  return hydrateCase(db.prepare(`
    SELECT * FROM governance_cases
    WHERE guild_id = ? AND kind = 'constitutional'
      AND challenged_type = ? AND challenged_id = ?
      AND status NOT IN ('final', 'constitutional_uncertain', 'overturned', 'acquitted')
    ORDER BY id DESC LIMIT 1
  `).get(String(guildId), String(challengedType), String(challengedId)));
}

export function listOpenCasesForLaw(lawId) {
  return db.prepare(`
    SELECT * FROM governance_cases
    WHERE law_id = ? AND status NOT IN ('final', 'overturned', 'acquitted', 'dismissed')
    ORDER BY id
  `).all(Number(lawId)).map(hydrateCase);
}

export function updateCase(id, patch) {
  const allowed = new Set([
    'status', 'public_thread_id', 'private_thread_id', 'defense_until', 'panel_id',
    'verdict_json', 'finalized_at', 'retry_after', 'failure_count', 'last_error', 'alleged_at'
  ]);
  const normalized = { ...patch };
  if ('verdict' in normalized) {
    normalized.verdict_json = canonicalJson(normalized.verdict);
    delete normalized.verdict;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (!entries.length) return getCase(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_cases SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: Number(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getCase(id);
}

export function addCaseEvidence(input) {
  const result = db.prepare(`
    INSERT INTO governance_case_evidence
      (case_id, submitted_by, message_id, channel_id, author_id, content, content_hash, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.caseId, input.submittedBy, input.messageId ?? null, input.channelId ?? null,
    input.authorId ?? null, input.content, sha256(input.content), input.occurredAt ?? null, Date.now()
  );
  return Number(result.lastInsertRowid);
}

export function listCaseEvidence(caseId) {
  return db.prepare('SELECT * FROM governance_case_evidence WHERE case_id = ? ORDER BY id').all(Number(caseId));
}

export function markEvidenceDisclosed(id, at = Date.now()) {
  db.prepare('UPDATE governance_case_evidence SET disclosed_at = ? WHERE id = ?').run(at, Number(id));
  return db.prepare('SELECT * FROM governance_case_evidence WHERE id = ?').get(Number(id)) ?? null;
}

export function addCaseSubmission(caseId, authorId, kind, content) {
  const result = db.prepare(`
    INSERT INTO governance_case_submissions (case_id, author_id, kind, content, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(caseId, authorId, kind, content, sha256(content), Date.now());
  return Number(result.lastInsertRowid);
}

export function listCaseSubmissions(caseId) {
  return db.prepare('SELECT * FROM governance_case_submissions WHERE case_id = ? ORDER BY id').all(Number(caseId));
}

export function recordCaseDecision(input) {
  db.prepare(`
    INSERT INTO governance_case_decisions
      (case_id, panel_id, phase, seat, model, verdict, law_id, offense_code, sanction_json,
       evidence_ids_json, reasons_json, input_hash, output_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.caseId, input.panelId, input.phase, input.seat, input.model, input.verdict,
    input.lawId ?? null, input.offenseCode ?? null,
    input.sanction ? canonicalJson(input.sanction) : null,
    canonicalJson(input.evidenceIds ?? []), canonicalJson(input.reasons ?? []),
    input.inputHash, canonicalJson(input.output), Date.now()
  );
}

export function listCaseDecisions(caseId, phase = null) {
  const rows = phase
    ? db.prepare('SELECT * FROM governance_case_decisions WHERE case_id = ? AND phase = ? ORDER BY seat').all(caseId, phase)
    : db.prepare('SELECT * FROM governance_case_decisions WHERE case_id = ? ORDER BY id').all(caseId);
  return rows.map((row) => ({
    ...row,
    sanction: parseJson(row.sanction_json, null),
    evidenceIds: parseJson(row.evidence_ids_json, []),
    reasons: parseJson(row.reasons_json, []),
    output: parseJson(row.output_json, {})
  }));
}

export function setCaseApproval(caseId, userId, decision, reason = '') {
  if (!['approve', 'reject'].includes(decision)) throw new Error('承認値が不正です。');
  db.prepare(`
    INSERT INTO governance_case_approvals (case_id, user_id, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(case_id, user_id) DO UPDATE SET decision = excluded.decision, reason = excluded.reason, created_at = excluded.created_at
  `).run(caseId, userId, decision, reason, Date.now());
}

export function listCaseApprovals(caseId) {
  return db.prepare('SELECT * FROM governance_case_approvals WHERE case_id = ? ORDER BY created_at').all(Number(caseId));
}

export function createSanction(input) {
  const executionKey = input.executionKey ?? `case:${input.caseId}:${input.type}`;
  const result = db.prepare(`
    INSERT INTO governance_sanctions
      (case_id, guild_id, user_id, type, duration_seconds, status, required_approvals, appealable,
       appeal_deadline, restriction_started_at, execution_key, definition_code, profile_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.caseId, input.guildId, input.userId, input.type, input.durationSeconds ?? null,
    input.status, input.requiredApprovals, input.appealable ? 1 : 0,
    input.appealDeadline ?? null, input.restrictionStartedAt ?? null, executionKey,
    input.definitionCode ?? null, input.profile ? canonicalJson(input.profile) : null
  );
  return getSanction(Number(result.lastInsertRowid));
}

export function getSanction(id) {
  const row = db.prepare('SELECT * FROM governance_sanctions WHERE id = ?').get(Number(id));
  return row ? { ...row, profile: parseJson(row.profile_json, null) } : null;
}

export function getCaseSanction(caseId) {
  const row = db.prepare('SELECT * FROM governance_sanctions WHERE case_id = ?').get(Number(caseId));
  return row ? { ...row, profile: parseJson(row.profile_json, null) } : null;
}

export function listSanctions(guildId, statuses = null) {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM governance_sanctions WHERE guild_id = ? AND status IN (${marks}) ORDER BY id`)
      .all(guildId, ...statuses).map((row) => ({ ...row, profile: parseJson(row.profile_json, null) }));
  }
  return db.prepare('SELECT * FROM governance_sanctions WHERE guild_id = ? ORDER BY id').all(guildId)
    .map((row) => ({ ...row, profile: parseJson(row.profile_json, null) }));
}

export function listSanctionsForLaw(lawId) {
  return db.prepare(`
    SELECT s.* FROM governance_sanctions s
    JOIN governance_cases c ON c.id = s.case_id
    WHERE c.law_id = ? AND s.status NOT IN ('reversed')
    ORDER BY s.id
  `).all(Number(lawId)).map((row) => ({ ...row, profile: parseJson(row.profile_json, null) }));
}

export function updateSanction(id, patch) {
  const allowed = new Set([
    'type', 'duration_seconds', 'status', 'required_approvals', 'appealable', 'appeal_deadline',
    'restriction_started_at', 'executed_at', 'reversed_at', 'execution_detail',
    'definition_code', 'profile_json'
  ]);
  const normalized = { ...patch };
  if ('profile' in normalized) {
    normalized.profile_json = canonicalJson(normalized.profile);
    delete normalized.profile;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (!entries.length) return getSanction(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_sanctions SET ${sql} WHERE id = @id`)
    .run({ id: Number(id), ...Object.fromEntries(entries) });
  return getSanction(id);
}

export function activateRestriction({ sanctionId, guildId, userId, definitionId, profile, startedAt, endsAt }) {
  db.prepare(`
    INSERT INTO governance_active_restrictions
      (sanction_id, guild_id, user_id, definition_id, profile_json, started_at, ends_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(sanction_id) DO UPDATE SET
      profile_json = excluded.profile_json,
      started_at = excluded.started_at,
      ends_at = excluded.ends_at,
      status = 'active'
  `).run(sanctionId, guildId, userId, definitionId, canonicalJson(profile), startedAt, endsAt);
}

export function activeRestrictions(guildId, userId, now = Date.now()) {
  return db.prepare(`
    SELECT * FROM governance_active_restrictions
    WHERE guild_id = ? AND user_id = ? AND status = 'active' AND ends_at > ?
    ORDER BY ends_at
  `).all(guildId, userId, now).map((row) => ({ ...row, profile: parseJson(row.profile_json, {}) }));
}

export function expireRestrictions(now = Date.now()) {
  return db.prepare(`
    UPDATE governance_active_restrictions SET status = 'expired'
    WHERE status = 'active' AND ends_at <= ?
  `).run(now).changes;
}

export function deactivateRestrictionForSanction(sanctionId, status = 'reversed') {
  return db.prepare(`
    UPDATE governance_active_restrictions SET status = ?
    WHERE sanction_id = ? AND status = 'active'
  `).run(status, sanctionId).changes;
}

export function restrictionUsageCount(restrictionId, kind, since) {
  return db.prepare(`
    SELECT COUNT(*) AS count FROM governance_restriction_usage
    WHERE restriction_id = ? AND kind = ? AND created_at >= ?
  `).get(restrictionId, kind, since).count;
}

export function restrictionUsageWindow(restrictionId, kind, since) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, MIN(created_at) AS oldest
    FROM governance_restriction_usage
    WHERE restriction_id = ? AND kind = ? AND created_at >= ?
  `).get(restrictionId, kind, since);
  return { count: row.count, oldest: row.oldest === null ? null : Number(row.oldest) };
}

export function recordRestrictionUsage(restrictionId, kind, eventId) {
  return db.prepare(`
    INSERT OR IGNORE INTO governance_restriction_usage (restriction_id, kind, event_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(restrictionId, kind, eventId ?? null, Date.now()).changes > 0;
}

export function createAppeal(caseId, appellantId, grounds) {
  const panelId = randomUUID();
  const result = db.prepare(`
    INSERT INTO governance_appeals (case_id, appellant_id, grounds, status, panel_id, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(caseId, appellantId, grounds, panelId, Date.now());
  return { id: Number(result.lastInsertRowid), caseId, appellantId, grounds, status: 'pending', panelId };
}

export function getAppeal(caseId) {
  return db.prepare('SELECT * FROM governance_appeals WHERE case_id = ?').get(Number(caseId)) ?? null;
}

export function updateAppeal(caseId, patch) {
  const allowed = new Set(['status', 'decided_at']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getAppeal(caseId);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_appeals SET ${sql} WHERE case_id = @case_id`)
    .run({ case_id: Number(caseId), ...Object.fromEntries(entries) });
  return getAppeal(caseId);
}

export function writeAudit({ guildId, actorType, actorId = null, action, targetType = null, targetId = null, detail = {} }) {
  const result = db.prepare(`
    INSERT INTO governance_audit
      (guild_id, actor_type, actor_id, action, target_type, target_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, actorType, actorId, action, targetType, targetId === null ? null : String(targetId), canonicalJson(detail), Date.now());
  return Number(result.lastInsertRowid);
}

export function listAudit(guildId, limit = 50) {
  return db.prepare('SELECT * FROM governance_audit WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit).map((row) => ({ ...row, detail: parseJson(row.detail_json, {}) }));
}

export function createAdministrativeAct({ guildId, kind, actorType = 'operator', actorId = null, summary, detail = {} }) {
  const result = db.prepare(`
    INSERT INTO governance_administrative_acts
      (guild_id, kind, actor_type, actor_id, summary, detail_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(guildId, kind, actorType, actorId, summary, canonicalJson(detail), Date.now());
  const act = getAdministrativeAct(Number(result.lastInsertRowid));
  writeAudit({ guildId, actorType, actorId, action: 'administrative_act.created', targetType: 'administrative_act', targetId: act.id, detail: { kind } });
  return act;
}

export function getAdministrativeAct(id) {
  return hydrateAdministrativeAct(db.prepare('SELECT * FROM governance_administrative_acts WHERE id = ?').get(Number(id)));
}

export function listAdministrativeActs(guildId, limit = 50) {
  return db.prepare('SELECT * FROM governance_administrative_acts WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(guildId), Number(limit)).map(hydrateAdministrativeAct);
}

export function updateAdministrativeAct(id, patch) {
  const allowed = new Set(['status', 'reversed_at', 'detail_json']);
  const normalized = { ...patch };
  if ('detail' in normalized) {
    normalized.detail_json = canonicalJson(normalized.detail);
    delete normalized.detail;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (!entries.length) return getAdministrativeAct(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_administrative_acts SET ${sql} WHERE id = @id`)
    .run({ id: Number(id), ...Object.fromEntries(entries) });
  return getAdministrativeAct(id);
}

export function enqueueAction({ guildId, actionType, targetId = null, payload, idempotencyKey }) {
  db.prepare(`
    INSERT OR IGNORE INTO governance_outbox
      (guild_id, action_type, target_id, payload_json, idempotency_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(guildId, actionType, targetId === null ? null : String(targetId), canonicalJson(payload), idempotencyKey, Date.now());
  return db.prepare('SELECT * FROM governance_outbox WHERE idempotency_key = ?').get(idempotencyKey);
}

export function pendingActions(limit = 25) {
  return db.prepare("SELECT * FROM governance_outbox WHERE status IN ('pending', 'error') AND attempts < 5 ORDER BY id LIMIT ?")
    .all(limit).map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

export function listActionFailures(guildId, limit = 10) {
  return db.prepare(`
    SELECT * FROM governance_outbox
    WHERE guild_id = ? AND status = 'error'
    ORDER BY id DESC LIMIT ?
  `).all(String(guildId), limit).map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

export function retryFailedActions(guildId) {
  return db.prepare(`
    UPDATE governance_outbox
    SET status = 'pending', attempts = 0, last_error = NULL
    WHERE guild_id = ? AND status = 'error'
  `).run(String(guildId)).changes;
}

export function markActionRunning(id) {
  db.prepare("UPDATE governance_outbox SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(id);
}

export function completeAction(id) {
  db.prepare("UPDATE governance_outbox SET status = 'completed', completed_at = ?, last_error = NULL WHERE id = ?")
    .run(Date.now(), id);
}

export function failAction(id, error) {
  db.prepare("UPDATE governance_outbox SET status = 'error', last_error = ? WHERE id = ?")
    .run(String(error).slice(0, 500), id);
}

export function startAiCall(guildId, purpose, model, inputHash) {
  const result = db.prepare(`
    INSERT INTO governance_ai_calls (guild_id, purpose, model, input_hash, status, created_at)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(guildId, purpose, model, inputHash, Date.now());
  return Number(result.lastInsertRowid);
}

export function finishAiCall(id, { output = null, error = null }) {
  db.prepare(`
    UPDATE governance_ai_calls
    SET status = ?, output_hash = ?, error = ?, finished_at = ? WHERE id = ?
  `).run(error ? 'error' : 'ok', output ? sha256(canonicalJson(output)) : null, error ? String(error).slice(0, 500) : null, Date.now(), id);
}

export function reserveAgentAttempt(guildId, userId, trusted, limit, windowMs = DAY_MS, kind = 'agent') {
  const now = Date.now();
  const usage = db.prepare(`
    SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM governance_agent_attempts
    WHERE guild_id = ? AND user_id = ? AND kind = ? AND created_at >= ?
  `).get(guildId, userId, kind, now - windowMs);
  const used = usage.count;
  if (limit === 0) return { ok: false, used, limit, retryAt: null };
  if (limit > 0 && used >= limit) {
    return { ok: false, used, limit, retryAt: Number(usage.oldest ?? now) + windowMs };
  }
  db.prepare('INSERT INTO governance_agent_attempts (guild_id, user_id, trusted, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, userId, trusted ? 1 : 0, kind, now);
  return { ok: true, used: used + 1, limit };
}

export function pruneGovernance(keepMs = 90 * 86_400_000) {
  const cutoff = Date.now() - keepMs;
  db.prepare('DELETE FROM governance_agent_attempts WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM governance_activity WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM governance_restriction_usage WHERE created_at < ?').run(cutoff);
  db.prepare("DELETE FROM governance_intakes WHERE status != 'pending' AND updated_at < ?").run(cutoff);
  db.prepare("DELETE FROM governance_setup_sessions WHERE status IN ('completed', 'expired') AND updated_at < ?").run(cutoff);
}

export { db as governanceDatabase };
