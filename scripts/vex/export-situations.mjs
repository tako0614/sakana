// 「vex が会話に入るべきか」の評価用に、実際の会話の場面を JSONL に書き出す (読み取りだけ)。
//
//   node --import tsx scripts/vex/export-situations.mjs > situations.jsonl
//
// 使うのは「全員に見えるチャンネル」の発言だけ (memory.sqlite の public_channels)。bot が大半を占めるチャンネル・
// スレッド・nsfw / 運営用 は除く。書き出したものは開発機の中に置き、リポジトリには入れない。
//
// 1場面 = 決める時点までの直近 12 件 (名前・何分前か) + 弱い正解。決める時点は、実際の bot が決めるときと同じにする:
//   direct    bot が呼ばれて答えた場面。呼ばれた時点で決める。join=1
//   implicit  質問・頼みごとの形で、10 分のあいだ誰も反応しなかった場面。**90 秒たっても誰も返事していない時点**で決める。join=1 (弱い)
//   quiet     質問ではない発言のあと、10 分のあいだ静かだった場面。同じく 90 秒の時点。join=0 (静かなだけでは入らない)
//   active    別の人が 60 秒以内に続いた、人どうしの会話。続いた発言のあとで決める。join=0
// 相槌・スタンプだけの発言は bot の門 (isBareAck) で先に落とすので、場面に入れない。
// 弱ラベルなので「ここでは入ってほしかった」とは限らない (implicit は修辞的な疑問も含む)。目視で確かめる前提。
//
// env: ARCHIVE_DB_PATH (既定 data/archive.sqlite) / MEMORY_DB_PATH (既定 data/memory.sqlite) / GUILD_ID / BOT_ID /
//      DAYS (既定 120) / SEED (既定 7) / COUNTS (既定 direct=100,implicit=100,quiet=100,active=100)
import Database from 'better-sqlite3';
import { isBareAck } from '../../src/agent/ack.ts';

const archive = new Database(process.env.ARCHIVE_DB_PATH ?? 'data/archive.sqlite', { readonly: true, fileMustExist: true });
const memory = new Database(process.env.MEMORY_DB_PATH ?? 'data/memory.sqlite', { readonly: true, fileMustExist: true });
const GUILD = process.env.GUILD_ID ?? '1255359848644608035';
const BOT = process.env.BOT_ID ?? '1498930574705033237';
const DAYS = Number(process.env.DAYS ?? 120);
const WANT = Object.fromEntries((process.env.COUNTS ?? 'direct=100,implicit=100,quiet=100,active=100').split(',').map((entry) => entry.split('=')).map(([key, value]) => [key, Number(value)]));

// 疑似乱数 (同じ SEED なら同じ場面)
let state = Number(process.env.SEED ?? 7) >>> 0;
const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
const shuffle = (items) => { const out = [...items]; for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };

const publicIds = new Set(memory.prepare('SELECT channel_id FROM public_channels WHERE guild_id = ?').all(GUILD).map((row) => row.channel_id));
const SKIP_NAME = /nsfw|r18|internal|moderator|logs|通知|notif|github|ルート|ウェルカム|welcome|コマンド|command|コイン|bot/i;
const since = Date.now() - DAYS * 86_400_000;
const channels = archive.prepare('SELECT channel_id, name, is_thread FROM channels WHERE guild_id = ?').all(GUILD)
  .filter((channel) => publicIds.has(channel.channel_id) && !channel.is_thread && !SKIP_NAME.test(channel.name ?? ''));

const clean = (text) => String(text ?? '').replace(/https?:\/\/\S+/g, '<url>').replace(/\s*\n\s*/g, ' ⏎ ').trim().slice(0, 300);
const QUESTION = /(？|\?|教えて|誰か|だれか|どうやって|わかる人|知ってる人|いる\?|いない\?|なんだっけ|どうすれば|どうしたら|おすすめ|どっち)/;

const found = { direct: [], implicit: [], quiet: [], active: [] };
const names = new Map();
for (const row of archive.prepare('SELECT DISTINCT author_id, author_name FROM messages WHERE guild_id = ? AND created_at > ?').all(GUILD, since)) names.set(row.author_id, row.author_name);

for (const channel of channels) {
  const rows = archive.prepare(`SELECT message_id, author_id, author_name, is_bot, content, created_at, reply_to FROM messages
    WHERE guild_id = ? AND channel_id = ? AND deleted = 0 AND created_at > ? AND content NOT LIKE '-# thinking%' ORDER BY created_at, message_id`).all(GUILD, channel.channel_id, since);
  const total = rows.length;
  const bots = rows.filter((row) => row.is_bot).length;
  if (total < 100 || bots / total > 0.3) continue;
  const byId = new Map(rows.map((row, index) => [row.message_id, index]));
  const answered = new Set(rows.filter((row) => row.author_id === BOT && row.reply_to).map((row) => row.reply_to));

  rows.forEach((row, index) => {
    if (row.is_bot) return;
    const text = String(row.content ?? '');
    const next = rows[index + 1];
    const gap = next ? next.created_at - row.created_at : Infinity;
    const mentionsBot = text.includes(`<@${BOT}>`) || text.includes(`<@!${BOT}>`);
    const mentionsOther = /<@!?\d+>/.test(text.replace(new RegExp(`<@!?${BOT}>`, 'g'), ''));
    const longEnough = text.replace(/<[^>]+>|\s/g, '').length >= 8;
    const ack = isBareAck(text) || !longEnough;
    const quiet = gap > 10 * 60_000;
    let kind = null;
    let upto = index;           // 場面に含める最後の発言
    let idle = 0;               // 決める時点の、最後の発言からの経過 (分)
    if (mentionsBot) kind = answered.has(row.message_id) ? 'direct' : null;
    else if (ack) kind = null;
    else if (QUESTION.test(text) && !mentionsOther && text.length >= 8 && quiet && !answered.has(row.message_id)) { kind = 'implicit'; idle = 1.5; }
    else if (!QUESTION.test(text) && quiet) { kind = 'quiet'; idle = 1.5; }
    else if (next && !next.is_bot && next.author_id !== row.author_id && gap <= 60_000) { kind = 'active'; upto = index + 1; }
    if (!kind) return;
    const decideAt = rows[upto].created_at + idle * 60_000;
    const window = rows.slice(Math.max(0, upto - 11), upto + 1);
    let lastBot = null;
    for (let i = upto; i >= Math.max(0, upto - 200); i -= 1) { if (rows[i].author_id === BOT) { lastBot = rows[i].created_at; break; } }
    found[kind].push({
      id: row.message_id, channel: channel.name, kind, join: kind === 'direct' || kind === 'implicit' ? 1 : 0,
      recent: window.map((message) => ({
        author: message.author_id === BOT ? 'vex' : String(message.author_name ?? 'unknown'),
        bot: Boolean(message.is_bot),
        minutes_ago: Math.round((decideAt - message.created_at) / 6000) / 10,
        text: clean(String(message.content ?? '').replace(new RegExp(`<@!?${BOT}>`, 'g'), '@vex').replace(/<@!?(\d+)>/g, (_, id) => `@${names.get(id) ?? 'someone'}`))
      })),
      last_speaker: String(rows[upto].author_name ?? 'unknown'),
      idle_minutes: idle,
      minutes_since_vex: lastBot ? Math.round((decideAt - lastBot) / 6000) / 10 : null
    });
  });
}

const out = [];
for (const kind of ['direct', 'implicit', 'quiet', 'active']) {
  const picked = shuffle(found[kind]).slice(0, WANT[kind] ?? 0);
  console.error(`${kind}: ${found[kind].length} found, ${picked.length} written`);
  out.push(...picked);
}
for (const item of shuffle(out)) console.log(JSON.stringify(item));
