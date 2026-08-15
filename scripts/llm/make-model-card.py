"""公開用のモデルカード (README.md) を**成果物から**作る。

    .venv-llm/bin/python scripts/llm/make-model-card.py dist/hf --corpus corpus-v7 \\
      --name evex-4 --repo tako080614/evex-4

手で書くと世代ごとに必ずずれる。プロンプトの形は世代で変わっていて
(evex-1/2 は `<|other|>`、evex-3 から `<|re|><|相手|>`、evex-4 からチャンネル)、
**カードの形が実物と違うと、落とした人は動かせない**。

なので **tok.model と config.json と stats.json を読んで、実物から書き起こす**。
語彙に `<|c0|>` があればチャンネルの節が出るし、無ければ出ない。

**speakers.json は読むが、出すのは順位と件数だけ。**userId と表示名は
同意を取っていない実在の人物のデータなので公開物に混ぜない
(to_safetensors.py と同じ判断)。
"""

import argparse
import json
from pathlib import Path

import sentencepiece as spm

parser = argparse.ArgumentParser()
parser.add_argument("out", nargs="?", default="dist/hf", help="safetensors を置いた先")
parser.add_argument("--corpus", default="corpus-v7")
parser.add_argument("--name", default="evex-4")
parser.add_argument("--repo", default=None, help="HF の repo id (使い方の例に出す)")
# **JESC が CC-BY-4.0** なので、既定はそれに揃えておく。
# 継承の要否は解釈が割れるが、緩い方に倒して後から締めるのは難しい
parser.add_argument("--license", default="cc-by-4.0")
args = parser.parse_args()

out = Path(args.out)
corpus = Path(args.corpus)
repo = args.repo or f"<あなたのユーザー名>/{args.name}"

config = json.loads((out / "config.json").read_text(encoding="utf8"))
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
stats = {}
if (corpus / "stats.json").exists():
    stats = json.loads((corpus / "stats.json").read_text(encoding="utf8"))


def has(piece):
    return sp.piece_to_id(piece) != sp.unk_id()


def count_series(fmt):
    """`<|s0|>` `<|s1|>` … が何個あるか。**上限を決め打ちにしない。**"""
    n = 0
    while has(fmt.format(n)):
        n += 1
    return n


SPEAKERS = count_series("<|s{}|>")
CHANNELS = count_series("<|c{}|>")
ROLES = [f"<|{c}|>" for c in "abcdefgh" if has(f"<|{c}|>")]
HAS_REPLY = has("<|re|>")
HAS_OVERFLOW = has("<|z|>")

# 話者の件数だけ (身元は出さない)
speaker_counts = []
if (corpus / "speakers.json").exists():
    speaker_counts = [row["count"]
                      for row in json.loads((corpus / "speakers.json").read_text(encoding="utf8"))]

fmt = lambda n: f"{n:,}"  # noqa: E731

# --- プロンプトの図 ---
#
# **実物のトークンで組む。**説明用に手で書くと、語彙に無いものを書いてしまう

ch = "<|c2|>" if CHANNELS else ""
example = (f"{ch}<|conv|><|s0|>これバグってる？<|s3|>"
           + ("<|re|><|s0|>" if HAS_REPLY else "")
           + "どこで止まってる？<|end|>")
ask = (f"{ch}<|conv|>"
       + (f"{ROLES[0]}日本の首都どこ" if ROLES else "<|other|>日本の首都どこ")
       + "<|s0|>")

lines = []
W = lines.append

# HF の frontmatter。**これが無いとライセンスが「不明」で出る**
W("---")
W(f"license: {args.license}")
W("language:")
W("- ja")
W("library_name: safetensors")
W("pipeline_tag: text-generation")
W("tags:")
W("- japanese")
W("- discord")
W("- from-scratch")
W("datasets:")
W("- OmniAICreator/Japanese-Roleplay-Dialogues")
W("- nntsuzu/JESC")
W("- p1atdev/open2ch")
W("---")
W("")
W(f"# {args.name}")
W("")
W("ある Discord サーバーのログだけから**ゼロから**学習した日本語の会話モデル。")
W("既存の重みからの派生ではなく、tokenizer も含めて全部このサーバーのために作ってある。")
W("")
W(f"- パラメータ **{fmt(config['params'])}** "
  f"({config['n_layers']} 層 / d_model {config['d_model']} / "
  f"{config['n_heads']} head / context {config['context']})")
W(f"- 語彙 **{fmt(config['vocab_size'])}** (sentencepiece BPE / byte_fallback)")
W(f"- {config.get('architecture', 'decoder-only transformer')} / weight tying")
if config.get("val_loss") is not None:
    W(f"- val loss **{config['val_loss']:.4f}** (epoch {config.get('trained_epoch')})")
W("")
W("## ⚠ プロンプトの形が独特です")
W("")
W("**この節を読まずに使うと、まともな出力は出ません。**普通の instruct モデルでも")
W("chat template でもなく、**記号だけで会話の構造を表す**独自の形です。")
W("`<|conv|>` から始めて `<|end|>` で終わる 1 行が 1 会話になります。")
W("")
W("```")
W(example)
W("```")
W("")

# --- 制御トークンの表 ---

W("### トークンの意味")
W("")
W("| トークン | 個数 | 意味 |")
W("|---|---|---|")
W("| `<|conv|>` | 1 | 会話の始まり。**必ず先頭に置く** |")
W("| `<|end|>` | 1 | 会話の終わり。生成はここで止める |")
if CHANNELS:
    W(f"| `<|c0|>`..`<|c{CHANNELS - 1}|>` | {CHANNELS} | "
      "どのチャンネルの会話か。**`<|conv|>` より前**に置く |")
    if has("<|cx|>"):
        W("| `<|cx|>` | 1 | 上位に入らないチャンネル |")
if SPEAKERS:
    W(f"| `<|s0|>`..`<|s{SPEAKERS - 1}|>` | {SPEAKERS} | "
      "固有の話者。発言数の多い順の**匿名の順位**で、身元は含みません |")
if ROLES:
    W(f"| `<|a|>`..`<|{ROLES[-1][2]}|>` | {len(ROLES)} | "
      "固有トークンを持たない人。**会話ごとに出てきた順**で振る |")
if HAS_OVERFLOW:
    W("| `<|z|>` | 1 | 役が足りないとき |")
if HAS_REPLY:
    W("| `<|re|>` | 1 | 返信。**直後に返信先のトークンを置く** |")
W("| `<nl>` | 1 | 発言の中の改行 |")
W("| `<url>` `<file>` `<mention>` `<channel>` `<time>` | 5 | "
  "正規化した中身。**学習で損失から外してある**ので、モデルは自分では書きません |")
W("| `<code>` `</code>` | 2 | コードブロックの囲み |")
W("")

W("### 組み立ての規則")
W("")
W("1. **話者トークンと本文を交互に、区切り文字なしで繋げる。**空白も改行も入れません")
W("2. 同じ人が続けて喋るときは、そのつどトークンを置きます "
  "(`<|a|>今日ひま？<|a|>あ、やっぱいいや`)")
if HAS_REPLY:
    W("3. 返信は `<話者><|re|><返信先>本文` の順。**自分への返信には付けません**")
if CHANNELS:
    W(f"{4 if HAS_REPLY else 3}. チャンネルは `<|conv|>` の**前**。"
      "学習データは 100% がこれで始まるので、省くと分布の外になります")
W("")
W("**続きを書かせたい人のトークンを末尾に置く**と、その人の発言として続きます:")
W("")
W("```")
W(ask)
W("```")
W("")

# --- 最小の推論コード ---

W("## 使い方")
W("")
W("`model.py` と `tok.model` がこのリポジトリに入っています。")
W("")
W("```python")
W("import json")
W("import torch")
W("import sentencepiece as spm")
W("from safetensors.torch import load_file")
W("from model import Config, MicroLM      # このリポジトリの model.py")
W("")
W("cfg = Config(**{k: v for k, v in json.load(open('config.json')).items()")
W("             if k in Config.__dataclass_fields__})")
W("model = MicroLM(cfg)")
W("state = load_file('model.safetensors')")
W("state['head.weight'] = state['embed.weight']   # weight tying。head は保存していない")
W("model.load_state_dict(state)")
W("model.eval()")
W("")
W("sp = spm.SentencePieceProcessor(model_file='tok.model')")
W(f"prompt = {ask!r}")
W("ids = torch.tensor([sp.encode(prompt, out_type=int)])")
W("got = model.generate(ids, max_new_tokens=80, temperature=0.9, top_k=40,")
W("                     stop_id=sp.piece_to_id('<|end|>'))")
W("print(sp.decode(got[0].tolist())[len(prompt):])")
W("```")
W("")
W("**生成は `<|end|>` か、次の話者トークンが出たところで切ってください。**")
W("切らずに流すと、他の人の発言まで作り続けます。")
W("")

# --- 学習 ---

W("## 学習")
W("")
if stats.get("pretrain_chars"):
    W("多段で学習しています。**外部データで日本語と会話の土台を作り、"
      "最後はこのサーバーのログだけで仕上げる**という順序です。")
    W("混合比だけで比率を守ろうとすると、外部が数倍あるぶん永久に薄まります。")
    W("")
    W("| 段 | 中身 | 量 |")
    W("|---|---|---|")
    W(f"| 段1 | 外部の会話 + このサーバーの素の会話 | {fmt(stats['pretrain_chars'])} 字 |")
    W(f"| 段2 | このサーバーだけ (窓の水増しと切り出し込み) | {fmt(stats['train_chars'])} 字 |")
    if stats.get("reacted_conversations"):
        # **`reacted_chars` は train に混ぜた周回込みの値。**段3 のファイルは 1 周ぶん
        W(f"| 段3 | リアクションの付いた発言の切り出しだけ | "
          f"{fmt(stats.get('reacted_file_chars', 0))} 字 |")
    W("")
if speaker_counts:
    W(f"話者トークンは発言数の多い順に {len(speaker_counts)} 人ぶん "
      f"(全発言の {stats.get('speaker_coverage', 0) * 100:.1f}% を被覆)。")
    W(f"件数は 最多 {fmt(max(speaker_counts))} / 最少 {fmt(min(speaker_counts))} で、"
      f"**{max(speaker_counts) // max(1, min(speaker_counts))} 倍**の開きがあります。")
    W("順位が小さいほどよく学習されています。")
    W("")

# --- 出典 ---

W("## 出典とライセンス")
W("")
W("段1 に使った外部データ:")
W("")
W("| データ | ライセンス |")
W("|---|---|")
W("| [OmniAICreator/Japanese-Roleplay-Dialogues]"
  "(https://huggingface.co/datasets/OmniAICreator/Japanese-Roleplay-Dialogues) | Apache-2.0 |")
W("| [nntsuzu/JESC](https://huggingface.co/datasets/nntsuzu/JESC) | **CC-BY-4.0** |")
W("| [p1atdev/open2ch](https://huggingface.co/datasets/p1atdev/open2ch) "
  "(元: [1never/open2ch-dialogue-corpus](https://github.com/1never/open2ch-dialogue-corpus)) "
  "| Apache-2.0 |")
W("")

# --- 注意 ---

W("## 注意")
W("")
W("- **話者トークン `<|sN|>` は匿名の順位で、userId は含まれていません。**"
  "ただし発言の癖は重みに入っているので、特定の順位で生成した文が"
  "その人の書き方に似ることはあります")
W("- **表示名は tokenizer の語彙に残っています。**`tok.model` は"
  "このサーバーのログから学習しているので、会話の中でよく呼ばれる名前は"
  "BPE が 1 トークンにまとめます。実測で 147 人中 16 人 (上位20人では 7 人) の"
  "表示名がそのまま語彙にあり、**列挙すれば読めます**。"
  "`<|sN|>` の番号と名前の対応は含まれていませんが、"
  "「このサーバーによく居る人の呼び名」は分かります")
W("- 学習元は特定のサーバーの雑談なので、**俗語と内輪の話題に強く偏っています**。"
  "汎用の日本語モデルではありません")
W("- 出力の正しさは保証しません。事実確認の用途には使えません")
W("- 有害表現の除去は学習データ側で機械的に掛けただけです。"
  "**推論側の安全機構はありません**")
W("")

card = out / "README.md"
card.write_text("\n".join(lines) + "\n", encoding="utf8")

print(f"{card}  {len(lines)} 行")
print(f"  話者 {SPEAKERS} / チャンネル {CHANNELS} / 役 {len(ROLES)} / "
      f"返信 {'あり' if HAS_REPLY else 'なし'}  ← **語彙から読んだ実物**")
print(f"  使い方の例: {ask}")
