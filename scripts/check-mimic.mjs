// 自作モデル (evex) 側の検証。
//
// 見ているのは1点だけ: 学習データと推論のプロンプトが同じ形かどうか。
// ずれても例外は出ず、モデルが「学習中に一度も見ていない形」を受け取って
// 静かに崩れた出力を返すだけなので、門を置く。

import {
  CONTROL_TOKENS, ROLE_TOKENS, ROLE_OVERFLOW, assignRoles, buildPrompt,
  firstTurn, humanize, messageText, nextRole, normalize
} from '../src/mimic/serialize.js';
import { DEFAULT_ENGINE, ENGINES, engineFor, setEngine } from '../src/mimic/prefs.js';
import { db } from '../src/db.js';

function fail(message) {
  throw new Error(message);
}

// --- 正規化 ---

{
  const cases = [
    ['https://example.com/a?b=c', '<url>'],
    ['<@123456789012345678>', '<mention>'],
    ['<@!123456789012345678>', '<mention>'],
    ['<@&123456789012345678>', '<mention>'],
    ['<#123456789012345678>', '<channel>'],
    ['<t:1700000000:R>', '<time>'],
    ['@everyone', '<mention>'],
    ['<:kusa:123456789012345678>', ':kusa:'],   // カスタム絵文字は名前を残す (文化なので)
    ['<a:party:123456789012345678>', ':party:']
  ];
  for (const [input, want] of cases) {
    const got = normalize(input);
    if (got !== want) fail(`正規化が違う: ${input} -> ${got} (期待 ${want})`);
  }

  // 残すもの。ここを潰すと文体が消える
  for (const keep of ['草', 'www', 'ｗｗｗ', '😭', '!?', 'そうだねー', '(´・ω・｀)']) {
    if (normalize(keep) !== keep) fail(`残すべきものが変わった: ${keep} -> ${normalize(keep)}`);
  }

  // 改行はトークンにする (会話 1 件を 1 行に収めるため)
  if (normalize('a\nb') !== 'a<nl>b') fail(`改行が <nl> になっていない: ${normalize('a\nb')}`);
  // U+2028 / U+2029 も潰す。JSON.stringify は素通しするのに readline は行終端として扱う
  if (normalize('a b') !== 'a<nl>b') fail('U+2028 を潰していない');
  if (normalize('a b') !== 'a<nl>b') fail('U+2029 を潰していない');

  // コードブロックは中身を残す
  const code = normalize('```js\nconst a = 1;\n```');
  if (!code.includes('<code>') || !code.includes('const a = 1;')) fail(`コードが壊れた: ${code}`);

  // 本文が空なら turn は残す (添付やスタンプ)
  if (messageText('') !== '<file>') fail('空の本文を <file> にしていない');
  if (messageText('  ') !== '<file>') fail('空白だけの本文を <file> にしていない');
}

// --- 二重適用で壊れないこと ---
//
// normalize は URL を潰してから改行を <nl> にする順序なので、一度通した文を
// もう一度通すと `https://<nl>Current` の `<nl>Current` まで URL として飲まれる
// (実データで1件出た)。buildPrompt が正規化済みの content を受ける契約を固定する。
{
  const raw = 'see https://\nCurrent Version';
  const once = messageText(raw);
  if (!once.includes('<nl>Current')) fail(`1回目で改行が消えた: ${once}`);

  const turns = [{ token: '<|a|>', reply: false, content: once }];
  const prompt = buildPrompt(turns);
  if (!prompt.includes('<nl>Current')) {
    fail(`buildPrompt が正規化を二度掛けている: ${prompt}`);
  }
}

// --- 直列化 ---

{
  const turns = [
    { token: '<|a|>', reply: false, content: '今日ひま？' },
    { token: '<|b|>', reply: true, content: 'ひま' }
  ];

  const prompt = buildPrompt(turns);
  if (prompt !== '<|conv|><|a|>今日ひま？<|b|><|re|>ひま') fail(`直列化が違う: ${prompt}`);

  // 末尾に役を置くと、その役として続きを書かせられる
  const asked = buildPrompt(turns, '<|c|>');
  if (!asked.endsWith('<|c|>')) fail(`末尾の役トークンが無い: ${asked}`);
}

// --- 1発言だけ取り出す ---
//
// 放っておくとモデルは会話を続けるので、次の話者トークンで切らないと
// 「他の人の発言まで捏造した長文」が Discord に流れる。
{
  const nameOf = (role) => role;

  // Discord に返すのは firstTurn。次の話者トークンで切る
  const one = firstTurn('そうだねー<|c|>いや違う<|end|>');
  if (one !== 'そうだねー') fail(`1発言だけになっていない: ${one}`);

  // <|end|> より後ろは次の会話なので捨てる
  const after = firstTurn('はい<|end|>ぜんぜん別の話');
  if (after !== 'はい') fail(`<|end|> の後ろを含んでいる: ${after}`);

  // 会話ごと見せる方 (sample.py 用) は名前を出して続ける
  const whole = humanize('そうだねー<|c|>いや違う<|end|>', nameOf);
  if (!whole.includes('c:') || !whole.includes('いや違う')) fail(`humanize が展開しない: ${whole}`);

  // 制御記号が生のまま表示に漏れない
  const shown = firstTurn('a<nl>b<url><file><mention><|re|>');
  for (const token of ['<nl>', '<url>', '<file>', '<mention>', '<|re|>']) {
    if (shown.includes(token)) fail(`制御記号が表示に漏れている: ${token} in ${shown}`);
  }
}

// --- 制御記号の一覧が tokenizer 側と食い違わないこと ---
//
// serialize.js が出す記号を tokenizer が知らないと、1トークンに収まらず
// 会話の構造だけで数百トークン払うことになる。
{
  const emitted = new Set();
  emitted.add(messageText(''));                          // <file>
  emitted.add(normalize('https://x.com'));               // <url>
  emitted.add(normalize('<@123456789012345678>'));       // <mention>
  emitted.add(normalize('<#123456789012345678>'));       // <channel>
  emitted.add(normalize('<t:1:R>'));                     // <time>
  emitted.add('<nl>');
  for (const token of ['<|conv|>', '<|end|>', '<|re|>', ROLE_OVERFLOW, '<code>', '</code>', ...ROLE_TOKENS]) {
    emitted.add(token);
  }

  for (const token of emitted) {
    if (!CONTROL_TOKENS.includes(token)) {
      fail(`serialize が出す ${token} が CONTROL_TOKENS に無い (tokenizer が知らない)`);
    }
  }
}

// --- 役の割り当て ---
//
// 会話ごとに振り直すことが身元を消す仕組みそのもの。同じ人でも別の会話では別の役。
{
  const roles = assignRoles(['u1', 'u2', 'u1', 'u3']);
  if (roles.get('u1') !== '<|a|>') fail(`最初に喋った人が <|a|>: ${roles.get('u1')}`);
  if (roles.get('u2') !== '<|b|>') fail(`2人目が <|b|>: ${roles.get('u2')}`);
  if (roles.get('u3') !== '<|c|>') fail(`3人目が <|c|>: ${roles.get('u3')}`);
  if (roles.size !== 3) fail(`同じ人に2つ振ってはいけない: ${roles.size}`);

  // bot は次の空いている役で喋る
  if (nextRole(roles) !== '<|d|>') fail(`次の役が違う: ${nextRole(roles)}`);

  // 9人目以降はまとめる (実測 0.9%)
  const many = assignRoles(Array.from({ length: 10 }, (_, i) => `u${i}`));
  if (many.get('u8') !== ROLE_OVERFLOW) fail(`9人目は ${ROLE_OVERFLOW}: ${many.get('u8')}`);
  if (many.get('u9') !== ROLE_OVERFLOW) fail(`10人目も ${ROLE_OVERFLOW}: ${many.get('u9')}`);

  // 別の会話では同じ人が別の役になる = 身元が残らない
  const other = assignRoles(['u2', 'u1']);
  if (other.get('u1') === roles.get('u1')) fail('会話をまたいで役が固定されてはいけない');
}

// --- 世代をまたいでも壊れないこと ---
//
// 相対トークンに変えたとき、デプロイ中の evex-1 に <|a|> を渡して出力を崩壊させた。
// 役の種類は推論サーバーの申告に従わせる。
{
  const v1 = { roles: ['<|other|>'], overflow: '<|other|>' };
  const roles = assignRoles(['u1', 'u2', 'u3'], v1);
  if (new Set(roles.values()).size !== 1) fail('evex-1 では参加者が全員同じ役になる');
  if (roles.get('u1') !== '<|other|>') fail(`申告された役を使う: ${roles.get('u1')}`);
  if (nextRole(roles, v1) !== '<|other|>') fail(`bot の役も申告に従う: ${nextRole(roles, v1)}`);

  // 申告が無ければ evex-2 の既定
  if (assignRoles(['u1']).get('u1') !== ROLE_TOKENS[0]) fail('申告が無ければ既定の役');

  // firstTurn は両世代のトークンで切る (取り違えると生の記号が Discord に漏れる)
  if (firstTurn('そうだね<|s1|>ID: xxx') !== 'そうだね') fail('evex-1 のトークンで切れていない');
  if (firstTurn('そうだね<|other|>はい') !== 'そうだね') fail('<|other|> で切れていない');
  if (firstTurn('そうだね<|b|>いや') !== 'そうだね') fail('evex-2 のトークンで切れていない');
}

console.log(`serialize ok (制御記号 ${CONTROL_TOKENS.length} 個 / 役 ${ROLE_TOKENS.length} + 溢れ / 二重適用でも壊れない)`);

// --- エンジンの選択 ---

const USER = 'check-model-user';
const clear = () => db.prepare('DELETE FROM agent_engine WHERE user_id = ?').run(USER);

clear();
try {
  if (engineFor(USER) !== DEFAULT_ENGINE) fail('既定は deepseek');
  if (!ENGINES[DEFAULT_ENGINE]) fail('既定のエンジンが ENGINES に無い');

  if (!setEngine(USER, 'evex')) fail('evex を選べない');
  if (engineFor(USER) !== 'evex') fail('選択が保存されていない');

  // 他人には影響しない (自分のぶんだけ)
  if (engineFor('check-model-other') !== DEFAULT_ENGINE) fail('選択が他人に漏れている');

  if (setEngine(USER, 'gpt-9')) fail('知らないエンジンを受け付けてはいけない');
  if (engineFor(USER) !== 'evex') fail('無効な指定で既存の選択を壊してはいけない');

  console.log(`engine ok (${Object.keys(ENGINES).join(' / ')} / 既定 ${DEFAULT_ENGINE})`);
} finally {
  clear();
}

// --- なりきり (素の日本語形式 / evex-ft-1) ---
//
// ここが崩れると「モデルが一度も見ていない形」を渡すことになり、例外は出ずに
// 静かに壊れる。evex-1 に <|a|> を渡して出力を崩壊させたのと同じ形の事故になる。
{
  const {
    buildPlainPrompt, channelLabel, labelFor, labelledSpeakers, plainFirstTurn, plainText
  } = await import('../src/mimic/plain.js');

  const speakers = labelledSpeakers();

  // labels.json は実 ID を含むので追跡していない (corpus/ と同じ扱い)。
  // 手元にコーパスが無い機械ではラベルの検査を飛ばして、形だけ確かめる
  if (!speakers.length) {
    if (plainFirstTurn('うん\nたこ: それは違う') !== 'うん') fail('名前ラベルで切れていない');
    if (channelLabel('nonexistent') !== '#other') fail('知らないチャンネルが #other にならない');
    console.log('mimic plain ok (labels.json 無し / 切り出しと既定ラベルだけ確認)');
  } else {

  const top = speakers[0];
  if (labelFor(top.userId) !== top.label) fail(`ラベルが引けない: ${top.userId}`);
  if (labelFor('000000000000000000') !== null) fail('知らない人にラベルが付いている');

  // 学習側 (build-sft.mjs) が切り詰めと連番を決めている。ここで作り直すとずれるので、
  // 12 字を超えるラベルや `:` 入りが混ざっていないことを確認する
  for (const row of speakers) {
    if (row.label.length > 12) fail(`ラベルが 12 字を超えている: ${row.label}`);
    if (/[:\n\r]/.test(row.label)) fail(`ラベルに : か改行が入っている: ${row.label}`);
  }
  if (new Set(speakers.map((r) => r.label)).size !== speakers.length) {
    fail('ラベルが重複している (同名の別人が混ざる)');
  }

  // プロンプトの形。末尾はラベルだけを置いて、そこから本文を書かせる
  const prompt = buildPlainPrompt([{ role: 'A', content: 'これバグってる？' }], {
    channelId: 'nonexistent', trailingRole: top.label
  });
  if (!prompt.startsWith('#other\n')) fail(`チャンネル行が先頭に無い: ${JSON.stringify(prompt)}`);
  if (!prompt.endsWith(`\n${top.label}:`)) fail(`末尾がラベルで終わっていない: ${JSON.stringify(prompt)}`);
  if (prompt.includes('undefined')) fail('プロンプトに undefined が混ざっている');

  // 生成の切り方。名前ラベルでも切れないと他人の発言まで流れる
  if (plainFirstTurn('うん\nたこ: それは違う') !== 'うん') fail('名前ラベルで切れていない');
  if (plainFirstTurn('うん\nB: いや') !== 'うん') fail('英字の役で切れていない');
  if (plainFirstTurn('うん\n#ch2\nA: 次') !== 'うん') fail('チャンネル行で切れていない');
  if (plainFirstTurn('1行目\n2行目') !== '1行目\n2行目') fail('ただの改行で切ってはいけない');

  // 正規化は build-sft.mjs と同じ規則でないと形がずれる
  const asRole = (id) => (id === 1 ? 'B' : null);
  if (plainText('<@1> やあ', () => 'B') !== '@B やあ') fail('メンションが役にならない');
  if (plainText('<@999> やあ', () => null) !== 'やあ') fail('会話の外のメンションを落としていない');
  if (plainText('見て https://github.com/a/b/c') !== '見て https://github.com') {
    fail('URL が origin に落ちていない');
  }
  if (plainText('<:neko:12345> かわいい') !== ':neko: かわいい') fail('絵文字が :name: になっていない');
  if (channelLabel('nonexistent') !== '#other') fail('知らないチャンネルが #other にならない');

  console.log(`mimic plain ok (${speakers.length} ラベル / 切り出し / 正規化)`);
  void asRole;
  }
}
