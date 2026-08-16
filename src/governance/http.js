import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  getActiveConstitution,
  getConstitution,
  getCurrentLawVersion,
  getLaw,
  listConstitutions,
  listGovernanceGuilds,
  listLawVersions,
  listLaws
} from './db.js';

/**
 * 成立した法令だけを外へ出す読み取り専用API。討議中の案件、投票、事件、
 * memberのIDは一切含めない。Cloudflare Tunnel の先に置くため、書き込み経路と
 * 未成立の記録をこのモジュールから触らない。
 */

const MAX_LIMIT = 200;

function lawSummary(law) {
  return {
    id: Number(law.id),
    code: law.code,
    title: law.title,
    version: Number(law.version ?? 1),
    status: law.status,
    effectiveAt: Number(law.effective_at),
    endedAt: law.ended_at === null || law.ended_at === undefined ? null : Number(law.ended_at)
  };
}

function lawDetail(law, guildId) {
  const versions = listLawVersions(law.id)
    .filter((entry) => entry.guild_id === guildId)
    .map(lawSummary)
    .sort((left, right) => left.version - right.version);
  const current = getCurrentLawVersion(law.id);
  return {
    ...lawSummary(law),
    text: law.text,
    provisions: law.provisions,
    contentHash: law.content_hash,
    constitutionVersion: constitutionVersion(law.constitution_id),
    currentVersion: current && current.guild_id === guildId ? Number(current.version ?? 1) : null,
    versions
  };
}

function constitutionVersion(constitutionId) {
  return getConstitution(constitutionId)?.version ?? null;
}

function constitutionSummary(constitution) {
  return {
    version: Number(constitution.version),
    status: constitution.status,
    enactedAt: Number(constitution.enacted_at),
    contentHash: constitution.content_hash
  };
}

function matchesQuery(law, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  const provisionText = (law.provisions?.articles ?? []).map((article) => `${article.code} ${article.text}`).join('\n');
  return `${law.title}\n${law.text}\n${provisionText}`.toLowerCase().includes(needle);
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function guildIds() {
  return new Set(listGovernanceGuilds().map((guild) => String(guild.guild_id)));
}

function json(status, body) {
  return { status, body };
}

/**
 * 経路の解決だけを行う純関数。socketを持たないのでテストから直接呼べる。
 */
export function handleStatuteRequest({ method = 'GET', path = '/', query = new URLSearchParams() } = {}) {
  if (method !== 'GET') return json(405, { error: 'method not allowed' });
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments[0] !== 'api') return json(404, { error: 'not found' });

  if (segments.length === 2 && segments[1] === 'health') {
    return json(200, { ok: true, guilds: listGovernanceGuilds().length });
  }
  if (segments.length === 2 && segments[1] === 'guilds') {
    return json(200, {
      guilds: listGovernanceGuilds().map((guild) => ({
        guildId: String(guild.guild_id),
        laws: listLaws(guild.guild_id, { limit: MAX_LIMIT }).length,
        constitutionVersion: getActiveConstitution(guild.guild_id)?.version ?? null
      }))
    });
  }
  if (segments[1] !== 'guilds' || segments.length < 4) return json(404, { error: 'not found' });

  const guildId = segments[2];
  if (!guildIds().has(guildId)) return json(404, { error: 'unknown guild' });
  const rest = segments.slice(3);

  if (rest[0] === 'laws' && rest.length === 1) {
    const includeHistory = query.get('status') === 'all';
    const limit = positiveInteger(query.get('limit'), 50, MAX_LIMIT);
    const search = String(query.get('q') ?? '').trim();
    const laws = listLaws(guildId, { activeOnly: !includeHistory, limit: MAX_LIMIT })
      .filter((law) => matchesQuery(law, search));
    return json(200, {
      total: laws.length,
      laws: laws.slice(0, limit).map(lawSummary)
    });
  }

  if (rest[0] === 'laws' && (rest.length === 2 || rest.length === 4)) {
    const law = getLaw(rest[1]);
    if (!law || law.guild_id !== guildId) return json(404, { error: 'unknown law' });
    if (rest.length === 2) return json(200, lawDetail(law, guildId));
    if (rest[2] !== 'versions') return json(404, { error: 'not found' });
    const version = listLawVersions(law.id)
      .find((entry) => entry.guild_id === guildId && Number(entry.version ?? 1) === Number(rest[3]));
    if (!version) return json(404, { error: 'unknown version' });
    return json(200, lawDetail(version, guildId));
  }

  if (rest[0] === 'constitution' && rest.length === 1) {
    const constitution = getActiveConstitution(guildId);
    if (!constitution) return json(404, { error: 'no constitution' });
    return json(200, { ...constitutionSummary(constitution), content: constitution.content });
  }

  if (rest[0] === 'constitutions' && rest.length === 1) {
    return json(200, {
      constitutions: listConstitutions(guildId, { limit: MAX_LIMIT }).map(constitutionSummary)
    });
  }

  if (rest[0] === 'constitutions' && rest.length === 2) {
    const constitution = listConstitutions(guildId, { limit: MAX_LIMIT })
      .find((entry) => Number(entry.version) === Number(rest[1]));
    if (!constitution) return json(404, { error: 'unknown version' });
    return json(200, { ...constitutionSummary(constitution), content: constitution.content });
  }

  return json(404, { error: 'not found' });
}

function authorized(headerValue, token) {
  const supplied = Buffer.from(String(headerValue ?? ''));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Cloudflare Tunnel の origin。tokenなしでは起動しない。tunnelのhostnameは
 * 公開されるので、Worker以外からの取得を拒否できる状態を必須にする。
 */
export function startStatuteServer({ port, token, host = '127.0.0.1' } = {}) {
  if (!token) throw new Error('STATUTE_HTTP_TOKEN がありません。法令APIはtokenなしで起動できません。');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://statutes.invalid');
    const send = ({ status, body }) => {
      const payload = `${JSON.stringify(body)}\n`;
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': status === 200 ? 'public, max-age=60' : 'no-store',
        'x-content-type-options': 'nosniff'
      });
      response.end(payload);
    };
    if (!authorized(request.headers['x-statute-token'], token)) {
      send(json(401, { error: 'unauthorized' }));
      return;
    }
    try {
      send(handleStatuteRequest({
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams
      }));
    } catch (error) {
      console.error('Statute API failed:', error);
      send(json(500, { error: 'internal error' }));
    }
  });
  server.listen(port, host);
  return server;
}
