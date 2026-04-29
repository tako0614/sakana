import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { extract, twind, virtual } from '@twind/core';
import presetTailwind from '@twind/preset-tailwind';

const emotionMeta = {
  joy: { ja: '喜び', color: '#f59e0b', textClass: 'text-amber-500', borderClass: 'border-amber-500', bgClass: 'bg-amber-500' },
  sadness: { ja: '悲しみ', color: '#3b82f6', textClass: 'text-blue-500', borderClass: 'border-blue-500', bgClass: 'bg-blue-500' },
  anticipation: { ja: '期待', color: '#10b981', textClass: 'text-emerald-500', borderClass: 'border-emerald-500', bgClass: 'bg-emerald-500' },
  surprise: { ja: '驚き', color: '#ec4899', textClass: 'text-pink-500', borderClass: 'border-pink-500', bgClass: 'bg-pink-500' },
  anger: { ja: '怒り', color: '#ef4444', textClass: 'text-red-500', borderClass: 'border-red-500', bgClass: 'bg-red-500' },
  fear: { ja: '恐れ', color: '#8b5cf6', textClass: 'text-violet-500', borderClass: 'border-violet-500', bgClass: 'bg-violet-500' },
  disgust: { ja: '嫌悪', color: '#64748b', textClass: 'text-slate-500', borderClass: 'border-slate-500', bgClass: 'bg-slate-500' },
  trust: { ja: '信頼', color: '#14b8a6', textClass: 'text-teal-500', borderClass: 'border-teal-500', bgClass: 'bg-teal-500' }
};

const roastLines = {
  joy: '今なら何でも許してくれます。',
  sadness: '慰めてあげると喜びますが、あまり構いすぎると逆効果かもしれません。',
  anticipation: 'ワクワクしています。期待に答えてあげよう',
  surprise: 'パニックにならないよう、状況をゆっくり説明してあげましょう。',
  anger: '触らぬ神に祟りなし。とりあえずそっと距離を置きましょう。',
  fear: '怯えています。あたまを撫でて、安心させてあげましょう。',
  disgust: '地雷を踏まないように注意が必要です。',
  trust: '何かお願い事をするなら今がチャンスです。'
};

export function renderEmotionHtml({ authorName, avatarUrl, text, result }) {
  const sheet = virtual();
  const tw = twind({ presets: [presetTailwind()] }, sheet);
  const markup = renderToStaticMarkup(
    <EmotionImage authorName={authorName} avatarUrl={avatarUrl} text={text} result={result} />
  );
  const { html, css } = extract(markup, tw);

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}${extraCss}</style></head>${html}</html>`;
}

function EmotionImage({ authorName, avatarUrl, text, result }) {
  const emotions = [...result.emotions].sort((a, b) => b.score - a.score);
  const topEmotion = emotions[0];
  const top5Emotions = emotions.slice(0, 5);
  const meta = getEmotionMeta(topEmotion.label);

  // 文字数に応じてフォントサイズを動的に調整
  const nameLength = [...authorName].length;
  const nameSize = nameLength > 20 ? 'text-[24px]' : nameLength > 12 ? 'text-[32px]' : 'text-[42px]';

  const verbText = getEmotionVerb(topEmotion.label);
  const verbLength = [...verbText].length;
  const verbSize = verbLength > 10 ? 'text-[40px]' : verbLength > 6 ? 'text-[52px]' : 'text-[64px]';

  const textLength = [...text].length;
  const textSize = textLength > 120 ? 'text-[18px]' : textLength > 80 ? 'text-[20px]' : textLength > 40 ? 'text-[24px]' : 'text-[28px]';

  return (
    <body className="m-0 flex h-[540px] w-[960px] items-center justify-center bg-transparent text-slate-900 antialiased font-sans">
      <main className="flex h-full w-full overflow-hidden bg-white">
        
        {/* 左側: ハイライト表示とコメント */}
        <section className={`flex flex-1 flex-col justify-center px-12 py-10 text-white relative overflow-hidden ${meta.bgClass}`}>
          {/* 背景の装飾 */}
          <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-white/10 blur-2xl"></div>
          <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-black/10 blur-2xl"></div>

          <div className="z-10 mb-6 font-black leading-tight drop-shadow-sm flex flex-col">
            <div className="flex items-baseline break-all">
              <span className={`inline-block align-bottom shrink-0 ${nameSize}`}>{authorName}</span>
              <span className="shrink-0 whitespace-nowrap ml-1 text-[42px]">は</span>
            </div>
            <span className={`inline-block mt-2 bg-white text-transparent bg-clip-text drop-shadow-[0_2px_2px_rgba(0,0,0,0.15)] filter break-keep leading-tight ${verbSize}`}>
              {verbText}！
            </span>
          </div>

          <div className="z-10 flex items-start gap-5 mb-8 flex-1 min-h-0">
            <img
              className="h-[104px] w-[104px] shrink-0 rounded-full border-4 border-white/40 bg-slate-800 object-cover shadow-lg"
              src={avatarUrl}
              alt=""
            />
            <div className={`speech-bubble relative break-words rounded-2xl bg-white/20 px-7 py-6 font-bold leading-normal backdrop-blur-sm shadow-inner overflow-hidden flex-1 ${textSize}`}>
              {text}
            </div>
          </div>

          <div className="z-10 mt-auto self-start rounded-xl bg-slate-900/25 px-7 py-4 backdrop-blur-md shadow-md max-w-full shrink-0">
            <div className="text-[24px] font-bold tracking-wide leading-snug">
              {getRoastLine(topEmotion.label)}
            </div>
          </div>
        </section>

        {/* 右側: 上位5位の感情グラフ (五角形レーダー) */}
        <section className="flex w-[440px] flex-col items-center justify-center bg-slate-50 p-6 relative">
          <div className="mt-2">
            <PentagonRadar emotions={top5Emotions} dominantColor={meta.color} />
          </div>
        </section>
      </main>
    </body>
  );
}

function PentagonRadar({ emotions, dominantColor }) {
  const center = 200;
  const radius = 125;
  
  const getPoint = (index, ratio) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / 5;
    const distance = radius * ratio;
    return {
      x: center + Math.cos(angle) * distance,
      y: center + Math.sin(angle) * distance
    };
  };

  const formatPoint = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

  const gridPoints = [1, 2, 3].map((level) =>
    Array.from({ length: 5 }).map((_, index) => formatPoint(getPoint(index, level / 3))).join(' ')
  );

  // スコアが小さい場合でもグラフがしっかり見えるよう、最大値を基準に相対スケーリングする
  const maxScore = Math.max(0.01, ...emotions.map((e) => e.score));

  const dataPoints = emotions.map((emotion, index) => {
    // 0〜maxScore を 0〜1 の比率に変換（一番高い感情が常に外枠に届くようにする）
    const ratio = Math.max(0, emotion.score) / maxScore;
    return getPoint(index, ratio);
  });

  return (
    <svg className="h-[400px] w-[400px] overflow-visible" viewBox="0 0 400 400" role="img" aria-label="上位5感情レーダーチャート">
      {gridPoints.map((points, index) => (
        <polygon key={index} className="fill-none stroke-slate-200 [stroke-width:2]" points={points} />
      ))}
      {Array.from({ length: 5 }).map((_, index) => {
        const point = getPoint(index, 1);
        return (
          <line
            key={index}
            className="stroke-slate-200 [stroke-width:1.5] stroke-dashed"
            strokeDasharray="4 4"
            x1={center}
            y1={center}
            x2={point.x.toFixed(1)}
            y2={point.y.toFixed(1)}
          />
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
        <circle
          key={index}
          cx={point.x.toFixed(1)}
          cy={point.y.toFixed(1)}
          r="6"
          fill="#ffffff"
          stroke={dominantColor}
          strokeWidth="3.5"
        />
      ))}
      {emotions.map((emotion, index) => {
        const point = getPoint(index, 1.25);
        return (
          <text key={emotion.label} className="radar-label fill-slate-700 text-[20px] font-black tracking-wider" x={point.x.toFixed(1)} y={point.y.toFixed(1)}>
            {getEmotionJapaneseName(emotion.label)}
          </text>
        );
      })}
    </svg>
  );
}

function getEmotionVerb(label) {
  const verbs = {
    joy: '喜んでいる',
    sadness: '悲しんでいる',
    anticipation: '期待している',
    surprise: '驚いている',
    anger: '怒っている',
    fear: '恐れている',
    disgust: '嫌悪している',
    trust: '信頼している'
  };
  return verbs[label] ?? '感情が昂っている';
}

function getEmotionName(label) {
  const meta = getEmotionMeta(label);
  return `${meta.ja} / ${label}`;
}

function getEmotionJapaneseName(label) {
  return getEmotionMeta(label).ja;
}

function getEmotionMeta(label) {
  return emotionMeta[label] ?? {
    ja: label,
    color: '#475569',
    textClass: 'text-slate-600',
    borderClass: 'border-slate-600',
    bgClass: 'bg-slate-600'
  };
}

function getRoastLine(label) {
  return roastLines[label] ?? '優しく見守ってあげてください。';
}

const extraCss = `
body {
  font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;
}
.speech-bubble::before {
  content: "";
  position: absolute;
  top: 30px;
  left: -12px;
  width: 0;
  height: 0;
  border-top: 10px solid transparent;
  border-bottom: 10px solid transparent;
  border-right: 12px solid rgba(255, 255, 255, 0.2);
}
.radar-label {
  text-anchor: middle;
  dominant-baseline: middle;
}
`;
