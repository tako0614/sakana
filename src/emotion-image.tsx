import { renderToStaticMarkup } from 'react-dom/server';
import type { CSSProperties } from 'react';

// 「きもち」の結果を 960x540 の画像にする HTML。
//
// 文字は React が必ずエスケープする (dangerouslySetInnerHTML は使わない)。色と文字の大きさは
// この中の表からしか来ないので、style に入るのは決まった値だけ。CSS は手で書く
// (以前の twind は更新が止まり、古い TypeScript を要求して入れ替えの妨げになった)。

export interface EmotionScore {
  label: string;
  score: number;
}

export interface EmotionResult {
  emotions: EmotionScore[];
  /** どの感情も低い (感情の無い発言)。見出しを「落ち着いている」にする。 */
  neutral?: boolean;
}

export interface EmotionImageInput {
  authorName: string;
  avatarUrl: string;
  text: string;
  result: EmotionResult;
}

interface EmotionMeta {
  ja: string;
  color: string;
}

const emotionMeta: Record<string, EmotionMeta> = {
  joy: { ja: '喜び', color: '#f59e0b' },
  sadness: { ja: '悲しみ', color: '#3b82f6' },
  anticipation: { ja: '期待', color: '#10b981' },
  surprise: { ja: '驚き', color: '#ec4899' },
  anger: { ja: '怒り', color: '#ef4444' },
  fear: { ja: '恐れ', color: '#8b5cf6' },
  disgust: { ja: '嫌悪', color: '#64748b' },
  trust: { ja: '信頼', color: '#14b8a6' },
  neutral: { ja: '平静', color: '#94a3b8' }
};

const roastLines: Record<string, string> = {
  joy: '今なら何でも許してくれます。',
  sadness: '慰めてあげると喜びますが、あまり構いすぎると逆効果かもしれません。',
  anticipation: 'ワクワクしています。期待に答えてあげよう',
  surprise: 'パニックにならないよう、状況をゆっくり説明してあげましょう。',
  anger: '触らぬ神に祟りなし。とりあえずそっと距離を置きましょう。',
  fear: '怯えています。あたまを撫でて、安心させてあげましょう。',
  disgust: '地雷を踏まないように注意が必要です。',
  trust: '何かお願い事をするなら今がチャンスです。',
  neutral: '特に感情は動いていないようです。普通に話しかけて大丈夫です。'
};

const verbs: Record<string, string> = {
  joy: '喜んでいる',
  sadness: '悲しんでいる',
  anticipation: '期待している',
  surprise: '驚いている',
  anger: '怒っている',
  fear: '恐れている',
  disgust: '嫌悪している',
  trust: '信頼している',
  neutral: '落ち着いている'
};

// 画像の中から外へ取りに行けるのは Discord のアバター画像だけ (描画側の Chrome でも同じ制限をかける)
export const IMAGE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `img-src ${IMAGE_HOSTS.map((host) => `https://${host}`).join(' ')} data:`,
  "style-src 'unsafe-inline'"
].join('; ');

export function renderEmotionHtml({ authorName, avatarUrl, text, result }: EmotionImageInput): string {
  const markup = renderToStaticMarkup(<EmotionImage authorName={authorName} avatarUrl={avatarUrl} text={text} result={result} />);
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`
    + `<style>${css}</style></head>${markup}</html>`;
}

function EmotionImage({ authorName, avatarUrl, text, result }: EmotionImageInput) {
  const emotions = [...result.emotions].sort((a, b) => b.score - a.score);
  const topLabel = result.neutral === true ? 'neutral' : (emotions[0]?.label ?? '');
  const meta = getEmotionMeta(topLabel);

  // 文字数に応じてフォントサイズを動的に調整
  const nameLength = [...authorName].length;
  const nameSize = nameLength > 20 ? 24 : nameLength > 12 ? 32 : 42;

  const verbText = verbs[topLabel] ?? '感情が昂っている';
  const verbLength = [...verbText].length;
  const verbSize = verbLength > 10 ? 40 : verbLength > 6 ? 52 : 64;

  const textLength = [...text].length;
  const textSize = textLength > 120 ? 18 : textLength > 80 ? 20 : textLength > 40 ? 24 : 28;

  return (
    <body>
      <main>
        {/* 左側: ハイライト表示とコメント */}
        <section className="highlight" style={{ background: meta.color }}>
          {/* 背景の装飾 */}
          <div className="glow glow-light"></div>
          <div className="glow glow-dark"></div>

          <div className="headline">
            <div className="name-row">
              <span className="name" style={{ fontSize: nameSize }}>{authorName}</span>
              <span className="particle">は</span>
            </div>
            <span className="verb" style={{ fontSize: verbSize }}>{verbText}！</span>
          </div>

          <div className="speech">
            <img className="avatar" src={avatarUrl} alt="" />
            <div className="speech-bubble" style={{ fontSize: textSize }}>{text}</div>
          </div>

          <div className="roast">
            <div className="roast-text">{roastLines[topLabel] ?? '優しく見守ってあげてください。'}</div>
          </div>
        </section>

        {/* 右側: 上位5位の感情グラフ (五角形レーダー) */}
        <section className="chart">
          <div className="chart-inner">
            <PentagonRadar emotions={emotions.slice(0, 5)} dominantColor={meta.color} />
          </div>
        </section>
      </main>
    </body>
  );
}

interface Point {
  x: number;
  y: number;
}

function PentagonRadar({ emotions, dominantColor }: { emotions: EmotionScore[]; dominantColor: string }) {
  const center = 200;
  const radius = 125;

  const getPoint = (index: number, ratio: number): Point => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / 5;
    const distance = radius * ratio;
    return { x: center + Math.cos(angle) * distance, y: center + Math.sin(angle) * distance };
  };

  const formatPoint = (p: Point) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

  const gridPoints = [1, 2, 3].map((level) =>
    Array.from({ length: 5 }, (_, index) => formatPoint(getPoint(index, level / 3))).join(' ')
  );

  // スコアが小さい場合でもグラフがしっかり見えるよう、最大値を基準に相対スケーリングする
  const maxScore = Math.max(0.01, ...emotions.map((e) => e.score));
  // 0〜maxScore を 0〜1 の比率に変換（一番高い感情が常に外枠に届くようにする）
  const dataPoints = emotions.map((emotion, index) => getPoint(index, Math.max(0, emotion.score) / maxScore));
  const dashed: CSSProperties = { stroke: '#e2e8f0', strokeWidth: 1.5 };

  return (
    <svg className="radar" viewBox="0 0 400 400" role="img" aria-label="上位5感情レーダーチャート">
      {gridPoints.map((points, index) => (
        <polygon key={index} className="radar-grid" points={points} />
      ))}
      {Array.from({ length: 5 }, (_, index) => {
        const point = getPoint(index, 1);
        return (
          <line key={index} style={dashed} strokeDasharray="4 4" x1={center} y1={center} x2={point.x.toFixed(1)} y2={point.y.toFixed(1)} />
        );
      })}
      <polygon
        points={dataPoints.map(formatPoint).join(' ')}
        fill={dominantColor}
        fillOpacity="0.25"
        stroke={dominantColor}
        strokeWidth="4"
        strokeLinejoin="round"
      />
      {dataPoints.map((point, index) => (
        <circle key={index} cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} r="6" fill="#ffffff" stroke={dominantColor} strokeWidth="3.5" />
      ))}
      {emotions.map((emotion, index) => {
        const point = getPoint(index, 1.25);
        return (
          <text key={emotion.label} className="radar-label" x={point.x.toFixed(1)} y={point.y.toFixed(1)}>
            {getEmotionMeta(emotion.label).ja}
          </text>
        );
      })}
    </svg>
  );
}

function getEmotionMeta(label: string): EmotionMeta {
  return emotionMeta[label] ?? { ja: label, color: '#475569' };
}

const css = `
body {
  margin: 0; display: flex; width: 960px; height: 540px; align-items: center; justify-content: center;
  background: transparent; color: #0f172a; -webkit-font-smoothing: antialiased;
  font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;
}
main { display: flex; width: 100%; height: 100%; overflow: hidden; background: #ffffff; }
.highlight {
  position: relative; display: flex; flex: 1 1 0%; flex-direction: column; justify-content: center;
  padding: 40px 48px; overflow: hidden; color: #ffffff;
}
.glow { position: absolute; width: 256px; height: 256px; border-radius: 9999px; filter: blur(40px); }
.glow-light { right: -80px; top: -80px; background: rgba(255, 255, 255, 0.1); }
.glow-dark { left: -80px; bottom: -80px; background: rgba(0, 0, 0, 0.1); }
.headline {
  z-index: 10; display: flex; flex-direction: column; margin-bottom: 24px; font-weight: 900; line-height: 1.25;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.05));
}
.name-row { display: flex; align-items: baseline; word-break: break-all; }
.name { display: inline-block; flex-shrink: 0; vertical-align: bottom; }
.particle { flex-shrink: 0; margin-left: 4px; font-size: 42px; white-space: nowrap; }
.verb {
  display: inline-block; margin-top: 8px; line-height: 1.25; word-break: keep-all;
  background: #ffffff; color: transparent; -webkit-background-clip: text; background-clip: text;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.15));
}
.speech { z-index: 10; display: flex; flex: 1 1 0%; align-items: flex-start; gap: 20px; min-height: 0; margin-bottom: 32px; }
.avatar {
  width: 104px; height: 104px; flex-shrink: 0; object-fit: cover; border-radius: 9999px;
  border: 4px solid rgba(255, 255, 255, 0.4); background: #1e293b;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
}
.speech-bubble {
  position: relative; flex: 1 1 0%; overflow: hidden; overflow-wrap: break-word; padding: 24px 28px;
  border-radius: 16px; background: rgba(255, 255, 255, 0.2); font-weight: 700; line-height: 1.5;
  backdrop-filter: blur(4px); box-shadow: inset 0 2px 4px 0 rgba(0, 0, 0, 0.05);
}
.speech-bubble::before {
  content: ""; position: absolute; top: 30px; left: -12px; width: 0; height: 0;
  border-top: 10px solid transparent; border-bottom: 10px solid transparent; border-right: 12px solid rgba(255, 255, 255, 0.2);
}
.roast {
  z-index: 10; flex-shrink: 0; align-self: flex-start; max-width: 100%; margin-top: auto; padding: 16px 28px;
  border-radius: 12px; background: rgba(15, 23, 42, 0.25); backdrop-filter: blur(12px);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
}
.roast-text { font-size: 24px; font-weight: 700; letter-spacing: 0.025em; line-height: 1.375; }
.chart {
  position: relative; display: flex; width: 440px; flex-direction: column; align-items: center; justify-content: center;
  padding: 24px; background: #f8fafc;
}
.chart-inner { margin-top: 8px; }
.radar { width: 400px; height: 400px; overflow: visible; }
.radar-grid { fill: none; stroke: #e2e8f0; stroke-width: 2; }
.radar-label { fill: #334155; font-size: 20px; font-weight: 900; letter-spacing: 0.05em; text-anchor: middle; dominant-baseline: middle; }
`;
