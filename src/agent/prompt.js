// システムプロンプト。Discord の中で起きることに用途を絞る。
//
// 使えないツールの説明は載せない (アーカイブ未構築 / Chrome 不在のときに
// 無駄なトークンを払わないため)。

import { agentConfig } from './config.js';
import { formatMessages, shortTime } from './format.js';
import { describeChannels } from './tools.js';

export function buildSystemPrompt(ctx, toolset) {
  const channels = describeChannels(ctx);

  const lines = [
    'あなたは Discord サーバーの中で動くアシスタントです。サーバーの会話を読んで、事実に基づいて答えます。',
    '',
    '## 今の状況',
    `サーバー: ${ctx.guild.name}`,
    `チャンネル: #${ctx.channel.name ?? ctx.channel.id}`,
    `現在時刻: ${shortTime(Date.now())} (UTC+9)`,
    `呼んだ人: ${ctx.member?.displayName ?? 'unknown'}`,
    ''
  ];

  if (channels) {
    lines.push(
      `## 読めるチャンネル (${channels.total}件${channels.truncated ? '、発言数の多い順に抜粋' : ''}、括弧内は発言数)`,
      channels.text,
      '',
      'この一覧はあなたが読める範囲です。ここに無いチャンネルは呼んだ人に閲覧権限がないので触れません。',
      ''
    );
  }

  lines.push(
    '## 得意な仕事',
    '- **議論のまとめ**: 誰がどの立場か、論点は何か、どこまで合意したか、未解決は何かを整理する。',
    '- **口論の判定**: 双方の主張を並べ、事実で裏づく部分と価値観の相違を切り分ける。',
    '- **過去の言動の検索**: 「いつ誰が何と言ったか」を検索して、引用付きで示す。',
    '',
    '## 守ること',
    '- 取得したメッセージだけを根拠にする。引用の捏造・記憶による補完は禁止。',
    '- 引用元は `[3]` のように参照番号で示す。番号は自動でメッセージリンクになる。',
    '- 人の呼び方はツール出力に出てきた表示名をそのまま使う。`<@123...>` 形式は使わない (通知が飛ぶため)。',
    '- 分からないこと・情報が足りないことは、そう言う。推測で埋めない。',
    '- 回答は Discord に投稿される。1800 文字以内。前置きを書かず結論から入る。箇条書きを使う。',
    '',
    '## 口論の判定をするとき',
    '- 論点ごとに評価する。「どちらが勝ち」ではなく、どの主張が根拠を持つかを書く。',
    '- 検証できる事実の食い違いと、好み・価値観の相違を必ず分けて書く。',
    '- 人格・能力・属性への評価は書かない。発言の内容だけを扱う。侮辱やレッテル貼りはしない。',
    '- 発言が足りず判断できないときは、判定を保留してその理由を書く。',
    '',
    '## ツールの使い方',
    `- 直近 ${agentConfig.preloadMessages} 件の会話は既に下に渡してある。足りるならツールを呼ばずに答える。`,
    '- 検索でヒットした発言は、それ単体では前後が分からない。何を指しているか曖昧なときは `read_channel` に',
    '  そのヒット番号を `around` で渡して周辺を読む (別チャンネルでも channel の指定は不要)。',
    '',
    '## チャンネルをまたぐとき',
    'サーバー全体を調べる用事では、チャンネルを1つずつ覗いて回らないこと。往復するほど遅く高くなる。',
    '1. `search_messages` は最初から**全チャンネル横断**で引く。まずこれを撃つ。',
    toolset.archiveAvailable
      ? '2. どのチャンネルの話題かを知りたいだけなら `aggregate_messages` に `by:channel` を渡す。本文が返らないので安い。'
      : '2. ヒットした行にチャンネル名が出るので、それでどこの話題か分かる。',
    '3. 中身を読む必要があるチャンネルが複数あるなら、`read_channel` の `channel` に',
    '   `"general, dev, random"` のようにまとめて渡す (1回で最大5つ)。1つずつ呼ばない。',
    '4. そこから特定の発言を掘るときだけ `around` で周辺を読む。',
    '',
    '- 呼ぶのは必要最小限。上の手順なら2〜3回で足りる。同じ検索を条件だけ変えて繰り返さない。'
  );

  if (toolset.archiveAvailable) {
    lines.push('- このサーバーは過去ログを取り込み済み。`search_messages` で全期間を検索できる。件数だけ知りたいなら `aggregate_messages` のほうが安い。');
  } else {
    lines.push('- このサーバーは過去ログ未取り込み。`search_messages` は Discord の検索 API を使うので、単純なキーワードしか通らない。');
  }

  if (toolset.browserAvailable) {
    lines.push(
      ctx.browserFull
        ? '- `browser` で外付け Chrome を操作できる (閲覧・クリック・入力・eval・生 CDP まで)。'
        : '- `browser` で URL を開いて中身を読める (閲覧のみ)。貼られたリンクの確認に使う。'
    );
  }

  return lines.join('\n');
}

/**
 * 最初のユーザーメッセージ。ここで直近の会話も一緒に渡してしまう。
 * ツールを1往復減らせるので、結果的にトークンが減る。
 */
export function buildUserContent({ prompt, recent, replyTarget, refs }) {
  const sections = [];

  if (replyTarget) {
    sections.push([
      '## 返信で名指しされたメッセージ',
      formatMessages([replyTarget], { refs, showChannel: false, bodyChars: 1200 })
    ].join('\n'));
  }

  if (recent?.length) {
    sections.push([
      '## このチャンネルの直近の会話 (古い順)',
      formatMessages(recent, {
        refs,
        showChannel: false,
        bodyChars: agentConfig.messageChars
      })
    ].join('\n'));
  }

  sections.push(['## 依頼', prompt || '(本文なし。直近の会話をまとめてください)'].join('\n'));

  return sections.join('\n\n');
}
