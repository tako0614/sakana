import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { OPERATIONAL_SETTING_DEFAULTS, isOperationalSettingKey, type OperationalSettingKey } from './config.js';
import { DAY_MS, canonicalJson, sha256 } from './policy.js';
import { closeGovernanceVote, compileConstitution, compileLegalSystem } from './rules.js';
import { AUTHORITY_SCHEMA, EFFECTIVE_SCHEMA } from './legal-system.js';
import { compileLegalRecovery } from './legal-recovery.js';
import { errorText, isArray, isEffectiveLegalSystem, isLawProvisions, isProposalBody, isRecord, oneOf } from './types.js';
import type {
  ActiveConstitution, ActiveRestriction, CompiledLegalSystem, ActiveRestrictionRow, ActivityInput, ActivityMessage, ActivityRow,
  AdministrativeAct, AdministrativeActRow, AppealRow, AuditEntry, AuditRow, CaseApprovalRow, CaseDecision,
  CaseDecisionRow, CaseEvidenceRow, CaseRecord, HumanVetoRow, CaseRow, CaseSubmissionRow, CompiledConstitution, Constitution,
  ConstitutionPolicy, ConstitutionRow, InstitutionTaskResult, DetentionRow, DiscussionMessage, FoundingLaw, GovernanceGuild,
  GovernanceGuildRow, GovernanceRules, InstrumentRelation, InstrumentRelationRow, Intake, IntakeRow,
  InterimProtectionRow, InvestigationEvidenceRow, InvestigationStepRow, Law, LawInput, LawProvisions,
  LawPublicationRow, LawRow, LegacyMessageArchiveRow, LegalBaseline, LegalSnapshot, LegalSnapshotRow, LegalTask,
  LegalTaskRow, MentionInvestigation, MentionInvestigationRow, NotificationRow, OutboxAction, OutboxRow,
  ParliamentSession, ParliamentSessionRow, Proposal, ProposalBody, ProposalDeliberation, ProposalDeliberationRow,
  ProposalElectorateRow, ProposalQueue, ProposalRow, ProposalVoteRow, ProposalVoterRow, QueuedInput,
  ReviewRow, SettingRow, Sanction, SanctionDefinitionRecord, SanctionDefinitionRow, SanctionRow, SetupSession, SetupSessionRow,
  StatutePublicationRow, SurfaceMigration, SurfaceMigrationRow, TrustedMutationRow, UnknownRecord, VoteSummary,
  WorkflowContext, WorkflowEvent, WorkflowEventRow, WorkflowInstance, WorkflowInstanceRow, WorkflowKey
} from './types.js';

// 列の追加を判断するために、表の現在の列名を読む。
function columnNames(table: string): Set<string> {
  const result: unknown = db.pragma(`table_info(${table})`);
  const rows = isArray(result) ? result : [];
  return new Set(rows.flatMap((row) => (isRecord(row) && typeof row.name === 'string' ? [row.name] : [])));
}

type Id = number | string;
type ColumnSpec = [name: string, definition: string];
interface CountRow { count: number }
interface ShortCountRow { c: number }

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
    procedure_channel_id TEXT NOT NULL DEFAULT '',
    procedure_message_id TEXT NOT NULL DEFAULT '',
    operations_thread_id TEXT NOT NULL DEFAULT '',
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
    source_message_id TEXT,
    superseded_at INTEGER,
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

if (!columnNames('governance_sanctions').has('definition_code')) {
  db.exec('ALTER TABLE governance_sanctions ADD COLUMN definition_code TEXT');
}
if (!columnNames('governance_sanctions').has('profile_json')) {
  db.exec('ALTER TABLE governance_sanctions ADD COLUMN profile_json TEXT');
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (2, ?)').run(Date.now());

for (const [table, columns] of Object.entries<ColumnSpec[]>({
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
  const existing = columnNames(table);
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (3, ?)').run(Date.now());

{
  const existing = columnNames('governance_guilds');
  for (const [name, definition] of [
    ['weekly_retry_after', 'INTEGER'],
    ['weekly_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['weekly_last_error', 'TEXT']
  ] satisfies ColumnSpec[]) {
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

for (const [table, columns] of Object.entries<ColumnSpec[]>({
  governance_activity: [['content', "TEXT NOT NULL DEFAULT ''"], ['parent_id', 'TEXT']],
  governance_proposals: [['vote_scope', "TEXT NOT NULL DEFAULT 'all'"]],
  governance_cases: [['alleged_at', 'INTEGER']],
  governance_case_evidence: [['disclosed_at', 'INTEGER'], ['conversation_json', 'TEXT']],
  governance_agent_attempts: [['kind', "TEXT NOT NULL DEFAULT 'agent'"]]
})) {
  const existing = columnNames(table);
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (6, ?)').run(Date.now());

{
  const existing = columnNames('governance_guilds');
  for (const [name, definition] of [
    ['legislature_role_id', "TEXT NOT NULL DEFAULT ''"],
    ['judiciary_role_id', "TEXT NOT NULL DEFAULT ''"]
  ] satisfies ColumnSpec[]) {
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
  const existing = columnNames('governance_guilds');
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
  const guildColumns = columnNames('governance_guilds');
  // v16以降の新規DBには旧surface列を作らない。既存DBではv16が値を移行して列を削除する。
  if (!guildColumns.has('procedure_channel_id')) {
    for (const [name, definition] of [
      ['guide_channel_id', "TEXT NOT NULL DEFAULT ''"],
      ['guide_message_id', "TEXT NOT NULL DEFAULT ''"],
      ['admin_channel_id', "TEXT NOT NULL DEFAULT ''"],
      ['admin_dashboard_message_id', "TEXT NOT NULL DEFAULT ''"]
    ] satisfies ColumnSpec[]) {
      if (!guildColumns.has(name)) db.exec(`ALTER TABLE governance_guilds ADD COLUMN ${name} ${definition}`);
    }
  }
  const publicationColumns = columnNames('governance_statute_publications');
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
if (!columnNames('governance_legacy_message_archive').has('message_created_at')) {
  db.exec('ALTER TABLE governance_legacy_message_archive ADD COLUMN message_created_at INTEGER');
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (9, ?)').run(Date.now());

{
  const submissionColumns = columnNames('governance_case_submissions');
  if (!submissionColumns.has('source_message_id')) {
    db.exec('ALTER TABLE governance_case_submissions ADD COLUMN source_message_id TEXT');
  }
  if (!submissionColumns.has('superseded_at')) {
    db.exec('ALTER TABLE governance_case_submissions ADD COLUMN superseded_at INTEGER');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gov_case_submission_source
    ON governance_case_submissions(case_id, source_message_id, superseded_at)
  `);
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (10, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_interim_protections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    law_id INTEGER NOT NULL,
    offense_code TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    minimum_events INTEGER NOT NULL,
    observed_events INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    evidence_message_id TEXT NOT NULL,
    evidence_channel_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_interim_protection_user
    ON governance_interim_protections(guild_id, user_id, status, ends_at);
`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (11, ?)').run(Date.now());

{
  const caseColumns = columnNames('governance_cases');
  const needsConstitutionBackfill = !caseColumns.has('constitution_id');
  for (const [name, definition] of [
    ['constitution_id', 'INTEGER'],
    ['procedure_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['decision_due_at', 'INTEGER'],
    ['response_completed_at', 'INTEGER'],
    ['police_event_key', 'TEXT'],
    ['review_count', 'INTEGER NOT NULL DEFAULT 0']
  ] satisfies ColumnSpec[]) {
    if (!caseColumns.has(name)) db.exec(`ALTER TABLE governance_cases ADD COLUMN ${name} ${definition}`);
  }
  const sanctionColumns = columnNames('governance_sanctions');
  for (const [name, definition] of [
    ['review_requested_at', 'INTEGER'],
    ['notice_delivered', 'INTEGER NOT NULL DEFAULT 0']
  ] satisfies ColumnSpec[]) {
    if (!sanctionColumns.has(name)) db.exec(`ALTER TABLE governance_sanctions ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_case_summary_event
    ON governance_cases(guild_id, police_event_key)
    WHERE police_event_key IS NOT NULL
  `);
  // 施行途中の事件は、その後に憲法が改正されても受付時の手続を維持する。
  // v12導入前の行には当時の現行憲法を一度だけ固定する。
  if (needsConstitutionBackfill) {
    db.exec(`
      UPDATE governance_cases
      SET constitution_id = (
        SELECT g.active_constitution_id
        FROM governance_guilds g
        WHERE g.guild_id = governance_cases.guild_id
      )
      WHERE constitution_id IS NULL
    `);
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (12, ?)').run(Date.now());

{
  const existing = columnNames('governance_proposals');
  if (!existing.has('debate_extensions')) {
    db.exec('ALTER TABLE governance_proposals ADD COLUMN debate_extensions INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_proposal_deliberations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      discussion_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_proposal_deliberations
      ON governance_proposal_deliberations(proposal_id, revision, id);
  `);
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (13, ?)').run(Date.now());

{
  const constitutionColumns = columnNames('governance_constitutions');
  for (const [name, definition] of [
    ['source_format', "TEXT NOT NULL DEFAULT 'legacy-policy'"],
    ['rules_json', 'TEXT'],
    ['rules_hash', 'TEXT'],
    ['compiler_version', 'INTEGER']
  ] satisfies ColumnSpec[]) {
    if (!constitutionColumns.has(name)) db.exec(`ALTER TABLE governance_constitutions ADD COLUMN ${name} ${definition}`);
  }
  const proposalColumns = columnNames('governance_proposals');
  for (const [name, definition] of [
    ['relation_type', 'TEXT'],
    ['target_type', 'TEXT'],
    ['target_id', 'TEXT'],
    ['target_hash', 'TEXT']
  ] satisfies ColumnSpec[]) {
    if (!proposalColumns.has(name)) db.exec(`ALTER TABLE governance_proposals ADD COLUMN ${name} ${definition}`);
  }
  const lawColumns = columnNames('governance_laws');
  for (const [name, definition] of [
    ['root_law_id', 'INTEGER'],
    ['supersedes_law_id', 'INTEGER'],
    ['version', 'INTEGER NOT NULL DEFAULT 1']
  ] satisfies ColumnSpec[]) {
    if (!lawColumns.has(name)) db.exec(`ALTER TABLE governance_laws ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_workflow_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      constitution_id INTEGER NOT NULL,
      workflow_key TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      current_state TEXT NOT NULL,
      state_entered_at INTEGER NOT NULL,
      wake_at INTEGER,
      context_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (subject_type, subject_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gov_workflow_wake
      ON governance_workflow_instances(guild_id, status, wake_at);
    CREATE TABLE IF NOT EXISTS governance_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_instance_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      from_state TEXT,
      to_state TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (workflow_instance_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_gov_workflow_events
      ON governance_workflow_events(workflow_instance_id, id);
    CREATE TABLE IF NOT EXISTS governance_instrument_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_hash TEXT,
      reason_json TEXT NOT NULL DEFAULT '[]',
      decision_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_instrument_relations
      ON governance_instrument_relations(guild_id, source_type, source_id);
  `);
  const constitutions = db.prepare<[], Pick<ConstitutionRow, 'id' | 'content' | 'policy_json'>>(`
    SELECT id, content, policy_json FROM governance_constitutions
    WHERE rules_json IS NULL OR rules_hash IS NULL OR compiler_version IS NULL
  `).all();
  const updateConstitutionRules = db.prepare(`
    UPDATE governance_constitutions
    SET source_format = ?, rules_json = ?, rules_hash = ?, compiler_version = ?, policy_json = ?, policy_hash = ?
    WHERE id = ?
  `);
  for (const row of constitutions) {
    // 旧形式の憲法はもう解釈できない。ここで落とすとbot全体が起動できなくなるので、
    // 行はそのまま残し、その憲法を実際に使う経路で失敗させる。
    let compiled: CompiledConstitution;
    try {
      compiled = compileConstitution({ content: row.content });
    } catch (error) {
      console.error(`Constitution ${row.id} has no executable rules block:`, error instanceof Error ? error.message : error);
      continue;
    }
    updateConstitutionRules.run(
      compiled.sourceFormat,
      canonicalJson(compiled.rules),
      compiled.rulesHash,
      compiled.compilerVersion,
      canonicalJson(compiled.policy),
      sha256(canonicalJson(compiled.policy)),
      row.id
    );
  }
  // 既存の進行中改憲案にも、受付時の改正対象を固定する。これにより並行案が
  // 先に成立した後、古い全文で現行憲法を上書きすることを防げる。
  db.exec(`
    UPDATE governance_proposals
    SET target_type = 'constitution',
        target_id = CAST(constitution_id AS TEXT),
        target_hash = (
          SELECT c.content_hash FROM governance_constitutions c
          WHERE c.id = governance_proposals.constitution_id
        )
    WHERE kind = 'amendment'
      AND (target_type IS NULL OR target_id IS NULL OR target_hash IS NULL)
  `);
  db.exec('UPDATE governance_laws SET root_law_id = id WHERE root_law_id IS NULL');
  const insertWorkflow = db.prepare(`
    INSERT OR IGNORE INTO governance_workflow_instances
      (guild_id, constitution_id, workflow_key, subject_type, subject_id, current_state,
       state_entered_at, wake_at, context_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
  `);
  const now = Date.now();
  const constitutionRules = db.prepare<[number], Pick<ConstitutionRow, 'rules_json'>>('SELECT rules_json FROM governance_constitutions WHERE id = ?');
  const migrateProposalState = db.prepare('UPDATE governance_proposals SET status = ?, updated_at = ? WHERE id = ?');
  type MigratingProposal = Pick<ProposalRow, 'id' | 'guild_id' | 'constitution_id' | 'kind' | 'status' | 'revision'
    | 'stage_started_at' | 'stage_ends_at' | 'created_at'>;
  for (const row of db.prepare<[], MigratingProposal>('SELECT id, guild_id, constitution_id, kind, status, revision, stage_started_at, stage_ends_at, created_at FROM governance_proposals').all()) {
    // 旧形式の規則も読むので、保存JSONの形を一段ずつ確かめる。
    const rules: unknown = JSON.parse(constitutionRules.get(row.constitution_id)?.rules_json ?? 'null');
    const candidate = isRecord(rules) && isRecord(rules.workflows)
      ? rules.workflows[row.kind === 'amendment' ? 'constitutionalAmendment' : 'law'] : null;
    const workflow = isRecord(candidate) && isRecord(candidate.states) ? { initial: candidate.initial, states: candidate.states } : null;
    const stateAt = (name: string): UnknownRecord | null => {
      const state = workflow?.states[name];
      return isRecord(state) ? state : null;
    };
    let currentState = row.status;
    if (workflow && !workflow.states[currentState]) {
      const findState = (handler: string, phase: string | null = null): string | null => Object.entries(workflow.states)
        .find(([, state]) => isRecord(state) && state.handler === handler
          && (phase === null || (isRecord(state.config) && state.config.phase === phase)))?.[0] ?? null;
      const legacyStates: Record<string, string | null> = {
        drafting: typeof workflow.initial === 'string' ? workflow.initial : null,
        draft: findState('public_discussion', 'initial') ?? findState('public_discussion', 'legacy_draft'),
        debate: Number(row.revision ?? 1) > 1
          ? findState('public_discussion', 'revision')
          : findState('public_discussion', 'initial') ?? findState('public_discussion', 'legacy_debate'),
        constitutional_review: findState('constitutional_panel'),
        voting: findState('public_vote')
      };
      currentState = legacyStates[row.status] ?? currentState;
      if (currentState !== row.status && workflow.states[currentState]) {
        migrateProposalState.run(currentState, now, row.id);
      } else {
        currentState = row.status;
      }
    }
    insertWorkflow.run(
      row.guild_id, row.constitution_id, row.kind === 'amendment' ? 'constitutionalAmendment' : 'law',
      'proposal', String(row.id), currentState, row.stage_started_at ?? row.created_at,
      row.stage_ends_at, stateAt(currentState)?.handler === 'terminal' ? 'completed' : 'active', now, now
    );
  }
  type MigratingCase = Pick<CaseRow, 'id' | 'guild_id' | 'constitution_id' | 'kind' | 'status' | 'created_at' | 'defense_until' | 'finalized_at'>;
  for (const row of db.prepare<[], MigratingCase>('SELECT id, guild_id, constitution_id, kind, status, created_at, defense_until, finalized_at FROM governance_cases').all()) {
    if (!row.constitution_id) continue;
    insertWorkflow.run(
      row.guild_id, row.constitution_id, row.kind === 'constitutional' ? 'constitutionalCase' : 'criminalCase',
      'case', String(row.id), row.status, row.created_at, row.defense_until,
      row.finalized_at ? 'completed' : 'active', now, now
    );
  }
  db.exec(`
    INSERT INTO governance_workflow_events
      (workflow_instance_id, event_type, actor_type, actor_id, from_state, to_state,
       payload_json, idempotency_key, created_at)
    SELECT w.id, 'migrated', 'system', NULL, NULL, w.current_state,
      '{"source":"schema-14"}', 'migration-created', w.created_at
    FROM governance_workflow_instances w
    WHERE NOT EXISTS (
      SELECT 1 FROM governance_workflow_events e WHERE e.workflow_instance_id = w.id
    )
  `);
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (14, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    audience_kind TEXT NOT NULL,
    audience_id TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    channel_id TEXT,
    message_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gov_notifications_rate
    ON governance_notifications(guild_id, audience_kind, audience_id, status, delivered_at);
  CREATE INDEX IF NOT EXISTS idx_gov_notifications_failed
    ON governance_notifications(guild_id, status, updated_at);
`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (15, ?)').run(Date.now());

{
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_surface_migrations (
      guild_id TEXT PRIMARY KEY,
      legacy_guide_channel_id TEXT NOT NULL DEFAULT '',
      legacy_gazette_channel_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  const columns = columnNames('governance_guilds');
  for (const [name, definition] of [
    ['procedure_channel_id', "TEXT NOT NULL DEFAULT ''"],
    ['procedure_message_id', "TEXT NOT NULL DEFAULT ''"],
    ['operations_thread_id', "TEXT NOT NULL DEFAULT ''"]
  ] satisfies ColumnSpec[]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE governance_guilds ADD COLUMN ${name} ${definition}`);
  }
  const migratedColumns = columnNames('governance_guilds');
  if (migratedColumns.has('admin_channel_id')) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO governance_surface_migrations
        (guild_id, legacy_guide_channel_id, legacy_gazette_channel_id, status, detail_json, created_at, updated_at)
      SELECT guild_id, guide_channel_id, gazette_channel_id, 'pending', '{}', ?, ?
      FROM governance_guilds
      WHERE guide_channel_id != '' OR gazette_channel_id != ''
    `).run(now, now);
    db.exec(`
      UPDATE governance_guilds
      SET procedure_channel_id = admin_channel_id,
          procedure_message_id = admin_dashboard_message_id
      WHERE procedure_channel_id = ''
    `);
    for (const name of [
      'guide_channel_id', 'guide_message_id', 'admin_channel_id', 'admin_dashboard_message_id', 'gazette_channel_id'
    ]) {
      if (columnNames('governance_guilds').has(name)) {
        db.exec(`ALTER TABLE governance_guilds DROP COLUMN ${name}`);
      }
    }
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (16, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_mention_investigations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL UNIQUE,
    response_message_id TEXT,
    request_text TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    outcome TEXT,
    result_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gov_mention_investigations
    ON governance_mention_investigations(guild_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS governance_investigation_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (investigation_id, message_id, purpose)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_investigation_evidence
    ON governance_investigation_evidence(investigation_id, id);
`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (17, ?)').run(Date.now());

{
  const columns = columnNames('governance_mention_investigations');
  for (const [name, definition] of [
    ['result_type', 'TEXT'],
    ['result_id', 'TEXT'],
    ['record_published_at', 'INTEGER']
  ] satisfies ColumnSpec[]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE governance_mention_investigations ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gov_mention_investigation_result
      ON governance_mention_investigations(guild_id, result_type, result_id)
  `);
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (18, ?)').run(Date.now());

{
  const proposalColumns = columnNames('governance_proposals');
  if (!proposalColumns.has('deferrals')) {
    db.exec('ALTER TABLE governance_proposals ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0');
  }
  const guildColumns = columnNames('governance_guilds');
  for (const [name, definition] of [
    ['last_session_at', 'INTEGER'],
    ['session_retry_after', 'INTEGER'],
    ['session_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['session_last_error', 'TEXT']
  ] satisfies ColumnSpec[]) {
    if (!guildColumns.has(name)) db.exec(`ALTER TABLE governance_guilds ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_parliament_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      constitution_id INTEGER NOT NULL,
      manual INTEGER NOT NULL DEFAULT 0,
      agenda_count INTEGER NOT NULL DEFAULT 0,
      outcomes_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gov_parliament_sessions
      ON governance_parliament_sessions(guild_id, started_at);

    CREATE TABLE IF NOT EXISTS governance_law_publications (
      guild_id TEXT NOT NULL,
      instrument_type TEXT NOT NULL,
      instrument_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      publication_status TEXT NOT NULL,
      pushed_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, instrument_type, instrument_id)
    );
  `);
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (19, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_detentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    released_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_detention_active
    ON governance_detentions(guild_id, user_id, status, ends_at);
`);
{
  const columns = columnNames('governance_guilds');
  // 警察の処分は裁判所ではなく手続の執行記録へ公開する。裁判所は争われた事件だけを持つ。
  if (!columns.has('enforcement_thread_id')) {
    db.exec("ALTER TABLE governance_guilds ADD COLUMN enforcement_thread_id TEXT NOT NULL DEFAULT ''");
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (20, ?)').run(Date.now());

// 席が自分で調べるようになったので、どの席がどのツールを何回叩いて何を見たかを残す。
// 憲法第十二条3の公開はスレへの要約で満たし、完全な往復はこの表にだけ置く。
db.exec(`
  CREATE TABLE IF NOT EXISTS governance_investigation_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_call_id INTEGER NOT NULL,
    guild_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    seat INTEGER NOT NULL,
    step INTEGER NOT NULL,
    tool TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    result_summary TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_investigation_call
    ON governance_investigation_steps(ai_call_id, step);
`);
{
  const columns = columnNames('governance_cases');
  // 裁判所が審理中に不利な証拠を足したら答弁をやり直す。その回数の上限を数える。
  if (!columns.has('redefense_count')) {
    db.exec('ALTER TABLE governance_cases ADD COLUMN redefense_count INTEGER NOT NULL DEFAULT 0');
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (21, ?)').run(Date.now());

// 国会が開かれたことは議題スレを見ないと分からなかった。開会ごとの議事録を
// 手続の1本のスレへ時系列で残す。
{
  const columns = columnNames('governance_guilds');
  if (!columns.has('parliament_thread_id')) {
    db.exec("ALTER TABLE governance_guilds ADD COLUMN parliament_thread_id TEXT NOT NULL DEFAULT ''");
  }
  const sessionColumns = columnNames('governance_parliament_sessions');
  if (!sessionColumns.has('minutes_message_id')) {
    db.exec('ALTER TABLE governance_parliament_sessions ADD COLUMN minutes_message_id TEXT');
  }
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (22, ?)').run(Date.now());

db.exec(`
  CREATE TABLE IF NOT EXISTS governance_legal_snapshots (
    hash TEXT PRIMARY KEY, guild_id TEXT NOT NULL, constitution_id INTEGER NOT NULL,
    content_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS governance_legal_runtime (
    guild_id TEXT NOT NULL, constitution_id INTEGER NOT NULL, last_snapshot_hash TEXT NOT NULL,
    PRIMARY KEY (guild_id, constitution_id)
  );
  CREATE TABLE IF NOT EXISTS governance_legal_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
    procedure_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active', wake_at INTEGER, retry_after INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS governance_institution_effects (
    event_key TEXT PRIMARY KEY, guild_id TEXT NOT NULL, task_id INTEGER NOT NULL,
    result_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);
if (!columnNames('governance_workflow_instances').has('legal_snapshot_hash')) {
  db.exec('ALTER TABLE governance_workflow_instances ADD COLUMN legal_snapshot_hash TEXT');
}
if (!columnNames('governance_outbox').has('retry_after')) {
  db.exec('ALTER TABLE governance_outbox ADD COLUMN retry_after INTEGER');
}
if (!columnNames('governance_reviews').has('target_hash')) {
  db.exec('ALTER TABLE governance_reviews ADD COLUMN target_hash TEXT');
}
if (!columnNames('governance_cases').has('workflow_state')) {
  db.exec('ALTER TABLE governance_cases ADD COLUMN workflow_state TEXT');
}
if (!columnNames('governance_case_approvals').has('target_hash')) {
  db.exec('ALTER TABLE governance_case_approvals ADD COLUMN target_hash TEXT');
}
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (23, ?)').run(Date.now());

db.exec(`CREATE TABLE IF NOT EXISTS governance_human_vetoes (
  subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL, round_key TEXT NOT NULL,
  target_hash TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (subject_type, subject_id, round_key, user_id)
);`);
db.prepare('INSERT OR IGNORE INTO governance_schema_migrations (version, applied_at) VALUES (24, ?)').run(Date.now());

// 単一bot processが前提。前回processが外部操作の途中で落ちたrunning actionを
// idempotency key付きoutboxから再試行できる状態へ戻す。
db.prepare("UPDATE governance_outbox SET status = 'error', last_error = 'interrupted before completion' WHERE status = 'running'").run();
db.prepare("UPDATE governance_notifications SET status = 'failed', last_error = 'interrupted before delivery', updated_at = ? WHERE status = 'sending'")
  .run(Date.now());

function parseJson(value: string | null | undefined, fallback: unknown = null): unknown {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

// JSON列のうち object を期待する値。壊れていれば JS 版と同じ既定値に戻す。
function parseRecord(value: string | null | undefined, fallback: UnknownRecord = {}): UnknownRecord {
  const parsed = parseJson(value, fallback);
  return isRecord(parsed) ? parsed : fallback;
}

// 保存した実行規則から、ある段の定義を読む。旧形式の規則も残るので一段ずつ確かめる。
function stateIn(rules: unknown, key: string, stateName: string): UnknownRecord | null {
  if (!isRecord(rules) || !isRecord(rules.workflows)) return null;
  const workflow = rules.workflows[key];
  if (!isRecord(workflow) || !isRecord(workflow.states)) return null;
  const state = workflow.states[stateName];
  return isRecord(state) ? state : null;
}

function stateHandlerIn(rules: unknown, key: string, stateName: string): string | null {
  const handler = stateIn(rules, key, stateName)?.handler;
  return typeof handler === 'string' ? handler : null;
}

const STORED_RULE_SCHEMAS = ['sakana.governance-rules/v1', 'sakana.legal-system/v2'];

// compileConstitution / compileLegalSystem が検証してから canonicalJson で書いた値。schema だけ確かめて読む。
function isStoredRules(value: unknown): value is GovernanceRules {
  return isRecord(value) && typeof value.$schema === 'string' && STORED_RULE_SCHEMAS.includes(value.$schema);
}

function storedRules(value: unknown): GovernanceRules | null {
  return isStoredRules(value) ? value : null;
}

// compileConstitution が validateConstitutionPolicy を通してから書いた値。版だけ確かめて読む。
function isStoredPolicy(value: unknown): value is ConstitutionPolicy {
  return isRecord(value) && typeof value.schemaVersion === 'number';
}

function storedPolicy(value: unknown): ConstitutionPolicy {
  if (!isStoredPolicy(value)) throw new Error('保存された憲法policyを読めません。');
  return value;
}

function storedContext(value: string | null | undefined): WorkflowContext {
  // 手続の各段が canonicalJson で書いた文脈。object であることだけ確かめる (各項目は読む側が確かめる)。
  return parseRecord(value, {}) as WorkflowContext;
}

function hydrateGuild(row: GovernanceGuildRow | undefined): GovernanceGuild | null {
  return row ?? null;
}

function hydrateConstitution(row: ConstitutionRow): Constitution;
function hydrateConstitution(row: ConstitutionRow | undefined): Constitution | null;
function hydrateConstitution(row: ConstitutionRow | undefined): Constitution | null {
  return row ? {
    ...row,
    policy: storedPolicy(parseJson(row.policy_json, {})),
    rules: storedRules(parseJson(row.rules_json, null))
  } : null;
}

const proposalRulesStmt = db.prepare<[number], Pick<ConstitutionRow, 'rules_json'>>('SELECT rules_json FROM governance_constitutions WHERE id = ?');
const proposalWorkflowStmt = db.prepare<[string], Pick<WorkflowInstanceRow, 'status' | 'context_json'>>(`
  SELECT status, context_json FROM governance_workflow_instances
  WHERE subject_type = 'proposal' AND subject_id = ?
`);

function hydrateProposal(row: ProposalRow): Proposal;
function hydrateProposal(row: ProposalRow | undefined): Proposal | null;
function hydrateProposal(row: ProposalRow | undefined): Proposal | null {
  if (!row) return null;
  const instance = getWorkflowInstance('proposal', row.id);
  const rules: unknown = instance?.legal_snapshot_hash
    ? getLegalSnapshot(instance.legal_snapshot_hash)?.rules
    : parseJson(proposalRulesStmt.get(Number(row.constitution_id))?.rules_json, null);
  const workflow = proposalWorkflowStmt.get(String(row.id));
  const key = row.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const body = parseJson(row.body_json, null);
  return {
    ...row,
    // 起草AIの出力を llm.js が検証してから保存した本文。読むときも項目の型を確かめる。
    body: isProposalBody(body) ? body : null,
    workflow_handler: stateHandlerIn(rules, key, row.status),
    workflow_status: workflow?.status ?? null,
    workflow_context: storedContext(workflow?.context_json)
  };
}

function hydrateLaw(row: LawRow): Law;
function hydrateLaw(row: LawRow | undefined): Law | null;
function hydrateLaw(row: LawRow | undefined): Law | null {
  // 成立時に法体系の組み立てを通った provisions。区分が配列であることを確かめる。
  if (!row) return null;
  const provisions = parseJson(row.provisions_json, {});
  return { ...row, provisions: isLawProvisions(provisions) ? provisions : {} };
}

function hydrateCase(row: CaseRow): CaseRecord;
function hydrateCase(row: CaseRow | undefined): CaseRecord | null;
function hydrateCase(row: CaseRow | undefined): CaseRecord | null {
  if (!row) return null;
  const instance = getWorkflowInstance('case', row.id);
  const snapshot = instance?.legal_snapshot_hash ? getLegalSnapshot(instance.legal_snapshot_hash) : null;
  const handler = snapshot && instance ? stateHandlerIn(snapshot.rules, instance.workflow_key, instance.current_state) : null;
  return { ...row, verdict: parseJson(row.verdict_json, null),
    workflow_state: instance?.current_state ?? row.workflow_state ?? row.status,
    workflow_handler: handler };
}

function hydrateAdministrativeAct(row: AdministrativeActRow): AdministrativeAct;
function hydrateAdministrativeAct(row: AdministrativeActRow | undefined): AdministrativeAct | null;
function hydrateAdministrativeAct(row: AdministrativeActRow | undefined): AdministrativeAct | null {
  return row ? { ...row, detail: parseRecord(row.detail_json, {}) } : null;
}

function hydrateIntake(row: IntakeRow): Intake;
function hydrateIntake(row: IntakeRow | undefined): Intake | null;
function hydrateIntake(row: IntakeRow | undefined): Intake | null {
  return row ? { ...row, payload: parseRecord(row.payload_json, {}) } : null;
}

function hydrateMentionInvestigation(row: MentionInvestigationRow): MentionInvestigation;
function hydrateMentionInvestigation(row: MentionInvestigationRow | undefined): MentionInvestigation | null;
function hydrateMentionInvestigation(row: MentionInvestigationRow | undefined): MentionInvestigation | null {
  return row ? { ...row, result: parseRecord(row.result_json, {}) } : null;
}

function hydrateSetupSession(row: SetupSessionRow | undefined): SetupSession | null {
  if (!row) return null;
  const resources = parseRecord(row.resources_json, {});
  if (!resources.procedureChannelId && resources.adminChannelId) {
    resources.procedureChannelId = resources.adminChannelId;
  }
  return { ...row, resources };
}

export type Patch = Record<string, unknown>;

export function getGovernanceGuild(guildId: Id): GovernanceGuild | null {
  return hydrateGuild(db.prepare<[string], GovernanceGuildRow>('SELECT * FROM governance_guilds WHERE guild_id = ?').get(String(guildId)));
}

export function listGovernanceGuilds(): GovernanceGuild[] {
  return db.prepare<[], GovernanceGuildRow>('SELECT * FROM governance_guilds ORDER BY created_at').all();
}

export function getGovernanceSurfaceMigration(guildId: Id): SurfaceMigration | null {
  const row = db.prepare<[string], SurfaceMigrationRow>('SELECT * FROM governance_surface_migrations WHERE guild_id = ?').get(String(guildId));
  return row ? { ...row, detail: parseRecord(row.detail_json, {}) } : null;
}

export interface SurfaceMigrationInput {
  guildId: Id;
  legacyGuideChannelId?: string | null;
  legacyGazetteChannelId?: string | null;
  detail?: unknown;
}

export function recordGovernanceSurfaceMigration({
  guildId,
  legacyGuideChannelId = '',
  legacyGazetteChannelId = '',
  detail = {}
}: SurfaceMigrationInput): SurfaceMigration | null {
  const now = Date.now();
  db.prepare(`
    INSERT INTO governance_surface_migrations
      (guild_id, legacy_guide_channel_id, legacy_gazette_channel_id, status, detail_json, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      legacy_guide_channel_id = CASE
        WHEN excluded.legacy_guide_channel_id != '' THEN excluded.legacy_guide_channel_id
        ELSE governance_surface_migrations.legacy_guide_channel_id
      END,
      legacy_gazette_channel_id = CASE
        WHEN excluded.legacy_gazette_channel_id != '' THEN excluded.legacy_gazette_channel_id
        ELSE governance_surface_migrations.legacy_gazette_channel_id
      END,
      detail_json = excluded.detail_json,
      updated_at = excluded.updated_at
  `).run(
    String(guildId), String(legacyGuideChannelId ?? ''), String(legacyGazetteChannelId ?? ''),
    canonicalJson(detail), now, now
  );
  return getGovernanceSurfaceMigration(guildId);
}

export function updateGovernanceSurfaceMigration(guildId: Id, patch: Patch): SurfaceMigration | null {
  const allowed = new Set(['status', 'detail_json', 'completed_at']);
  const normalized: Patch = { ...patch };
  if ('detail' in normalized) {
    normalized.detail_json = canonicalJson(normalized.detail);
    delete normalized.detail;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (!entries.length) return getGovernanceSurfaceMigration(guildId);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_surface_migrations SET ${sql}, updated_at = @updated_at WHERE guild_id = @guild_id`)
    .run({ guild_id: String(guildId), updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getGovernanceSurfaceMigration(guildId);
}

export interface BootstrapGovernanceInput {
  guildId: string;
  enactedBy: string;
  constitution: string;
  laws?: FoundingLaw[] | null;
  policy?: unknown;
  enforcementMode: string;
  trustedRoleId: string;
  appealRoleId: string;
  legislatureRoleId?: string;
  judiciaryRoleId?: string;
  categoryId?: string | null;
  parliamentForumId: string;
  courtForumId: string;
  courtChatChannelId: string;
  statuteForumId?: string;
  procedureChannelId?: string;
  procedureMessageId?: string;
  operationsThreadId?: string;
}

// 存在を前提に読む行。無ければ JS 版 (TypeError) と同じく処理を止める。
function requireRecord<T>(record: T | null | undefined, label: string): T {
  if (record === null || record === undefined) throw new Error(`${label}が見つかりません。`);
  return record;
}

export const bootstrapGovernanceGuild = db.transaction((input: BootstrapGovernanceInput) => {
  if (getGovernanceGuild(input.guildId)) throw new Error('このサーバーは初期化済みです。');
  const compiled = compileConstitution({ content: input.constitution, laws: input.laws ?? null });
  if (!compiled.policy) throw new Error('自律統治の導入には憲法と基礎法令一式が必要です。');
  const now = Date.now();
  const contentHash = sha256(input.constitution);
  const pHash = sha256(canonicalJson(compiled.policy));
  const inserted = db.prepare(`
    INSERT INTO governance_constitutions
      (guild_id, version, content, policy_json, content_hash, policy_hash, status, enacted_by, enacted_at,
       source_format, rules_json, rules_hash, compiler_version)
    VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId,
    input.constitution,
    canonicalJson(compiled.policy),
    contentHash,
    pHash,
    input.enactedBy,
    now,
    compiled.sourceFormat,
    canonicalJson(compiled.rules),
    compiled.rulesHash,
    compiled.compilerVersion
  );
  const constitutionId = Number(inserted.lastInsertRowid);
  db.prepare(`
    INSERT INTO governance_guilds (
      guild_id, status, enforcement_mode, trusted_role_id, appeal_role_id,
      legislature_role_id, judiciary_role_id, category_id,
      parliament_forum_id, court_forum_id, court_chat_channel_id, statute_forum_id,
      procedure_channel_id, procedure_message_id, operations_thread_id,
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
    input.procedureChannelId ?? '',
    input.procedureMessageId ?? '',
    input.operationsThreadId ?? '',
    constitutionId,
    now,
    now
  );
  for (const [key, value] of Object.entries(OPERATIONAL_SETTING_DEFAULTS)) {
    db.prepare(`INSERT INTO governance_settings (guild_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.guildId, key, value, input.enactedBy, now);
  }
  for (const law of input.laws ?? []) {
    const proposal = db.prepare(`INSERT INTO governance_proposals
      (guild_id, kind, source, title, summary, body_json, status, proposer_id, constitution_id, vote_scope, created_at, updated_at)
      VALUES (?, 'law', 'founding', ?, ?, ?, 'enacted', ?, ?, 'none', ?, ?)`)
      .run(input.guildId, law.title, law.summary, canonicalJson(law), input.enactedBy, constitutionId, now, now);
    enactLaw({ ...law, guildId: input.guildId, constitutionId, proposalId: Number(proposal.lastInsertRowid), effectiveAt: now });
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

export function updateGovernanceGuild(guildId: string, patch: Patch): GovernanceGuild | null {
  const allowed = new Set([
    'status', 'enforcement_mode', 'trusted_role_id', 'appeal_role_id',
    'legislature_role_id', 'judiciary_role_id', 'category_id',
    'parliament_forum_id', 'court_forum_id', 'court_chat_channel_id', 'statute_forum_id',
    'procedure_channel_id', 'procedure_message_id', 'operations_thread_id',
    'active_constitution_id', 'last_session_at', 'session_retry_after',
    'session_failure_count', 'session_last_error', 'enforcement_thread_id',
    'parliament_thread_id'
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getGovernanceGuild(guildId);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_guilds SET ${sql}, updated_at = @updated_at WHERE guild_id = @guild_id`)
    .run({ guild_id: guildId, updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getGovernanceGuild(guildId);
}

export function getConstitution(id: Id | null | undefined): Constitution | null {
  return hydrateConstitution(db.prepare<[number], ConstitutionRow>('SELECT * FROM governance_constitutions WHERE id = ?').get(Number(id)));
}

export function getActiveConstitution(guildId: Id): ActiveConstitution | null {
  const constitution = hydrateConstitution(db.prepare<[string], ConstitutionRow>(`
    SELECT c.* FROM governance_guilds g
    JOIN governance_constitutions c ON c.id = g.active_constitution_id
    WHERE g.guild_id = ?
  `).get(String(guildId)));
  // EFFECTIVE_SCHEMA の規則だけを、現在の成立法令から組み立て直す。
  if (!constitution || constitution.rules?.$schema !== EFFECTIVE_SCHEMA || !isEffectiveLegalSystem(constitution.rules)) return constitution;
  const laws = listLaws(guildId, { limit: 10000 }).filter((law) => law.effective_at <= Date.now());
  let effective: CompiledLegalSystem;
  try {
    effective = compileLegalSystem({ authority: constitution.rules.authority, laws });
  } catch (error) {
    const runtime = db.prepare<[string, number], { last_snapshot_hash: string }>('SELECT last_snapshot_hash FROM governance_legal_runtime WHERE guild_id = ? AND constitution_id = ?').get(String(guildId), constitution.id);
    const baseline: LegalBaseline | null = runtime ? getLegalSnapshot(runtime.last_snapshot_hash) : {
      constitutionId: constitution.id, constitutionHash: constitution.content_hash,
      rules: constitution.rules, policy: constitution.policy, rulesHash: constitution.rules_hash
    };
    effective = compileLegalRecovery(constitution, baseline, error);
    return { ...constitution, ...effective, rules_hash: effective.rulesHash };
  }
  const hash = saveLegalSnapshot({ ...constitution, ...effective, rules_hash: effective.rulesHash });
  db.prepare(`INSERT INTO governance_legal_runtime (guild_id, constitution_id, last_snapshot_hash) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, constitution_id) DO UPDATE SET last_snapshot_hash = excluded.last_snapshot_hash
    WHERE last_snapshot_hash != excluded.last_snapshot_hash`).run(String(guildId), constitution.id, hash);
  return { ...constitution, ...effective, rules_hash: effective.rulesHash };
}

export const ensureLegalRecoveryProposal = db.transaction((guildId: string, now: number = Date.now()): Proposal | null => {
  const constitution = getActiveConstitution(guildId);
  // 修復状態は法令定義の法体系にしか生じない。
  if (!constitution?.rules?.recovery || !isEffectiveLegalSystem(constitution.rules)) return null;
  const recovery = constitution.rules.recovery;
  const existing = listProposals(guildId, { limit: 10000 }).find((proposal) => proposal.source === 'constitutional_repair'
    && proposal.workflow_handler !== 'terminal');
  if (existing) return existing;
  const repairBinding = constitution.rules.bindings.law;
  if (!repairBinding) throw new Error('修復に使う法律手続の指定がありません。');
  const interval = constitution.policy.legislation.sessionIntervalMilliseconds;
  const task = createLegalTask({ guildId, procedureId: repairBinding.target,
    snapshotHash: saveLegalSnapshot(constitution), eventKey: `${guildId}:constitutional-repair:${constitution.rules_hash}:${Math.floor(now / interval)}`,
    state: 'repair', input: { cause: recovery.cause }, now });
  if (task.status === 'completed') return null;
  const proposal = createProposal({ guildId, constitutionId: constitution.id, kind: 'law', source: 'constitutional_repair',
    title: '統治制度の修復法', summary: `憲法第十五条の暫定権限に基づき、停止した法令を復活させず代替組織法を起草する。制度の欠落: ${recovery.cause}`,
    status: constitution.rules.workflows.law.initial, voteScope: 'all' });
  updateLegalTask(task.id, { completed: true, context: { proposalId: proposal.id } });
  return proposal;
});

export type SnapshotSource = Pick<Constitution, 'id' | 'guild_id' | 'content_hash' | 'rules' | 'policy' | 'rules_hash'>;

export function saveLegalSnapshot(constitution: SnapshotSource): string {
  const content = { constitutionId: constitution.id, constitutionHash: constitution.content_hash,
    rules: constitution.rules, policy: constitution.policy, rulesHash: constitution.rules_hash };
  const hash = sha256(canonicalJson({ guildId: constitution.guild_id, ...content }));
  db.prepare(`INSERT OR IGNORE INTO governance_legal_snapshots (hash, guild_id, constitution_id, content_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hash, constitution.guild_id, constitution.id, canonicalJson(content), Date.now());
  return hash;
}

export function getLegalSnapshot(hash: string): LegalSnapshot | null {
  const row = db.prepare<[string], LegalSnapshotRow>('SELECT * FROM governance_legal_snapshots WHERE hash = ?').get(hash);
  if (!row) return null;
  // saveLegalSnapshot が書いた形だけを受け取る。壊れた snapshot は無いものとして扱う。
  const content = parseJson(row.content_json);
  if (!isRecord(content) || typeof content.constitutionId !== 'number' || typeof content.constitutionHash !== 'string') return null;
  const rules = storedRules(content.rules);
  if (!rules || !isStoredPolicy(content.policy)) return null;
  return { constitutionId: content.constitutionId, constitutionHash: content.constitutionHash, rules,
    policy: content.policy, rulesHash: typeof content.rulesHash === 'string' ? content.rulesHash : null,
    hash, guildId: row.guild_id };
}

export interface LegalTaskInput {
  guildId: string;
  procedureId: string;
  snapshotHash: string;
  eventKey: string;
  state: string;
  input: unknown;
  now?: number;
}

export function createLegalTask({ guildId, procedureId, snapshotHash, eventKey, state, input, now = Date.now() }: LegalTaskInput): LegalTask {
  db.prepare(`INSERT OR IGNORE INTO governance_legal_tasks
    (guild_id, procedure_id, snapshot_hash, event_key, state, context_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(guildId, procedureId, snapshotHash, eventKey, state, canonicalJson({ input }), now, now);
  return requireRecord(hydrateLegalTask(db.prepare<[string], LegalTaskRow>('SELECT * FROM governance_legal_tasks WHERE event_key = ?').get(eventKey)), '機関の手続');
}
function hydrateLegalTask(row: LegalTaskRow): LegalTask;
function hydrateLegalTask(row: LegalTaskRow | undefined): LegalTask | null;
function hydrateLegalTask(row: LegalTaskRow | undefined): LegalTask | null { return row ? { ...row, context: storedContext(row.context_json) } : null; }
export function getLegalTask(id: Id): LegalTask | null { return hydrateLegalTask(db.prepare<[Id], LegalTaskRow>('SELECT * FROM governance_legal_tasks WHERE id = ?').get(id)); }
export function listLegalTasks(guildId: string, { pending = true, now = Date.now() }: { pending?: boolean; now?: number } = {}): LegalTask[] {
  return db.prepare<unknown[], LegalTaskRow>(`SELECT * FROM governance_legal_tasks WHERE guild_id = ?
    ${pending ? "AND status = 'active' AND (retry_after IS NULL OR retry_after <= ?) AND (wake_at IS NULL OR wake_at <= ?)" : ''}
    ORDER BY updated_at, id LIMIT 100`).all(...(pending ? [guildId, now, now] : [guildId])).map((row) => hydrateLegalTask(row));
}
export interface LegalTaskPatch {
  state?: string;
  context?: unknown;
  wakeAt?: number | null;
  completed?: boolean;
  error?: unknown;
}
export function updateLegalTask(id: Id, { state, context, wakeAt = null, completed = false, error = null }: LegalTaskPatch): LegalTask | null {
  const task = requireRecord(getLegalTask(id), '機関の手続');
  const failures = error ? task.failure_count + 1 : 0;
  db.prepare(`UPDATE governance_legal_tasks SET state = ?, context_json = ?, wake_at = ?, status = ?,
    retry_after = ?, failure_count = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(state ?? task.state, canonicalJson(context ?? task.context), wakeAt, completed ? 'completed' : 'active',
      error ? Date.now() + Math.min(3600000, 300000 * 2 ** Math.min(failures - 1, 4)) : null,
      failures, error ? errorText(error).slice(0, 1000) : null, Date.now(), id);
  return getLegalTask(id);
}

export interface InstitutionEffectInput {
  task: LegalTask;
  eventKey: string;
  result: InstitutionTaskResult;
  effect: unknown;
  constitution: Pick<ActiveConstitution, 'id' | 'rules' | 'policy'>;
}

export const recordInstitutionEffect = db.transaction(({ task, eventKey, result, effect, constitution }: InstitutionEffectInput): unknown => {
  const old = db.prepare<[string], { result_json: string }>('SELECT result_json FROM governance_institution_effects WHERE event_key = ?').get(eventKey);
  if (old) return parseJson(old.result_json);
  let recorded: { type: string; id: number };
  if (effect === 'propose' && result.decision === 'propose') {
    const rules = requireRecord(constitution.rules, '機関の適用法令');
    const proposal = createProposal({ guildId: task.guild_id, kind: 'law', source: `institution:${task.id}`,
      title: result.output.title, summary: result.output.summary, proposerId: null,
      status: rules.workflows.law.initial, constitutionId: constitution.id, voteScope: constitution.policy.voting.defaultScope });
    recorded = { type: 'proposal', id: proposal.id };
  } else {
    const act = createAdministrativeAct({ guildId: task.guild_id, kind: 'institution_report', actorType: 'ai',
      summary: result.output.summary, detail: { taskId: task.id, procedureId: task.procedure_id,
        snapshotHash: task.snapshot_hash, outputs: result.outputs } });
    recorded = { type: 'administrative_act', id: act.id };
  }
  db.prepare('INSERT INTO governance_institution_effects (event_key, guild_id, task_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(eventKey, task.guild_id, task.id, canonicalJson(recorded), Date.now());
  return recorded;
});

export interface GovernedSubject {
  id: Id;
  guild_id: string;
  constitution_id: Id | null;
}

export function constitutionForSubject(type: string, record: GovernedSubject): Constitution | null {
  const constitution = getConstitution(record.constitution_id);
  const instance = getWorkflowInstance(type, record.id);
  if (!instance?.legal_snapshot_hash) return constitution;
  const snapshot = getLegalSnapshot(instance.legal_snapshot_hash);
  if (!snapshot || !constitution || snapshot.guildId !== record.guild_id || snapshot.constitutionId !== constitution.id) throw new Error('案件の適用法令snapshotが不正です。');
  return { ...constitution, rules: snapshot.rules, policy: snapshot.policy, rules_hash: snapshot.rulesHash };
}

export function listConstitutions(guildId: Id, { limit = 50 }: { limit?: number } = {}): Constitution[] {
  return db.prepare<[string, number], ConstitutionRow>(`
    SELECT * FROM governance_constitutions
    WHERE guild_id = ?
    ORDER BY version DESC
    LIMIT ?
  `).all(String(guildId), Number(limit)).map((row) => hydrateConstitution(row));
}

export interface EnactConstitutionInput {
  guildId: string;
  content: string;
  proposalId?: Id | null;
  enactedBy?: string;
  enactedAt?: number;
  targetConstitutionId?: Id | null;
  targetHash?: string | null;
  bootstrapLaws?: FoundingLaw[];
}

type ReviewTally = Pick<ReviewRow, 'seat' | 'verdict' | 'target_hash'>;

export const enactConstitution = db.transaction((input: EnactConstitutionInput): Constitution | null => {
  const current = getActiveConstitution(input.guildId);
  if (!current) throw new Error('有効な憲法がありません。');
  const bootstrapLaws = input.bootstrapLaws ?? [];
  if (bootstrapLaws.length) {
    const proposal = getProposal(input.proposalId);
    if (current.policy.autonomous || bootstrapLaws.length !== 1 || proposal?.source !== 'legal_migration'
      || proposal.kind !== 'amendment' || proposal.body?.content !== input.content
      || canonicalJson(proposal.body?.bootstrapLaws) !== canonicalJson(bootstrapLaws)
      || proposal.workflow_handler !== 'public_vote') throw new Error('初期法の同時成立には旧憲法下の移行改正案が必要です。');
    const currentRules = requireRecord(current.rules, '旧憲法の実行規則');
    const tally = proposalVoteSummary(proposal.id);
    const vote = currentRules.votes.constitutionalAmendment;
    const early = vote.earlyClose === 'all_ballots_cast' && tally.electorate > 0 && tally.yes + tally.no + tally.abstain === tally.electorate;
    if ((Number(proposal.stage_ends_at) > Date.now() && !early) || !closeGovernanceVote({kind:'amendment',scope:proposal.vote_scope,...tally},currentRules).passed) throw new Error('旧憲法の改憲投票が成立していません。');
    const review = listProposalDeliberations(proposal.id).at(-1)?.decision;
    if (!review || review.targetHash !== sha256(canonicalJson(proposal.body))) throw new Error('移行案とAI採択・審査対象が一致しません。');
    for (const [record,phase,verdict,seats,needed] of [
      [review.adoption,'adoption','approve',currentRules.panels.parliament.seats,currentRules.panels.parliament.required.decision],
      [review.review,'pre','constitutional',currentRules.panels.constitutional.seats,current.policy.judiciary.constitutionalVotesRequired]
    ] satisfies [unknown, string, string, number, number | undefined][]) {
      const rows=db.prepare<unknown[], ReviewTally>('SELECT seat,verdict,target_hash FROM governance_reviews WHERE guild_id=? AND target_id=? AND panel_id=? AND phase=?')
        .all(input.guildId,String(proposal.id),(isRecord(record) ? record.panelId : undefined)??'',phase);
      // 必要票が定められていなければ JS 版と同じく比較は成立しない (n < undefined は false)。
      if (rows.length!==seats || new Set(rows.map((row)=>row.seat)).size!==seats || rows.some((row)=>row.target_hash!==review.targetHash)
        || rows.filter((row)=>row.verdict===verdict).length<Number(needed)) throw new Error('移行に必要な独立した判断がありません。');
    }
  }
  const root = compileConstitution({ content: input.content });
  if (current.policy.autonomous && root.rules.$schema !== AUTHORITY_SCHEMA) throw new Error('新制度から旧schemaへの権限移行は実装されていません。');
  const compiled = root.rules.$schema === AUTHORITY_SCHEMA
    ? compileConstitution({ content: input.content, laws: [...listLaws(input.guildId, { limit: 10000 }), ...bootstrapLaws] })
    : root;
  if (input.targetConstitutionId !== undefined
    && Number(input.targetConstitutionId) !== Number(current.id)) {
    throw new Error('改正対象の憲法が審議中に更新されました。最新版を基礎に再討議が必要です。');
  }
  if (input.targetHash && input.targetHash !== current.content_hash) {
    throw new Error('改正対象の憲法本文が審議中に更新されました。最新版を基礎に再討議が必要です。');
  }
  const now = input.enactedAt ?? Date.now();
  db.prepare("UPDATE governance_constitutions SET status = 'superseded' WHERE id = ?").run(current.id);
  const inserted = db.prepare(`
    INSERT INTO governance_constitutions
      (guild_id, version, content, policy_json, content_hash, policy_hash, status, enacted_by, enacted_at, proposal_id,
       source_format, rules_json, rules_hash, compiler_version)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId,
    current.version + 1,
    input.content,
    canonicalJson(compiled.policy),
    sha256(input.content),
    sha256(canonicalJson(compiled.policy)),
    input.enactedBy ?? 'vote',
    now,
    input.proposalId ?? null,
    compiled.sourceFormat,
    canonicalJson(compiled.rules),
    compiled.rulesHash,
    compiled.compilerVersion
  );
  const id = Number(inserted.lastInsertRowid);
  updateGovernanceGuild(input.guildId, { active_constitution_id: id });
  for (const law of bootstrapLaws) enactLaw({guildId:input.guildId,proposalId:input.proposalId,constitutionId:id,
    code:law.code,title:law.title,text:law.text,provisions:law.provisions,effectiveAt:now});
  if (bootstrapLaws.length) {
    for (const proposal of listProposals(input.guildId,{limit:10000})) {
      if (proposal.id !== input.proposalId && !['public_vote','terminal'].includes(proposal.workflow_handler ?? '')) rebaseProposalLegalSystem(proposal.id,{reason:'constitutional_migration'});
    }
  }
  writeAudit({ guildId: input.guildId, actorType: 'system', action: 'constitution.enacted', targetType: 'constitution', targetId: id, detail: { version: current.version + 1, proposalId: input.proposalId } });
  return getConstitution(id);
});

export function getOperationalSetting(guildId: string, key: OperationalSettingKey): number {
  const row = db.prepare<[string, string], Pick<SettingRow, 'value'>>('SELECT value FROM governance_settings WHERE guild_id = ? AND key = ?').get(guildId, key);
  return row && Number.isFinite(row.value) ? row.value : OPERATIONAL_SETTING_DEFAULTS[key];
}

export function setOperationalSetting(guildId: string, key: string, value: number, actorId: string): void {
  // 呼び出し側の検査 (parseOperationalSetting) を通らない経路でも、設定名として使えるのは既定値を持つものだけ。
  if (!isOperationalSettingKey(key)) throw new Error('変更できない設定です。');
  db.prepare(`
    INSERT INTO governance_settings (guild_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, key, value, actorId, Date.now());
  writeAudit({ guildId, actorType: 'operator', actorId, action: 'setting.update', targetType: 'setting', targetId: key, detail: { value } });
}

export function listOperationalSettings(guildId: string): { key: OperationalSettingKey; value: number }[] {
  return Object.keys(OPERATIONAL_SETTING_DEFAULTS).filter(isOperationalSettingKey)
    .map((key) => ({ key, value: getOperationalSetting(guildId, key) }));
}

export interface GovernanceIntakeInput {
  guildId: Id;
  branch: string;
  action: string;
  requesterId: Id;
  channelId: Id;
  sourceMessageId: Id;
  payload?: unknown;
  expiresAt: number;
}

export function createGovernanceIntake(input: GovernanceIntakeInput): Intake | null {
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
  return hydrateIntake(db.prepare<[string], IntakeRow>('SELECT * FROM governance_intakes WHERE source_message_id = ?')
    .get(String(input.sourceMessageId)));
}

export function getGovernanceIntake(id: Id): Intake | null {
  return hydrateIntake(db.prepare<[number], IntakeRow>('SELECT * FROM governance_intakes WHERE id = ?').get(Number(id)));
}

export function findGovernanceIntakeByResult(guildId: Id, resultType: string, resultId: Id): Intake | null {
  return hydrateIntake(db.prepare<[string, string, string], IntakeRow>(`
    SELECT * FROM governance_intakes
    WHERE guild_id = ? AND status = 'completed' AND result_type = ? AND result_id = ?
      AND last_error IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(String(guildId), String(resultType), String(resultId)));
}

export function listPendingGovernanceIntakes(guildId: Id, now: number = Date.now()): Intake[] {
  return db.prepare<[string, number], IntakeRow>(`
    SELECT * FROM governance_intakes
    WHERE guild_id = ? AND status = 'pending' AND expires_at > ?
    ORDER BY id
  `).all(String(guildId), Number(now)).map((row) => hydrateIntake(row));
}

export interface MentionInvestigationInput {
  guildId: Id;
  branch: string;
  requesterId: Id;
  channelId: Id;
  sourceMessageId: Id;
  requestText: string;
}

export function createMentionInvestigation(input: MentionInvestigationInput): MentionInvestigation | null {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO governance_mention_investigations
      (guild_id, branch, requester_id, channel_id, source_message_id,
       request_text, request_hash, status, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', '{}', ?, ?)
  `).run(
    String(input.guildId), String(input.branch), String(input.requesterId),
    String(input.channelId), String(input.sourceMessageId), String(input.requestText),
    sha256(String(input.requestText)), now, now
  );
  return getMentionInvestigationBySource(input.sourceMessageId);
}

export function getMentionInvestigation(id: Id): MentionInvestigation | null {
  return hydrateMentionInvestigation(db.prepare<[number], MentionInvestigationRow>(
    'SELECT * FROM governance_mention_investigations WHERE id = ?'
  ).get(Number(id)));
}

export function getMentionInvestigationBySource(sourceMessageId: Id): MentionInvestigation | null {
  return hydrateMentionInvestigation(db.prepare<[string], MentionInvestigationRow>(
    'SELECT * FROM governance_mention_investigations WHERE source_message_id = ?'
  ).get(String(sourceMessageId)));
}

export function findMentionInvestigationByResult(guildId: Id, resultType: string, resultId: Id): MentionInvestigation | null {
  return hydrateMentionInvestigation(db.prepare<[string, string, string], MentionInvestigationRow>(`
    SELECT * FROM governance_mention_investigations
    WHERE guild_id = ? AND result_type = ? AND result_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(String(guildId), String(resultType), String(resultId)));
}

export function findAcceptedMentionInvestigationForCase(guildId: Id, caseId: Id): MentionInvestigation | null {
  return db.prepare<[string], MentionInvestigationRow>(`
    SELECT * FROM governance_mention_investigations
    WHERE guild_id = ? AND status = 'accepted' AND result_type = 'case'
    ORDER BY id DESC LIMIT 100
  `).all(String(guildId)).map((row) => hydrateMentionInvestigation(row)).find((entry) => {
    const caseIds: unknown = entry.result.caseIds ?? [];
    const list = isArray(caseIds) ? caseIds : [];
    // JS 版は配列でない caseIds で例外になっていた。ここでは一致なしとして扱う。
    return list.some((id) => String(id) === String(caseId));
  }) ?? null;
}

export function listStaleMentionInvestigations(guildId: Id, before: number, limit = 10): MentionInvestigation[] {
  return db.prepare<[string, number, number], MentionInvestigationRow>(`
    SELECT * FROM governance_mention_investigations
    WHERE guild_id = ? AND status = 'processing' AND updated_at <= ?
    ORDER BY updated_at, id LIMIT ?
  `).all(String(guildId), Number(before), Number(limit)).map((row) => hydrateMentionInvestigation(row));
}

export function updateMentionInvestigation(id: Id, patch: Patch): MentionInvestigation | null {
  const allowed = new Set([
    'response_message_id', 'status', 'outcome', 'result_json', 'last_error', 'completed_at',
    'result_type', 'result_id', 'record_published_at'
  ]);
  const normalized: Patch = { ...patch };
  if ('result' in normalized) {
    normalized.result_json = canonicalJson(normalized.result);
    delete normalized.result;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getMentionInvestigation(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_mention_investigations SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: Number(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  return getMentionInvestigation(id);
}

export interface InvestigationEvidenceInput {
  messageId: Id;
  channelId: Id;
  authorId: Id;
  content: string;
  contentHash?: string | null;
  occurredAt: number;
}

export function recordInvestigationEvidence(investigationId: Id, rows: readonly InvestigationEvidenceInput[], purpose: string): InvestigationEvidenceRow[] {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO governance_investigation_evidence
      (investigation_id, message_id, channel_id, author_id, content, content_hash,
       occurred_at, purpose, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const transaction = db.transaction(() => {
    for (const row of rows) insert.run(
      Number(investigationId), String(row.messageId), String(row.channelId),
      String(row.authorId), String(row.content).slice(0, 8000),
      String(row.contentHash ?? sha256(String(row.content))), Number(row.occurredAt),
      String(purpose), now
    );
  });
  transaction();
  return listInvestigationEvidence(investigationId);
}

export function listInvestigationEvidence(investigationId: Id, purpose: string | null = null): InvestigationEvidenceRow[] {
  if (purpose === null) {
    return db.prepare<[number], InvestigationEvidenceRow>(`
      SELECT * FROM governance_investigation_evidence
      WHERE investigation_id = ? ORDER BY id
    `).all(Number(investigationId));
  }
  return db.prepare<[number, string], InvestigationEvidenceRow>(`
    SELECT * FROM governance_investigation_evidence
    WHERE investigation_id = ? AND purpose = ? ORDER BY id
  `).all(Number(investigationId), String(purpose));
}

export function updateGovernanceIntake(id: Id, patch: Patch): Intake | null {
  const allowed = new Set([
    'response_message_id', 'payload_json', 'status', 'expires_at', 'result_type',
    'result_id', 'last_error'
  ]);
  const normalized: Patch = { ...patch };
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

export function claimGovernanceIntake(id: Id, requesterId: Id, now: number = Date.now()): Intake | null {
  const result = db.prepare(`
    UPDATE governance_intakes
    SET status = 'processing', updated_at = ?
    WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?
  `).run(now, Number(id), String(requesterId), now);
  return result.changes === 1 ? getGovernanceIntake(id) : null;
}

export function expireGovernanceIntakes(now: number = Date.now()): Intake[] {
  const rows = db.prepare<[number], IntakeRow>(`
    SELECT * FROM governance_intakes
    WHERE status = 'pending' AND expires_at <= ?
    ORDER BY id
  `).all(now).map((row) => hydrateIntake(row));
  if (rows.length > 0) {
    db.prepare(`
      UPDATE governance_intakes SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
  }
  return rows;
}

export interface SetupSessionInput {
  guildId: Id;
  requestedBy: Id;
  constitutionHash: string;
  policyHash: string;
  expiresAt: number;
}

export function createGovernanceSetupSession(input: SetupSessionInput): SetupSession | null {
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

export function getGovernanceSetupSession(id: Id): SetupSession | null {
  return hydrateSetupSession(db.prepare<[string], SetupSessionRow>('SELECT * FROM governance_setup_sessions WHERE id = ?').get(String(id)));
}

export function getResumableGovernanceSetup(guildId: Id): SetupSession | null {
  return hydrateSetupSession(db.prepare<[string], SetupSessionRow>(`
    SELECT * FROM governance_setup_sessions
    WHERE guild_id = ? AND status IN ('provisioning', 'failed')
    ORDER BY updated_at DESC LIMIT 1
  `).get(String(guildId)));
}

export function claimGovernanceSetupSession(id: Id, requestedBy: Id, now: number = Date.now()): SetupSession | null {
  const result = db.prepare(`
    UPDATE governance_setup_sessions
    SET status = 'provisioning', last_error = NULL, updated_at = ?
    WHERE id = ? AND requested_by = ? AND status IN ('preview', 'failed')
      AND (expires_at > ? OR resources_json <> '{}')
  `).run(now, String(id), String(requestedBy), now);
  return result.changes === 1 ? getGovernanceSetupSession(id) : null;
}

export function updateGovernanceSetupSession(id: Id, patch: Patch): SetupSession | null {
  const normalized: Patch = { ...patch };
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

export interface LegacyMessageInput {
  guildId: Id;
  channelId: Id;
  messageId: Id;
  authorId?: Id | null;
  content?: string | null;
  attachments?: unknown[];
  createdAt?: number;
  reason: string;
}

export function archiveLegacyGovernanceMessage(input: LegacyMessageInput): LegacyMessageArchiveRow | undefined {
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
  return db.prepare<[string, string, string], LegacyMessageArchiveRow>(`
    SELECT * FROM governance_legacy_message_archive
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?
  `).get(String(input.guildId), String(input.channelId), String(input.messageId));
}

export function markLegacyGovernanceMessageDeleted(guildId: Id, channelId: Id, messageId: Id): void {
  db.prepare(`
    UPDATE governance_legacy_message_archive SET deleted_at = ?
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?
  `).run(Date.now(), String(guildId), String(channelId), String(messageId));
}

export function markLegacyGovernanceChannelDeleted(guildId: Id, channelId: Id): number {
  return db.prepare(`
    UPDATE governance_legacy_message_archive SET deleted_at = COALESCE(deleted_at, ?)
    WHERE guild_id = ? AND channel_id = ?
  `).run(Date.now(), String(guildId), String(channelId)).changes;
}

export function listLegacyGovernanceMessageArchive(guildId: Id): (LegacyMessageArchiveRow & { attachments: unknown })[] {
  return db.prepare<[string], LegacyMessageArchiveRow>(`
    SELECT * FROM governance_legacy_message_archive
    WHERE guild_id = ? ORDER BY id
  `).all(String(guildId)).map((row) => ({ ...row, attachments: parseJson(row.attachments_json, []) }));
}

export interface TrustedMutationInput {
  guildId: string;
  userId: string;
  roleId: string;
  desired: boolean;
  authorizedBy: string;
  ttlMs?: number;
}

export function authorizeTrustedMutation({ guildId, userId, roleId, desired, authorizedBy, ttlMs = 60_000 }: TrustedMutationInput): number {
  const result = db.prepare(`
    INSERT INTO governance_trusted_mutations
      (guild_id, user_id, role_id, desired, authorized_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, roleId, desired ? 1 : 0, authorizedBy, Date.now() + ttlMs);
  return Number(result.lastInsertRowid);
}

export function consumeTrustedMutation({ guildId, userId, roleId, desired }: Pick<TrustedMutationInput, 'guildId' | 'userId' | 'roleId' | 'desired'>): TrustedMutationRow | null {
  const now = Date.now();
  const row = db.prepare<unknown[], TrustedMutationRow>(`
    SELECT * FROM governance_trusted_mutations
    WHERE guild_id = ? AND user_id = ? AND role_id = ? AND desired = ?
      AND consumed_at IS NULL AND expires_at >= ?
    ORDER BY id LIMIT 1
  `).get(guildId, userId, roleId, desired ? 1 : 0, now);
  if (!row) return null;
  db.prepare('UPDATE governance_trusted_mutations SET consumed_at = ? WHERE id = ?').run(now, row.id);
  return row;
}

if (!columnNames('governance_activity').has('structure_json')) {
  db.exec("ALTER TABLE governance_activity ADD COLUMN structure_json TEXT NOT NULL DEFAULT '{}'");
}
const insertActivityStmt = db.prepare(`
  INSERT INTO governance_activity
    (message_id, guild_id, channel_id, parent_id, user_id, activity_date, content_hash, content, created_at, structure_json)
  VALUES (@messageId, @guildId, @channelId, @parentId, @userId, @activityDate, @contentHash, @content, @createdAt, @structureJson)
  ON CONFLICT(message_id) DO UPDATE SET content=excluded.content, content_hash=excluded.content_hash, structure_json=excluded.structure_json
  WHERE governance_activity.content IS NOT excluded.content OR governance_activity.structure_json IS NOT excluded.structure_json
`);

export function recordActivity(row: ActivityInput | null | undefined): boolean {
  if (!row) return false;
  return insertActivityStmt.run({ structureJson: '{}', ...row }).changes > 0;
}

export const recordActivities = db.transaction((rows: readonly ActivityInput[]): number => {
  let count = 0;
  for (const row of rows) count += insertActivityStmt.run({ structureJson: '{}', ...row }).changes;
  return count;
});

export function deleteActivity(messageId: Id): boolean {
  return db.prepare('DELETE FROM governance_activity WHERE message_id = ?').run(String(messageId)).changes > 0;
}

export function activityCounts(guildId: string, userId: string, since: number): { date: string; count: number }[] {
  return db.prepare<[string, string, number], { activity_date: string; unique_count: number }>(`
    SELECT activity_date, COUNT(DISTINCT content_hash) AS unique_count
    FROM governance_activity
    WHERE guild_id = ? AND user_id = ? AND created_at >= ?
    GROUP BY activity_date
    ORDER BY activity_date
  `).all(guildId, userId, since).map((row) => ({ date: row.activity_date, count: row.unique_count }));
}

export function recentGovernanceMessages(guildId: Id, since: number, channelIds: readonly Id[], limit = 300): ActivityMessage[] {
  if (!channelIds.length) return [];
  const marks = channelIds.map(() => '?').join(',');
  const newestFirst = db.prepare<unknown[], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND created_at >= ?
      AND (channel_id IN (${marks}) OR parent_id IN (${marks})) AND content <> ''
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(String(guildId), Number(since), ...channelIds.map(String), ...channelIds.map(String), Number(limit));
  const seen = new Set<string>();
  return newestFirst.filter((row) => {
    if (seen.has(row.content_hash)) return false;
    seen.add(row.content_hash);
    return true;
  }).reverse();
}

export function recentConversationActivity(guildId: Id, channelId: Id, since: number, limit = 50): ActivityMessage[] {
  return db.prepare<[string, string, number, number], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND created_at >= ? AND content <> ''
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(String(guildId), String(channelId), Number(since), Number(limit)).reverse();
}

export function recentActorActivity(guildId: Id, userId: Id, since: number, limit = 100): ActivityMessage[] {
  return db.prepare<[string, string, number, number], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND user_id = ? AND created_at >= ? AND content <> ''
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(String(guildId), String(userId), Number(since), Number(limit)).reverse();
}

export function recentGuildActivity(guildId: Id, since: number, limit = 500): ActivityMessage[] {
  return db.prepare<[string, number, number], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND created_at >= ? AND content <> ''
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(String(guildId), Number(since), Number(limit)).reverse();
}

// 席が LIKE で粗く絞ってから n-gram で並べ替える。governance_activity に FTS は無い。
export function searchGuildActivity(guildId: Id, since: number, terms: readonly unknown[], limit = 500): ActivityMessage[] {
  const clauses = terms.map(() => 'content LIKE ? ESCAPE \'\\\'').join(' OR ');
  return db.prepare<unknown[], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND created_at >= ? AND content <> ''
      ${clauses ? `AND (${clauses})` : ''}
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(
    String(guildId),
    Number(since),
    ...terms.map((term) => `%${String(term).replace(/[\\%_]/g, '\\$&')}%`),
    Number(limit)
  ).reverse();
}

export function getActivityMessage(guildId: Id, messageId: Id): ActivityMessage | null {
  return db.prepare<[string, string], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity WHERE guild_id = ? AND message_id = ?
  `).get(String(guildId), String(messageId)) ?? null;
}

// 既出の投稿の前後を読む。同じ channel_id の中だけを時刻で辿る。
export function activityContext(guildId: Id, messageId: Id, { before = 5, after = 5 }: { before?: number; after?: number } = {}): ActivityMessage[] {
  const anchor = getActivityMessage(guildId, messageId);
  if (!anchor) return [];
  const earlier = db.prepare<[string, string, number, number, string, number], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND content <> ''
      AND (created_at < ? OR (created_at = ? AND message_id < ?))
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(
    String(guildId), String(anchor.channel_id),
    Number(anchor.created_at), Number(anchor.created_at), String(anchor.message_id),
    Math.max(0, Number(before))
  ).reverse();
  const later = db.prepare<[string, string, number, number, string, number], ActivityMessage>(`
    SELECT message_id, channel_id, parent_id, user_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND content <> ''
      AND (created_at > ? OR (created_at = ? AND message_id > ?))
    ORDER BY created_at ASC, message_id ASC LIMIT ?
  `).all(
    String(guildId), String(anchor.channel_id),
    Number(anchor.created_at), Number(anchor.created_at), String(anchor.message_id),
    Math.max(0, Number(after))
  );
  return [...earlier, anchor, ...later];
}

export interface InvestigationStepInput {
  aiCallId?: number | null;
  guildId: Id;
  purpose: string;
  seat?: number | null;
  step: number;
  tool: string;
  arguments?: unknown;
  resultCount?: number | null;
  resultSummary?: string | null;
  result?: unknown;
  error?: unknown;
}

export function recordInvestigationStep(input: InvestigationStepInput): void {
  db.prepare(`
    INSERT INTO governance_investigation_steps
      (ai_call_id, guild_id, purpose, seat, step, tool, arguments_json,
       result_count, result_summary, result_hash, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(input.aiCallId ?? 0),
    String(input.guildId),
    String(input.purpose),
    Number(input.seat ?? 0),
    Number(input.step),
    String(input.tool),
    canonicalJson(input.arguments ?? {}),
    Number(input.resultCount ?? 0),
    String(input.resultSummary ?? '').slice(0, 500),
    sha256(canonicalJson(input.result ?? null)),
    input.error ? String(input.error).slice(0, 500) : null,
    Date.now()
  );
}

export function listInvestigationSteps(aiCallId: Id): InvestigationStepRow[] {
  return db.prepare<[number], InvestigationStepRow>(
    'SELECT * FROM governance_investigation_steps WHERE ai_call_id = ? ORDER BY step'
  ).all(Number(aiCallId));
}

export function proposalDiscussion(proposalId: Id, since: number, until: number, limit = 300): DiscussionMessage[] {
  const proposal = getProposal(proposalId);
  if (!proposal?.forum_thread_id) return [];
  return db.prepare<[string, string, number, number, number], DiscussionMessage>(`
    SELECT message_id, user_id, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND created_at >= ? AND created_at <= ? AND content <> ''
    ORDER BY created_at, message_id LIMIT ?
  `).all(
    String(proposal.guild_id),
    String(proposal.forum_thread_id),
    Number(since),
    Number(until),
    Number(limit)
  );
}

// 提案スレは議題になる前から人間が討論する。proposal行の有無に関係なくthread単位で読む。
// スレそのものが提案なので、proposal行ができる前の議論も含めて全部が対象。
// 長いスレでは古い方ではなく新しい方を残す（先頭投稿だけは常に付ける）。
export function threadDiscussion(guildId: Id, threadId: Id | null, since = 0, limit = 60): DiscussionMessage[] {
  const newest = db.prepare<[string, string, number, number], DiscussionMessage>(`
    SELECT message_id, user_id, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND created_at >= ? AND content <> ''
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(String(guildId), String(threadId), Number(since), Number(limit)).reverse();
  const first = db.prepare<[string, string], DiscussionMessage>(`
    SELECT message_id, user_id, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND content <> ''
    ORDER BY created_at, message_id LIMIT 1
  `).get(String(guildId), String(threadId));
  if (first && !newest.some((row) => row.message_id === first.message_id)) newest.unshift(first);
  return newest;
}

export function threadDiscussionCount(guildId: Id, threadId: Id, since = 0): number {
  return requireRecord(db.prepare<[string, string, number], ShortCountRow>(`
    SELECT COUNT(*) c FROM governance_activity
    WHERE guild_id = ? AND channel_id = ? AND created_at >= ? AND content <> ''
  `).get(String(guildId), String(threadId), Number(since)), '集計').c;
}

export function countParliamentSessions(guildId: Id): number {
  return requireRecord(db.prepare<[string], ShortCountRow>('SELECT COUNT(*) c FROM governance_parliament_sessions WHERE guild_id = ?').get(String(guildId)), '集計').c;
}

export function setParliamentSessionMinutes(id: Id, messageId: Id): void {
  db.prepare('UPDATE governance_parliament_sessions SET minutes_message_id = ? WHERE id = ?')
    .run(String(messageId), Number(id));
}

export interface ParliamentSessionInput {
  guildId: Id;
  constitutionId: Id;
  manual?: boolean;
  agendaCount?: number;
  outcomes?: unknown[];
  startedAt: number;
}

export function recordParliamentSession({ guildId, constitutionId, manual = false, agendaCount = 0, outcomes = [], startedAt }: ParliamentSessionInput): number {
  const result = db.prepare(`
    INSERT INTO governance_parliament_sessions
      (guild_id, constitution_id, manual, agenda_count, outcomes_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(guildId), Number(constitutionId), manual ? 1 : 0,
    Number(agendaCount), canonicalJson(outcomes), Number(startedAt), Date.now()
  );
  return Number(result.lastInsertRowid);
}

export function listParliamentSessions(guildId: Id, { limit = 10 }: { limit?: number } = {}): ParliamentSession[] {
  return db.prepare<[string, number], ParliamentSessionRow>(`
    SELECT * FROM governance_parliament_sessions WHERE guild_id = ? ORDER BY id DESC LIMIT ?
  `).all(String(guildId), Number(limit)).map((row) => ({ ...row, outcomes: parseJson(row.outcomes_json, []) }));
}

export function getLawPublication(guildId: Id, instrumentType: string, instrumentId: Id): LawPublicationRow | null {
  return db.prepare<[string, string, string], LawPublicationRow>(`
    SELECT * FROM governance_law_publications
    WHERE guild_id = ? AND instrument_type = ? AND instrument_id = ?
  `).get(String(guildId), String(instrumentType), String(instrumentId)) ?? null;
}

export interface LawPublicationInput {
  guildId: Id;
  instrumentType: string;
  instrumentId: Id;
  contentHash: string;
  publicationStatus: string;
}

export function upsertLawPublication({ guildId, instrumentType, instrumentId, contentHash, publicationStatus }: LawPublicationInput): LawPublicationRow | null {
  db.prepare(`
    INSERT INTO governance_law_publications
      (guild_id, instrument_type, instrument_id, content_hash, publication_status, pushed_at)
    VALUES (@guild_id, @instrument_type, @instrument_id, @content_hash, @publication_status, @pushed_at)
    ON CONFLICT (guild_id, instrument_type, instrument_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      publication_status = excluded.publication_status,
      pushed_at = excluded.pushed_at
  `).run({
    guild_id: String(guildId),
    instrument_type: String(instrumentType),
    instrument_id: String(instrumentId),
    content_hash: String(contentHash),
    publication_status: String(publicationStatus),
    pushed_at: Date.now()
  });
  return getLawPublication(guildId, instrumentType, instrumentId);
}

export interface WorkflowInstanceInput {
  guildId: Id;
  constitutionId: Id;
  workflowKey: string;
  subjectType: string;
  subjectId: Id;
  currentState: string;
  stateEnteredAt?: number | null;
  wakeAt?: number | null;
  context?: unknown;
  status?: string;
}

export function ensureWorkflowInstance({
  guildId, constitutionId, workflowKey, subjectType, subjectId, currentState,
  stateEnteredAt = Date.now(), wakeAt = null, context = {}, status = 'active'
}: WorkflowInstanceInput): WorkflowInstance | null {
  const now = Date.now();
  const active = getActiveConstitution(guildId);
  const snapshotHash = active?.policy?.autonomous && Number(active.id) === Number(constitutionId)
    ? saveLegalSnapshot(active) : null;
  db.prepare(`
    INSERT OR IGNORE INTO governance_workflow_instances
      (guild_id, constitution_id, workflow_key, subject_type, subject_id, current_state,
       state_entered_at, wake_at, context_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(guildId), Number(constitutionId), String(workflowKey), String(subjectType), String(subjectId),
    String(currentState), Number(stateEnteredAt), wakeAt === null ? null : Number(wakeAt),
    canonicalJson(context), String(status), now, now
  );
  const instance = getWorkflowInstance(subjectType, subjectId);
  if (snapshotHash && instance && !instance.legal_snapshot_hash) {
    db.prepare('UPDATE governance_workflow_instances SET legal_snapshot_hash = ? WHERE id = ?').run(snapshotHash, instance.id);
  }
  if (instance && listWorkflowEvents(instance.id).length === 0) {
    db.prepare(`
      INSERT INTO governance_workflow_events
        (workflow_instance_id, event_type, actor_type, actor_id, from_state, to_state,
         payload_json, idempotency_key, created_at)
      VALUES (?, 'created', 'system', NULL, NULL, ?, '{}', 'created', ?)
    `).run(instance.id, String(currentState), now);
  }
  return getWorkflowInstance(subjectType, subjectId);
}

export function getWorkflowInstance(subjectType: string, subjectId: Id): WorkflowInstance | null {
  const row = db.prepare<[string, string], WorkflowInstanceRow>(`
    SELECT * FROM governance_workflow_instances WHERE subject_type = ? AND subject_id = ?
  `).get(String(subjectType), String(subjectId));
  return row ? { ...row, context: storedContext(row.context_json) } : null;
}

export function listWorkflowEvents(workflowInstanceId: Id): WorkflowEvent[] {
  return db.prepare<[number], WorkflowEventRow>(`
    SELECT * FROM governance_workflow_events WHERE workflow_instance_id = ? ORDER BY id
  `).all(Number(workflowInstanceId)).map((row) => ({ ...row, payload: parseRecord(row.payload_json, {}) }));
}

function workflowStateIsTerminal(subjectType: string, subjectId: Id, stateName: string): boolean | null {
  const handler = workflowStateHandler(subjectType, subjectId, stateName);
  return handler === null ? null : handler === 'terminal';
}

function workflowStateHandler(subjectType: string, subjectId: Id, stateName: string): string | null {
  const instance = getWorkflowInstance(subjectType, subjectId);
  if (!instance) return null;
  const snapshot = instance.legal_snapshot_hash ? getLegalSnapshot(instance.legal_snapshot_hash) : null;
  const constitution = snapshot ?? getConstitution(instance.constitution_id);
  return stateHandlerIn(constitution?.rules, instance.workflow_key, stateName);
}

export interface WorkflowTransition {
  subjectType: string;
  subjectId: Id;
  toState: string;
  eventType?: string;
  actorType?: string;
  actorId?: Id | null;
  wakeAt?: number | null;
  context?: unknown;
  payload?: unknown;
  idempotencyKey?: string | null;
  completed?: boolean;
}

export const transitionWorkflowInstance = db.transaction(({
  subjectType, subjectId, toState, eventType = 'state_changed', actorType = 'system', actorId = null,
  wakeAt = null, context = null, payload = {}, idempotencyKey = null, completed = false
}: WorkflowTransition): WorkflowInstance | null => {
  const instance = getWorkflowInstance(subjectType, subjectId);
  if (!instance) throw new Error(`workflow instanceがありません: ${subjectType}:${subjectId}`);
  if (idempotencyKey) {
    const existing = db.prepare<[number, string], WorkflowEventRow>(`
      SELECT * FROM governance_workflow_events WHERE workflow_instance_id = ? AND idempotency_key = ?
    `).get(instance.id, String(idempotencyKey));
    if (existing) return getWorkflowInstance(subjectType, subjectId);
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO governance_workflow_events
      (workflow_instance_id, event_type, actor_type, actor_id, from_state, to_state,
       payload_json, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instance.id, String(eventType), String(actorType), actorId === null ? null : String(actorId),
    instance.current_state, String(toState), canonicalJson(payload),
    idempotencyKey === null ? null : String(idempotencyKey), now
  );
  db.prepare(`
    UPDATE governance_workflow_instances
    SET current_state = ?, state_entered_at = ?, wake_at = ?,
        context_json = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(toState), String(toState) === instance.current_state ? instance.state_entered_at : now, wakeAt === null ? null : Number(wakeAt),
    context === null ? instance.context_json : canonicalJson(context),
    completed ? 'completed' : 'active', now, instance.id
  );
  return getWorkflowInstance(subjectType, subjectId);
});

export interface InstrumentRelationInput {
  guildId: Id;
  sourceType: string;
  sourceId: Id;
  relationType: string;
  targetType: string;
  targetId: Id;
  targetHash?: string | null;
  reasons?: unknown;
  decision?: unknown;
}

export function recordInstrumentRelation({
  guildId, sourceType, sourceId, relationType, targetType, targetId,
  targetHash = null, reasons = [], decision = {}
}: InstrumentRelationInput): number {
  const result = db.prepare(`
    INSERT INTO governance_instrument_relations
      (guild_id, source_type, source_id, relation_type, target_type, target_id,
       target_hash, reason_json, decision_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(guildId), String(sourceType), String(sourceId), String(relationType),
    String(targetType), String(targetId), targetHash === null ? null : String(targetHash),
    canonicalJson(reasons), canonicalJson(decision), Date.now()
  );
  return Number(result.lastInsertRowid);
}

export function listInstrumentRelations(guildId: Id, sourceType: string, sourceId: Id): InstrumentRelation[] {
  return db.prepare<[string, string, string], InstrumentRelationRow>(`
    SELECT * FROM governance_instrument_relations
    WHERE guild_id = ? AND source_type = ? AND source_id = ? ORDER BY id
  `).all(String(guildId), String(sourceType), String(sourceId)).map((row) => ({
    ...row,
    reasons: parseJson(row.reason_json, []),
    decision: parseJson(row.decision_json, {})
  }));
}

export function recentUserActivity(guildId: Id, userId: Id, channelId: Id, since: number, until: number = Date.now(), limit = 100): Omit<ActivityMessage, 'user_id'>[] {
  return db.prepare<[string, string, string, number, number, number], Omit<ActivityMessage, 'user_id'>>(`
    SELECT message_id, channel_id, parent_id, content_hash, content, created_at
    FROM governance_activity
    WHERE guild_id = ? AND user_id = ? AND channel_id = ?
      AND created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC, message_id DESC LIMIT ?
  `).all(
    String(guildId), String(userId), String(channelId), Number(since), Number(until), Number(limit)
  ).reverse();
}

export interface ProposalInput {
  guildId: string;
  kind?: string;
  source: string;
  title: string;
  summary: string;
  body?: unknown;
  status?: string;
  proposerId?: string | null;
  constitutionId: number;
  voteScope?: string;
  stageStartedAt?: number;
  stageEndsAt?: number | null;
  relationType?: string;
  targetType?: string | null;
  targetId?: Id | null;
  targetHash?: string | null;
}

export function createProposal(input: ProposalInput): Proposal {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO governance_proposals
      (guild_id, kind, source, title, summary, body_json, status, proposer_id, constitution_id,
       vote_scope, stage_started_at, stage_ends_at, relation_type, target_type, target_id, target_hash,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.relationType ?? 'new',
    input.targetType ?? null,
    input.targetId === null || input.targetId === undefined ? null : String(input.targetId),
    input.targetHash ?? null,
    now,
    now
  );
  const proposal = requireRecord(getProposal(Number(result.lastInsertRowid)), '作成した案件');
  ensureWorkflowInstance({
    guildId: proposal.guild_id,
    constitutionId: proposal.constitution_id,
    workflowKey: proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law',
    subjectType: 'proposal',
    subjectId: proposal.id,
    currentState: proposal.status,
    stateEnteredAt: proposal.stage_started_at,
    wakeAt: proposal.stage_ends_at
  });
  const aiSource = ['weekly', 'log_scan'].includes(input.source)
    || ['mention_investigation:', 'institution:'].some((prefix) => String(input.source).startsWith(prefix));
  writeAudit({ guildId: input.guildId, actorType: aiSource ? 'ai' : 'member', actorId: aiSource ? null : input.proposerId, action: 'proposal.created', targetType: 'proposal', targetId: proposal.id, detail: { kind: proposal.kind, source: proposal.source, voteScope: proposal.vote_scope } });
  return requireRecord(getProposal(proposal.id), '作成した案件');
}

export interface QueueOptions {
  blockedByProposalId?: Id | null;
  reason?: string;
  actorType?: string;
}

export const queueProposalWorkflow = db.transaction((proposalId: Id, {
  blockedByProposalId = null, reason = 'same_target_in_progress', actorType = 'system'
}: QueueOptions = {}): Proposal | null => {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error('待機対象の案件がありません。');
  const instance = getWorkflowInstance('proposal', proposal.id);
  if (!instance || instance.status === 'completed') throw new Error('終了済み案件は待機にできません。');
  if (instance.status === 'queued') return proposal;
  const now = Date.now();
  const context: WorkflowContext = {
    ...instance.context,
    queue: {
      queuedAt: now,
      blockedByProposalId: blockedByProposalId === null ? null : String(blockedByProposalId),
      reason,
      previousState: instance.current_state
    }
  };
  db.prepare(`
    INSERT INTO governance_workflow_events
      (workflow_instance_id, event_type, actor_type, actor_id, from_state, to_state,
       payload_json, idempotency_key, created_at)
    VALUES (?, 'proposal.queued', ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    instance.id, actorType, instance.current_state, instance.current_state,
    canonicalJson(context.queue), `queued:${now}`, now
  );
  db.prepare(`
    UPDATE governance_workflow_instances
    SET status = 'queued', wake_at = NULL, context_json = ?, updated_at = ?
    WHERE id = ?
  `).run(canonicalJson(context), now, instance.id);
  writeAudit({
    guildId: proposal.guild_id,
    actorType,
    action: 'proposal.queued',
    targetType: 'proposal',
    targetId: proposal.id,
    detail: context.queue
  });
  return getProposal(proposal.id);
});

export interface QueuedInputSource {
  intakeId: Id;
  userId?: Id | null;
  summary?: string | null;
  sourceType?: string;
}

export const appendQueuedProposalInput = db.transaction((proposalId: Id, {
  intakeId, userId = null, summary, sourceType = 'intake'
}: QueuedInputSource): Proposal | null => {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error('審議待ちの案件がありません。');
  const instance = getWorkflowInstance('proposal', proposal.id);
  if (!instance || instance.status !== 'queued') throw new Error('案件は審議待ちではありません。');
  const queue: ProposalQueue = { ...(instance.context.queue ?? {}) };
  const inputs = Array.isArray(queue.inputs) ? [...queue.inputs] : [];
  if (inputs.some((entry) => String(entry.intakeId) === String(intakeId))) return proposal;
  const input: QueuedInput = {
    intakeId: String(intakeId),
    userId: userId === null ? null : String(userId),
    sourceType: String(sourceType),
    summary: String(summary ?? '').trim().slice(0, 1800),
    createdAt: Date.now()
  };
  inputs.push(input);
  // Keep the queue context bounded. The original intake remains the durable
  // source record even when more than 20 equivalent requests arrive.
  queue.inputs = inputs.slice(-20);
  const context = { ...instance.context, queue };
  db.prepare(`
    UPDATE governance_workflow_instances
    SET context_json = ?, updated_at = ?
    WHERE id = ?
  `).run(canonicalJson(context), input.createdAt, instance.id);
  writeAudit({
    guildId: proposal.guild_id,
    actorType: sourceType === 'mention_investigation' ? 'ai' : 'member',
    actorId: sourceType === 'mention_investigation' ? null : userId,
    action: 'proposal.queue_input_added',
    targetType: 'proposal',
    targetId: proposal.id,
    detail: { intakeId: String(intakeId) }
  });
  return getProposal(proposal.id);
});

export interface ProposalInputSource {
  sourceId: Id;
  userId?: Id | null;
  summary?: string | null;
  sourceType?: string;
}

export const appendProposalInput = db.transaction((proposalId: Id, {
  sourceId, userId = null, summary, sourceType = 'mention_investigation'
}: ProposalInputSource): Proposal | null => {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error('関連する案件がありません。');
  const instance = getWorkflowInstance('proposal', proposal.id);
  if (!instance || instance.status === 'completed') throw new Error('関連する案件は終了しています。');
  const queue: ProposalQueue = { ...(instance.context.queue ?? {}) };
  const inputs = Array.isArray(queue.inputs) ? [...queue.inputs] : [];
  if (inputs.some((entry) => String(entry.sourceId ?? entry.intakeId) === String(sourceId))) return proposal;
  const input: QueuedInput = {
    sourceId: String(sourceId),
    userId: userId === null ? null : String(userId),
    sourceType: String(sourceType),
    summary: String(summary ?? '').trim().slice(0, 1800),
    createdAt: Date.now()
  };
  queue.inputs = [...inputs, input].slice(-20);
  db.prepare(`
    UPDATE governance_workflow_instances
    SET context_json = ?, updated_at = ?
    WHERE id = ?
  `).run(canonicalJson({ ...instance.context, queue }), input.createdAt, instance.id);
  writeAudit({
    guildId: proposal.guild_id,
    actorType: sourceType === 'mention_investigation' ? 'ai' : 'member',
    actorId: sourceType === 'mention_investigation' ? null : userId,
    action: 'proposal.input_added',
    targetType: 'proposal',
    targetId: proposal.id,
    detail: { sourceId: String(sourceId), sourceType }
  });
  return getProposal(proposal.id);
});

export interface ResumeTarget {
  constitutionId: Id;
  targetType?: string | null;
  targetId?: Id | null;
  targetHash?: string | null;
}

export const resumeQueuedProposal = db.transaction((proposalId: Id, {
  constitutionId, targetType = null, targetId = null, targetHash = null
}: ResumeTarget): Proposal | null => {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error('再開対象の案件がありません。');
  const instance = getWorkflowInstance('proposal', proposal.id);
  if (!instance || instance.status !== 'queued') throw new Error('案件は待機中ではありません。');
  const constitution = getConstitution(constitutionId);
  const workflowKey = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const initial = constitution?.rules?.workflows?.[workflowKey]?.initial;
  if (!initial) throw new Error('再開に使う憲法のworkflowがありません。');
  const now = Date.now();
  db.prepare(`
    UPDATE governance_proposals
    SET constitution_id = ?, status = ?, body_json = NULL, stage_started_at = ?, stage_ends_at = NULL,
        revision = 1, debate_extensions = 0, retry_after = NULL, failure_count = 0, last_error = NULL,
        target_type = ?, target_id = ?, target_hash = ?, updated_at = ?
    WHERE id = ?
  `).run(
    Number(constitutionId), initial, now,
    targetType, targetId === null ? null : String(targetId), targetHash,
    now, Number(proposal.id)
  );
  db.prepare(`
    INSERT INTO governance_workflow_events
      (workflow_instance_id, event_type, actor_type, actor_id, from_state, to_state,
       payload_json, idempotency_key, created_at)
    VALUES (?, 'proposal.resumed', 'system', NULL, ?, ?, ?, ?, ?)
  `).run(
    instance.id, instance.current_state, initial,
    canonicalJson({ constitutionId, targetType, targetId, targetHash }),
    `resumed:${now}`, now
  );
  const context = { ...instance.context };
  delete context.queue;
  db.prepare(`
    UPDATE governance_workflow_instances
    SET constitution_id = ?, workflow_key = ?, current_state = ?, state_entered_at = ?,
        wake_at = NULL, context_json = ?, status = 'active', updated_at = ?
    WHERE id = ?
  `).run(
    Number(constitutionId), workflowKey, initial, now,
    canonicalJson(context), now, instance.id
  );
  writeAudit({
    guildId: proposal.guild_id,
    actorType: 'system',
    action: 'proposal.resumed',
    targetType: 'proposal',
    targetId: proposal.id,
    detail: { constitutionId, targetType, targetId, targetHash }
  });
  return getProposal(proposal.id);
});

export function getProposal(id: Id | null | undefined): Proposal | null {
  return hydrateProposal(db.prepare<[number], ProposalRow>('SELECT * FROM governance_proposals WHERE id = ?').get(Number(id)));
}

export function getProposalByForumThread(threadId: Id): Proposal | null {
  return hydrateProposal(db.prepare<[string], ProposalRow>('SELECT * FROM governance_proposals WHERE forum_thread_id = ?').get(String(threadId)));
}

export function findActiveProposalByNormalizedTitle(guildId: Id, normalizedTitle: string): Proposal | null {
  const rows = db.prepare<[string, string], ProposalRow>(`
    SELECT * FROM governance_proposals
    WHERE guild_id = ? AND lower(trim(title)) = ?
    ORDER BY id DESC LIMIT 100
  `).all(String(guildId), String(normalizedTitle).trim().toLowerCase()).map((row) => hydrateProposal(row));
  return rows.find((proposal) => proposal.workflow_handler
    ? proposal.workflow_handler !== 'terminal'
    : !['enacted', 'rejected', 'remanded'].includes(proposal.status)) ?? null;
}

export function listProposals(guildId: string, { statuses = null, limit = 25 }: { statuses?: readonly string[] | null; limit?: number } = {}): Proposal[] {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare<unknown[], ProposalRow>(`SELECT * FROM governance_proposals WHERE guild_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT ?`)
      .all(guildId, ...statuses, limit).map((row) => hydrateProposal(row));
  }
  return db.prepare<[string, number], ProposalRow>('SELECT * FROM governance_proposals WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit).map((row) => hydrateProposal(row));
}

export const repairInstitutionProposalScope = db.transaction((id: Id): Proposal | null => {
  const proposal = getProposal(id);
  if (proposal?.vote_scope !== 'none' || !proposal.source.startsWith('institution:') || proposal.workflow_handler === 'terminal') return proposal;
  const constitution = constitutionForSubject('proposal', proposal);
  if (!constitution?.policy.autonomous) return proposal;
  const allowedScopes: readonly string[] = constitution.policy.voting.allowedScopes;
  if (allowedScopes.includes('none')) return proposal;
  const instance = requireRecord(getWorkflowInstance('proposal', id), '案件の手続');
  if (instance.context.publicVote?.announced || proposalElectorate(id).length || listProposalVotes(id).length) {
    throw new Error('開始済みの投票資格は変更できません。法定の再審議が必要です。');
  }
  const scope = constitution.policy.voting.defaultScope;
  db.prepare('UPDATE governance_proposals SET vote_scope = ? WHERE id = ?').run(scope, id);
  writeAudit({ guildId: proposal.guild_id, actorType: 'system', action: 'proposal.scope_repaired',
    targetType: 'proposal', targetId: id, detail: { from: 'none', to: scope, legalSnapshot: instance.legal_snapshot_hash } });
  return getProposal(id);
});

export const updateProposal = db.transaction((id: Id, patch: Patch): Proposal | null => {
  const allowed = new Set([
    'title', 'summary', 'body_json', 'status', 'forum_thread_id', 'forum_message_id',
    'stage_started_at', 'stage_ends_at', 'revision', 'deferrals',
    'retry_after', 'failure_count', 'last_error', 'relation_type', 'target_type', 'target_id', 'target_hash'
  ]);
  const normalized: Patch = { ...patch };
  if ('body' in normalized) {
    normalized.body_json = canonicalJson(normalized.body);
    delete normalized.body;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return getProposal(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_proposals SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: Number(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  const updated = requireRecord(getProposal(id), '案件');
  if ('status' in normalized) {
    const completed = workflowStateIsTerminal('proposal', id, updated.status)
      ?? ['enacted', 'rejected', 'remanded'].includes(updated.status);
    transitionWorkflowInstance({
      subjectType: 'proposal',
      subjectId: id,
      toState: updated.status,
      eventType: typeof patch.workflowEventType === 'string' ? patch.workflowEventType : 'proposal.state_changed',
      wakeAt: updated.stage_ends_at,
      payload: patch.workflowPayload ?? {},
      idempotencyKey: typeof patch.workflowIdempotencyKey === 'string' ? patch.workflowIdempotencyKey : null,
      completed
    });
  }
  return getProposal(id);
});

// 国会が改憲だと判断した議題は、同じスレのまま改憲workflowへ移す。
// 両workflowはstate名が同じなので、workflow_keyも合わせて付け替える。
export const setProposalKind = db.transaction((id: Id, kind: string): Proposal | null => {
  if (!['law', 'amendment'].includes(kind)) throw new Error('未対応の案件種別です。');
  const proposal = getProposal(id);
  if (!proposal) throw new Error('案件がありません。');
  if (proposal.kind === kind) return proposal;
  if (constitutionForSubject('proposal', proposal)?.policy.autonomous) return rebaseProposalLegalSystem(id, { kind, reason: 'kind_changed' });
  const workflowKey = kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const rules = parseJson(proposalRulesStmt.get(Number(proposal.constitution_id))?.rules_json, null);
  if (!stateIn(rules, workflowKey, proposal.status)) {
    throw new Error('現在の段階を移行先のworkflowで解釈できません。');
  }
  db.prepare('UPDATE governance_proposals SET kind = ?, updated_at = ? WHERE id = ?')
    .run(kind, Date.now(), Number(id));
  db.prepare(`
    UPDATE governance_workflow_instances SET workflow_key = ?, updated_at = ?
    WHERE subject_type = 'proposal' AND subject_id = ?
  `).run(workflowKey, Date.now(), String(id));
  return getProposal(id);
});

export const rebaseProposalLegalSystem = db.transaction((id: Id, { kind = null, reason = 'legal_system_changed' }: { kind?: string | null; reason?: string } = {}): Proposal | null => {
  const proposal = requireRecord(getProposal(id), '案件');
  const current = getActiveConstitution(proposal.guild_id);
  if (!current?.policy.autonomous) throw new Error('移行先の法令定義がありません。');
  const instance = requireRecord(getWorkflowInstance('proposal', id), '案件の手続');
  const nextKind = kind ?? proposal.kind;
  const key = nextKind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const initial = requireRecord(current.rules, '移行先の法令定義').workflows[key].initial;
  transitionWorkflowInstance({ subjectType: 'proposal', subjectId: id, toState: initial,
    eventType: 'legal.rebased', context: { inputHistory: instance.context.inputHistory ?? instance.context.queue?.inputs ?? [] }, payload: { reason, oldSnapshot: instance.legal_snapshot_hash,
      oldConstitution: proposal.constitution_id, body: proposal.body, context: instance.context,
      voters: proposalElectorate(id), votes: listProposalVotes(id) } });
  db.prepare('DELETE FROM governance_votes WHERE proposal_id = ?').run(id);
  db.prepare('DELETE FROM governance_proposal_voters WHERE proposal_id = ?').run(id);
  db.prepare(`UPDATE governance_proposals SET kind = ?, constitution_id = ?, status = ?, revision = revision + 1,
    stage_ends_at = NULL, retry_after = NULL, last_error = NULL, target_type = NULL, target_id = NULL, target_hash = NULL WHERE id = ?`)
    .run(nextKind, current.id, initial, id);
  db.prepare(`UPDATE governance_workflow_instances SET constitution_id = ?, workflow_key = ?, legal_snapshot_hash = ? WHERE id = ?`)
    .run(current.id, key, saveLegalSnapshot(current), instance.id);
  return getProposal(id);
});

export interface DeliberationInput {
  proposalId: Id;
  revision: number;
  outcome: string;
  discussion?: unknown;
  decision?: unknown;
}

export function recordProposalDeliberation({ proposalId, revision, outcome, discussion, decision }: DeliberationInput): number {
  const result = db.prepare(`
    INSERT INTO governance_proposal_deliberations
      (proposal_id, revision, outcome, discussion_json, decision_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Number(proposalId),
    Number(revision),
    String(outcome),
    canonicalJson(discussion ?? []),
    canonicalJson(decision ?? {}),
    Date.now()
  );
  return Number(result.lastInsertRowid);
}

export function listProposalDeliberations(proposalId: Id): ProposalDeliberation[] {
  return db.prepare<[number], ProposalDeliberationRow>(`
    SELECT * FROM governance_proposal_deliberations WHERE proposal_id = ? ORDER BY id
  `).all(Number(proposalId)).map((row) => {
    const parsed = parseJson(row.discussion_json, []);
    const discussion = isArray(parsed) ? parsed : [];
    return {
      ...row,
      discussion,
      decision: parseRecord(row.decision_json, {})
    };
  });
}

export interface VoterSnapshotRow {
  userId: string;
  eligibleGeneral: unknown;
  trusted: unknown;
}

export const snapshotProposalVoters = db.transaction((proposalId: Id, rows: readonly VoterSnapshotRow[]): number => {
  const instance = getWorkflowInstance('proposal', proposalId);
  if (instance?.legal_snapshot_hash) {
    if (listProposalVotes(proposalId).length) transitionWorkflowInstance({ subjectType: 'proposal', subjectId: proposalId,
      toState: instance.current_state, wakeAt: instance.wake_at, eventType: 'vote.superseded',
      payload: { voters: proposalElectorate(proposalId), votes: listProposalVotes(proposalId), targetHash: instance.context.publicVote?.targetHash } });
    db.prepare('DELETE FROM governance_votes WHERE proposal_id = ?').run(proposalId);
  }
  db.prepare('DELETE FROM governance_proposal_voters WHERE proposal_id = ?').run(proposalId);
  const insert = db.prepare(`
    INSERT INTO governance_proposal_voters (proposal_id, user_id, eligible_general, trusted, snapshotted_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const row of rows) insert.run(proposalId, row.userId, row.eligibleGeneral ? 1 : 0, row.trusted ? 1 : 0, now);
  return rows.length;
});

export function proposalVoter(proposalId: Id, userId: Id): ProposalVoterRow | null {
  return db.prepare<[number, string], ProposalVoterRow>('SELECT * FROM governance_proposal_voters WHERE proposal_id = ? AND user_id = ?')
    .get(Number(proposalId), String(userId)) ?? null;
}

export const castProposalVote = db.transaction((proposalId: Id, userId: string, choice: string) => {
  if (!['yes', 'no', 'abstain'].includes(choice)) throw new Error('無効な票です。');
  const voter = proposalVoter(proposalId, userId);
  if (!voter?.eligible_general) throw new Error('この投票scopeの有権者ではありません。');
  const proposal = getProposal(proposalId);
  if (!proposal || workflowStateHandler('proposal', proposal.id, proposal.status) !== 'public_vote'
    || Number(proposal.stage_ends_at) <= Date.now()) {
    throw new Error('この投票は受付中ではありません。');
  }
  assertVotingRights(proposal.guild_id, userId);
  const instance = getWorkflowInstance('proposal', proposalId);
  if (instance?.legal_snapshot_hash && (!instance.context.publicVote?.announced
    || instance.context.publicVote.targetHash !== sha256(canonicalJson(proposal.body)))) throw new Error('投票対象の全文公開が完了していません。');
  const old = db.prepare<[Id, string], Pick<ProposalVoteRow, 'choice'>>('SELECT choice FROM governance_votes WHERE proposal_id = ? AND user_id = ?')
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

export function proposalVoteSummary(proposalId: Id): VoteSummary {
  const counts: Record<string, number> = Object.fromEntries(db.prepare<[Id], { choice: string; count: number }>(`
    SELECT v.choice, COUNT(*) AS count
    FROM governance_votes v
    JOIN governance_proposal_voters e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
    WHERE v.proposal_id = ? AND e.eligible_general = 1
    GROUP BY v.choice
  `).all(proposalId).map((row) => [row.choice, row.count]));
  const snapshot = db.prepare<[Id], { electorate: number | null; trusted_electorate: number | null }>(`
    SELECT
      SUM(CASE WHEN eligible_general = 1 THEN 1 ELSE 0 END) AS electorate,
      SUM(CASE WHEN trusted = 1 THEN 1 ELSE 0 END) AS trusted_electorate
    FROM governance_proposal_voters WHERE proposal_id = ?
  `).get(proposalId);
  const trustedCounts = db.prepare<[Id], { yes: number | null; no: number | null; abstain: number | null }>(`
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
    trustedAbstain,
    vetoCount: humanVetoResult('proposal', proposalId).count
  };
}

export function proposalElectorate(proposalId: Id): ProposalElectorateRow[] {
  return db.prepare<[number], ProposalElectorateRow>(`
    SELECT user_id, eligible_general, trusted
    FROM governance_proposal_voters
    WHERE proposal_id = ?
    ORDER BY user_id
  `).all(Number(proposalId));
}

export function listProposalVotes(proposalId: Id): ProposalVoteRow[] {
  return db.prepare<[Id], ProposalVoteRow>(`
    SELECT v.user_id, v.choice, v.updated_at, e.trusted
    FROM governance_votes v
    JOIN governance_proposal_voters e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
    WHERE v.proposal_id = ? ORDER BY v.updated_at, v.user_id
  `).all(proposalId);
}

export interface EnactLawInput {
  guildId: string;
  proposalId?: Id | null;
  code: string;
  title?: string;
  text?: unknown;
  summary?: string;
  provisions?: LawProvisions;
  constitutionId: Id;
  effectiveAt?: number;
  supersedesLawId?: Id | null;
  targetHash?: string | null;
}

export const enactLaw = db.transaction((input: EnactLawInput): Law => {
  const text = String(input.text);
  const provisions = input.provisions;
  const constitution = getConstitution(getGovernanceGuild(input.guildId)?.active_constitution_id ?? input.constitutionId);
  if (constitution?.policy?.autonomous) {
    // 法令定義の制度では、成立後の法体系全体が組み立てられることを確かめてから成立させる。
    if (!isEffectiveLegalSystem(constitution.rules)) throw new Error('現行憲法の法体系を読めません。');
    const prospective: LawInput[] = listLaws(input.guildId, { limit: 10000 }).filter((law) => Number(law.id) !== Number(input.supersedesLawId));
    prospective.push({ code: input.code, text, provisions });
    compileLegalSystem({ authority: constitution.rules.authority, laws: prospective });
  }
  const superseded = input.supersedesLawId ? getLaw(input.supersedesLawId) : null;
  if (input.supersedesLawId && (!superseded || superseded.guild_id !== input.guildId || superseded.status !== 'active')) {
    throw new Error('改正対象の法律は現行ではありません。');
  }
  if (superseded && input.targetHash && superseded.content_hash !== input.targetHash) {
    throw new Error('改正対象の法律が審議中に更新されました。最新版を反映した再討議が必要です。');
  }
  const rootLawId = superseded?.root_law_id ?? superseded?.id ?? null;
  const version = superseded ? Number(superseded.version ?? 1) + 1 : 1;
  const result = db.prepare(`
    INSERT INTO governance_laws
      (guild_id, proposal_id, code, title, text, provisions_json, content_hash, constitution_id,
       status, effective_at, root_law_id, supersedes_law_id, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    input.guildId,
    input.proposalId,
    input.code,
    input.title,
    text,
    canonicalJson(provisions),
    sha256(`${text}\n${canonicalJson(provisions)}`),
    input.constitutionId,
    input.effectiveAt ?? Date.now(),
    rootLawId,
    superseded?.id ?? null,
    version
  );
  const lawId = Number(result.lastInsertRowid);
  if (superseded) {
    db.prepare("UPDATE governance_laws SET status = 'superseded', ended_at = ? WHERE id = ?")
      .run(input.effectiveAt ?? Date.now(), superseded.id);
  } else {
    db.prepare('UPDATE governance_laws SET root_law_id = id WHERE id = ?').run(lawId);
  }
  const law = requireRecord(getLaw(lawId), '成立した法律');
  registerSanctionDefinitions(law);
  return law;
});

export const registerSanctionDefinitions = db.transaction((law: Law | null): number => {
  const definitions = Array.isArray(law?.provisions?.sanctionDefinitions)
    ? law.provisions.sanctionDefinitions
    : [];
  if (!law) return definitions.length;
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

export function getSanctionDefinition(lawId: Id, code: string): SanctionDefinitionRecord | null {
  const row = db.prepare<[number, string], SanctionDefinitionRow>(`
    SELECT * FROM governance_sanction_definitions
    WHERE law_id = ? AND code = ? AND status = 'active'
  `).get(Number(lawId), String(code));
  return row ? { ...row, profile: parseJson(row.profile_json, null) } : null;
}

export function getLaw(id: Id | null | undefined): Law | null {
  return hydrateLaw(db.prepare<[number], LawRow>('SELECT * FROM governance_laws WHERE id = ?').get(Number(id)));
}

export function listLawVersions(lawId: Id): Law[] {
  const law = getLaw(lawId);
  if (!law) return [];
  const rootId = law.root_law_id ?? law.id;
  return db.prepare<[number], LawRow>(`
    SELECT * FROM governance_laws WHERE root_law_id = ? ORDER BY version
  `).all(Number(rootId)).map((row) => hydrateLaw(row));
}

export function getCurrentLawVersion(lawId: Id | null | undefined): Law | null {
  const law = getLaw(lawId);
  if (!law) return null;
  const rootId = law.root_law_id ?? law.id;
  return hydrateLaw(db.prepare<[number], LawRow>(`
    SELECT * FROM governance_laws WHERE root_law_id = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1
  `).get(Number(rootId)));
}

export function updateLaw(id: Id, patch: Patch): Law | null {
  // Capture the effective procedure before an invalidation removes its authority.
  const existingLaw = getLaw(id);
  if (existingLaw && patch.status && patch.status !== existingLaw.status) getActiveConstitution(existingLaw.guild_id);
  const allowed = new Set(['status', 'ended_at']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getLaw(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_laws SET ${sql} WHERE id = @id`)
    .run({ id: Number(id), ...Object.fromEntries(entries) });
  return getLaw(id);
}

export function listLaws(guildId: Id, { activeOnly = true, limit = 50 }: { activeOnly?: boolean; limit?: number } = {}): Law[] {
  const sql = activeOnly
    ? "SELECT * FROM governance_laws WHERE guild_id = ? AND status = 'active' ORDER BY effective_at DESC LIMIT ?"
    : 'SELECT * FROM governance_laws WHERE guild_id = ? ORDER BY effective_at DESC LIMIT ?';
  return db.prepare<[Id, number], LawRow>(sql).all(guildId, limit).map((row) => hydrateLaw(row));
}

export function getStatutePublication(guildId: Id, instrumentType: string, instrumentId: Id): StatutePublicationRow | null {
  return db.prepare<[string, string, string], StatutePublicationRow>(`
    SELECT * FROM governance_statute_publications
    WHERE guild_id = ? AND instrument_type = ? AND instrument_id = ?
  `).get(String(guildId), String(instrumentType), String(instrumentId)) ?? null;
}

export function listStatutePublications(guildId: Id): StatutePublicationRow[] {
  return db.prepare<[string], StatutePublicationRow>(`
    SELECT * FROM governance_statute_publications
    WHERE guild_id = ?
    ORDER BY instrument_type, id
  `).all(String(guildId));
}

export interface StatutePublicationInput {
  guildId: Id;
  instrumentType: string;
  instrumentId: Id;
  forumThreadId: Id;
  forumMessageId: Id;
  detailMessageId?: Id | null;
  publicationStatus: string;
  contentHash: string;
}

export function upsertStatutePublication(input: StatutePublicationInput): StatutePublicationRow | null {
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

export function lawAtTime(id: Id, occurredAt: number): Law | null {
  return hydrateLaw(db.prepare<[number, number, number], LawRow>(`
    SELECT * FROM governance_laws
    WHERE id = ? AND effective_at <= ? AND (ended_at IS NULL OR ended_at > ?)
      AND status IN ('active', 'superseded', 'repealed', 'unconstitutional')
  `).get(Number(id), Number(occurredAt), Number(occurredAt)));
}

// A normal amendment preserves the immutable law applicable to the alleged act.
// Suspension, repeal and unconstitutionality require relief, not silent revival.
export function lawForCase(record: Pick<CaseRecord, 'law_id' | 'alleged_at' | 'guild_id'>): Law {
  const law = getLaw(record.law_id);
  const at = Number(record.alleged_at);
  if (!law || law.guild_id !== record.guild_id || !['active', 'superseded'].includes(law.status)) {
    throw new Error('適用法が停止・失効しています。処分を進めず救済が必要です。');
  }
  if (record.alleged_at == null || !Number.isFinite(at) || at < law.effective_at
    || (law.ended_at != null && at >= law.ended_at)) throw new Error('行為時に有効な法律を確認できません。');
  return law;
}

export interface ReviewInput {
  guildId: string;
  targetType: string;
  targetId: Id;
  panelId: string;
  phase: string;
  seat: number;
  model: string;
  verdict: string;
  reasons?: unknown;
  citations?: unknown;
  inputHash: string;
  output: unknown;
  targetHash?: string | null;
}

export function recordReview(input: ReviewInput): void {
  db.prepare(`
    INSERT INTO governance_reviews
      (guild_id, target_type, target_id, panel_id, phase, seat, model, verdict, reasons_json,
       citations_json, input_hash, output_json, created_at, target_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId, input.targetType, String(input.targetId), input.panelId, input.phase, input.seat,
    input.model, input.verdict, canonicalJson(input.reasons ?? []), canonicalJson(input.citations ?? []),
    input.inputHash, canonicalJson(input.output), Date.now(), input.targetHash ?? null
  );
}

/** 成立の根拠として手続の文脈に保存した、同一案への採択と憲法審査の記録。 */
export interface LegislationProof {
  targetHash: string;
  adoption?: unknown;
  review?: unknown;
}

export const commitReviewedLegislation = db.transaction((proposalId: Id, proof: LegislationProof): { kind: string; id: number } => {
  const proposal = getProposal(proposalId);
  if (!proposal?.body) throw new Error('成立対象の本文がありません。');
  const body = proposal.body;
  const hash = sha256(canonicalJson(body));
  if (hash !== proof.targetHash) throw new Error('審査対象と成立対象が一致しません。');
  const previous = proposal.kind === 'amendment'
    ? db.prepare<[Id], { id: number }>('SELECT id FROM governance_constitutions WHERE proposal_id = ?').get(proposalId)
    : db.prepare<[Id], { id: number }>('SELECT id FROM governance_laws WHERE proposal_id = ?').get(proposalId);
  if (previous) return { kind: proposal.kind, id: previous.id };
  const pinned = constitutionForSubject('proposal', proposal);
  const current = getActiveConstitution(proposal.guild_id);
  if (current?.rules?.recovery && (proposal.source !== 'constitutional_repair' || proposal.kind !== 'law')) {
    throw new Error('暫定権限で成立できるのは制度修復法だけです。');
  }
  if (!pinned?.policy.autonomous || !current || current.content_hash !== pinned.content_hash || current.rules_hash !== pinned.rules_hash) {
    throw Object.assign(new Error('適用法令が審議中に変わりました。最新の法令で再検討します。'), { code: 'LEGAL_STALE' });
  }
  const pinnedRules = pinned.rules;
  if (!isEffectiveLegalSystem(pinnedRules)) throw new Error('法令は現在の段階に成立権限を与えていません。');
  const instance = requireRecord(getWorkflowInstance('proposal', proposalId), '案件の手続');
  const key = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const procedure = pinnedRules.workflows[key];
  if (procedure.states[instance.current_state]?.handler !== 'law_enactment') throw new Error('法令は現在の段階に成立権限を与えていません。');
  const check = (record: unknown, phase: string, verdict: string, handler: string, requiredKey: string) => {
    if (!isRecord(record) || record.targetHash !== hash) throw new Error('同一案への必要な判断記録がありません。');
    const state = typeof record.state === 'string' ? procedure.states[record.state] : undefined;
    if (state?.handler !== handler || state.config.institution !== record.institutionId) throw new Error('判断を行う機関の根拠が不正です。');
    const institution = requireRecord(typeof record.institutionId === 'string' ? pinnedRules.institutions[record.institutionId] : undefined, '判断を行う機関');
    const rows = db.prepare<unknown[], ReviewTally>(`SELECT seat, verdict, target_hash FROM governance_reviews
      WHERE guild_id = ? AND target_id = ? AND panel_id = ? AND phase = ? AND target_type = ?`)
      .all(proposal.guild_id, String(proposalId), record.panelId, phase, phase === 'adoption' ? 'proposal' : proposal.kind === 'amendment' ? 'amendment' : 'law');
    const needed = institution.required[requiredKey];
    if (needed === undefined || !Number.isInteger(needed) || rows.length !== institution.seats || new Set(rows.map((row) => row.seat)).size !== institution.seats
      || rows.some((row) => row.seat < 1 || row.seat > institution.seats)
      || rows.some((row) => row.target_hash !== hash)
      || rows.filter((row) => row.verdict === verdict).length < needed) throw new Error('独立したAI判断の必要票がありません。');
  };
  check(proof.adoption, 'adoption', 'approve', 'ai_ratification', 'approve');
  check(proof.review, 'pre', 'constitutional', 'constitutional_panel', 'constitutional');
  if (Object.values(procedure.states).some((state) => state.handler === 'public_vote')) {
    const vote = instance.context.publicVote;
    const summary = proposalVoteSummary(proposalId);
    const rule = pinnedRules.votes[key];
    const early = !rule.humanVeto && rule.earlyClose === 'all_ballots_cast' && summary.electorate > 0
      && summary.yes + summary.no + summary.abstain === summary.electorate;
    if (!vote?.announced || !vote.closed || vote.targetHash !== hash
      || procedure.states[vote.state]?.handler !== 'public_vote'
      || (Date.now() < vote.deadline && !early)
      || !closeGovernanceVote({ kind: proposal.kind, scope: proposal.vote_scope, ...summary }, pinnedRules).passed) throw new Error('同一案への人間の投票が成立していません。');
  }
  let record: { id: number } | null;
  if (proposal.kind === 'amendment') {
    record = enactConstitution({ guildId: proposal.guild_id, content: body.content ?? '',
      proposalId, enactedBy: 'ai', targetConstitutionId: proposal.target_id, targetHash: proposal.target_hash });
  } else {
    record = enactLaw({ guildId: proposal.guild_id, proposalId,
      code: `LAW-${proposalId}-R${proposal.revision}`, title: body.title,
      text: body.text, provisions: body.provisions, constitutionId: pinned.id,
      supersedesLawId: proposal.target_type === 'law' ? Number(proposal.target_id) : null,
      targetHash: proposal.target_hash });
  }
  const enacted = requireRecord(record, '成立した法令');
  const panelOf = (value: unknown) => (isRecord(value) ? value.panelId : undefined);
  writeAudit({ guildId: proposal.guild_id, actorType: 'ai', action: 'legislation.enacted', targetType: proposal.kind,
    targetId: enacted.id, detail: { proposalId, targetHash: hash, legalSnapshot: instance.legal_snapshot_hash,
      adoptionPanelId: panelOf(proof.adoption), reviewPanelId: panelOf(proof.review) } });
  enqueueAction({ guildId: proposal.guild_id, actionType: 'legislation_notice', targetId: proposalId,
    payload: { proposalId, enacted: { kind: proposal.kind, id: enacted.id } }, idempotencyKey: `legislation-enacted:${proposalId}` });
  return { kind: proposal.kind, id: enacted.id };
});

export interface CaseInput {
  guildId: string;
  kind?: string;
  reporterId: string;
  reporterType?: string;
  accusedId?: string | null;
  lawId?: Id | null;
  offenseCode?: string | null;
  challengedType?: string | null;
  challengedId?: Id | null;
  summary: string;
  status?: string;
  defenseUntil?: number | null;
  allegedAt?: number | null;
  constitutionId?: number | null;
  procedureVersion?: number;
  decisionDueAt?: number | null;
  policeEventKey?: string | null;
}

export function createCase(input: CaseInput): CaseRecord {
  if (input.kind !== 'constitutional' && getActiveConstitution(input.guildId)?.rules?.recovery) {
    throw new Error('制度修復中は新しい処罰手続を開始できません。');
  }
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO governance_cases
      (guild_id, kind, reporter_id, accused_id, law_id, offense_code, challenged_type, challenged_id,
      summary, status, defense_until, alleged_at, constitution_id, procedure_version,
      decision_due_at, police_event_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId, input.kind ?? 'criminal', input.reporterId, input.accusedId ?? null,
    input.lawId ?? null, input.offenseCode ?? null, input.challengedType ?? null,
    input.challengedId === null || input.challengedId === undefined ? null : String(input.challengedId),
    input.summary, input.status ?? 'filed', input.defenseUntil ?? null,
    input.allegedAt ?? null, input.constitutionId ?? null, input.procedureVersion ?? 1,
    input.decisionDueAt ?? null, input.policeEventKey ?? null,
    now, now
  );
  const created = requireRecord(getCase(Number(result.lastInsertRowid)), '受け付けた事件');
  if (created.constitution_id) {
    const constitution = getActiveConstitution(created.guild_id);
    const procedure = constitution?.policy.autonomous
      ? requireRecord(constitution.rules, '事件の適用法令').workflows[created.kind === 'constitutional' ? 'constitutionalCase' : 'criminalCase'] : null;
    const initial = procedure?.initial ?? created.status;
    if (procedure) {
      const initialState = requireRecord(procedure.states[initial], '事件手続の開始段階');
      db.prepare('UPDATE governance_cases SET status = ?, workflow_state = ? WHERE id = ?')
        .run(initialState.config.phase ?? initial, initial, created.id);
    }
    ensureWorkflowInstance({
      guildId: created.guild_id,
      constitutionId: created.constitution_id,
      workflowKey: created.kind === 'constitutional' ? 'constitutionalCase' : 'criminalCase',
      subjectType: 'case',
      subjectId: created.id,
      currentState: initial,
      stateEnteredAt: created.created_at,
      wakeAt: created.defense_until
    });
  }
  writeAudit({
    guildId: input.guildId,
    actorType: input.reporterType === 'ai' ? 'ai' : 'member',
    actorId: input.reporterType === 'ai' ? null : input.reporterId,
    action: 'case.filed',
    targetType: 'case',
    targetId: created.id,
    detail: { kind: created.kind, accusedId: created.accused_id }
  });
  return requireRecord(getCase(created.id), '受け付けた事件');
}

export function getCase(id: Id | null | undefined): CaseRecord | null {
  return hydrateCase(db.prepare<[number], CaseRow>('SELECT * FROM governance_cases WHERE id = ?').get(Number(id)));
}

export function getCaseByPublicThread(threadId: Id): CaseRecord | null {
  return hydrateCase(db.prepare<[string], CaseRow>('SELECT * FROM governance_cases WHERE public_thread_id = ?').get(String(threadId)));
}

export function listCases(guildId: string, { statuses = null, limit = 25 }: { statuses?: readonly string[] | null; limit?: number } = {}): CaseRecord[] {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare<unknown[], CaseRow>(`SELECT * FROM governance_cases WHERE guild_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT ?`)
      .all(guildId, ...statuses, limit).map((row) => hydrateCase(row));
  }
  return db.prepare<[string, number], CaseRow>('SELECT * FROM governance_cases WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit).map((row) => hydrateCase(row));
}

export function findCaseByPoliceEvent(guildId: Id, policeEventKey: string): CaseRecord | null {
  return hydrateCase(db.prepare<[string, string], CaseRow>(`
    SELECT * FROM governance_cases WHERE guild_id = ? AND police_event_key = ? LIMIT 1
  `).get(String(guildId), String(policeEventKey)));
}

export function findRecentPoliceCase(guildId: Id, userId: Id, lawId: Id, offenseCode: string, since: number): CaseRecord | null {
  return hydrateCase(db.prepare<[string, string, number, string, number], CaseRow>(`
    SELECT * FROM governance_cases
    WHERE guild_id = ? AND accused_id = ? AND law_id = ? AND offense_code = ?
      AND procedure_version = 2 AND police_event_key IS NOT NULL AND created_at >= ?
    ORDER BY id DESC LIMIT 1
  `).get(String(guildId), String(userId), Number(lawId), String(offenseCode), Number(since)));
}

export function findOpenConstitutionalCase(guildId: Id, challengedType: string, challengedId: Id): CaseRecord | null {
  return hydrateCase(db.prepare<[string, string, string], CaseRow>(`
    SELECT * FROM governance_cases
    WHERE guild_id = ? AND kind = 'constitutional'
      AND challenged_type = ? AND challenged_id = ?
      AND status NOT IN ('final', 'constitutional_uncertain', 'overturned', 'acquitted')
    ORDER BY id DESC LIMIT 1
  `).get(String(guildId), String(challengedType), String(challengedId)));
}

export function listOpenCasesForLaw(lawId: Id): CaseRecord[] {
  return db.prepare<[number], CaseRow>(`
    SELECT * FROM governance_cases
    WHERE law_id = ? AND status NOT IN ('final', 'overturned', 'acquitted', 'dismissed')
    ORDER BY id
  `).all(Number(lawId)).map((row) => hydrateCase(row));
}

const WORKFLOW_KEYS: readonly WorkflowKey[] = ['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase'];

export const updateCase = db.transaction((id: Id, patch: Patch): CaseRecord | null => {
  const allowed = new Set([
    'status', 'public_thread_id', 'private_thread_id', 'defense_until', 'panel_id',
    'verdict_json', 'finalized_at', 'retry_after', 'failure_count', 'last_error', 'alleged_at',
    'constitution_id', 'procedure_version', 'decision_due_at', 'response_completed_at',
    'police_event_key', 'review_count', 'redefense_count', 'workflow_state'
  ]);
  const normalized: Patch = { ...patch };
  const current = getCase(id);
  const constitution = current ? constitutionForSubject('case', current) : null;
  if ('status' in normalized && current && constitution?.policy.autonomous && normalized.status !== current.status) {
    const status = String(normalized.status);
    const instance = requireRecord(getWorkflowInstance('case', id), '事件の手続');
    const rules = requireRecord(constitution.rules, '事件の適用法令');
    const procedure = requireRecord(oneOf(WORKFLOW_KEYS, instance.workflow_key) ? rules.workflows[instance.workflow_key] : undefined, '事件の手続定義');
    const state = procedure.states[instance.current_state];
    const targetName = state?.on[status]
      ?? procedure.config.interruptions?.[status]
      ?? (state?.handler === 'terminal' ? procedure.config.reopen?.[status] : null);
    if (!targetName || !procedure.states[targetName]) throw new Error(`法律は ${instance.current_state} で ${status} の遷移を認めていません。`);
    const target = procedure.states[targetName];
    normalized.workflow_state = targetName;
    if (target.handler !== 'terminal') {
      normalized.status = target.config.phase ?? targetName;
      normalized.finalized_at = null;
    } else {
      normalized.finalized_at ??= Date.now();
      if (['completed', 'expired', 'exhausted', 'rejected'].includes(status)) normalized.status = target.config.phase ?? 'final';
    }
  }
  if ('verdict' in normalized) {
    normalized.verdict_json = canonicalJson(normalized.verdict);
    delete normalized.verdict;
  }
  const entries = Object.entries(normalized).filter(([key]) => allowed.has(key));
  if (!entries.length) return getCase(id);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_cases SET ${sql}, updated_at = @updated_at WHERE id = @id`)
    .run({ id: Number(id), updated_at: Date.now(), ...Object.fromEntries(entries) });
  const updated = requireRecord(getCase(id), '事件');
  if ('status' in normalized && getWorkflowInstance('case', id)) {
    const targetState = String(normalized.workflow_state ?? updated.workflow_state ?? updated.status);
    const completed = workflowStateIsTerminal('case', id, targetState)
      ?? ['final', 'overturned', 'acquitted', 'dismissed', 'constitutional_uncertain', 'unenforceable'].includes(updated.status);
    transitionWorkflowInstance({
      subjectType: 'case',
      subjectId: id,
      toState: targetState,
      eventType: typeof patch.workflowEventType === 'string' ? patch.workflowEventType : 'case.state_changed',
      wakeAt: updated.defense_until ?? updated.decision_due_at,
      payload: patch.workflowPayload ?? {},
      idempotencyKey: typeof patch.workflowIdempotencyKey === 'string' ? patch.workflowIdempotencyKey : null,
      completed
    });
  }
  return getCase(id);
});

export interface CaseEvidenceInput {
  caseId: Id;
  submittedBy: string;
  messageId?: string | null;
  channelId?: string | null;
  authorId?: string | null;
  content: string;
  occurredAt?: number | null;
  conversation?: unknown;
}

export function addCaseEvidence(input: CaseEvidenceInput): number {
  const result = db.prepare(`
    INSERT INTO governance_case_evidence
      (case_id, submitted_by, message_id, channel_id, author_id, content, content_hash, occurred_at, created_at, conversation_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.caseId, input.submittedBy, input.messageId ?? null, input.channelId ?? null,
    input.authorId ?? null, input.content, sha256(input.content), input.occurredAt ?? null, Date.now(),
    input.conversation ? JSON.stringify(input.conversation) : null
  );
  return Number(result.lastInsertRowid);
}

export function listCaseEvidence(caseId: Id): CaseEvidenceRow[] {
  return db.prepare<[number], CaseEvidenceRow>('SELECT * FROM governance_case_evidence WHERE case_id = ? ORDER BY id').all(Number(caseId));
}

export function markEvidenceDisclosed(id: Id, at: number = Date.now()): CaseEvidenceRow | null {
  db.prepare('UPDATE governance_case_evidence SET disclosed_at = ? WHERE id = ?').run(at, Number(id));
  return db.prepare<[number], CaseEvidenceRow>('SELECT * FROM governance_case_evidence WHERE id = ?').get(Number(id)) ?? null;
}

export function addCaseSubmission(caseId: Id, authorId: string, kind: string, content: string, { sourceMessageId = null }: { sourceMessageId?: string | null } = {}): number {
  const result = db.prepare(`
    INSERT INTO governance_case_submissions
      (case_id, author_id, kind, content, content_hash, source_message_id, superseded_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(caseId, authorId, kind, content, sha256(content), sourceMessageId, Date.now());
  return Number(result.lastInsertRowid);
}

export function listCaseSubmissions(caseId: Id): CaseSubmissionRow[] {
  return db.prepare<[number], CaseSubmissionRow>('SELECT * FROM governance_case_submissions WHERE case_id = ? ORDER BY id').all(Number(caseId));
}

export function listCurrentCaseSubmissions(caseId: Id): CaseSubmissionRow[] {
  return db.prepare<[number], CaseSubmissionRow>(`
    SELECT * FROM governance_case_submissions
    WHERE case_id = ? AND superseded_at IS NULL ORDER BY id
  `).all(Number(caseId));
}

export interface SubmissionReplacement {
  previous: CaseSubmissionRow;
  current: CaseSubmissionRow | undefined;
  unchanged?: true;
}

export const replaceCaseSubmission = db.transaction((caseId: Id, authorId: string, kind: string, content: string, sourceMessageId: string): SubmissionReplacement | null => {
  const current = db.prepare<[number, string, string], CaseSubmissionRow>(`
    SELECT * FROM governance_case_submissions
    WHERE case_id = ? AND author_id = ? AND source_message_id = ? AND superseded_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(Number(caseId), String(authorId), String(sourceMessageId));
  if (!current) return null;
  const contentHash = sha256(content);
  if (contentHash === current.content_hash) {
    return { previous: current, current, unchanged: true };
  }
  const now = Date.now();
  db.prepare('UPDATE governance_case_submissions SET superseded_at = ? WHERE id = ?').run(now, current.id);
  const result = db.prepare(`
    INSERT INTO governance_case_submissions
      (case_id, author_id, kind, content, content_hash, source_message_id, superseded_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(Number(caseId), String(authorId), String(kind), String(content), contentHash, String(sourceMessageId), now);
  return {
    previous: { ...current, superseded_at: now },
    current: db.prepare<[number], CaseSubmissionRow>('SELECT * FROM governance_case_submissions WHERE id = ?').get(Number(result.lastInsertRowid))
  };
});

export interface CaseDecisionInput {
  caseId: Id;
  panelId: string;
  phase: string;
  seat: number;
  model: string;
  verdict: string;
  lawId?: Id | null;
  offenseCode?: string | null;
  sanction?: unknown;
  evidenceIds?: unknown;
  reasons?: unknown;
  inputHash: string;
  output: unknown;
}

export function recordCaseDecision(input: CaseDecisionInput): void {
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

export function listCaseDecisions(caseId: Id, phase: string | null = null): CaseDecision[] {
  const rows = phase
    ? db.prepare<[Id, string], CaseDecisionRow>('SELECT * FROM governance_case_decisions WHERE case_id = ? AND phase = ? ORDER BY seat').all(caseId, phase)
    : db.prepare<[Id], CaseDecisionRow>('SELECT * FROM governance_case_decisions WHERE case_id = ? ORDER BY id').all(caseId);
  return rows.map((row) => ({
    ...row,
    sanction: parseJson(row.sanction_json, null),
    evidenceIds: parseJson(row.evidence_ids_json, []),
    reasons: parseJson(row.reasons_json, []),
    output: parseJson(row.output_json, {})
  }));
}

export const setCaseApproval = db.transaction((caseId: Id, userId: string, decision: string, reason = '') => {
  if (!['approve', 'reject'].includes(decision)) throw new Error('承認値が不正です。');
  const caseRecord = getCase(caseId);
  const legal = caseRecord ? constitutionForSubject('case', caseRecord) : null;
  const approval = getWorkflowInstance('case', caseId)?.context.approval;
  const sanction = legal?.policy.autonomous ? getCaseSanction(caseId) : null;
  if (legal?.policy.autonomous && (!caseRecord || caseRecord.workflow_handler !== 'human_approval' || !approval
    || approval.deadline <= Date.now() || !approval.members.includes(String(userId))
    || !sanction || approval.sanctionHash !== sanctionApprovalHash(sanction))) throw new Error('法令で定める承認の対象・資格・期限を満たしません。');
  if (caseRecord) assertVotingRights(caseRecord.guild_id, String(userId));
  // 被告・通報者は自分の事件の執行を承認も拒否もできない (旧制度でも法令定義の制度でも)。
  if (caseRecord && [caseRecord.accused_id, caseRecord.reporter_id].includes(String(userId))) {
    throw new Error('被告・通報者は執行承認できません。');
  }
  const previous = db.prepare<[number, string], CaseApprovalRow>(`
    SELECT * FROM governance_case_approvals WHERE case_id = ? AND user_id = ?
  `).get(Number(caseId), String(userId));
  db.prepare(`
    INSERT INTO governance_case_approvals (case_id, user_id, decision, reason, created_at, target_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id, user_id) DO UPDATE SET decision = excluded.decision, reason = excluded.reason, created_at = excluded.created_at, target_hash = excluded.target_hash
  `).run(caseId, userId, decision, reason, Date.now(), legal?.policy.autonomous ? approval?.sanctionHash ?? null : null);
  return {
    oldDecision: previous?.decision ?? null,
    approval: db.prepare<[number, string], CaseApprovalRow>(`
      SELECT * FROM governance_case_approvals WHERE case_id = ? AND user_id = ?
    `).get(Number(caseId), String(userId))
  };
});

export type ApprovalTarget = Pick<Sanction, 'id' | 'type' | 'duration_seconds' | 'definition_code' | 'profile' | 'required_approvals' | 'case_id'>;

export function sanctionApprovalHash(sanction: ApprovalTarget): string {
  return sha256(canonicalJson({ id: sanction.id, type: sanction.type, duration: sanction.duration_seconds,
    definition: sanction.definition_code, profile: sanction.profile, required: sanction.required_approvals,
    judgment: getCase(sanction.case_id)?.panel_id ?? null }));
}

export interface LegalApprovalResult {
  passed: boolean;
  rejected: boolean;
  approvals: number;
  vetoCount?: number;
  vetoWindowOpen?: boolean;
}

export function legalApprovalResult(caseId: Id, now: number = Date.now()): LegalApprovalResult {
  const sanction = getCaseSanction(caseId);
  const approval = getWorkflowInstance('case', caseId)?.context.approval;
  if (!sanction || !approval || approval.sanctionHash !== sanctionApprovalHash(sanction)) return { passed: false, rejected: false, approvals: 0 };
  const ballots = listCaseApprovals(caseId).filter((row) => row.target_hash === approval.sanctionHash && row.created_at >= approval.openedAt && row.created_at <= approval.deadline && approval.members.includes(row.user_id));
  const approvals = ballots.filter((row) => row.decision === 'approve').length;
  const veto = humanVetoResult('case', caseId);
  const rejected = veto.vetoed || (approval.rejectVotes > 0 && ballots.filter((row) => row.decision === 'reject').length >= approval.rejectVotes);
  const vetoWindowOpen = Boolean(approval.veto && now < approval.deadline);
  return { passed: !rejected && !vetoWindowOpen && approvals >= sanction.required_approvals,
    rejected, approvals, vetoCount: veto.count, vetoWindowOpen };
}

function humanVetoRound(subjectType: string, subjectId: Id) {
  if (!['proposal', 'case'].includes(subjectType)) throw new Error('拒否権の対象が不正です。');
  const record: Proposal | CaseRecord | null = subjectType === 'proposal' ? getProposal(subjectId) : getCase(subjectId);
  const instance = getWorkflowInstance(subjectType, subjectId);
  const period = subjectType === 'proposal' ? instance?.context.publicVote : instance?.context.approval;
  const caseSanction = subjectType === 'proposal' ? null : getCaseSanction(subjectId);
  const targetHash = subjectType === 'proposal' ? sha256(canonicalJson(record && 'body' in record ? record.body : undefined))
    : caseSanction ? sanctionApprovalHash(caseSanction) : null;
  const expectedHash = subjectType === 'proposal' ? instance?.context.publicVote?.targetHash : instance?.context.approval?.sanctionHash;
  const valid = Boolean(record && period?.veto && targetHash === expectedHash);
  return { record, period, targetHash, valid,
    key: sha256(canonicalJson({ subjectType, subjectId, targetHash, openedAt: period?.openedAt ?? null })) };
}

export function humanVetoResult(subjectType: string, subjectId: Id): { count: number; vetoed: boolean } {
  const round = humanVetoRound(subjectType, subjectId);
  const period = round.period;
  // valid なら期間と拒否権者の固定は必ずある。
  if (!round.valid || !period?.veto) return { count: 0, vetoed: false };
  const veto = period.veto;
  const rows = db.prepare<unknown[], Pick<HumanVetoRow, 'user_id' | 'created_at'>>(`SELECT user_id, created_at FROM governance_human_vetoes
    WHERE subject_type = ? AND subject_id = ? AND round_key = ? AND target_hash = ?`)
    .all(subjectType, subjectId, round.key, round.targetHash);
  const count = rows.filter((row) => veto.members.includes(row.user_id)
    && row.created_at >= period.openedAt && row.created_at < period.deadline).length;
  return { count, vetoed: count >= Number(veto.required) };
}

export const castHumanVeto = db.transaction((subjectType: string, subjectId: Id, userId: string): { count: number; vetoed: boolean } => {
  const round = humanVetoRound(subjectType, subjectId);
  const { record, period } = round;
  const handler = subjectType === 'proposal' ? 'public_vote' : 'human_approval';
  if (!round.valid || !record || !period?.veto || record.workflow_handler !== handler || period.deadline <= Date.now()
    || !period.veto.members.includes(String(userId)) || (subjectType === 'proposal' && !period.announced)) throw new Error('拒否権の対象・資格・行使期間を満たしません。');
  assertVotingRights(record.guild_id, String(userId));
  const inserted = db.prepare(`INSERT OR IGNORE INTO governance_human_vetoes
    (subject_type, subject_id, round_key, target_hash, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(subjectType, subjectId, round.key, round.targetHash, String(userId), Date.now()).changes;
  if (inserted) writeAudit({ guildId: record.guild_id, actorType: 'member', actorId: String(userId),
    action: 'human.veto', targetType: subjectType, targetId: subjectId,
    detail: { round: round.key, targetHash: round.targetHash, required: period.veto.required } });
  return humanVetoResult(subjectType, subjectId);
});

export function listCaseApprovals(caseId: Id): CaseApprovalRow[] {
  return db.prepare<[number], CaseApprovalRow>('SELECT * FROM governance_case_approvals WHERE case_id = ? ORDER BY created_at').all(Number(caseId));
}

export interface SanctionInput {
  caseId: Id;
  guildId: string;
  userId: string;
  type: string;
  durationSeconds?: number | null;
  status: string;
  requiredApprovals: number;
  appealable?: unknown;
  appealDeadline?: number | null;
  restrictionStartedAt?: number | null;
  executionKey?: string;
  definitionCode?: string | null;
  profile?: unknown;
}

export function createSanction(input: SanctionInput): Sanction | null {
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

function hydrateSanction(row: SanctionRow): Sanction {
  return { ...row, profile: parseJson(row.profile_json, null) };
}

export function getSanction(id: Id | null | undefined): Sanction | null {
  const row = db.prepare<[number], SanctionRow>('SELECT * FROM governance_sanctions WHERE id = ?').get(Number(id));
  return row ? hydrateSanction(row) : null;
}

export function getCaseSanction(caseId: Id): Sanction | null {
  const row = db.prepare<[number], SanctionRow>('SELECT * FROM governance_sanctions WHERE case_id = ?').get(Number(caseId));
  return row ? hydrateSanction(row) : null;
}

export function listSanctions(guildId: string, statuses: readonly string[] | null = null): Sanction[] {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare<unknown[], SanctionRow>(`SELECT * FROM governance_sanctions WHERE guild_id = ? AND status IN (${marks}) ORDER BY id`)
      .all(guildId, ...statuses).map(hydrateSanction);
  }
  return db.prepare<[string], SanctionRow>('SELECT * FROM governance_sanctions WHERE guild_id = ? ORDER BY id').all(guildId)
    .map(hydrateSanction);
}

export function listContestableSanctions(guildId: Id, userId: Id): Sanction[] {
  return db.prepare<[string, string, number], SanctionRow>(`
    SELECT s.* FROM governance_sanctions s
    JOIN governance_cases c ON c.id = s.case_id
    WHERE s.guild_id = ? AND s.user_id = ? AND c.procedure_version = 2
      AND c.review_count = 0
      AND (
        (s.type = 'warning' AND s.status IN ('executed', 'simulated', 'reviewable'))
        OR (s.type IN ('restriction', 'timeout') AND s.status IN ('executed', 'simulated', 'reviewable')
          AND (s.restriction_started_at IS NULL OR s.restriction_started_at + COALESCE(s.duration_seconds, 0) * 1000 > ?))
      )
    ORDER BY s.id DESC
  `).all(String(guildId), String(userId), Date.now())
    .map(hydrateSanction);
}

export function listSanctionsForLaw(lawId: Id): Sanction[] {
  return db.prepare<[number], SanctionRow>(`
    SELECT s.* FROM governance_sanctions s
    JOIN governance_cases c ON c.id = s.case_id
    WHERE c.law_id = ? AND s.status NOT IN ('reversed')
    ORDER BY s.id
  `).all(Number(lawId)).map(hydrateSanction);
}

export function updateSanction(id: Id, patch: Patch): Sanction | null {
  const allowed = new Set([
    'type', 'duration_seconds', 'status', 'required_approvals', 'appealable', 'appeal_deadline',
    'restriction_started_at', 'executed_at', 'reversed_at', 'execution_detail',
    'definition_code', 'profile_json', 'review_requested_at', 'notice_delivered'
  ]);
  const normalized: Patch = { ...patch };
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

export interface RestrictionActivation {
  sanctionId: Id;
  guildId: string;
  userId: string;
  definitionId: Id;
  profile: unknown;
  startedAt: number;
  endsAt: number;
}

export function activateRestriction({ sanctionId, guildId, userId, definitionId, profile, startedAt, endsAt }: RestrictionActivation): void {
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

export function activeRestrictions(guildId: string, userId: string, now: number = Date.now()): ActiveRestriction[] {
  return db.prepare<[string, string, number], ActiveRestrictionRow>(`
    SELECT * FROM governance_active_restrictions
    WHERE guild_id = ? AND user_id = ? AND status = 'active' AND ends_at > ?
    ORDER BY ends_at
  `).all(guildId, userId, now).map((row) => ({ ...row, profile: parseJson(row.profile_json, {}) }));
}

/** 有効な制限のうち、指定した制御の規則。profile は法令の制限定義から作って保存したもの。 */
export function restrictionRules(restriction: Pick<ActiveRestriction, 'profile'>, primitive: string): UnknownRecord[] {
  const profile = restriction.profile;
  const rules = isRecord(profile) && isArray(profile.rules) ? profile.rules : [];
  return rules.filter(isRecord).filter((rule) => rule.primitive === primitive);
}

// 制裁で投票権を止められた人 (block_voting・拘留中) は、投票・執行承認・拒否権のどれも行使できない。
// restrictions.ts の governanceActionAllowed(…, 'vote') と同じ判定を、票を書き込む場所でも確かめる。
function assertVotingRights(guildId: string, userId: string, now: number = Date.now()): void {
  const suspended = activeDetentions(guildId, userId, now).length > 0
    || activeRestrictions(guildId, userId, now).some((restriction) => restrictionRules(restriction, 'block_voting').length > 0);
  if (suspended) throw new Error('投票権が制裁により停止されています。');
}

export function expireRestrictions(now: number = Date.now()): number {
  return db.prepare(`
    UPDATE governance_active_restrictions SET status = 'expired'
    WHERE status = 'active' AND ends_at <= ?
  `).run(now).changes;
}

export function deactivateRestrictionForSanction(sanctionId: Id, status = 'reversed'): number {
  return db.prepare(`
    UPDATE governance_active_restrictions SET status = ?
    WHERE sanction_id = ? AND status = 'active'
  `).run(status, sanctionId).changes;
}

export interface DetentionInput {
  caseId: Id;
  guildId: Id;
  userId: Id;
  reason: unknown;
  durationSeconds: number;
  startedAt: number;
  endsAt: number;
  status: string;
}

// 拘留は罰ではない保全なので、刑ではなく事件へ紐づけて時間だけを持つ。
export function createDetention({ caseId, guildId, userId, reason, durationSeconds, startedAt, endsAt, status }: DetentionInput): DetentionRow | null {
  const now = Date.now();
  db.prepare(`
    INSERT INTO governance_detentions
      (case_id, guild_id, user_id, reason, duration_seconds, started_at, ends_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(caseId), String(guildId), String(userId), String(reason).slice(0, 500),
    Number(durationSeconds), Number(startedAt), Number(endsAt), String(status), now
  );
  return getCaseDetention(caseId);
}

export function getCaseDetention(caseId: Id): DetentionRow | null {
  return db.prepare<[number], DetentionRow>('SELECT * FROM governance_detentions WHERE case_id = ?').get(Number(caseId)) ?? null;
}

export function activeDetentions(guildId: Id, userId: Id, now: number = Date.now()): DetentionRow[] {
  return db.prepare<[string, string, number], DetentionRow>(`
    SELECT * FROM governance_detentions
    WHERE guild_id = ? AND user_id = ? AND status = 'active' AND ends_at > ?
  `).all(String(guildId), String(userId), Number(now));
}

export function releaseDetention(caseId: Id, now: number = Date.now()): DetentionRow | null {
  db.prepare("UPDATE governance_detentions SET status = 'released', released_at = ? WHERE case_id = ? AND status = 'active'")
    .run(Number(now), Number(caseId));
  return getCaseDetention(caseId);
}

export function expireDetentions(now: number = Date.now()): DetentionRow[] {
  const rows = db.prepare<[number], DetentionRow>("SELECT * FROM governance_detentions WHERE status = 'active' AND ends_at <= ?").all(Number(now));
  if (rows.length) {
    db.prepare("UPDATE governance_detentions SET status = 'expired', released_at = ? WHERE status = 'active' AND ends_at <= ?")
      .run(Number(now), Number(now));
  }
  return rows;
}

// 拘留された時間は、同じ事件で後から科す期間処分の刑期から差し引く。
export function detainedSeconds(caseId: Id, now: number = Date.now()): number {
  const row = getCaseDetention(caseId);
  if (!row) return 0;
  const until = row.released_at ?? Math.min(now, row.ends_at);
  return Math.max(0, Math.floor((until - row.started_at) / 1000));
}

export interface InterimProtectionInput {
  caseId: Id;
  guildId: Id;
  userId: Id;
  lawId: Id;
  offenseCode: string;
  triggerType: string;
  minimumEvents: number;
  observedEvents: number;
  windowSeconds: number;
  durationSeconds: number;
  evidenceMessageId: Id;
  evidenceChannelId: Id;
  startedAt: number;
  endsAt: number;
  status: string;
}

export function createInterimProtection(input: InterimProtectionInput): InterimProtectionRow | null {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO governance_interim_protections
      (case_id, guild_id, user_id, law_id, offense_code, trigger_type,
       minimum_events, observed_events, window_seconds, duration_seconds,
       evidence_message_id, evidence_channel_id, started_at, ends_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(input.caseId), String(input.guildId), String(input.userId), Number(input.lawId),
    String(input.offenseCode), String(input.triggerType), Number(input.minimumEvents),
    Number(input.observedEvents), Number(input.windowSeconds), Number(input.durationSeconds),
    String(input.evidenceMessageId), String(input.evidenceChannelId), Number(input.startedAt),
    Number(input.endsAt), String(input.status), now
  );
  return getInterimProtection(Number(result.lastInsertRowid));
}

export function getInterimProtection(id: Id): InterimProtectionRow | null {
  return db.prepare<[number], InterimProtectionRow>('SELECT * FROM governance_interim_protections WHERE id = ?').get(Number(id)) ?? null;
}

export function getCaseInterimProtection(caseId: Id): InterimProtectionRow | null {
  return db.prepare<[number], InterimProtectionRow>('SELECT * FROM governance_interim_protections WHERE case_id = ?').get(Number(caseId)) ?? null;
}

export function listInterimProtections(guildId: Id, statuses: readonly string[] | null = null): InterimProtectionRow[] {
  if (statuses?.length) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare<unknown[], InterimProtectionRow>(`
      SELECT * FROM governance_interim_protections
      WHERE guild_id = ? AND status IN (${marks}) ORDER BY id
    `).all(String(guildId), ...statuses.map(String));
  }
  return db.prepare<[string], InterimProtectionRow>(`
    SELECT * FROM governance_interim_protections WHERE guild_id = ? ORDER BY id
  `).all(String(guildId));
}

export function activeInterimProtections(guildId: Id, userId: Id, now: number = Date.now()): InterimProtectionRow[] {
  return db.prepare<[string, string, number], InterimProtectionRow>(`
    SELECT p.* FROM governance_interim_protections p
    JOIN governance_guilds g ON g.guild_id = p.guild_id
    WHERE p.guild_id = ? AND p.user_id = ? AND p.status = 'active'
      AND p.ends_at > ? AND g.enforcement_mode = 'live'
    ORDER BY p.ends_at
  `).all(String(guildId), String(userId), Number(now));
}

export function expireInterimProtections(now: number = Date.now()): InterimProtectionRow[] {
  const expired = db.prepare<[number], InterimProtectionRow>(`
    SELECT * FROM governance_interim_protections
    WHERE status = 'active' AND ends_at <= ? ORDER BY id
  `).all(Number(now));
  if (expired.length > 0) {
    db.prepare(`
      UPDATE governance_interim_protections SET status = 'expired', ended_at = ?
      WHERE status = 'active' AND ends_at <= ?
    `).run(Number(now), Number(now));
  }
  return expired.map((row) => ({ ...row, status: 'expired', ended_at: Number(now) }));
}

export function endInterimProtection(caseId: Id, status = 'released', now: number = Date.now()): InterimProtectionRow | null {
  if (!['released', 'expired', 'cancelled', 'e2e_completed'].includes(status)) {
    throw new Error('一時保全の終了状態が不正です。');
  }
  db.prepare(`
    UPDATE governance_interim_protections SET status = ?, ended_at = ?
    WHERE case_id = ? AND status IN ('active', 'simulated')
  `).run(status, Number(now), Number(caseId));
  return getCaseInterimProtection(caseId);
}

export function restrictionUsageCount(restrictionId: Id, kind: string, since: number): number {
  return requireRecord(db.prepare<[Id, string, number], CountRow>(`
    SELECT COUNT(*) AS count FROM governance_restriction_usage
    WHERE restriction_id = ? AND kind = ? AND created_at >= ?
  `).get(restrictionId, kind, since), '集計').count;
}

export function restrictionUsageWindow(restrictionId: Id, kind: string, since: number): { count: number; oldest: number | null } {
  const row = requireRecord(db.prepare<[Id, string, number], { count: number; oldest: number | null }>(`
    SELECT COUNT(*) AS count, MIN(created_at) AS oldest
    FROM governance_restriction_usage
    WHERE restriction_id = ? AND kind = ? AND created_at >= ?
  `).get(restrictionId, kind, since), '集計');
  return { count: row.count, oldest: row.oldest === null ? null : Number(row.oldest) };
}

export function recordRestrictionUsage(restrictionId: Id, kind: string, eventId: Id | null | undefined): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO governance_restriction_usage (restriction_id, kind, event_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(restrictionId, kind, eventId ?? null, Date.now()).changes > 0;
}

export function createAppeal(caseId: Id, appellantId: string, grounds: string): { id: number; caseId: Id; appellantId: string; grounds: string; status: string; panelId: string } {
  const panelId = randomUUID();
  const result = db.prepare(`
    INSERT INTO governance_appeals (case_id, appellant_id, grounds, status, panel_id, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(caseId, appellantId, grounds, panelId, Date.now());
  return { id: Number(result.lastInsertRowid), caseId, appellantId, grounds, status: 'pending', panelId };
}

export function getAppeal(caseId: Id): AppealRow | null {
  return db.prepare<[number], AppealRow>('SELECT * FROM governance_appeals WHERE case_id = ?').get(Number(caseId)) ?? null;
}

export function updateAppeal(caseId: Id, patch: Patch): AppealRow | null {
  const allowed = new Set(['status', 'decided_at']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getAppeal(caseId);
  const sql = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE governance_appeals SET ${sql} WHERE case_id = @case_id`)
    .run({ case_id: Number(caseId), ...Object.fromEntries(entries) });
  return getAppeal(caseId);
}

export interface AuditInput {
  guildId: string;
  actorType: string;
  actorId?: Id | null;
  action: string;
  targetType?: string | null;
  targetId?: Id | null;
  detail?: unknown;
}

export function writeAudit({ guildId, actorType, actorId = null, action, targetType = null, targetId = null, detail = {} }: AuditInput): number {
  const result = db.prepare(`
    INSERT INTO governance_audit
      (guild_id, actor_type, actor_id, action, target_type, target_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, actorType, actorId, action, targetType, targetId === null ? null : String(targetId), canonicalJson(detail), Date.now());
  return Number(result.lastInsertRowid);
}

export function listAudit(guildId: string, limit = 50): AuditEntry[] {
  return db.prepare<[string, number], AuditRow>('SELECT * FROM governance_audit WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit).map((row) => ({ ...row, detail: parseJson(row.detail_json, {}) }));
}

export interface AdministrativeActInput {
  guildId: string;
  kind: string;
  actorType?: string;
  actorId?: string | null;
  summary: string;
  detail?: unknown;
}

export function createAdministrativeAct({ guildId, kind, actorType = 'operator', actorId = null, summary, detail = {} }: AdministrativeActInput): AdministrativeAct {
  const result = db.prepare(`
    INSERT INTO governance_administrative_acts
      (guild_id, kind, actor_type, actor_id, summary, detail_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(guildId, kind, actorType, actorId, summary, canonicalJson(detail), Date.now());
  const act = requireRecord(getAdministrativeAct(Number(result.lastInsertRowid)), '作成した行政行為');
  writeAudit({ guildId, actorType, actorId, action: 'administrative_act.created', targetType: 'administrative_act', targetId: act.id, detail: { kind } });
  return act;
}

export function getAdministrativeAct(id: Id): AdministrativeAct | null {
  return hydrateAdministrativeAct(db.prepare<[number], AdministrativeActRow>('SELECT * FROM governance_administrative_acts WHERE id = ?').get(Number(id)));
}

export function listAdministrativeActs(guildId: Id, limit = 50): AdministrativeAct[] {
  return db.prepare<[string, number], AdministrativeActRow>('SELECT * FROM governance_administrative_acts WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(guildId), Number(limit)).map((row) => hydrateAdministrativeAct(row));
}

export function updateAdministrativeAct(id: Id, patch: Patch): AdministrativeAct | null {
  const allowed = new Set(['status', 'reversed_at', 'detail_json']);
  const normalized: Patch = { ...patch };
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

export function getGovernanceNotification(eventKey: unknown): NotificationRow | null {
  return db.prepare<[string], NotificationRow>('SELECT * FROM governance_notifications WHERE event_key = ?').get(String(eventKey)) ?? null;
}

export interface NotificationClaim {
  guildId: Id;
  eventKey: string;
  eventType: string;
  audienceKind: string;
  audienceId?: Id | null;
  limit?: unknown;
  suppressionReason?: string | null;
  now?: number;
}

export interface NotificationClaimResult {
  action: 'send' | 'skip' | 'suppressed';
  notification: NotificationRow | null;
}

const claimNotificationTransaction = db.transaction((input: NotificationClaim): NotificationClaimResult => {
  const guildId = String(input.guildId);
  const eventKey = String(input.eventKey);
  const eventType = String(input.eventType);
  const audienceKind = String(input.audienceKind);
  const audienceId = input.audienceId === null || input.audienceId === undefined
    ? null
    : String(input.audienceId);
  const limit = Math.max(0, Number(input.limit) || 0);
  const forcedSuppression = input.suppressionReason ? String(input.suppressionReason).slice(0, 500) : null;
  const now = Number(input.now ?? Date.now());
  const existing = getGovernanceNotification(eventKey);
  if (existing) {
    if (existing.status === 'failed' && existing.attempts < 3) {
      db.prepare(`
        UPDATE governance_notifications
        SET status = 'sending', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE event_key = ?
      `).run(now, eventKey);
      return { action: 'send', notification: getGovernanceNotification(eventKey) };
    }
    return { action: 'skip', notification: existing };
  }
  const audienceClause = audienceKind === 'user' ? 'AND audience_id = ?' : '';
  const parameters = audienceKind === 'user'
    ? [guildId, audienceKind, audienceId, now - DAY_MS]
    : [guildId, audienceKind, now - DAY_MS];
  const delivered = requireRecord(db.prepare<unknown[], CountRow>(`
    SELECT COUNT(*) AS count FROM governance_notifications
    WHERE guild_id = ? AND audience_kind = ? ${audienceClause}
      AND status = 'delivered' AND delivered_at >= ?
  `).get(...parameters), '集計').count;
  const suppressed = Boolean(forcedSuppression) || limit === 0 || delivered >= limit;
  db.prepare(`
    INSERT INTO governance_notifications
      (guild_id, event_key, event_type, audience_kind, audience_id, status, attempts,
       last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId,
    eventKey,
    eventType,
    audienceKind,
    audienceId,
    suppressed ? 'suppressed' : 'sending',
    suppressed ? 0 : 1,
    suppressed
      ? (forcedSuppression ?? (limit === 0 ? 'notifications disabled by limit' : '24 hour notification limit reached'))
      : null,
    now,
    now
  );
  return { action: suppressed ? 'suppressed' : 'send', notification: getGovernanceNotification(eventKey) };
});

export function claimGovernanceNotification(input: NotificationClaim): NotificationClaimResult {
  if (!String(input.eventKey ?? '').startsWith('governance:')) throw new Error('通知キーが不正です。');
  if (!['everyone', 'trusted_role', 'user'].includes(input.audienceKind)) throw new Error('通知対象が不正です。');
  return claimNotificationTransaction(input);
}

export interface NotificationReconcile {
  guildId: Id;
  eventKey: string;
  eventType: string;
  audienceKind: string;
  audienceId?: Id | null;
  channelId?: Id | null;
  messageId?: Id | null;
  deliveredAt?: number | null;
}

export function reconcileGovernanceNotification(input: NotificationReconcile): NotificationRow | null {
  const now = Number(input.deliveredAt ?? Date.now());
  db.prepare(`
    INSERT INTO governance_notifications
      (guild_id, event_key, event_type, audience_kind, audience_id, status, attempts,
       channel_id, message_id, last_error, created_at, updated_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, 'reconciled', 0, ?, ?, 'existing message found; notification not repeated', ?, ?, NULL)
    ON CONFLICT(event_key) DO UPDATE SET
      status = CASE
        WHEN governance_notifications.status IN ('delivered', 'suppressed', 'reconciled') THEN governance_notifications.status
        ELSE 'reconciled'
      END,
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      last_error = CASE
        WHEN governance_notifications.status IN ('delivered', 'suppressed', 'reconciled') THEN governance_notifications.last_error
        ELSE excluded.last_error
      END,
      updated_at = excluded.updated_at
    WHERE governance_notifications.status IN ('sending', 'failed')
  `).run(
    String(input.guildId), String(input.eventKey), String(input.eventType), String(input.audienceKind),
    input.audienceId === null || input.audienceId === undefined ? null : String(input.audienceId),
    input.channelId === null || input.channelId === undefined ? null : String(input.channelId),
    input.messageId === null || input.messageId === undefined ? null : String(input.messageId),
    now, now
  );
  return getGovernanceNotification(input.eventKey);
}

export function completeGovernanceNotification(eventKey: string, { channelId = null, messageId = null }: { channelId?: Id | null; messageId?: Id | null } = {}): NotificationRow | null {
  const now = Date.now();
  db.prepare(`
    UPDATE governance_notifications
    SET status = 'delivered', channel_id = ?, message_id = ?, last_error = NULL,
      delivered_at = ?, updated_at = ?
    WHERE event_key = ? AND status = 'sending'
  `).run(channelId === null ? null : String(channelId), messageId === null ? null : String(messageId), now, now, String(eventKey));
  return getGovernanceNotification(eventKey);
}

export function failGovernanceNotification(eventKey: string, error: unknown): NotificationRow | null {
  db.prepare(`
    UPDATE governance_notifications
    SET status = 'failed', last_error = ?, updated_at = ?
    WHERE event_key = ? AND status = 'sending'
  `).run(errorText(error).slice(0, 500), Date.now(), String(eventKey));
  return getGovernanceNotification(eventKey);
}

export interface NotificationStats {
  delivered: number;
  suppressed: number;
  failed: number;
  reconciled: number;
}

export function governanceNotificationStats(guildId: Id, since: number = Date.now() - DAY_MS): NotificationStats {
  const rows = db.prepare<[string, number], { status: string; count: number }>(`
    SELECT status, COUNT(*) AS count FROM governance_notifications
    WHERE guild_id = ? AND updated_at >= ?
    GROUP BY status
  `).all(String(guildId), Number(since));
  const stats: NotificationStats = { delivered: 0, suppressed: 0, failed: 0, reconciled: 0 };
  for (const row of rows) {
    if (row.status === 'delivered' || row.status === 'suppressed' || row.status === 'failed' || row.status === 'reconciled') {
      stats[row.status] = Number(row.count);
    }
  }
  return stats;
}

export function listNotificationFailures(guildId: Id, limit = 10): NotificationRow[] {
  return db.prepare<[string, number], NotificationRow>(`
    SELECT * FROM governance_notifications
    WHERE guild_id = ? AND status = 'failed'
    ORDER BY updated_at DESC LIMIT ?
  `).all(String(guildId), Number(limit));
}

export function retryFailedNotifications(guildId: Id): number {
  return db.prepare(`
    UPDATE governance_notifications
    SET attempts = 0, updated_at = ?
    WHERE guild_id = ? AND status = 'failed'
  `).run(Date.now(), String(guildId)).changes;
}

export interface OutboxInput {
  guildId: string;
  actionType: string;
  targetId?: Id | null;
  payload: unknown;
  idempotencyKey: string;
}

export function enqueueAction({ guildId, actionType, targetId = null, payload, idempotencyKey }: OutboxInput): OutboxRow | undefined {
  db.prepare(`
    INSERT OR IGNORE INTO governance_outbox
      (guild_id, action_type, target_id, payload_json, idempotency_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(guildId, actionType, targetId === null ? null : String(targetId), canonicalJson(payload), idempotencyKey, Date.now());
  return db.prepare<[string], OutboxRow>('SELECT * FROM governance_outbox WHERE idempotency_key = ?').get(idempotencyKey);
}

export function pendingActions(limit = 25): OutboxAction[] {
  return db.prepare<[number, number], OutboxRow>(`SELECT * FROM governance_outbox WHERE status IN ('pending', 'error')
    AND (attempts < 5 OR action_type = 'sanction_reverse') AND (retry_after IS NULL OR retry_after <= ?)
    ORDER BY id LIMIT ?`).all(Date.now(), limit).map((row) => ({ ...row, payload: parseRecord(row.payload_json, {}) }));
}

export function listActionFailures(guildId: Id, limit = 10): OutboxAction[] {
  return db.prepare<[string, number], OutboxRow>(`
    SELECT * FROM governance_outbox
    WHERE guild_id = ? AND status = 'error'
    ORDER BY id DESC LIMIT ?
  `).all(String(guildId), limit).map((row) => ({ ...row, payload: parseRecord(row.payload_json, {}) }));
}

export function retryFailedActions(guildId: Id): number {
  return db.prepare(`
    UPDATE governance_outbox
    SET status = 'pending', attempts = 0, last_error = NULL, retry_after = NULL
    WHERE guild_id = ? AND status = 'error'
  `).run(String(guildId)).changes;
}

export function markActionRunning(id: Id): boolean {
  return db.prepare(`UPDATE governance_outbox SET status = 'running', attempts = attempts + 1 WHERE id = ?
    AND status IN ('pending', 'error') AND (attempts < 5 OR action_type = 'sanction_reverse')
    AND (retry_after IS NULL OR retry_after <= ?)`).run(id, Date.now()).changes === 1;
}

export function completeAction(id: Id): void {
  db.prepare("UPDATE governance_outbox SET status = 'completed', completed_at = ?, last_error = NULL WHERE id = ?")
    .run(Date.now(), id);
}

export function failAction(id: Id, error: unknown): void {
  const action = db.prepare<[Id], Pick<OutboxRow, 'action_type' | 'attempts'>>('SELECT action_type, attempts FROM governance_outbox WHERE id = ?').get(id);
  const retryAfter = action?.action_type === 'sanction_reverse'
    ? Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(action.attempts - 1, 6)) : null;
  db.prepare("UPDATE governance_outbox SET status = 'error', last_error = ?, retry_after = ? WHERE id = ?")
    .run(String(error).slice(0, 500), retryAfter, id);
}

export function startAiCall(guildId: string, purpose: string, model: string, inputHash: string): number {
  const result = db.prepare(`
    INSERT INTO governance_ai_calls (guild_id, purpose, model, input_hash, status, created_at)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(guildId, purpose, model, inputHash, Date.now());
  return Number(result.lastInsertRowid);
}

export function finishAiCall(id: Id, { output = null, error = null }: { output?: unknown; error?: unknown }): void {
  db.prepare(`
    UPDATE governance_ai_calls
    SET status = ?, output_hash = ?, error = ?, finished_at = ? WHERE id = ?
  `).run(error ? 'error' : 'ok', output ? sha256(canonicalJson(output)) : null, error ? String(error).slice(0, 500) : null, Date.now(), id);
}

export interface AgentAttemptReservation {
  ok: boolean;
  used: number;
  limit: number;
  retryAt?: number | null;
}

export function reserveAgentAttempt(guildId: string, userId: string, trusted: unknown, limit: number, windowMs: number = DAY_MS, kind = 'agent'): AgentAttemptReservation {
  const now = Date.now();
  const usage = requireRecord(db.prepare<[string, string, string, number], { count: number; oldest: number | null }>(`
    SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM governance_agent_attempts
    WHERE guild_id = ? AND user_id = ? AND kind = ? AND created_at >= ?
  `).get(guildId, userId, kind, now - windowMs), '集計');
  const used = usage.count;
  if (limit === 0) return { ok: false, used, limit, retryAt: null };
  if (limit > 0 && used >= limit) {
    return { ok: false, used, limit, retryAt: Number(usage.oldest ?? now) + windowMs };
  }
  db.prepare('INSERT INTO governance_agent_attempts (guild_id, user_id, trusted, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, userId, trusted ? 1 : 0, kind, now);
  return { ok: true, used: used + 1, limit };
}

export function pruneGovernance(keepMs: number = 90 * 86_400_000): void {
  const cutoff = Date.now() - keepMs;
  db.prepare('DELETE FROM governance_agent_attempts WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM governance_activity WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM governance_restriction_usage WHERE created_at < ?').run(cutoff);
  db.prepare("DELETE FROM governance_intakes WHERE status != 'pending' AND updated_at < ?").run(cutoff);
  db.prepare("DELETE FROM governance_mention_investigations WHERE status IN ('completed', 'failed') AND updated_at < ?").run(cutoff);
  db.prepare("DELETE FROM governance_setup_sessions WHERE status IN ('completed', 'expired') AND updated_at < ?").run(cutoff);
  db.prepare("DELETE FROM governance_notifications WHERE status != 'sending' AND updated_at < ?").run(cutoff);
}

export { db as governanceDatabase };
