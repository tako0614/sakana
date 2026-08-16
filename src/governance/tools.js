// 統治AIの席が自分で調べるための読み取り専用ツール。
//
// 母集団は governance_activity と統治DBだけで、Discord APIもアーカイブDBも触らない。
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

const DAY_MS = 86_400_000;
// ツールループは毎リクエストでmessages配列を丸ごと再送するので、返す量は手数の
// 二乗で効く。索引として使える最小限まで絞る。全文が要るものは別の経路で読む。
const CONTENT_LIMIT = 160;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAXIMUM_LOOKBACK_DAYS = 90;
const MAXIMUM_ROWS = 25;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function since(context, days) {
  const fallback = context.defaultLookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  return Date.now() - boundedInteger(days, fallback, 1, MAXIMUM_LOOKBACK_DAYS) * DAY_MS;
}

// 席へ見せる形。content は索引用に切り詰め、content_hash は見せない（席は引用IDだけを返す）。
// 完全な行は retrieved 側に残し、証拠化のときの改ざん検知に使う。
function messageView(row) {
  return {
    id: String(row.message_id),
    channelId: String(row.channel_id),
    authorId: String(row.user_id),
    content: String(row.content ?? '').slice(0, CONTENT_LIMIT),
    at: Number(row.created_at)
  };
}

function evidenceRow(row) {
  return {
    messageId: String(row.message_id),
    channelId: String(row.channel_id),
    authorId: String(row.user_id),
    content: String(row.content ?? ''),
    contentHash: String(row.content_hash),
    occurredAt: Number(row.created_at)
  };
}

// LIKE で粗く絞ってから既存の n-gram 関連度で並べ替える。二文字未満の断片は
// ほぼ全件に当たるので落とす。
function searchTerms(query) {
  return String(query ?? '')
    .split(/[\s、。,.：:；;「」『』（）()\[\]]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);
}

const TOOLS = {
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
      const terms = searchTerms(args.query);
      const limit = boundedInteger(args.limit, 10, 1, MAXIMUM_ROWS);
      const pool = searchGuildActivity(context.guildId, since(context, args.days), terms, 500);
      return pool
        .map((row) => ({ row, score: contextRelevance(String(args.query ?? ''), row.content) }))
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
      return recentActorActivity(
        context.guildId,
        String(args.userId ?? ''),
        since(context, args.days),
        boundedInteger(args.limit, 10, 1, MAXIMUM_ROWS)
      );
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
      return recentGovernanceMessages(
        context.guildId,
        since(context, args.days),
        [String(args.channelId ?? '')],
        boundedInteger(args.limit, 10, 1, MAXIMUM_ROWS)
      );
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
      return activityContext(context.guildId, String(args.messageId ?? ''), {
        before: boundedInteger(args.before, 4, 0, 10),
        after: boundedInteger(args.after, 4, 0, 10)
      });
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
      const constitution = getActiveConstitution(context.guildId);
      if (!constitution) return { error: 'no active constitution' };
      const content = String(constitution.content ?? '');
      const sections = content.split(/^## /m).slice(1)
        .map((part) => ({ heading: part.split('\n')[0].trim(), body: '## ' + part.trim() }));
      const heading = String(args.heading ?? '').trim();
      if (!heading) {
        return { version: constitution.version, headings: sections.map((entry) => entry.heading) };
      }
      const found = sections.find((entry) => entry.heading === heading)
        ?? sections.find((entry) => entry.heading.includes(heading));
      if (!found) return { error: `unknown heading: ${heading}`, headings: sections.map((entry) => entry.heading) };
      return { version: constitution.version, heading: found.heading, text: found.body.slice(0, 4000) };
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
      const laws = listLaws(context.guildId, { activeOnly: false, limit: 200 });
      const code = String(args.code ?? '').trim();
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
      const accusedId = String(args.accusedId ?? '').trim();
      return listCases(context.guildId, { limit: boundedInteger(args.limit, 10, 1, 25) })
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
      const lawId = Number(args.lawId);
      const offenseCode = String(args.offenseCode ?? '').trim();
      const cases = listCases(context.guildId, { limit: 100 })
        .filter((entry) => Number(entry.law_id) === lawId
          && (!offenseCode || entry.offense_code === offenseCode)
          && Number(entry.id) !== Number(context.caseId ?? 0))
        .slice(0, boundedInteger(args.limit, 5, 1, 10));
      return cases.map((entry) => ({
        caseId: entry.id,
        status: entry.status,
        offenseCode: entry.offense_code,
        summary: String(entry.summary ?? '').slice(0, CONTENT_LIMIT),
        decisions: listCaseDecisions(entry.id).map((decision) => ({
          phase: decision.phase,
          seat: decision.seat,
          verdict: decision.verdict,
          sanction: decision.sanction_json ? JSON.parse(decision.sanction_json) : null,
          reasons: JSON.parse(decision.reasons_json ?? '[]').slice(0, 2)
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
      const caseId = Number(args.caseId ?? context.caseId ?? 0);
      const caseRecord = getCase(caseId);
      if (!caseRecord || String(caseRecord.guild_id) !== String(context.guildId)) {
        return { error: `unknown case: ${caseId}` };
      }
      return {
        id: caseRecord.id,
        status: caseRecord.status,
        accusedId: caseRecord.accused_id,
        summary: caseRecord.summary,
        evidence: listCaseEvidence(caseId).map((row) => ({
          id: String(row.message_id ?? row.id),
          channelId: String(row.channel_id ?? ''),
          authorId: String(row.author_id ?? ''),
          content: String(row.content ?? '').slice(0, CONTENT_LIMIT),
          contentHash: String(row.content_hash ?? ''),
          at: Number(row.occurred_at ?? 0)
        })),
        submissions: listCurrentCaseSubmissions(caseId).map((row) => ({
          authorId: row.author_id,
          kind: row.kind,
          content: String(row.content ?? '').slice(0, CONTENT_LIMIT)
        }))
      };
    }
  }
};

// 正本は rules.js（循環importを避けるため）。ここで登録漏れ・余りを起動時に弾く。
{
  const registered = Object.keys(TOOLS).sort().join(',');
  if (registered !== [...IMPLEMENTED_TOOLS].sort().join(',')) {
    throw new Error(`調査手段の実装と実行規則の一覧がずれています: ${registered}`);
  }
}
export { IMPLEMENTED_TOOLS };

export function toolDefinitions(allowed) {
  return allowed
    .filter((name) => name in TOOLS)
    .map((name) => ({
      type: 'function',
      function: {
        name,
        description: TOOLS[name].description,
        parameters: TOOLS[name].parameters
      }
    }));
}

function summarize(name, args, result) {
  const count = Array.isArray(result) ? result.length : (result?.error ? 0 : 1);
  const detail = name === 'search_messages' ? `「${String(args.query ?? '').slice(0, 40)}」`
    : name === 'read_user_messages' ? `対象者 ${String(args.userId ?? '').slice(0, 24)}`
      : name === 'read_channel' ? `channel ${String(args.channelId ?? '').slice(0, 24)}`
        : name === 'read_context' ? `記録 ${String(args.messageId ?? '').slice(0, 24)} の前後`
          : name === 'read_law' ? (args.code ? String(args.code).slice(0, 24) : '法令一覧')
            : name === 'read_precedent' ? `法 ${args.lawId ?? '?'} の過去の判断`
              : name === 'read_constitution' ? (args.heading ? String(args.heading).slice(0, 24) : '憲法の目次')
                : name === 'read_cases' ? '事件一覧'
                : `事件 ${args.caseId ?? '当件'}`;
  return { count, detail };
}

// 席ごとに1つ作る。retrieved はその席が実際に見たIDの台帳で、引用の検算に使う。
export function buildToolset({ guildId, allowed, caseId = null, maximumOutputBytes = 10 * 1024 }) {
  const context = {
    guildId: String(guildId),
    caseId,
    defaultLookbackDays: getOperationalSetting(String(guildId), 'investigation_lookback_days')
  };
  const permitted = new Set(allowed.filter((name) => name in TOOLS));
  const retrieved = new Map();
  const trace = [];
  let spentBytes = 0;
  return {
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
      // 最悪ケースを固定する。予算を使い切ったらツールを閉じて結論へ行かせる。
      if (spentBytes >= maximumOutputBytes) {
        const error = 'investigation output budget spent; stop calling tools and answer now';
        trace.push({ step, tool: String(name), arguments: rawArguments, count: 0, detail: '予算切れ', error });
        return { error };
      }
      if (!permitted.has(name)) {
        const error = `tool not permitted by the constitution: ${name}`;
        trace.push({ step, tool: String(name), arguments: rawArguments, count: 0, detail: '許可外', error });
        return { error };
      }
      let args;
      try {
        args = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : (rawArguments ?? {});
      } catch {
        const error = 'arguments must be a JSON object';
        trace.push({ step, tool: name, arguments: rawArguments, count: 0, detail: '引数不正', error });
        return { error };
      }
      let raw;
      try {
        raw = TOOLS[name].run(context, args);
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 200);
        trace.push({ step, tool: name, arguments: args, count: 0, detail: '失敗', error: message });
        return { error: message };
      }
      // 発言を返すツールだけ、完全な行を retrieved へ積む。モデルへは切り詰めた形を返す。
      const view = TOOLS[name].rows && Array.isArray(raw) ? raw.map(messageView) : raw;
      if (TOOLS[name].rows && Array.isArray(raw)) {
        for (const row of raw) retrieved.set(String(row.message_id), evidenceRow(row));
      }
      // 事件記録から読んだ証拠は既に採用済みなので、そのまま引用できる。
      for (const row of raw?.evidence ?? []) {
        if (row?.id) {
          retrieved.set(String(row.id), {
            messageId: String(row.id),
            channelId: String(row.channelId ?? ''),
            authorId: String(row.authorId ?? ''),
            content: String(row.content ?? ''),
            contentHash: String(row.contentHash ?? ''),
            occurredAt: Number(row.at ?? 0)
          });
        }
      }
      spentBytes += JSON.stringify(view ?? null).length;
      const { count, detail } = summarize(name, args, view);
      trace.push({ step, tool: name, arguments: args, count, detail, error: null, result: view });
      return view;
    }
  };
}

// スレへ出す要約。完全な往復は governance_investigation_steps にだけ残す。
export function investigationSummary(trace, { seat = null, lens = null, maximumSteps = 0 } = {}) {
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
