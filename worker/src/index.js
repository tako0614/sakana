import {
  renderConstitution,
  renderLaw,
  renderList,
  renderMessage,
  matchesQuery
} from './render.js';

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers ?? {})
    }
  });
}

// 長さが違っても早期returnしない比較。トークンの長さを漏らさない。
function secretEquals(left, right) {
  const a = new TextEncoder().encode(String(left ?? ''));
  const b = new TextEncoder().encode(String(right ?? ''));
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function authorized(request, env) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(env.GOVERNANCE_LAW_API_TOKEN) && secretEquals(token, env.GOVERNANCE_LAW_API_TOKEN);
}

function text(value, name, maximum) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum) throw new Error(`${name} が不正です。`);
  return normalized;
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} が不正です。`);
  return parsed;
}

export function validateInstrument(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('本文がJSON objectではありません。');
  const allowed = new Set([
    'guildId', 'type', 'instrumentId', 'rootId', 'code', 'title', 'version', 'status',
    'publicationStatus', 'text', 'provisions', 'contentHash', 'effectiveAt', 'endedAt'
  ]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`未対応の項目があります: ${unknown.join(', ')}`);
  if (!['law', 'constitution'].includes(body.type)) throw new Error('type が不正です。');
  return {
    guildId: text(body.guildId, 'guildId', 32),
    type: body.type,
    instrumentId: text(String(body.instrumentId), 'instrumentId', 64),
    // 改正で版が変わっても同じ法令として並べるための系列ID。旧botはrootIdを送らない。
    rootId: body.rootId === null || body.rootId === undefined
      ? text(String(body.instrumentId), 'instrumentId', 64)
      : text(String(body.rootId), 'rootId', 64),
    code: text(body.code, 'code', 100),
    title: text(body.title, 'title', 200),
    version: integer(body.version, 'version'),
    status: text(body.status, 'status', 40),
    publicationStatus: text(body.publicationStatus, 'publicationStatus', 40),
    text: text(body.text, 'text', 200_000),
    provisionsJson: body.provisions === null || body.provisions === undefined
      ? null
      : JSON.stringify(body.provisions),
    contentHash: text(body.contentHash, 'contentHash', 128),
    effectiveAt: integer(body.effectiveAt, 'effectiveAt'),
    endedAt: body.endedAt === null || body.endedAt === undefined ? null : integer(body.endedAt, 'endedAt')
  };
}

async function upsertInstrument(env, value) {
  await env.LAWS.prepare(`
    INSERT INTO instruments
      (guild_id, type, instrument_id, root_id, code, title, version, status, publication_status,
       text, provisions_json, content_hash, effective_at, ended_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    ON CONFLICT (guild_id, type, instrument_id) DO UPDATE SET
      root_id = excluded.root_id,
      code = excluded.code,
      title = excluded.title,
      version = excluded.version,
      status = excluded.status,
      publication_status = excluded.publication_status,
      text = excluded.text,
      provisions_json = excluded.provisions_json,
      content_hash = excluded.content_hash,
      effective_at = excluded.effective_at,
      ended_at = excluded.ended_at,
      updated_at = excluded.updated_at
  `).bind(
    value.guildId, value.type, value.instrumentId, value.rootId, value.code, value.title, value.version,
    value.status, value.publicationStatus, value.text, value.provisionsJson, value.contentHash,
    value.effectiveAt, value.endedAt, Date.now()
  ).run();
}

function publicRow(row) {
  return {
    type: row.type,
    id: row.instrument_id,
    rootId: row.root_id ?? row.instrument_id,
    code: row.code,
    title: row.title,
    version: row.version,
    status: row.status,
    publicationStatus: row.publication_status,
    contentHash: row.content_hash,
    effectiveAt: row.effective_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at
  };
}

async function listInstruments(env, guildId, { type = null, includeHistory = false } = {}) {
  const conditions = ['guild_id = ?1'];
  const bindings = [guildId];
  if (type) {
    conditions.push(`type = ?${bindings.length + 1}`);
    bindings.push(type);
  }
  if (!includeHistory) conditions.push("status = 'active'");
  const { results } = await env.LAWS.prepare(
    `SELECT * FROM instruments WHERE ${conditions.join(' AND ')} ORDER BY type, effective_at DESC, version DESC`
  ).bind(...bindings).all();
  return results ?? [];
}

async function versionsOf(env, guildId, row) {
  const rootId = row.root_id ?? row.instrument_id;
  const { results } = await env.LAWS.prepare(
    'SELECT * FROM instruments WHERE guild_id = ?1 AND type = ?2 AND COALESCE(root_id, instrument_id) = ?3 ORDER BY version'
  ).bind(guildId, row.type, rootId).all();
  return results ?? [];
}

async function findInstrument(env, guildId, type, instrumentId) {
  return env.LAWS.prepare(
    'SELECT * FROM instruments WHERE guild_id = ?1 AND type = ?2 AND instrument_id = ?3'
  ).bind(guildId, type, instrumentId).first();
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const guildId = url.searchParams.get('guild') ?? env.DEFAULT_GUILD_ID ?? '';

    if (request.method === 'POST' && url.pathname === '/v1/instruments') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
      let value;
      try {
        value = validateInstrument(await request.json());
      } catch (error) {
        return json({ error: String(error?.message ?? error) }, { status: 400 });
      }
      await upsertInstrument(env, value);
      return json({ ok: true, guildId: value.guildId, type: value.type, instrumentId: value.instrumentId });
    }

    if (request.method === 'GET' && url.pathname === '/v1/laws') {
      if (!guildId) return json({ error: 'guild is required' }, { status: 400 });
      const rows = await listInstruments(env, guildId, {
        includeHistory: url.searchParams.get('history') === '1'
      });
      return json({ guildId, instruments: rows.map(publicRow) });
    }

    const lawMatch = url.pathname.match(/^\/v1\/laws\/([^/]+)$/);
    if (request.method === 'GET' && lawMatch) {
      if (!guildId) return json({ error: 'guild is required' }, { status: 400 });
      const row = await env.LAWS.prepare(
        'SELECT * FROM instruments WHERE guild_id = ?1 AND code = ?2 ORDER BY version DESC LIMIT 1'
      ).bind(guildId, decodeURIComponent(lawMatch[1])).first();
      if (!row) return json({ error: 'not found' }, { status: 404 });
      return json({
        ...publicRow(row),
        text: row.text,
        provisions: row.provisions_json ? JSON.parse(row.provisions_json) : null
      });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      if (!guildId) return new Response('guild を指定してください。', { status: 400 });
      const query = url.searchParams.get('q') ?? '';
      const type = ['law', 'constitution'].includes(url.searchParams.get('type'))
        ? url.searchParams.get('type')
        : '';
      const history = url.searchParams.get('history') === '1';
      const rows = await listInstruments(env, guildId, { type: type || null, includeHistory: history });
      return html(renderList({
        guildId,
        rows: rows.filter((row) => matchesQuery(row, query)),
        query,
        type,
        history
      }));
    }

    const viewMatch = url.pathname.match(/^\/(law|constitution)\/([^/]+)$/);
    if (request.method === 'GET' && viewMatch) {
      if (!guildId) return new Response('guild を指定してください。', { status: 400 });
      const [, type, rawId] = viewMatch;
      const row = await findInstrument(env, guildId, type, decodeURIComponent(rawId));
      if (!row) {
        return html(renderMessage({
          guildId, title: '見つかりません - 法令集', message: 'その法令は公開されていません。'
        }), 404);
      }
      const versions = await versionsOf(env, guildId, row);
      return html(type === 'constitution'
        ? renderConstitution({ guildId, row, versions })
        : renderLaw({ guildId, row, versions }));
    }

    return json({ error: 'not found' }, { status: 404 });
  }
};
