// 統治AIの席が自分で調べるための読み取り専用ツール。
//
// 母集団は公開活動の記録・権限を確認したアーカイブ・統治DB。
// 席が挙げた証拠は最終的に revalidateInvestigationEvidence がDiscordから再取得して
// ハッシュ照合するので、ここで返すのは「どれを見に行くか」を決めるための索引にすぎない。
//
// 席が引用できるIDは、その席が実際にこのツールで取得したIDだけに限る。retrieved が
// その台帳で、幻の証拠を弾く唯一の検算になる。
import {
  activityContext,
  getActiveConstitution,
  getCase,
  getOperationalSetting,
  listCaseEvidence,
  listCaseDecisions,
  listCases,
  listCurrentCaseSubmissions,
  listLaws,
  recentActorActivity,
  recentGovernanceMessages,
  searchGuildActivity
} from './db.js';
import { contextRelevance } from './context.js';
import { IMPLEMENTED_TOOLS } from './rules.js';
import { archiveEnvelope } from '../conversation/message.js';
import { db as archive } from '../archive/db.js';
import { hasVisibilityClient, publicChannels as publicChannelIds } from '../archive/visibility.js';
import { normalizeActivityContent, sha256 } from './policy.js';
import {
  arrayOf,
  isActivityRow,
  isCaseRow,
  isConstitutionRow,
  isDecisionRow,
  isEvidenceRow,
  isLawRow,
  isNumber,
  isRecord,
  isString,
  isSubmissionRow,
  narrow,
  narrowList,
  shape,
  type ActivityRow,
  type InvestigationStep,
  type RecordTool,
  type RetrievedRecord,
  type RowTool,
  type ToolArgs,
  type ToolContext,
  type ToolDefinition,
  type ToolRow,
  type Toolset,
  type ToolsetOptions
} from './types-service.js';

const DAY_MS = 86_400_000;
// 一覧の要約だけを短くする。証拠本文・条文には適用せずページで全文を返す。
const CONTENT_LIMIT = 240;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAXIMUM_LOOKBACK_DAYS = 90;
const MAXIMUM_ROWS = 30;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function since(context: ToolContext, days: unknown): number {
  const fallback = context.defaultLookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  return Date.now() - boundedInteger(days, fallback, 1, MAXIMUM_LOOKBACK_DAYS) * DAY_MS;
}

// 席に渡す原文と状態。全文が届いた場合だけ同じ内容を引用台帳へ入れる。
function messageView(row: ToolRow) {
  return {
    id: String(row.message_id),
    channelId: String(row.channel_id),
    authorId: String(row.user_id),
    content: String(row.content ?? ''),
    at: Number(row.created_at),
    conversation: row.conversation ?? archiveEnvelope({ ...row, author_id: row.user_id })
  };
}

function evidenceRow(row: ToolRow): RetrievedRecord {
  return {
    messageId: String(row.message_id),
    channelId: String(row.channel_id),
    authorId: String(row.user_id),
    content: String(row.content ?? ''),
    contentHash: String(row.content_hash),
    occurredAt: Number(row.created_at),
    ...(row.source ? { source: row.source } : {})
  };
}

// LIKE で粗く絞ってから既存の n-gram 関連度で並べ替える。二文字未満の断片は
// ほぼ全件に当たるので落とす。
function searchTerms(query: unknown): string[] {
  return String(query ?? '')
    .split(/[\s、。,.：:；;「」『』（）()\[\]]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);
}

const activityRows = (value: unknown): ActivityRow[] => narrowList(value, isActivityRow, 'activity');

function parseJsonText(value: string): unknown {
  return JSON.parse(value);
}

const TOOLS: Record<string, RowTool | RecordTool> = {
  search_messages: {
    rows: true,
    description: 'Search public logs kept by the governance system. Returns matching messages ranked by relevance.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for. Japanese or English.' },
        days: { type: 'integer', description: `How many days back to look, 1-${MAXIMUM_LOOKBACK_DAYS}.` },
        limit: { type: 'integer', description: `How many messages to return, 1-${MAXIMUM_ROWS}.` }
      },
      required: ['query']
    },
    run(context, args) {
      const terms = searchTerms(args['query']);
      const limit = boundedInteger(args['limit'], 15, 1, MAXIMUM_ROWS);
      const pool = activityRows(searchGuildActivity(context.guildId, since(context, args['days']), terms, 500));
      return pool
        .map((row) => ({ row, score: contextRelevance(String(args['query'] ?? ''), row.content) }))
        .sort((left, right) => right.score - left.score || right.row.created_at - left.row.created_at)
        .slice(0, limit)
        .map((entry) => entry.row);
    }
  },
  read_user_messages: {
    rows: true,
    description: 'Read one member\'s recent public messages in time order.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Discord user id.' },
        days: { type: 'integer', description: `How many days back, 1-${MAXIMUM_LOOKBACK_DAYS}.` },
        limit: { type: 'integer', description: `How many messages, 1-${MAXIMUM_ROWS}.` }
      },
      required: ['userId']
    },
    run(context, args) {
      return activityRows(recentActorActivity(
        context.guildId,
        String(args['userId'] ?? ''),
        since(context, args['days']),
        boundedInteger(args['limit'], 15, 1, MAXIMUM_ROWS)
      ));
    }
  },
  read_channel: {
    rows: true,
    description: 'Read recent public messages of one channel or thread in time order.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel or thread id.' },
        days: { type: 'integer', description: `How many days back, 1-${MAXIMUM_LOOKBACK_DAYS}.` },
        limit: { type: 'integer', description: `How many messages, 1-${MAXIMUM_ROWS}.` }
      },
      required: ['channelId']
    },
    run(context, args) {
      return activityRows(recentGovernanceMessages(
        context.guildId,
        since(context, args['days']),
        [String(args['channelId'] ?? '')],
        boundedInteger(args['limit'], 15, 1, MAXIMUM_ROWS)
      ));
    }
  },
  read_context: {
    rows: true,
    description: 'Read the messages immediately before and after one message in the same channel.',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Discord message id.' },
        before: { type: 'integer', description: 'How many earlier messages, 0-20.' },
        after: { type: 'integer', description: 'How many later messages, 0-20.' }
      },
      required: ['messageId']
    },
    run(context, args) {
      return activityRows(activityContext(context.guildId, String(args['messageId'] ?? ''), {
        before: boundedInteger(args['before'], 4, 0, 10),
        after: boundedInteger(args['after'], 4, 0, 10)
      }));
    }
  },
  read_constitution: {
    description: 'Read the constitution. Without an article heading it returns the list of headings; with one it returns that article in full.',
    parameters: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'Exact Markdown heading text, e.g. 第八条（立法）. Omit to list every heading.' }
      },
      required: []
    },
    run(context, args) {
      const constitution = context.constitution ?? narrow(getActiveConstitution(context.guildId), isConstitutionRow, 'constitution');
      if (!constitution) return { error: 'no active constitution' };
      const content = String(constitution.content ?? '');
      const sections = content.split(/^## /m).slice(1)
        .map((part) => ({ heading: (part.split('\n')[0] ?? '').trim(), body: '## ' + part.trim() }));
      const heading = String(args['heading'] ?? '').trim();
      if (!heading) {
        return { version: constitution.version, headings: sections.map((entry) => entry.heading) };
      }
      const found = sections.find((entry) => entry.heading === heading)
        ?? sections.find((entry) => entry.heading.includes(heading));
      if (!found) return { error: `unknown heading: ${heading}`, headings: sections.map((entry) => entry.heading) };
      return { version: constitution.version, heading: found.heading, text: found.body };
    }
  },
  read_law: {
    description: 'Read one enacted law in full, including its articles, offenses, and sanction definitions.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Law code such as LAW-1-R1. Omit to list every enacted law.' }
      },
      required: []
    },
    run(context, args) {
      const laws = narrowList(listLaws(context.guildId, { activeOnly: false, limit: 200 }), isLawRow, 'law');
      const code = String(args['code'] ?? '').trim();
      if (!code) {
        return laws.map((law) => ({
          id: law.id, code: law.code, title: law.title, status: law.status, effectiveAt: law.effective_at
        }));
      }
      const law = laws.find((entry) => entry.code === code);
      if (!law) return { error: `unknown law code: ${code}` };
      return {
        id: law.id,
        code: law.code,
        title: law.title,
        status: law.status,
        effectiveAt: law.effective_at,
        text: law.text,
        provisions: law.provisions
      };
    }
  },
  read_cases: {
    description: 'List past cases, optionally only those of one accused member.',
    parameters: {
      type: 'object',
      properties: {
        accusedId: { type: 'string', description: 'Discord user id. Omit for every recent case.' },
        limit: { type: 'integer', description: 'How many cases, 1-25.' }
      },
      required: []
    },
    run(context, args) {
      const accusedId = String(args['accusedId'] ?? '').trim();
      return narrowList(listCases(context.guildId, { limit: boundedInteger(args['limit'], 10, 1, 25) }), isCaseRow, 'case')
        .filter((entry) => !accusedId || String(entry.accused_id) === accusedId)
        .map((entry) => ({
          id: entry.id,
          status: entry.status,
          accusedId: entry.accused_id,
          lawId: entry.law_id,
          offenseCode: entry.offense_code,
          summary: String(entry.summary ?? '').slice(0, CONTENT_LIMIT),
          createdAt: entry.created_at
        }));
    }
  },
  read_precedent: {
    description: 'Read how earlier panels decided the same offense, with their reasons and sanctions.',
    parameters: {
      type: 'object',
      properties: {
        lawId: { type: 'integer', description: 'Enacted law id.' },
        offenseCode: { type: 'string', description: 'Offense code such as O1. Omit for every offense of the law.' },
        limit: { type: 'integer', description: 'How many cases, 1-10.' }
      },
      required: ['lawId']
    },
    run(context, args) {
      const lawId = Number(args['lawId']);
      const offenseCode = String(args['offenseCode'] ?? '').trim();
      const cases = narrowList(listCases(context.guildId, { limit: 100 }), isCaseRow, 'case')
        .filter((entry) => Number(entry.law_id) === lawId
          && (!offenseCode || entry.offense_code === offenseCode)
          && Number(entry.id) !== Number(context.caseId ?? 0))
        .slice(0, boundedInteger(args['limit'], 5, 1, 10));
      return cases.map((entry) => ({
        caseId: entry.id,
        status: entry.status,
        offenseCode: entry.offense_code,
        summary: String(entry.summary ?? '').slice(0, CONTENT_LIMIT),
        decisions: narrowList(listCaseDecisions(entry.id), isDecisionRow, 'case decision').map((decision) => ({
          phase: decision.phase,
          seat: decision.seat,
          verdict: decision.verdict,
          sanction: decision.sanction_json ? parseJsonText(decision.sanction_json) : null,
          reasons: reasonList(parseJsonText(decision.reasons_json ?? '[]')).slice(0, 2)
        }))
      }));
    }
  },
  read_case_record: {
    description: 'Read the admitted evidence and the written answers of one case.',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'integer', description: 'Case id. Omit for the case under review.' }
      },
      required: []
    },
    run(context, args) {
      const caseId = Number(args['caseId'] ?? context.caseId ?? 0);
      const caseRecord = narrow(getCase(caseId), isCaseRow, 'case');
      if (!caseRecord || String(caseRecord.guild_id) !== String(context.guildId)) {
        return { error: `unknown case: ${caseId}` };
      }
      return {
        id: caseRecord.id,
        status: caseRecord.status,
        accusedId: caseRecord.accused_id,
        summary: caseRecord.summary,
        evidence: narrowList(listCaseEvidence(caseId), isEvidenceRow, 'case evidence').map((row) => ({
          id: String(row.message_id ?? row.id),
          channelId: String(row.channel_id ?? ''),
          authorId: String(row.author_id ?? ''),
          content: String(row.content ?? ''),
          contentHash: String(row.content_hash ?? ''),
          at: Number(row.occurred_at ?? 0),
          conversation: row.conversation_json ? parseJsonText(row.conversation_json) : { metadata: 'legacy_incomplete' }
        })),
        submissions: narrowList(listCurrentCaseSubmissions(caseId), isSubmissionRow, 'case submission').map((row) => ({
          authorId: row.author_id,
          kind: row.kind,
          content: String(row.content ?? '')
        }))
      };
    }
  }
};

// 判例の理由は JSON 配列で保存している。配列でなければ slice できないので空にする。
function reasonList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('判例の理由が配列ではありません。');
  return value;
}

// 正本は rules.js（循環importを避けるため）。ここで登録漏れ・余りを起動時に弾く。
const implementedTools: readonly string[] = narrowList(IMPLEMENTED_TOOLS, isString, 'implemented tool');
{
  const registered = Object.keys(TOOLS).sort().join(',');
  if (registered !== [...implementedTools].sort().join(',')) {
    throw new Error(`調査手段の実装と実行規則の一覧がずれています: ${registered}`);
  }
}
export { IMPLEMENTED_TOOLS };

export function toolDefinitions(allowed: readonly string[]): ToolDefinition[] {
  return allowed.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) return [];
    return [{
      type: 'function' as const,
      function: {
        name,
        description: tool.description,
        parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
          offset: { type: 'integer', description: 'For a paged result, repeat the same arguments with nextOffset until complete. Offsets count JSON characters.' }
        } }
      }
    }];
  });
}

function summarize(name: string, args: ToolArgs, result: unknown): { count: number; detail: string } {
  const count = Array.isArray(result) ? result.length : (isRecord(result) && result['error'] ? 0 : 1);
  const detail = name === 'search_messages' ? `「${String(args['query'] ?? '').slice(0, 40)}」`
    : name === 'read_user_messages' ? `対象者 ${String(args['userId'] ?? '').slice(0, 24)}`
      : name === 'read_channel' ? `channel ${String(args['channelId'] ?? '').slice(0, 24)}`
        : name === 'read_context' ? `記録 ${String(args['messageId'] ?? '').slice(0, 24)} の前後`
          : name === 'read_law' ? (args['code'] ? String(args['code']).slice(0, 24) : '法令一覧')
            : name === 'read_precedent' ? `法 ${String(args['lawId'] ?? '?')} の過去の判断`
              : name === 'read_constitution' ? (args['heading'] ? String(args['heading']).slice(0, 24) : '憲法の目次')
                : name === 'read_cases' ? '事件一覧'
                : `事件 ${String(args['caseId'] ?? '当件')}`;
  return { count, detail };
}

// アーカイブの行。全文の差し替えと現存確認に content と deleted だけを使う。
const isArchiveSource = shape({ content: isString, deleted: isNumber });
const isArchiveMessage = shape({ content: isString });

const isRetrievedRecord = shape({
  messageId: isString,
  channelId: isString,
  authorId: isString,
  content: isString,
  contentHash: isString,
  occurredAt: isNumber
});
const isRetrievedEntry = (value: unknown): value is [string, RetrievedRecord] => (
  Array.isArray(value) && value.length === 2 && isString(value[0]) && isRetrievedRecord(value[1])
);
const isPageRange = (value: unknown): value is [number, number] => (
  Array.isArray(value) && value.length === 2 && isNumber(value[0]) && isNumber(value[1])
);
const isPageEntry = (value: unknown): value is [string, [number, number][]] => (
  Array.isArray(value) && value.length === 2 && isString(value[0]) && arrayOf(isPageRange)(value[1])
);
const isInvestigationStep = shape({
  step: isNumber,
  tool: isString,
  count: isNumber,
  detail: isString
});
// 途中で止まった調査の保存点。checkpoint() が書いたものを読み戻す。
const isCheckpoint = shape({
  trace: arrayOf(isInvestigationStep),
  retrieved: arrayOf(isRetrievedEntry),
  spentBytes: isNumber,
  pages: (value: unknown): value is [string, [number, number][]][] | undefined => value === undefined || arrayOf(isPageEntry)(value)
});

/** 席が出したツール呼び出しの引数。JSON object 以外は受け付けない。 */
function parseToolArguments(rawArguments: unknown): ToolArgs | null {
  try {
    const parsed: unknown = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : (rawArguments ?? {});
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 席ごとに1つ作る。retrieved はその席が実際に見たIDの台帳で、引用の検算に使う。
export function buildToolset({ guildId, allowed, caseId = null, constitution = null, maximumOutputBytes = 10 * 1024, onStep }: ToolsetOptions): Toolset {
  const lookback: unknown = getOperationalSetting(String(guildId), 'investigation_lookback_days');
  const context: ToolContext = {
    guildId: String(guildId),
    caseId,
    constitution,
    defaultLookbackDays: isNumber(lookback) ? lookback : DEFAULT_LOOKBACK_DAYS
  };
  const permitted = new Set(allowed.filter((name) => name in TOOLS));
  const retrieved = new Map<string, RetrievedRecord>();
  const trace: InvestigationStep[] = [];
  let spentBytes = 0;
  const pages = new Map<string, [number, number][]>();
  const record = (entry: InvestigationStep) => { trace.push(entry); onStep?.(entry); };
  const visibleChannels = (): Set<string> => new Set(narrowList(publicChannelIds(guildId), isString, 'public channel'));
  const toolset: Toolset = {
    readOnly: true,
    call(name, args) { return toolset.run(name, args); },
    exhausted: () => spentBytes >= maximumOutputBytes,
    checkpoint: () => ({ trace, retrieved: [...retrieved], spentBytes, pages: [...pages] }),
    assertCurrent() {
      const publicChannels = visibleChannels();
      const invalid = (message: string) => Object.assign(new Error(message), { code: 'AGENT_CONTEXT_INVALIDATED' });
      for (const row of retrieved.values()) {
        if (row.source !== 'archive') continue;
        if (hasVisibilityClient() && !publicChannels.has(String(row.channelId))) throw invalid('Investigative source is no longer public');
        const source = narrow(archive.prepare('SELECT content, deleted FROM messages WHERE guild_id = ? AND message_id = ?')
          .get(String(guildId), row.messageId), isArchiveSource, 'archive message');
        if (!source || source.deleted || source.content !== row.content) throw invalid('Investigative source changed; the record must be refreshed');
      }
    },
    restore(saved) {
      if (!saved) return;
      if (!isCheckpoint(saved)) throw new TypeError('調査の保存点の形が想定と違います。');
      // 保存点は checkpoint() が書いた trace そのもの (形は上で確かめた)。
      trace.splice(0, trace.length, ...saved.trace.map((entry) => ({ arguments: null, error: null, ...entry })));
      for (const [id, row] of saved.retrieved) retrieved.set(id, row);
      for (const [id, entry] of saved.pages ?? []) pages.set(id, entry);
      spentBytes = saved.spentBytes;
    },
    definitions: toolDefinitions([...permitted]),
    retrieved,
    trace,
    get steps() {
      return trace.length;
    },
    get spentBytes() {
      return spentBytes;
    },
    async run(name, rawArguments) {
      const step = trace.length + 1;
      const toolName = String(name);
      // 最悪ケースを固定する。予算を使い切ったらツールを閉じて結論へ行かせる。
      if (spentBytes >= maximumOutputBytes) {
        const error = 'investigation output budget spent; stop calling tools and answer now';
        record({ step, tool: toolName, arguments: rawArguments, count: 0, detail: '予算切れ', error });
        return { error };
      }
      const tool = permitted.has(toolName) ? TOOLS[toolName] : undefined;
      if (!tool) {
        const error = `tool not permitted by the constitution: ${toolName}`;
        record({ step, tool: toolName, arguments: rawArguments, count: 0, detail: '許可外', error });
        return { error };
      }
      const args = parseToolArguments(rawArguments);
      if (!args) {
        const error = 'arguments must be a JSON object';
        record({ step, tool: toolName, arguments: rawArguments, count: 0, detail: '引数不正', error });
        return { error };
      }
      let rows: ToolRow[] | null = null;
      let raw: unknown;
      if (tool.rows) {
        rows = tool.run(context, args);
        // Prefer the full archived source only within currently public channels.
        const channels = visibleChannels();
        if (hasVisibilityClient()) rows = rows.filter((row) => channels.has(String(row.channel_id)));
        rows = rows.map((row) => {
          if (!channels.has(String(row.channel_id))) return row;
          const source: unknown = archive.prepare('SELECT * FROM messages WHERE guild_id = ? AND message_id = ? AND deleted = 0')
            .get(String(guildId), String(row.message_id));
          return isArchiveMessage(source)
            ? { ...row, source: 'archive', content: source.content, content_hash: sha256(normalizeActivityContent(source.content)), conversation: archiveEnvelope(source) }
            : row;
        });
        raw = rows;
      } else {
        raw = tool.run(context, args);
      }
      const fullView: unknown = rows ? rows.map(messageView) : raw;
      const serialized = JSON.stringify(fullView ?? null);
      const remaining = Math.max(0, maximumOutputBytes - spentBytes);
      const pageBytes = Math.min(6000, remaining);
      let view: unknown = fullView;
      let fullyObserved = Buffer.byteLength(serialized) <= pageBytes;
      if (!fullyObserved) {
        const offset = boundedInteger(args['offset'], 0, 0, serialized.length);
        const identity = sha256(serialized);
        let end = Math.min(serialized.length, offset + pageBytes);
        const page = () => ({ page: { encoding: 'json_fragment', documentHash: identity, offset, nextOffset: end < serialized.length ? end : null,
          totalCharacters: serialized.length, content: serialized.slice(offset, end) } });
        view = page();
        while (end > offset && Buffer.byteLength(JSON.stringify(view)) > pageBytes) { end -= 1; view = page(); }
        if (end === offset) { spentBytes = maximumOutputBytes; return { error: 'Output budget exhausted; remaining content was not observed' }; }
        const ranges = [...(pages.get(identity) ?? []), [offset, end] satisfies [number, number]].sort((a, b) => a[0] - b[0]);
        let through = 0;
        for (const [start, finish] of ranges) { if (start > through) break; through = Math.max(through, finish); }
        pages.set(identity, ranges);
        fullyObserved = through >= serialized.length;
      }
      // Only complete, actually delivered records can become newly cited evidence.
      if (fullyObserved) {
        if (rows) {
          for (const row of rows) retrieved.set(String(row.message_id), evidenceRow(row));
        }
        const evidence = isRecord(raw) && Array.isArray(raw['evidence']) ? raw['evidence'] : [];
        for (const row of evidence) {
          if (isRecord(row) && row['id']) retrieved.set(String(row['id']), { messageId: String(row['id']), channelId: String(row['channelId'] ?? ''),
            authorId: String(row['authorId'] ?? ''), content: String(row['content'] ?? ''), contentHash: String(row['contentHash'] ?? ''), occurredAt: Number(row['at'] ?? 0) });
        }
      }
      spentBytes += Buffer.byteLength(JSON.stringify(view ?? null));
      const { count, detail } = summarize(toolName, args, view);
      record({ step, tool: toolName, arguments: args, count, detail, error: null, result: view });
      return view;
    }
  };
  return toolset;
}

// スレへ出す要約。完全な往復は governance_investigation_steps にだけ残す。
export function investigationSummary(
  trace: readonly InvestigationStep[],
  { seat = null, lens = null, maximumSteps = 0 }: { seat?: number | null; lens?: string | null; maximumSteps?: number } = {}
): string | null {
  if (!trace.length) return null;
  const head = seat ? `## 調査記録（席${seat}${lens ? ` / ${lens.split(':')[0]}` : ''}）` : '## 調査記録';
  const lines = trace.map((entry) => (
    entry.error
      ? `- ${entry.tool} ${entry.detail} → 失敗`
      : `- ${entry.tool} ${entry.detail} → ${entry.count}件`
  ));
  const footer = maximumSteps ? `（${maximumSteps}手中 ${trace.length}手を使用・全文は監査記録）` : null;
  return [head, ...lines, footer].filter(Boolean).join('\n');
}
