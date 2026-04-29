import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder } from 'discord.js';
import nodeHtmlToImage from 'node-html-to-image';
import { renderEmotionHtml } from './emotion-image.jsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const analyzerScript = resolve(__dirname, '../scripts/analyze-emotions.py');

const emotionTriggerText = process.env.EMOTION_TRIGGER_TEXT ?? 'きもち';
const pythonBin = process.env.EMOTION_PYTHON_BIN ?? 'python3';
const analysisTimeoutMs = Number(process.env.EMOTION_ANALYSIS_TIMEOUT_MS ?? 180_000);

export function isEmotionRequest(message) {
  return message.content.trim() === emotionTriggerText && Boolean(message.reference?.messageId);
}

export async function handleEmotionRequest(message) {
  let targetMessage;

  try {
    targetMessage = await message.fetchReference();
  } catch (error) {
    console.error('Failed to fetch referenced message:', error);
    await message.reply({
      content: 'リプライ先のメッセージを取得できませんでした。',
      allowedMentions: { repliedUser: false }
    });
    return;
  }

  const targetText = targetMessage.content.trim();
  if (!targetText) {
    await message.reply({
      content: 'リプライ先に分析できるテキストがありません。',
      allowedMentions: { repliedUser: false }
    });
    return;
  }

  try {
    await message.channel.sendTyping();
    const result = await analyzeEmotion(targetText);
    const image = await renderEmotionImage({
      authorName: targetMessage.member?.displayName ?? targetMessage.author.displayName ?? targetMessage.author.username,
      avatarUrl: getMessageAuthorAvatarUrl(targetMessage),
      text: targetText,
      result
    });

    const attachment = new AttachmentBuilder(image, { name: 'kimochi.png' });
    await message.reply({
      files: [attachment],
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error('Failed to analyze emotion:', error);
    await message.reply({
      content: [
        '気持ち分析に失敗しました。',
        'Python 依存関係が未設定の場合は `pip install -r requirements.txt` を実行してください。'
      ].join('\n'),
      allowedMentions: { repliedUser: false }
    });
  }
}

function analyzeEmotion(text) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonBin, [analyzerScript], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Emotion analysis timed out after ${analysisTimeoutMs}ms`));
    }, analysisTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }

      settled = true;

      if (code !== 0) {
        reject(new Error(stderr || `Emotion analyzer exited with code ${code}`));
        return;
      }

      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Invalid analyzer output: ${error.message}`));
      }
    });

    child.stdin.end(JSON.stringify({ text }));
  });
}

async function renderEmotionImage({ authorName, avatarUrl, text, result }) {
  const html = renderEmotionHtml({ authorName, avatarUrl, text, result });

  return nodeHtmlToImage({
    html,
    type: 'png',
    encoding: 'buffer',
    puppeteerArgs: {
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });
}

function getMessageAuthorAvatarUrl(message) {
  const avatarOptions = {
    extension: 'png',
    size: 128,
    forceStatic: true
  };

  return message.member?.displayAvatarURL(avatarOptions) ?? message.author.displayAvatarURL(avatarOptions);
}
