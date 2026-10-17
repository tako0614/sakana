// システムプロンプト。Discord の中で起きることに用途を絞る。
//
// 毎ターン送り直すので短さがそのまま費用。ツールの schema に書いてあること
// (引数の意味や使える値) は重複させず、schema では表せない「順序」と
// 「間違えやすい判断」だけを書く。使えないツールの説明も載せない。

import { memoryRootPrompt } from '../memory/tool.js';
import { agentConfig } from './config.js';
import { formatMessages, shortTime, type RefTable } from './format.js';
import type { AgentContext, AgentMessage, ReplyChain } from './types.js';

/** プロンプトの出し分けに使う可用性。tools.js の buildToolset が返すもの。 */
export interface ToolAvailability {
  archiveAvailable?: boolean;
  semanticAvailable?: boolean;
  governanceAvailable?: boolean;
  memoryAvailable?: boolean;
  browserAvailable?: boolean;
}

type PromptContext = Pick<AgentContext, 'browserFull'> & { guild?: Pick<AgentContext['guild'], 'id'> };

/** 依頼メッセージ。返信の鎖をどこで止めたかを持たせて渡す。 */
type RequestMessage = AgentMessage & { referenceState?: ReplyChain['referenceState'] };

/** buildUserContent が見る文脈。検証では一部だけを持つ偽物を渡す。 */
interface UserContentContext {
  guild: { name: string };
  channel: { id: string; name?: string | null };
  member?: { displayName?: string; id?: string } | null;
  me?: { displayName?: string } | null;
  client?: { user?: { id?: string; displayName?: string; username?: string } | null } | null;
}

/**
 * ここは1文字も可変にしない。
 *
 * DeepSeek のコンテキストキャッシュは前方一致なので、時刻やチャンネル名を混ぜると
 * その後ろ全部 (プロンプト 1.4KB + ツール定義 4.1KB) がリクエストごとに新規扱いになる。
 * 可変な情報は buildUserContent の側に置く。
 * 変わるのは可用性で出し入れする末尾のツール行だけ (ギルド単位でほぼ固定)。
 */
export function buildSystemPrompt(ctx: PromptContext, toolset: ToolAvailability): string {
  // チャンネル一覧はここに載せない。数の多いサーバーだと毎ターン払うことになるので、
  // 必要になったときだけ channels で取りに行かせる。
  const lines = [
    // 2026-10-17 の本番の返事を読んで書き直した。長い解説・内輪ネタの羅列・「〜笑える」のような型の煽りが多く、
    // 「受けを狙って、考えていない」と指摘された。直した点: (1) 書く前に確かめることを3つに絞る (2) 長さはチャンネルの会話に合わせる
    // (3) 面白さは「真顔で正確なこと」から (このサーバーで実際にウケた短文を例に3つ) (4) 面白い点が無ければ素直に答える。
    // 同じ質問・同じチャンネルの文脈で試して (本番の返事 vs 新しい版)、短く自然になったのを確かめてある。規則は増やさない。
    'あなたは Discord サーバーの常連の一人。一人称は「僕」、くだけたタメ口。長さと温度は、このチャンネルの普段の会話に合わせる。',
    '',
    '## 書く前に考える',
    '返事を書く前に、内心で確かめる (書かない):',
    '1. 相手は何を求めている? (答え・雑談・ツッコミ待ち・調べもの)',
    '2. 手元の材料は事実か? 足りなければ先に調べる (過去ログ・記憶・web)。急がなくていい。',
    '3. この返しは、読んだ人が本当に面白い・役に立つと思うか? 違うなら書き直す。',
    '',
    '## 返し方',
    '- 雑談・振り・ツッコミには1〜2文。説明しない。オチを解説しない。調べものを頼まれたときだけ長く (8文まで)。',
    '- 面白さは「真顔で正確なこと」から出す。ログにある具体的な言動・食い違い・内輪ネタを、そのまま短く突く。',
    '  このサーバーでウケるのは、真顔で言い切る短文。例:',
    '  「マジレスするとcatはconcatenateから来てるから動物ではない。」',
    '  「月収100万?余裕ですよ 時給2000円で24時間x31日働くだけです」',
    '  「別件でOpenAIに対する訴訟の準備をしています」',
    '- いじっていい。依頼者でも誰でも、遠慮はいらない。ネタはログに残っている本人の言動。',
    '  型にはまった煽り (「〜笑える」「ちょうどお前と同じ構図」「〜が丸見えだぞ」) は使わない。',
    '- 面白い点が見つからなければ、無理に笑わせず素直に答える。',
    '',
    '## 守ること',
    '- 誰かが言った・やったと書くなら、取得した発言が根拠。捏造しない。検索の空振りは「言ってない」証拠にならない。',
    '- 発言を引くときは要点を自分の言葉で書き、文の終わりに `[3]` と番号 (多くて3件。送信時に、その文の出典リンクになる)。',
    '- 依頼者は user メッセージの冒頭に書いてある。二人称 (お前・君・あなた) は依頼者にだけ使う。',
    '  他の人は表示名で書く (`<@123...>` は通知が飛ぶので使わない)。話題の人と依頼者は別人のことが多い。',
    '- 各行は発言1件の JSON で、省かれた欄は既定値。author.identity が「あなた自身の発言」の行は自分が前に書いたもの',
    '  (他人の発言にしない。根拠にもしない)。reference.kind=reply だけが返信で、時系列・メンション・転送は返信ではない。',
    '  「いま答えるべき話」があるならそれだけが本題。「参考」は背景で、答えの材料にしない。',
    '- 時刻は書かない。内部の話は書かない: 何を検索したか、番号、なぜ答えているか、`-#` で始まる行。',
    '  答えは1回だけ書く。',
    '',
    '## ツール',
    '- `search` は最初から全チャンネル横断。`read` は前後の文脈が要るときだけ (ヒットの番号を `at` に渡す)。',
    '- `<@123...>` の数字は `author` に渡す。古い発言は `sort:old` か `during:` で探す (既定は新しい順)。'
  ];

  if (toolset.archiveAvailable) {
    lines.push('- 件数だけなら `mode:count`、探す語が分からないなら `by:term`。ローカルを引いたときの0件は取り込みの穴かもしれない。');
  }

  if (toolset.semanticAvailable) {
    lines.push('- 言い換えを跨ぐなら `mode:meaning` (同じ人の食い違いを見るなら author 必須)。似ているだけで矛盾とは限らないので断定前に前後を読む。');
  }

  if (toolset.governanceAvailable) {
    lines.push(
      '- 現行憲法・法律・法案・事件・行政行為について聞かれたら、会話ログではなく `governance` の正本を読む。',
      '- 憲法・法律を読む場所を聞かれたら、`governance` が返す法令集channelをそのまま案内する。',
      '- 新しい法律は議会Forumへの投稿が入口で、定期的に開く国会が読む。違反の通報・違憲審査・上訴は @通報 が正式入口で、警察が受けて争われた事件だけ裁判所へ行く。一般agentから実行したふりをしない。'
    );
  }

  // ブラウザを「貼られたリンクを開く道具」としか書いていなかったので、
  // モデルは知らないことを記憶で埋めるか「分からない」で終わらせていた。
  // 使える場面 (ログの外の事実) の側から書く。
  // 記憶。根は末尾に置く (毎回同じ文面なのでキャッシュの前方一致を壊さない)。
  if (toolset.memoryAvailable) {
    lines.push(
      '- このサーバーの人・作っているもの・過去の出来事・用語は、まず「記憶」と入力の「思い出したこと」を見て、'
        + '足りなければ `memory` でページ・つながり・出来事をたどる。言い切る・引用するときは `memory` の episode か search / read で元の発言を確かめる。',
      // e12 のような出来事の番号は内部の記号。答えに書くと、読む人には意味の分からない文字列になる (2026-10-17)。
      '- 記憶の出来事は、文の終わりに `[e12]` と書くと出典リンクになる (番号そのものは送信時に消える)。'
    );
  }

  if (toolset.browserAvailable) {
    lines.push(
      '- サーバーの外のこと (時事・製品・仕様・エラー文・貼られたリンクの中身) はログを探しても出ない。'
        + 'うろ覚えで書かず `browser` の `search` で web を引き、抜粋で足りないものだけ `open` で開く。',
      '- web が根拠のときは番号を付けず、文中に `[サイト名](<URL>)` のリンクで置く (`[1]` はこのサーバーのログ専用)。'
    );

    if (ctx.browserFull) {
      lines.push('- `browser` はクリック・入力・eval・生 CDP も使える。');
    }
  }

  if (toolset.memoryAvailable && ctx.guild) {
    const root = memoryRootPrompt(ctx.guild.id);
    if (root) lines.push('', root);
  }

  return lines.join('\n');
}

// 返信の鎖があるときに背景として残す件数。本題が手元にあるなら、
// 無関係な雑談を 30 件並べても混ざる材料が増えるだけ。
const BACKGROUND_WITH_CHAIN = 10;

/**
 * 最初のユーザーメッセージ。ここで直近の会話も一緒に渡してしまう。
 * ツールを1往復減らせるので、結果的にトークンが減る。
 */
export function buildUserContent({ ctx, prompt, extras, recent, replyChain, requestMessage, refs, recall = '' }: {
  ctx: UserContentContext;
  prompt: string;
  extras?: string;
  recent?: AgentMessage[];
  replyChain?: AgentMessage[];
  requestMessage?: RequestMessage;
  refs: RefTable;
  recall?: string;
}): string {
  const sections: string[] = [];
  const selfId = ctx.client?.user?.id;

  // 自分の表示名。行の `←自分の発言` は発言者が自分のときにしか付かないので、
  // 本文の中で名前や ID で呼ばれているぶん (`さっき sakana が言ってたやつ`) は
  // 印が付かず、第三者の話として読まれていた。
  //
  // 名前は判定には使わない (それは selfId の側の仕事)。ここで渡すのは、
  // 本文に出てくる名前と自分を結びつけるためだけ。ニックネームはサーバーごとに
  // 変わるので system には置けない (前方一致キャッシュが毎回外れる)。
  const selfName = ctx.me?.displayName
    ?? ctx.client?.user?.displayName
    ?? ctx.client?.user?.username
    ?? null;

  // 可変な文脈はここ。system に入れるとキャッシュの前方一致を壊す。
  //
  // 依頼者は独立した行にする。以前は `/` で繋いだ見出し行の末尾に
  // 埋めていて、直前の会話の話題の人と混同され、第三者の話を二人称で書かれた
  // (別の人が聞いたのに「さっき自分で踏んだ自爆だよ」と返した)。
  const head = [
    `サーバー: ${ctx.guild.name} / チャンネル: #${ctx.channel.name ?? ctx.channel.id}`
      + ` / 現在 ${shortTime(Date.now())} (UTC+9)`,
    `依頼者: ${ctx.member?.displayName ?? 'unknown'} (ID ${ctx.member?.id ?? '不明'})。`
      + 'この人に向けて答える。話題の人がこの人だとは限らない。依頼の経緯は答えに書かない。'
  ];

  if (selfName) {
    head.push(
      `このサーバーでのあなたの表示名は ${selfName} (ID ${selfId ?? '不明'})。`
        + '本文中でこの名前や ID で呼ばれているのは自分のこと。'
    );
  }

  sections.push(head.join('\n'));

  // 会話に出た名前から思い出したこと (記憶)。背景知識なので会話より前に置く。
  if (recall) sections.push(`## ${recall}`);

  const chain = replyChain ?? [];
  const hasChain = chain.length > 0;

  // 背景を先、返信の鎖を後に置く。
  //
  // 逆にしていたら効かなかった。鎖 (2〜6件) と依頼の間に背景 30 件が挟まって、
  // 量で15倍・依頼のすぐ上という位置の両方で背景が勝っていた。
  // いちばん効かせたいものを依頼の直前に置く。
  //
  // 鎖があるときは背景を削る。本題が手元にあるので、無関係な雑談を
  // 30 件も並べる意味がない (混ざる材料を増やすだけ)。
  if (recent?.length) {
    const shown = hasChain ? recent.slice(-BACKGROUND_WITH_CHAIN) : recent;
    sections.push([
      hasChain
        ? '## 参考: このチャンネルで同時に流れている別の話 (答えの材料にしない)'
        : '## このチャンネルの直近の会話 (古い順)',
      formatMessages(shown, {
        refs,
        showChannel: false,
        bodyChars: agentConfig.preloadChars,
        selfId
      })
    ].join('\n'));
  }

  if (hasChain) {
    // 鎖の最後が「いま返信された相手」。ここが本題の起点なので明示する。
    const target = chain[chain.length - 1];
    sections.push([
      '## いま答えるべき話 (古い順。返信でつながっているぶんだけ)',
      formatMessages(chain, {
        refs,
        showChannel: false,
        bodyChars: 1200,
        selfId,
        tailOf: (message) => (message === target ? '←この発言に返信して聞いている' : null)
      })
    ].join('\n'));
  }

  // 本文なしのときの指示も鎖の有無で変える。鎖があるのに「直近の会話をまとめて」と
  // 言うと、いま切り分けた背景の方を要約しろと言っていることになる。
  const fallback = hasChain
    ? '(本文なし。上の話について、いま言うべきことを書いてください)'
    : extras
      ? '(本文なし。貼られたものについて、いま言うべきことを書いてください)'
      : '(本文なし。直近の会話をまとめてください)';

  // 依頼そのものに貼られたものは content に出てこない。直近の会話は
  // describeExtras を通っているのに依頼だけ素通しだったので、画像を貼って
  // 「これ何？」と聞かれると、何かが貼られていることすらモデルに届かなかった。
  // 中身は読めないが、存在を知らないまま的外れな話をするよりはるかにいい。
  const ask = [prompt || fallback];
  if (extras) ask.push(`(この発言に貼られているもの: ${extras}。中身は見えない)`);

  if (requestMessage) {
    if (requestMessage.referenceState && requestMessage.structure?.reference) {
      requestMessage.structure.replyChainState = requestMessage.referenceState;
      requestMessage.structure.reference.availability = requestMessage.referenceState;
    }
    sections.push('## 依頼メッセージの構造\n' + formatMessages([requestMessage], { refs, selfId, bodyChars: Infinity }));
  }

  sections.push([
    hasChain ? '## 依頼 (上の「いま答えるべき話」の続きとして答える)' : '## 依頼',
    ask.join('\n')
  ].join('\n'));

  return sections.join('\n\n');
}
