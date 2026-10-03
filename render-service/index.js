const express = require('express');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const textToSpeech = require('@google-cloud/text-to-speech');
const { Storage } = require('@google-cloud/storage');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const { createReadStream } = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const activeChildren = new Set();
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      activeChildren.delete(child);
      if (err) {
        err.stdout = stdout; err.stderr = stderr;
        console.error(`COMMAND FAILED: ${cmd}`);
        console.error(`  exit code: ${err.code ?? 'n/a'}   signal: ${err.signal ?? 'n/a'}`);
        console.error(`  message  : ${err.message}`);
        const totalArgBytes = args.reduce((n, a) => n + String(a).length, 0);
        const longestArg = args.reduce((n, a) => Math.max(n, String(a).length), 0);
        console.error(`  args     : ${args.length} args, ${totalArgBytes} bytes total, longest single arg ${longestArg} bytes`);
        if (longestArg > 131072) {
          console.error('  -> A SINGLE ARGUMENT EXCEEDS 128KB (Linux MAX_ARG_STRLEN). This is almost');
          console.error('     certainly the cause: the process cannot be spawned at all (E2BIG).');
        }
        if (stderr) console.error(`  stderr   :\n${String(stderr).slice(-4000)}`);
        reject(err);
      } else resolve({ stdout, stderr });
    });
    activeChildren.add(child);
  });
}
function killAllActiveProcesses(reason) {
  if (!activeChildren.size) return;
  console.warn(`killing ${activeChildren.size} orphaned process(es) — reason: ${reason}`);
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch (err) { console.warn('failed to kill a process (non-fatal):', err.message); }
  }
  activeChildren.clear();
}

const credentials = process.env.GOOGLE_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
  : undefined;

const visionClient = new vision.ImageAnnotatorClient(credentials ? { credentials } : undefined);
const ttsClient = new textToSpeech.TextToSpeechClient(credentials ? { credentials } : undefined);

let aiSetupFailureReason = null;

let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
  console.log('AI setup: require("@anthropic-ai/sdk") OK — package is installed.');
} catch (err) {
  aiSetupFailureReason = `the "@anthropic-ai/sdk" npm package is NOT installed in this container (${err && (err.message || err)})`;
  console.error('AI setup FAILED: require("@anthropic-ai/sdk") threw — AI chrome filter + emotion detection are DISABLED, falling back to pattern/keyword matching only.');
  console.error('  error:', err && (err.stack || err.message || err));
  console.error('  FIX: run `npm install @anthropic-ai/sdk --save` inside render-service/, confirm');
  console.error('  "@anthropic-ai/sdk" now appears under "dependencies" in render-service/package.json,');
  console.error('  then redeploy. If package.json was never updated, the Cloud Run build never installs it.');
  Anthropic = null;
}

const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'vidmasta-7e113';
const GCP_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const CLAUDE_MODEL_CANDIDATES = ['claude-opus-5'];

let genAIRegional = null;
if (Anthropic) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    aiSetupFailureReason = 'the ANTHROPIC_API_KEY environment variable is NOT set on this Cloud Run revision';
    console.error('AI setup FAILED: ANTHROPIC_API_KEY is missing — AI chrome filter + emotion detection are DISABLED.');
    console.error('  FIX: add ANTHROPIC_API_KEY to render-service/env.yaml and redeploy with');
    console.error('  --env-vars-file=env.yaml. NOTE: deploying with --set-env-vars REPLACES the entire');
    console.error('  env var set, so a previous deploy using that flag can silently drop this key.');
  } else {
    console.log(`AI setup: ANTHROPIC_API_KEY is present (length ${apiKey.length}, starts "${apiKey.slice(0, 7)}").`);
    try {
      genAIRegional = new Anthropic({ apiKey });
      console.log('AI setup: @anthropic-ai/sdk initialized OK. AI chrome filter + emotion detection enabled.');
    } catch (err) {
      aiSetupFailureReason = `constructing the Anthropic client threw (${err && (err.message || err)})`;
      console.error('AI setup FAILED: @anthropic-ai/sdk failed to INITIALIZE.');
      console.error('  error:', err && (err.stack || err.message || err));
      genAIRegional = null;
    }
  }
}

async function generateWithFallback(prompt, config, debugTrail) {
  if (!genAIRegional) {
    if (debugTrail) debugTrail.push('AI: no candidate model/region was available — falling back');
    return null;
  }
  for (const model of CLAUDE_MODEL_CANDIDATES) {
    try {
      const response = await genAIRegional.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = (response.content || []).map((block) => block.text || '').join('');
      console.log(`AI: model "${model}" succeeded`);
      if (debugTrail) debugTrail.push(`AI model=${model}: OK`);
      return text;
    } catch (err) {
      const status = err && (err.status || err.statusCode);
      console.error(`AI CALL FAILED: model "${model}" — status=${status ?? 'n/a'} type=${err && err.name}`);
      console.error('  message:', err && (err.message || err));
      if (status === 401 || status === 403) {
        console.error('  -> This is an AUTH failure: the ANTHROPIC_API_KEY is present but rejected.');
        console.error('     Check the key is valid and not revoked in the Anthropic Console.');
      } else if (status === 400 && /deprecated|unsupported|unexpected|not supported/i.test(String(err && err.message))) {
        console.error('  -> This is a REQUEST PARAMETER failure: the model rejected a parameter this');
        console.error('     code sent. Read the message above for the exact parameter name and remove');
        console.error('     it from the messages.create({...}) call in generateWithFallback.');
      } else if (status === 400 && /model/i.test(String(err && err.message))) {
        console.error(`  -> The model name "${model}" was rejected. Verify it is correct and available to this account.`);
      } else if (status === 429) {
        console.error('  -> Rate limited or out of credit on the Anthropic account.');
      }
      if (debugTrail) debugTrail.push(`AI model=${model}: ERROR status=${status ?? 'n/a'} ${err && (err.message || err)}`);
    }
  }
  if (debugTrail) debugTrail.push('AI: no candidate model/region was available — falling back');
  return null;
}

const WIDTH = 720, HEIGHT = 1280, XFADE = 0.4;
const HOOK_PIXELIZE_DURATION = 0.15;
const INTRO_XFADE = 0.6;
const ZOOM_START = 1.25, ZOOM_END = 1.0;
const CAPTION_WHITE = 'white';
const CAPTION_GREEN = '0x39FF14';
const FONT = path.join(__dirname, 'assets', 'fonts', 'TikTokSans-Black.ttf');
const ASSETS = path.join(__dirname, 'assets');

const CHROME_PATTERNS = [
  /^\d+(\.\d+)?[kKmM]?\+?\s*(likes?|upvotes?|downvotes?|comments?|shares?|retweets?|replies?|views?|awards?|points?|karma)$/i,
  /^(reply|share|save|report|follow|following|unfollow|like|retweet|repost|quote|award|gift|more|see more|show more|read more|edit|edited|delete|pin|pinned|op|text|imessage|message|text message)$/i,
  /^tex[a-z]$/i,
  /^tex[a-z]\s+message$/i,
  /^(likes?|upvotes?|downvotes?|comments?|shares?|retweets?|replies?|views?|awards?|points?|karma)$/i,
  /^u\/\S+$|^r\/\S+$|^@\w+$/,
  /^\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?$/i,
  /^\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(just now|yesterday|today)$/i,
  /^\d+(\.\d+)?[kKmM]?$/,
  /^\d+%\s*(upvoted)?$/i,
  /^(posted by|submitted by)\s+u\/\S+/i,
  /^[\u2022\-\u2013\u2014\u00b7|]+$/,
  /^[A-Za-z]{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{2,4}$/i,
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+'?\d{2,4}$/i,
  /^\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?[kKmM]?\+?\s*retweets?\s+\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?[kKmM]?\+?\s*(?:ouote|quote)\s+tweets?\s+\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?[kKmM]?\+?\s*likes?$/i,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^\d{1,2}:\d{2}\s*(am|pm)?$/i,
  /^(posted|submitted|edited)\s+(on\s+)?.{0,20}$/i,
  /^(view\s+)?\d+(\.\d+)?[kKmM]?\s*(more\s+)?(repl(y|ies)|comments?)$/i,
  /^replying to\s+@\S+(\s*(,|and)\s*@\S+)*\.?$/i,
  /^replying to\.?$/i,
  /^@?[\w.-]+\s+\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(?:b|black circle|musical note|heart|star|repl(?:y|ies)|ago|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|\d+)(?:\s+(?:b|black circle|musical note|heart|star|repl(?:y|ies)|ago|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|\d+))*$/i,
  /^[il]\s+\d+$/i,
  /^i\s*funny\s*\.\s*co$/i,
  /^(go|swipe up|swipe|link in bio|tap here|click here)$/i,
  /^sanctified[\s._-]*ish$/i,
  /^i\s*funny\s*\.\s*co$/i,
  /^(\d{1,2}:\d{2}\s*(am|pm)?)?\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{2,4})?\s*(\d+(\.\d+)?[kKmM]?\+?\s*(likes?|upvotes?|downvotes?|comments?|shares?|retweets?|replies?|views?|awards?|points?|karma))?$/i,
  /^physio\s*tru\b.*$/i,
  /^(\d+\s+)?d\s*field(\s+(phase|days?))?\s+(free\s+)?training\s+menu$/i,
  /^(free\s+)?training\s+menu$/i,
  /^field\s+(phase|days?)$/i,
  /^\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago(\s+\d{1,2})?(\s+[A-Za-z])?$/i,
  /^\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\s+\d+\s+d\s*field(\s+(phase|days?))?\s+(free\s+)?training\s+menu$/i,
  /^\d+\s*hits?!?$/i,
  /^twitter for \w+$/i,
  /^blue\s*checkmark$/i,
  /^verified$/i,
  /^twitter web app$/i,
  /^quote\s+tweets?$/i,
  /^show this thread$/i,
  /^\d{1,2}-\d{1,2}$/,
  /^(?:\d{1,2}-\d{1,2}|\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?[kKmM]?|repl(?:y|ies)|like|likes|share|shares|view|views|comments?|b|black circle|musical note|heart|star|thumbs up|thumbs down|edited|ago|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|mo|min|hr|h|d|w|m|y)(?:\s+(?:\d{1,2}-\d{1,2}|\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?[kKmM]?|repl(?:y|ies)|like|likes|share|shares|view|views|comments?|b|black circle|musical note|heart|star|thumbs up|thumbs down|edited|ago|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|mo|min|hr|h|d|w|m|y))*$/i,
  /^\d{1,3}(?:,\d{3})+$/,
  /^(?:lte|5g|4g|3g|wi-?fi)\s*\d{1,3}%?$/i,
  /^[\w.'-]{2,30}\s*[>\u25b8\u25b6\u2023\u27a4]\s*[\w.'-]{2,30}\.{0,3}$/,
  /^get inspired on edits$/i,
  /^insights$/i,
  /^boost$/i,
  /^\d{4}-\d{1,2}-\d{1,2}$/,
  /^[\w\-]{2,30}(?:\s*(?:[\u2022\u00b7|]|\s\.)\s*(?:edited\s+)?\d+\s*(?:mo|min|mins|hr|hrs|h|d|w|m|y|seconds?|secs?|minutes?|hours?|hrs?|days?|weeks?|months?|years?)\s*(?:ago)?\s*\.?)+(?:\s*(?:[\u2022\u00b7|]|\s\.)?\s*edited)?\s*\.?$/i,
  /^(?=[\w.\-]*\d|[\w.\-]{8,})[\w.\-]{2,30}(?:\s+(?:edited\s+)?\d+\s*(?:mo|min|mins|hr|hrs|h|d|w|m|y|seconds?|secs?|minutes?|hours?|hrs?|days?|weeks?|months?|years?)\s*(?:ago)?)+(?:\s+edited)?$/i,
  /^archived post\s*\.?\s*(new comments cannot be posted.*)?$/i,
  /^votes cannot be cast\s*\.?$/i,
  /^new comments cannot be posted( and)?\s*\.?$/i,
  /^\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\s*\(?edited\)?(?:\s*[.,\u2022\u00b7|]?\s*[a-zA-Z0-9]{1,4})*\s*[.,\u2022\u00b7|]?\s*$/i,
  /^[A-Z][\w'.-]*(\s+[A-Z][\w'.-]*){0,4}\s+and\s+\d+(\.\d+)?[kKmM]?\+?\s+others?(\s+\d{1,3}(,\d{3})*(\.\d+)?[kKmM]?\+?\s*(likes?|upvotes?|downvotes?|comments?|shares?|retweets?|replies?|views?|awards?|points?|karma))?$/i,
  /^\d{1,3}(,\d{3})+(\.\d+)?[kKmM]?\+?\s*(likes?|upvotes?|downvotes?|comments?|shares?|retweets?|replies?|views?|awards?|points?|karma)$/i,
];

function isChromeFragment(text) {
  if (BOT_HEADER_LINE.test(text.trim())) return true;
  return CHROME_PATTERNS.some((re) => re.test(text));
}

function stripLeadingMention(text) {
  let result = text;
  result = result.replace(/^([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3})\s+@\s*\1\b\s*/i, '');
  result = result.replace(/^replying to\s+@\s*[\w.]+(\s*(,|and)\s*@\s*[\w.]+)*[:,]?\s+/i, '');
  result = result.replace(/^(@\s*[\w.]+[:,]?\s*)+/, '');
  result = result.replace(/^#\s*[\w.]+\s+(?=\S)/, '');
  result = result.replace(/@\s*[\w.]+/g, '');
  result = result.replace(/\s{2,}/g, ' ');
  result = result.replace(/^[,:;]\s*/, '');
  return result.trim();
}

const TRAILING_CTA_WORDS = /\s+(go|swipe up|swipe|link in bio|tap here|click here)[.!]?$/i;
function stripTrailingCTA(text) {
  return text.replace(TRAILING_CTA_WORDS, '').trim();
}

const LEADING_REDDIT_TAGS = /^(?:r\s*\/\s*\S+\s+)?(?:u\s*\/\s*\S+\s+)?/i;
const BOT_HEADER_LINE = /^[\w]*(?:_?bot|bot_?|automoderator)[\w]*(?:\s+(?:app\s+)?mod)?(?:\s*[•·|-]?\s*\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?)?$/i;
function stripLeadingRedditTags(text) {
  return text.replace(LEADING_REDDIT_TAGS, '').trim();
}

const LEADING_DISPLAY_NAME_REPLYING_TO = /^[A-Z][\w'.-]*(\s+[A-Z][\w'.-]*)*\s*[•·]\s*replying to\s+/i;
function stripLeadingReplyingToHeader(text) {
  return text.replace(LEADING_DISPLAY_NAME_REPLYING_TO, '').trim();
}

const MID_TEXT_IFUNNY = /\s*[iR]\s*funny\s*\.\s*co\s*/gi;
function stripIfunnyWatermarkAnywhere(text) {
  return text.replace(MID_TEXT_IFUNNY, ' ').replace(/\s{2,}/g, ' ').trim();
}

const MID_TEXT_REPLY_HEADER = /\s*[\w\s\/'.-]*?\.{2,}\s*\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s+replying to\s*(@\s*\S+)?\s*/gi;
function stripReplyHeaderAnywhere(text) {
  return text.replace(MID_TEXT_REPLY_HEADER, ' ').replace(/\s{2,}/g, ' ').trim();
}

const TRAILING_TIMESTAMP = /(?<=[)\]"'.!?])\s+\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\s*(\(\s*edited\s*\))?(\s+[\w\u00c0-\u9fff]{1,4}){0,4}\s*[.!]?$/i;
function stripTrailingTimestamp(text) {
  return text.replace(TRAILING_TIMESTAMP, '').trim();
}

const IDENTITY_MARKER_PATTERNS = [
  /^\(?@[\w.]+\)?\.*$/,
  /^\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?$/i,
  /^\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago$/i,
  /^replying to\b.*$/i,
  /^(?:\d{1,2}-\d{1,2}|\d{1,3}(?:[.,]\d{3})*[kKmM]?|repl(?:y|ies)|like|likes|heart|share|shares)(?:\s+(?:\d{1,2}-\d{1,2}|\d{1,3}(?:[.,]\d{3})*[kKmM]?|repl(?:y|ies)|like|likes|heart|share|shares))*$/i,
];
function isIdentityMarkerLine(text) {
  const t = String(text || '').trim();
  return IDENTITY_MARKER_PATTERNS.some((re) => re.test(t));
}

const HEADER_NOISE = new RegExp([
  String.raw`@\s*[\w.]+`,
  String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`,
  String.raw`\d{1,2}:\d{2}\s*(?:am|pm)?`,
  String.raw`\d{1,2}\s+[A-Za-z]{3,9}\.?\s+'?\d{2,4}`,
  String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}`,
  String.raw`\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|mo|min|hr|h|d|w|m|y)\s*ago`,
  String.raw`\d+\s*(?:mo|min|mins|hr|hrs|h|d|w|m|y)\b`,
  String.raw`blue\s*checkmark`,
  String.raw`verified`,
  String.raw`[\u2022\u00b7|]`,
].join('|'), 'gi');

function isSelfContainedAccountHeader(raw) {
  const t = String(raw || '').trim();
  if (!/@/.test(t)) return false;
  if (/[.!?]$/.test(t.replace(/\.{2,}$/, ''))) return false;
  const startsWithHandle = /^@/.test(t);
  const rest = t
    .replace(HEADER_NOISE, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/[()\[\]]/g, ' ')
    .replace(/\s+\.(?=\s|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!rest) return true;
  const toks = rest.split(/\s+/).filter(Boolean);
  if (toks.length > 4) return false;
  if (toks.every((w) => /^[^a-z]*[A-Z]/.test(w))) return true;
  return !startsWithHandle && toks.length <= 2;
}

function isDisplayNameHeaderInContext(texts, i) {
  const raw = String(texts[i] || '').trim();
  if (!raw) return false;
  if (isSelfContainedAccountHeader(raw)) return true;
  const core = raw.replace(/\.{2,}$/, '').trim();
  const wasTruncated = core !== raw;
  if (/[.!?]$/.test(core)) return false;
  const tokens = core.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 5) return false;
  const prev = i > 0 ? String(texts[i - 1] || '').trim() : '';
  const next = i < texts.length - 1 ? String(texts[i + 1] || '').trim() : '';
  if (tokens.length <= 3 && (BARE_HANDLE_LINE.test(prev) || BARE_HANDLE_LINE.test(next))) return true;
  const alpha = tokens.filter((t) => /[A-Za-z]/.test(t));
  if (!alpha.length) return false;
  if (!alpha.every((t) => /^[^a-z]*[A-Z]/.test(t))) return false;
  if (tokens.length < 2) return false;
  const REPLYING_TO_MARKER = /^replying to\b/i;
  if (REPLYING_TO_MARKER.test(prev) || REPLYING_TO_MARKER.test(next)) return true;
  const BADGE_MARKER = /^(blue\s*checkmark|verified)$/i;
  if (BADGE_MARKER.test(prev) || BADGE_MARKER.test(next)) return true;
  return core.includes('/') || wasTruncated;
}

const CHROME_ATOM_SOURCES = [
  String.raw`\d{1,2}:\d{2}\s*(?:am|pm)?`,
  String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`,
  String.raw`\d{4}-\d{1,2}-\d{1,2}`,
  String.raw`\d{1,2}\s+[A-Za-z]{3,9}\.?\s+'?\d{2,4}`,
  String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}`,
  String.raw`twitter for \w+`,
  String.raw`\d[\d.,]*[kKmM]?\s*(?:retweets?|quote\s+tweets?|ouote\s+tweets?|likes?|views?|comments?|replies?|shares?|upvotes?)`,
  String.raw`\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|mo|min|hr|h|d|w|m|y)\s*ago(?:\s+\d{1,2}){0,4}`,
];
const CHROME_ATOM = new RegExp(`(?:${CHROME_ATOM_SOURCES.join('|')})`, 'i');
const CHROME_RUN = new RegExp(
  `(?:${CHROME_ATOM_SOURCES.join('|')})(?:\\s*[\\u2022\\u00b7|\\-]?\\s*(?:${CHROME_ATOM_SOURCES.join('|')}))*`,
  'gi'
);
const RELATIVE_TIMESTAMP_ATOM = String.raw`\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|mo|min|hr|h|d|w|m|y)\s*ago(?:\s+\d{1,2}){0,4}`;
const LONE_RELATIVE_TIMESTAMP = new RegExp(`^${RELATIVE_TIMESTAMP_ATOM}$`, 'i');
const LONG_LINE_WORDS = 8;
function stripEmbeddedChrome(text) {
  const original = String(text || '');
  const totalWords = original.split(/\s+/).filter(Boolean).length;
  const result = original.replace(CHROME_RUN, (match, offset) => {
    const run = match.trim();
    if (!run) return match;
    const isLoneAmbiguous = LONE_RELATIVE_TIMESTAMP.test(run);
    if (isLoneAmbiguous) {
      const trailing = offset + match.length >= original.trimEnd().length;
      if (!(trailing && totalWords >= LONG_LINE_WORDS)) return match;
    }
    return ' ';
  });
  return result.replace(/\s{2,}/g, ' ').trim();
}

const USERNAME_TIMESTAMP_LINE = /^[A-Z][\w.'-]*(\s+[A-Z][\w.'-]*){0,3}\s+\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?$/;
const HANDLE_HEADER_LINE = /^[A-Za-z0-9\u00c0-\u00ff .,'-]{0,40}(\(@\w+\)|@\w+)[A-Za-z0-9\u00c0-\u00ff .,'-]{0,40}([\s.|]{0,3}\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?)?[\s.|]{0,3}$/i;
const BARE_HANDLE_LINE = /^\(?@[\w.]+\)?\.*$/;

function cleanLine(rawText) {
  const trimmed = rawText.trim().replace(/^\+\s+/, '');
  if (USERNAME_TIMESTAMP_LINE.test(trimmed)) return '';
  if (HANDLE_HEADER_LINE.test(trimmed)) return '';
  if (isChromeFragment(trimmed)) return '';
  const parts = trimmed.split(/\s*[\u2022\u00b7|\u26ab]\s*|\s+-\s+|\s+\.\s+|\s+\.\s*$/).map((p) => p.trim()).filter(Boolean);
  return parts.filter((p) => /[a-zA-Z0-9]/.test(p)).filter((p) => !isChromeFragment(p)).join(' ');
}


const AI_IMAGE_MAX_EDGE = 1568;
async function prepareImageForVision(imgPath, dir, tag) {
  const outPath = path.join(dir, `vision_${tag}.jpg`);
  await run('ffmpeg', [
    '-i', imgPath,
    '-vf', `scale='if(gt(iw,ih),min(${AI_IMAGE_MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${AI_IMAGE_MAX_EDGE},ih))'`,
    '-q:v', '4', '-y', outPath,
  ]);
  const stat = await fs.stat(outPath);
  return { path: outPath, bytes: stat.size };
}

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_ANALYSIS_MODEL = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-3.1-flash-lite';
console.log(GEMINI_API_KEY
  ? `Gemini analysis: GEMINI_API_KEY is set (length ${GEMINI_API_KEY.length}, starts "${GEMINI_API_KEY.slice(0, 3)}") — screenshot filter + emotion detection will use ${GEMINI_ANALYSIS_MODEL}`
  : 'Gemini analysis: GEMINI_API_KEY is NOT set — screenshot filter + emotion detection will use Claude instead');

const GEMINI_ENDPOINTS = [
  { name: 'Gemini API', url: (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent` },
  { name: 'Vertex AI express', url: (m) => `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent` },
];
let geminiWorkingEndpoint = null;

const GEMINI_RETRYABLE = new Set([429, 500, 503, 504]);
const GEMINI_MAX_ATTEMPTS = 5;
async function geminiGenerate(parts, label, debugTrail) {
  if (!GEMINI_API_KEY) {
    if (debugTrail) debugTrail.push(`${label}: GEMINI_API_KEY is not set, so Gemini could not run`);
    return null;
  }
  const endpoints = geminiWorkingEndpoint ? [geminiWorkingEndpoint] : GEMINI_ENDPOINTS;
  const failures = [];
  const started = Date.now();
  for (const ep of endpoints) {
    let keyRejected = false;
    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      let retryable = false;
      try {
        const r = await fetch(`${ep.url(GEMINI_ANALYSIS_MODEL)}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });
        const json = await r.json().catch(() => ({}));
        if (r.ok) {
          const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          if (text) {
            if (!geminiWorkingEndpoint) console.log(`Gemini: using the ${ep.name} endpoint for ${GEMINI_ANALYSIS_MODEL}`);
            geminiWorkingEndpoint = ep;
            const retries = attempt - 1;
            console.log(`Gemini [${label}]: ${GEMINI_ANALYSIS_MODEL} via ${ep.name} OK in ${Date.now() - started}ms${retries ? ` after ${retries} retr${retries === 1 ? 'y' : 'ies'}` : ''}`);
            if (retries && debugTrail) debugTrail.push(`${label}: Gemini was busy, succeeded after ${retries} retr${retries === 1 ? 'y' : 'ies'}`);
            return text;
          }
          failures.push(`${ep.name} attempt ${attempt}: empty response (finishReason=${json.candidates?.[0]?.finishReason || 'n/a'}, blockReason=${json.promptFeedback?.blockReason || 'n/a'})`);
          retryable = true;
        } else {
          failures.push(`${ep.name} attempt ${attempt}: HTTP ${r.status} ${JSON.stringify(json.error || json).slice(0, 200)}`);
          if (r.status === 401 || r.status === 403) keyRejected = true;
          else retryable = GEMINI_RETRYABLE.has(r.status);
        }
      } catch (err) {
        failures.push(`${ep.name} attempt ${attempt}: network error ${err && (err.message || err)}`);
        retryable = true;
      }
      console.error(`Gemini [${label}] ${failures[failures.length - 1]}`);
      if (keyRejected || !retryable || attempt === GEMINI_MAX_ATTEMPTS) break;
      const waitMs = 2000 * 2 ** (attempt - 1);
      console.log(`Gemini [${label}]: retrying in ${waitMs / 1000}s (attempt ${attempt + 1} of ${GEMINI_MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!keyRejected) break;
  }
  if (debugTrail) debugTrail.push(`${label}: Gemini ${GEMINI_ANALYSIS_MODEL} FAILED after retrying (${failures.slice(-3).join(' || ')})`);
  return null;
}

async function aiKeepMaskFromImage(imgPath, lines, dir, tag, debugTrail) {
  if (!GEMINI_API_KEY || !lines.length) return null;
  try {
    const prepared = await prepareImageForVision(imgPath, dir, tag);
    if (prepared.bytes > 4.5 * 1024 * 1024) {
      console.warn(`vision classifier: prepared image is ${(prepared.bytes / 1024 / 1024).toFixed(1)}MB, too large — falling back to text-only classification.`);
      if (debugTrail) debugTrail.push('vision classifier: image too large after downscale — used text-only classifier');
      return null;
    }
    const b64 = (await fs.readFile(prepared.path)).toString('base64');
    const numbered = lines.map((l, i) => `${i}: ${l}`).join('\n');

    const prompt =
      'The image is a screenshot of a social media post or comment thread. ' +
      'Below it are the OCR lines extracted from that exact screenshot, in ' +
      'top-to-bottom order and numbered.\n\n' +
      'LOOK AT THE IMAGE to decide, for each numbered line, whether it is:\n' +
      '- REAL CONTENT: words a person actually typed — the body of a post, ' +
      'comment or reply.\n' +
      '- UI CHROME: anything the app drew rather than a person typing it.\n\n' +
      'Because you can SEE the layout, judge each line by its visual role, ' +
      'not by whether the words look meaningful:\n' +
      '- A username/display name sits on its own short line directly above ' +
      'the comment it wrote, usually in smaller, greyer or bolder text and ' +
      'next to a profile picture. It is CHROME even when it reads like an ' +
      'ordinary word or name ("Stephen", "Display", "Corn", "truxGG").\n' +
      '- A comment footer (a date like "11-25" or "2-16", the word Reply or ' +
      'Replies, like/heart counts, thumb icons) is CHROME. The word Reply ' +
      'or Replies and ANY numbers next to it must never be kept.\n' +
      '- Text OCR produced from an ICON or emoji ("musical note", "heart", ' +
      '"thumbs up", "blue checkmark") is CHROME — check the image to see ' +
      'whether that spot is a picture rather than typed text.\n' +
      '- Timestamps, view/retweet/like counts, app signatures ("Twitter for ' +
      'iPhone"), watermarks, phone status bar (clock, battery, "LTE 81"), ' +
      'and buttons ("Follow", "Insights", "Boost", "Show this thread") are ' +
      'all CHROME.\n' +
      '- The post\'s own TITLE and body ARE real content, including when a ' +
      'sentence wraps across two or more OCR lines — keep every part.\n' +
      '- A short reaction someone typed ("Oh...!!!", "I wish I did", ' +
      '"Unconcerned") IS real content. Being short is not a reason to drop ' +
      'a line; being visually positioned as a name/footer/button is.\n\n' +
      'When genuinely unsure, keep the line — a pattern-based safety net ' +
      'runs afterwards and removes clear-cut chrome shapes.\n\n' +
      `Return ONLY a JSON array of exactly ${lines.length} booleans, in the ` +
      'same order as the numbered lines — true = REAL CONTENT (keep), ' +
      'false = UI CHROME (discard). Raw JSON only, no explanation.\n\n' +
      numbered;

    let rawText = await geminiGenerate(
      [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }, { text: prompt }],
      'screenshot filter',
      debugTrail,
    );
    let modelUsed = rawText != null ? `Gemini ${GEMINI_ANALYSIS_MODEL}` : null;
    if (rawText == null) return null;

    let cleaned = rawText.trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    let mask;
    try {
      mask = JSON.parse(cleaned);
    } catch {
      const arr = cleaned.match(/\[[\s\S]*\]/);
      if (!arr) throw new Error(`no JSON array in vision response: ${cleaned.slice(0, 300)}`);
      mask = JSON.parse(arr[0]);
    }
    if (!Array.isArray(mask) || mask.length !== lines.length) {
      console.warn(`vision classifier: mask length mismatch (got ${Array.isArray(mask) ? mask.length : typeof mask}, expected ${lines.length}) — falling back.`);
      if (debugTrail) debugTrail.push('vision classifier: mask length mismatch — used text-only classifier');
      return null;
    }
    console.log(`vision classifier: kept ${mask.filter(Boolean).length}/${lines.length} lines`);
    if (debugTrail) debugTrail.push(`vision classifier: kept ${mask.filter(Boolean).length}/${lines.length} lines (${modelUsed} saw the screenshot)`);
    const result = mask.map(Boolean);
    result.modelUsed = modelUsed;
    return result;
  } catch (err) {
    console.error('vision classifier failed, falling back to text-only:', err && (err.stack || err.message || err));
    if (debugTrail) debugTrail.push(`vision classifier: ERROR ${err && (err.message || err)} — used text-only classifier`);
    return null;
  }
}

async function aiKeepMask(lines, debugTrail) {
  if (!genAIRegional) {
    if (debugTrail) debugTrail.push('chrome filter: SKIPPED — genAIRegional not available');
    return null;
  }
  if (!lines.length) return null;
  let rawText = '';
  try {
    const numbered = lines.map((l, i) => `${i}: ${l}`).join('\n');
    const prompt =
      'These are raw OCR lines from a screenshot of a social media post or ' +
      'thread, in the exact top-to-bottom order they appear on screen. ' +
      'Nothing has been pre-filtered yet.\n\n' +
      'Classify each line as either:\n' +
      '- REAL CONTENT: text a person actually wrote.\n' +
      '- UI CHROME: a display name, an @handle, a timestamp, a like/reply ' +
      'count, a button label (Reply, Share, Follow), a "Replying to @X" ' +
      'line, or app-navigation/icon text.\n\n' +
      'A short line functioning as a header immediately followed by ' +
      'reply-count/timestamp chrome, OR immediately followed by a bare ' +
      '@handle on its own line (e.g. "Corn" then "@cornskiii", or "ersha" ' +
      'then "@ershacaitlin"), is UI CHROME (a display name) even if the ' +
      'name itself is an ordinary word or real first name that would ' +
      'otherwise read as plausible content — judge it by POSITION, not ' +
      'wording.\n\n' +
      'CONCRETE CASES THAT HAVE LEAKED BEFORE — all of these are UI ' +
      'CHROME and must be discarded:\n' +
      '  "Addison Rae" sitting above "@whoisadd..." (a name above its own ' +
      'handle, even when the handle is cut off with "...")\n' +
      '  "exquisite dead guy" above "@localfuckwit" (a lowercase, ' +
      'sentence-like display name is still a display name)\n' +
      '  "Chris Chan Sonichu/CPU Blue..." (a compound account name)\n' +
      '  "SEGA Europe" next to a verification badge read as "blue ' +
      'checkmark" or "verified"\n' +
      '  "2 hours ago (edited)", "2 hours ago (edited) • 53 3", and any ' +
      'timestamp with stray trailing digits from misread like/reply icons\n' +
      '  "degenerat2947 • 3y ago", "aemondstareye • 3y ago • Edited 3y ' +
      'ago" (a lowercase Reddit handle plus timestamps)\n' +
      '  "Judgement_Bot_AITA App MOD • 10m ago" and any other bot account\n' +
      '  "Insights", "Boost", "Get inspired on Edits" (app footer buttons)\n' +
      '  A comment footer made only of a date, the word Reply/Replies, and ' +
      'like counts — e.g. "11-25 Reply", "2-22 Reply 7", "Reply 288", ' +
      '"3-13 Reply". The word Reply or Replies, together with any numbers ' +
      'before or after it, is ALWAYS chrome and must never be spoken.\n' +
      '  Icon names OCR produced from picture buttons — "musical note", ' +
      '"heart", "thumbs up", "black circle" — alone or combined with ' +
      '"reply"/counts. These are logos, never words a person typed.\n' +
      '  A bare account name on its own line directly above the comment ' +
      'it wrote, e.g. "Adriqueman", "Display", "Stephen", "truxGG", ' +
      '"BrownieHamza", "Vini". In a comment thread EVERY comment block ' +
      'begins with the commenter\'s name on its own short line, followed ' +
      'by their actual comment text, then a date/Reply/like footer. That ' +
      'first short line is ALWAYS the username, even when it looks like ' +
      'an ordinary first name or word — judge it by that block structure, ' +
      'not by whether the word itself seems meaningful.\n' +
      '  A reply-chain header of the form "Name > Name" (one account ' +
      'replying to another, e.g. "Adriqueman > Display").\n' +
      '  Phone status-bar text captured at the top of a screenshot: a ' +
      'clock, battery percentage, "LTE 81", "5G", signal indicators.\n' +
      '  "Twitter Web App", "Twitter for iPhone" (client signatures)\n' +
      '  "Text" or "Text Message" (a message-box placeholder, not a ' +
      'message)\n' +
      '  "Archived post. New comments cannot be posted..." (a Reddit ' +
      'notice)\n' +
      '  "ifunny.co", "PhysioTru" and similar watermarks stamped onto the ' +
      'image\n\n' +
      'CONCRETE CASES THAT HAVE BEEN WRONGLY DISCARDED — all of these are ' +
      'REAL CONTENT and must be kept:\n' +
      '  "of a heart attack" (the second half of the wrapped title "4 ' +
      'signs ur about to die")\n' +
      '  "hiv tests" (a real reply, even though it is short and lowercase ' +
      'and sits after a block of chrome)\n' +
      '  "America First MAGA Conservative" (a profile bio made of short ' +
      'self-chosen tags — keep the whole run)\n' +
      '  "WE NEED THIS VERSION OF FROZEN" (an all-caps meme caption)\n' +
      '  "were human rights violations" (the end of a real sentence)\n' +
      '  "Unconcerned", "So F\'ing Ridiculous", "I love music ugh" (short ' +
      'genuine reactions)\n' +
      '  The SAME sentence appearing twice in a screenshot is real ' +
      'content BOTH times — keep both.\n\n' +
      'A post\'s own TITLE is REAL CONTENT, including when it visually ' +
      'wraps across two or more OCR lines (e.g. "4 signs ur about to die" ' +
      'then "of a heart attack" — BOTH lines are real content). Never drop ' +
      'a line just because it sits near the top of a post next to other ' +
      'chrome, and never drop the second half of a wrapped sentence.\n\n' +
      'NEVER keep: a username or display name, an @mention, a "Replying ' +
      'to" line, a relative or absolute timestamp ("2 hours ago", "23 Nov ' +
      '21", "2:38 pm"), a like/retweet/quote/reply/share/view count, a ' +
      'button label (Reply, Comment, Like, Share, Follow, Insights, ' +
      'Boost, "Get inspired on Edits", "Show this thread"), an app ' +
      'signature ("Twitter for iPhone"), a watermark (ifunny.co, ' +
      'PhysioTru), or a Reddit bot header ("Judgement_Bot_AITA App MOD ' +
      '10m ago", "AutoModerator"). These are never what a person wrote.\n\n' +
      'A timestamp followed by garbled non-sentence fragments (misread ' +
      'game HUD or menu text, e.g. "3 years ago 1 D Field Phase Free ' +
      'Training Menu") is UI CHROME as a whole line — even when the ' +
      'fragments contain real English words, what matters is that they ' +
      'do not form an actual sentence.\n\n' +
      'A run of short self-descriptor tags in a profile bio (e.g. "MAGA", ' +
      '"Catholic", "Transgender", "Zoomer") IS real content — keep the ' +
      'whole run, do not drop tags out of the middle.\n\n' +
      'A short standalone action/CTA word like "Go" merged onto the END ' +
      'of an otherwise-real line (e.g. "...Hiv tests Go") should be ' +
      'treated as not belonging to what the person wrote.\n\n' +
      'When genuinely unsure, lean toward REAL CONTENT rather than ' +
      'discarding it — a pattern-based safety net runs after you and ' +
      'catches clear-cut chrome shapes you weren\'t sure about. This ' +
      'matters most for the FIRST and LAST lines of a post: being short, ' +
      'or sitting at the top or bottom next to chrome, is NOT itself a ' +
      'reason to discard a line.\n\n' +
      `Return ONLY a JSON array of exactly ${lines.length} booleans, true ` +
      '= REAL CONTENT (keep), false = UI CHROME (discard). Raw JSON only.\n\n' +
      numbered;

    rawText = await generateWithFallback(prompt, { temperature: 0, responseMimeType: 'application/json' }, debugTrail);
    if (rawText == null) {
      if (debugTrail) debugTrail.push('chrome filter: no candidate model available — used pattern filter only');
      return null;
    }
    let cleaned = rawText.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    let mask;
    try {
      mask = JSON.parse(cleaned);
    } catch {
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!arrayMatch) throw new Error(`no JSON array found in response: ${cleaned.slice(0, 300)}`);
      mask = JSON.parse(arrayMatch[0]);
    }
    if (!Array.isArray(mask) || mask.length !== lines.length) {
      if (debugTrail) debugTrail.push(`chrome filter: mask length mismatch — used pattern filter only`);
      return null;
    }
    console.log(`AI chrome filter: kept ${mask.filter(Boolean).length}/${lines.length} lines`);
    if (debugTrail) debugTrail.push(`chrome filter: AI kept ${mask.filter(Boolean).length}/${lines.length} lines`);
    return mask.map(Boolean);
  } catch (err) {
    console.warn('AI chrome filter unavailable, using pattern filter only.', err && (err.message || err));
    if (debugTrail) debugTrail.push(`chrome filter: ERROR ${err && (err.message || err)} — used pattern filter only`);
    return null;
  }
}

const EMOTION_KEYWORDS = {
  happy: ['happy', 'glad', 'great', 'love'], excited: ['excited', "can't wait", 'amazing'],
  sad: ['sad', 'crying', 'miss'], mad: ['mad', 'angry', 'furious'],
  confused: ['confused', 'huh', "doesn't make sense"], grossed_out: ['gross', 'disgusting', 'ew'],
  afraid: ['scared', 'afraid', 'terrified'], shocked: ['shocked', "can't believe", 'no way'],
  goofy_mood: ['lol', 'lmao', 'bruh', 'goofy'], building_suspense: ['wait', 'then', 'suddenly', 'until'],
};

function keywordEmotion(text) {
  const lower = text.toLowerCase();
  for (const [emotion, words] of Object.entries(EMOTION_KEYWORDS)) {
    if (words.some((w) => lower.includes(w))) return emotion;
  }
  return null;
}

async function aiDetectEmotions(lineTexts, availableEmotions, debugTrail) {
  if (!GEMINI_API_KEY || !lineTexts.length || !availableEmotions.length) return null;
  try {
    const numbered = lineTexts.map((l, i) => `${i}: ${l}`).join('\n');
    const prompt =
      'These are consecutive lines of a social media post. For each ' +
      'numbered line, pick whichever ONE of these emotions its tone is ' +
      `closest to: ${availableEmotions.join(', ')}. ` +
      (availableEmotions.includes('goofy_mood') ? 'goofy_mood = silly, joking, absurd or playful. ' : '') +
      (availableEmotions.includes('building_suspense') ? 'building_suspense = tense setup that leads up to a reveal. ' : '') +
      `Return ONLY a JSON array of exactly ${lineTexts.length} strings.\n\n` +
      numbered;
    const text = await geminiGenerate([{ text: prompt }], 'emotion detection', debugTrail);
    const modelUsed = `Gemini ${GEMINI_ANALYSIS_MODEL}`;
    if (text == null) {
      if (debugTrail) debugTrail.push('emotion detection: Gemini unavailable — using keyword matching instead');
      return null;
    }
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    let arr;
    try {
      arr = JSON.parse(cleaned);
    } catch {
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!arrayMatch) throw new Error(`no JSON array found`);
      arr = JSON.parse(arrayMatch[0]);
    }
    if (!Array.isArray(arr) || arr.length !== lineTexts.length) return null;
    const mapped = arr.map((e) => {
      const norm = String(e).trim().toLowerCase();
      if (availableEmotions.includes(norm)) return norm;
      if (availableEmotions.includes('happy')) return 'happy';
      return null;
    });
    if (debugTrail) debugTrail.push(`emotion detection: ${modelUsed} resolved ${mapped.filter(Boolean).length}/${lineTexts.length} lines directly`);
    return mapped;
  } catch (err) {
    if (debugTrail) debugTrail.push(`emotion detection: ERROR ${err && (err.message || err)}`);
    return null;
  }
}

async function resolveLineEmotions(lineTexts, availableEmotions, debugTrail) {
  if (!availableEmotions.length) return lineTexts.map(() => null);
  const aiResult = await aiDetectEmotions(lineTexts, availableEmotions, debugTrail);
  const resolved = [];
  let lastGood = availableEmotions[0];
  for (let i = 0; i < lineTexts.length; i++) {
    let e = aiResult ? aiResult[i] : null;
    if (!e) {
      const kw = keywordEmotion(lineTexts[i]);
      e = kw && availableEmotions.includes(kw) ? kw : null;
    }
    if (!e) e = lastGood;
    lastGood = e;
    resolved.push(e);
  }
  if (debugTrail) debugTrail.push(`emotion sequence: [${resolved.join(', ')}]`);
  console.log('emotion sequence for this post:', resolved);
  return resolved;
}

let firestore = null;
let firebaseAuth = null;
let firebaseAdminFailureReason = null;
try {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: GCP_PROJECT });
  firestore = getFirestore();
  firebaseAuth = getAuth();
  console.log('firebase-admin initialized (modular API) — YouTube/TikTok/Instagram export enabled');
} catch (err) {
  firebaseAdminFailureReason = err && (err.message || String(err));
  console.error('firebase-admin FAILED to initialize — YouTube/TikTok/Instagram export routes will return 503.');
  console.error('  error:', err && (err.stack || err.message || err));
  firestore = null;
  firebaseAuth = null;
}

const GCS_BUCKET_NAME = process.env.GCS_TEMP_BUCKET;
let gcsStorage = null;
try {
  gcsStorage = new Storage({ projectId: GCP_PROJECT });
  console.log(`Cloud Storage initialized — Instagram publishing ${GCS_BUCKET_NAME ? 'enabled' : 'DISABLED'}`);
} catch (err) {
  gcsStorage = null;
}

function youtubeUnavailable(res) {
  if (firestore && firebaseAuth) return false;
  res.status(503).send(`YouTube export is not configured on the server right now.${firebaseAdminFailureReason ? ` (${firebaseAdminFailureReason})` : ''}`);
  return true;
}

async function resolveExportVideo(req, label) {
  const { jobId, videoBase64 } = req.body || {};
  if (jobId) {
    const job = jobs.get(jobId);
    if (!job) return { error: 'That video has expired on the server — please generate it again.' };
    if (job.status !== 'done' || !job.videoPath) return { error: `That video is not ready yet (status: ${job.status}).` };
    try {
      const buf = await fs.readFile(job.videoPath);
      console.log(`${label}: reusing rendered video from job ${jobId} (${(buf.length / 1024 / 1024).toFixed(1)} MB, no re-upload needed)`);
      return { buffer: buf };
    } catch (err) {
      return { error: `Could not read the rendered video: ${err && (err.message || err)}` };
    }
  }
  if (!videoBase64) return { error: 'Missing videoBase64 (or jobId) in request body' };
  const buf = Buffer.from(videoBase64, 'base64');
  const mb = buf.length / 1024 / 1024;
  console.log(`${label}: received inline video upload (${mb.toFixed(1)} MB)`);
  if (mb > 24) {
    console.error(`${label}: inline upload is ${mb.toFixed(1)} MB — at/over Cloud Run's 32MB request cap.`);
    console.error(`  This is why longer videos fail to post with a generic "Load failed": the request`);
    console.error(`  is rejected by the PLATFORM before this server sees it. The frontend should send`);
    console.error(`  { jobId } instead of { videoBase64 } — the rendered file is already on this server.`);
  }
  return { buffer: buf };
}

const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI;

async function verifyUser(req) {
  if (!firebaseAuth) return null;
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) return null;
  try {
    const decoded = await firebaseAuth.verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    return null;
  }
}

const app = express();
app.use(cors({ exposedHeaders: ['X-Vidmasta-Debug'] }));

app.use((req, res, next) => {
  const len = Number(req.headers['content-length'] || 0);
  if (len > 0 && (req.path === '/generate' || req.path === '/generate/start')) {
    const mb = (len / (1024 * 1024)).toFixed(2);
    console.log(`INCOMING ${req.method} ${req.path}: payload ${mb} MB (${len} bytes)`);
    if (len > 32 * 1024 * 1024) {
      console.error(`PAYLOAD OVER CLOUD RUN'S 32MiB LIMIT (${mb} MB). Cloud Run normally rejects`);
      console.error('  this before it reaches the app, so if you are seeing this the limit may have');
      console.error('  been raised. Reduce image count or resolution if generations fail to start.');
    }
  }
  next();
});

app.use(express.json({ limit: '300mb' }));

app.get('/', (req, res) => res.send('Vidmasta render service is running.'));

app.get('/youtube/auth-url', async (req, res) => {
  if (youtubeUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  if (!YT_CLIENT_ID || !YT_REDIRECT_URI) return res.status(500).send('YouTube OAuth is not configured');
  const params = new URLSearchParams({
    client_id: YT_CLIENT_ID, redirect_uri: YT_REDIRECT_URI, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload', access_type: 'offline', prompt: 'consent', state: uid,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/youtube/callback', async (req, res) => {
  if (youtubeUnavailable(res)) return;
  const { code, state: uid } = req.query;
  if (!code || !uid) return res.status(400).send('Missing code or state');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET, redirect_uri: YT_REDIRECT_URI, grant_type: 'authorization_code' }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      return res.send('<script>try{window.opener&&window.opener.postMessage({type:"vidmasta-youtube-connected",success:false},"*")}catch(e){}window.close()</script>Connection failed.');
    }
    await firestore.collection('youtube_tokens').doc(String(uid)).set({ refreshToken: tokens.refresh_token, connectedAt: Date.now() });
    res.send('<script>try{window.opener&&window.opener.postMessage({type:"vidmasta-youtube-connected",success:true},"*")}catch(e){}window.close()</script>Connected!');
  } catch (err) {
    res.send('<script>try{window.opener&&window.opener.postMessage({type:"vidmasta-youtube-connected",success:false},"*")}catch(e){}window.close()</script>Something went wrong.');
  }
});

app.get('/youtube/status', async (req, res) => {
  if (youtubeUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const doc = await firestore.collection('youtube_tokens').doc(uid).get();
  res.json({ connected: doc.exists });
});

app.get('/youtube/access-token', async (req, res) => {
  if (youtubeUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const doc = await firestore.collection('youtube_tokens').doc(uid).get();
  if (!doc.exists) return res.status(404).send('YouTube not connected');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: doc.data().refreshToken, client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return res.status(500).send('Could not refresh YouTube access.');
    res.json({ accessToken: tokens.access_token });
  } catch (err) {
    res.status(500).send('Could not refresh YouTube access.');
  }
});

async function doYoutubeUpload(uid, videoBuffer, title) {
  const doc = await firestore.collection('youtube_tokens').doc(uid).get();
  if (!doc.exists) throw new Error('YouTube not connected');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: doc.data().refreshToken, client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET, grant_type: 'refresh_token' }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Could not refresh YouTube access: ${JSON.stringify(tokens)}`);
  const metadata = { snippet: { title: title || 'Untitled #Shorts', description: '#Shorts', categoryId: '22' }, status: { privacyStatus: 'public' } };
  const boundary = `vidmasta_${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    videoBuffer, Buffer.from(`\r\n--${boundary}--`),
  ]);
  const uploadRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) throw new Error(`YouTube upload failed (${uploadRes.status}): ${uploadText}`);
  return JSON.parse(uploadText);
}

app.post('/youtube/upload', async (req, res) => {
  if (youtubeUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const { title } = req.body || {};
  const resolved = await resolveExportVideo(req, 'youtube/upload');
  if (resolved.error) return res.status(400).send(resolved.error);
  try {
    const result = await doYoutubeUpload(uid, resolved.buffer, title);
    res.json({ videoId: result.id });
  } catch (err) {
    res.status(500).send(err && (err.message || String(err)));
  }
});

const TT_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TT_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TT_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

function tiktokUnavailable(res) {
  if (firestore && firebaseAuth) return false;
  res.status(503).send(`TikTok export is not configured on the server right now.${firebaseAdminFailureReason ? ` (${firebaseAdminFailureReason})` : ''}`);
  return true;
}

async function refreshTiktokToken(uid) {
  const doc = await firestore.collection('tiktok_tokens').doc(uid).get();
  if (!doc.exists) return null;
  const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_key: TT_CLIENT_KEY, client_secret: TT_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: doc.data().refreshToken }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || tokens.error) return null;
  await firestore.collection('tiktok_tokens').doc(uid).set({ refreshToken: tokens.refresh_token, openId: tokens.open_id, connectedAt: doc.data().connectedAt, updatedAt: Date.now() });
  return tokens.access_token;
}

app.get('/tiktok/auth-url', async (req, res) => {
  if (tiktokUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  if (!TT_CLIENT_KEY || !TT_REDIRECT_URI) return res.status(500).send('TikTok OAuth is not configured');
  const params = new URLSearchParams({ client_key: TT_CLIENT_KEY, redirect_uri: TT_REDIRECT_URI, response_type: 'code', scope: 'user.info.basic,video.publish', state: uid });
  res.json({ url: `https://www.tiktok.com/v2/auth/authorize/?${params}` });
});

app.get('/tiktok/callback', async (req, res) => {
  if (tiktokUnavailable(res)) return;
  const { code, state: uid } = req.query;
  if (!code || !uid) return res.status(400).send('Missing code or state');
  const closeHtml = (success, message) => `<script>try{window.opener&&window.opener.postMessage({type:"vidmasta-tiktok-connected",success:${success}},"*")}catch(e){}window.close()</script>${message}`;
  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_key: TT_CLIENT_KEY, client_secret: TT_CLIENT_SECRET, code: String(code), grant_type: 'authorization_code', redirect_uri: TT_REDIRECT_URI }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) return res.send(closeHtml(false, 'Connection failed.'));
    await firestore.collection('tiktok_tokens').doc(String(uid)).set({ refreshToken: tokens.refresh_token, openId: tokens.open_id, connectedAt: Date.now() });
    res.send(closeHtml(true, 'Connected!'));
  } catch (err) {
    res.send(closeHtml(false, 'Something went wrong.'));
  }
});

app.get('/tiktok/status', async (req, res) => {
  if (tiktokUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const doc = await firestore.collection('tiktok_tokens').doc(uid).get();
  res.json({ connected: doc.exists });
});

app.get('/tiktok/creator-info', async (req, res) => {
  if (tiktokUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const accessToken = await refreshTiktokToken(uid);
  if (!accessToken) return res.status(404).send('TikTok not connected');
  try {
    const infoRes = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    });
    const ttLogId = infoRes.headers.get('x-tt-logid');
    const info = await infoRes.json();
    if (!infoRes.ok || info.error?.code !== 'ok') {
      const code = String(info.error?.code || '');
      console.error(`tiktok creator-info FAILED (http ${infoRes.status}, x-tt-logid: ${ttLogId}): ${JSON.stringify(info.error || info)}`);
      const CANNOT_POST_NOW = {
        spam_risk_too_many_posts: 'This TikTok account has reached its posting limit for the last 24 hours.',
        reached_active_user_cap: 'TikTok has reached this app\'s daily limit of posting users.',
        spam_risk_user_banned_from_posting: 'TikTok has restricted this account from posting.',
      };
      if (CANNOT_POST_NOW[code]) return res.status(429).send(`${CANNOT_POST_NOW[code]} You can\'t post to TikTok right now — please try again later.`);
      return res.status(500).send(`Could not fetch TikTok creator info${code ? ` (${code})` : ''}. Please try again.`);
    }
    res.json(info.data);
  } catch (err) {
    res.status(500).send('Could not fetch TikTok creator info.');
  }
});

async function doTiktokPublish(uid, videoBuffer, title, options) {
  const { privacyLevel, allowComment, allowDuet, allowStitch, yourBrand, brandedContent } = options || {};
  if (!privacyLevel) throw new Error('Missing privacyLevel');
  if (brandedContent && privacyLevel === 'SELF_ONLY') {
    throw new Error('Branded Content cannot be posted as private (SELF_ONLY).');
  }
  const accessToken = await refreshTiktokToken(uid);
  if (!accessToken) throw new Error('TikTok not connected');

  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: {
        title: (title || 'Untitled').slice(0, 150),
        privacy_level: privacyLevel,
        disable_duet: !allowDuet,
        disable_comment: !allowComment,
        disable_stitch: !allowStitch,
        brand_organic_toggle: !!yourBrand,
        brand_content_toggle: !!brandedContent,
      },
      source_info: { source: 'FILE_UPLOAD', video_size: videoBuffer.length, chunk_size: videoBuffer.length, total_chunk_count: 1 },
    }),
  });
  const ttLogId = initRes.headers.get('x-tt-logid');
  console.log(`tiktok publish INIT x-tt-logid: ${ttLogId || '(not present in response headers)'}`);
  const init = await initRes.json();
  if (!initRes.ok || init.error?.code !== 'ok') {
    const detail = JSON.stringify(init.error || init);
    console.error(`tiktok publish INIT FAILED (http ${initRes.status}, x-tt-logid: ${ttLogId}): ${detail}`);
    if (String(init.error?.code) === 'unaudited_client_can_only_post_to_private_accounts') {
      throw new Error(`TikTok has not audited this app for public posting yet — only SELF_ONLY (private) is allowed until the Content Posting API audit is approved. (x-tt-logid: ${ttLogId || 'not present'})`);
    }
    const CANNOT_POST_NOW_CODES = new Set(['spam_risk_too_many_posts', 'reached_active_user_cap', 'spam_risk_user_banned_from_posting']);
    if (CANNOT_POST_NOW_CODES.has(String(init.error?.code))) {
      const explain = {
        spam_risk_too_many_posts: 'This TikTok account has posted too many times in the last 24 hours.',
        reached_active_user_cap: 'This app has reached its daily limit of active posting users.',
        spam_risk_user_banned_from_posting: 'TikTok has restricted this account from posting.',
      }[init.error.code];
      const err = new Error(`${explain} Please try again later — do not retry automatically.`);
      err.cannotPostNow = true;
      throw err;
    }
    throw new Error(`TikTok publish init failed (http ${initRes.status}): ${detail}`);
  }
  const { publish_id, upload_url } = init.data;
  const uploadRes = await fetch(upload_url, {
    method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}` }, body: videoBuffer,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => '<no body>');
    throw new Error(`TikTok video upload failed (http ${uploadRes.status}): ${body.slice(0, 300)}`);
  }
  let finalStatus = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id }),
    });
    const status = await statusRes.json();
    const stage = status.data?.status;
    if (stage === 'PUBLISH_COMPLETE') { finalStatus = status.data; break; }
    if (stage === 'FAILED') throw new Error(`TikTok publish failed: ${JSON.stringify(status.data || status)}`);
  }
  return { publishId: publish_id, status: finalStatus ? 'complete' : 'still_processing' };
}

app.post('/tiktok/publish', async (req, res) => {
  if (tiktokUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const { title, ...options } = req.body || {};
  const resolved = await resolveExportVideo(req, 'tiktok/publish');
  if (resolved.error) return res.status(400).send(resolved.error);
  try {
    const result = await doTiktokPublish(uid, resolved.buffer, title, options);
    res.status(result.status === 'complete' ? 200 : 202).json(result);
  } catch (err) {
    const msg = err && (err.message || String(err));
    const status = err && err.cannotPostNow ? 429 : (msg.includes('audited') ? 403 : 500);
    res.status(status).send(msg);
  }
});

const IG_APP_ID = process.env.INSTAGRAM_APP_ID;
const IG_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const IG_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;

function instagramUnavailable(res) {
  if (firestore && firebaseAuth) return false;
  res.status(503).send(`Instagram export is not configured on the server right now.${firebaseAdminFailureReason ? ` (${firebaseAdminFailureReason})` : ''}`);
  return true;
}

app.get('/instagram/auth-url', async (req, res) => {
  if (instagramUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  if (!IG_APP_ID || !IG_REDIRECT_URI) return res.status(500).send('Instagram OAuth is not configured');
  const params = new URLSearchParams({ client_id: IG_APP_ID, redirect_uri: IG_REDIRECT_URI, response_type: 'code', scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement', state: uid });
  res.json({ url: `https://www.facebook.com/v19.0/dialog/oauth?${params}` });
});

app.get('/instagram/callback', async (req, res) => {
  if (instagramUnavailable(res)) return;
  const { code, state: uid } = req.query;
  if (!code || !uid) return res.status(400).send('Missing code or state');
  const closeHtml = (success, message) => `<script>try{window.opener&&window.opener.postMessage({type:"vidmasta-instagram-connected",success:${success}},"*")}catch(e){}window.close()</script>${message}`;
  try {
    const shortRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?` + new URLSearchParams({ client_id: IG_APP_ID, redirect_uri: IG_REDIRECT_URI, client_secret: IG_APP_SECRET, code: String(code) }));
    const shortTokens = await shortRes.json();
    if (!shortRes.ok || shortTokens.error) return res.send(closeHtml(false, 'Connection failed.'));
    const longRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?` + new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: IG_APP_ID, client_secret: IG_APP_SECRET, fb_exchange_token: shortTokens.access_token }));
    const longTokens = await longRes.json();
    if (!longRes.ok || longTokens.error) return res.send(closeHtml(false, 'Connection failed.'));
    let debugData = null;
    try {
      const debugRes = await fetch(`https://graph.facebook.com/debug_token?` + new URLSearchParams({ input_token: longTokens.access_token, access_token: `${IG_APP_ID}|${IG_APP_SECRET}` }));
      debugData = await debugRes.json();
    } catch (debugErr) {}
    const pagesScope = debugData?.data?.granular_scopes?.find((s) => s.scope === 'pages_show_list');
    const authorizedPageIds = pagesScope?.target_ids || [];
    const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longTokens.access_token}`);
    const pages = await pagesRes.json();
    const candidatePageIds = new Set([...(pages.data || []).map((p) => p.id), ...authorizedPageIds]);
    if (!candidatePageIds.size) return res.send(closeHtml(false, 'No Facebook Page found.'));
    let matchedPage = null;
    let igAccountId = null;
    for (const pageId of candidatePageIds) {
      const pageRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=name,access_token,instagram_business_account&access_token=${longTokens.access_token}`);
      const pageData = await pageRes.json();
      if (pageData.instagram_business_account?.id) {
        matchedPage = { id: pageId, name: pageData.name, access_token: pageData.access_token };
        igAccountId = pageData.instagram_business_account.id;
        break;
      }
    }
    if (!matchedPage || !igAccountId) return res.send(closeHtml(false, "No linked Instagram Business account found."));
    await firestore.collection('instagram_tokens').doc(String(uid)).set({ pageAccessToken: matchedPage.access_token, instagramAccountId: igAccountId, connectedAt: Date.now() });
    res.send(closeHtml(true, 'Connected!'));
  } catch (err) {
    res.send(closeHtml(false, 'Something went wrong.'));
  }
});

app.get('/instagram/status', async (req, res) => {
  if (instagramUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const doc = await firestore.collection('instagram_tokens').doc(uid).get();
  res.json({ connected: doc.exists });
});

async function doInstagramPublish(uid, videoBuffer, title) {
  if (!gcsStorage || !GCS_BUCKET_NAME) throw new Error('Instagram publishing is not configured.');
  const doc = await firestore.collection('instagram_tokens').doc(uid).get();
  if (!doc.exists) throw new Error('Instagram not connected');
  const { pageAccessToken, instagramAccountId } = doc.data();
  const objectName = `insta-temp/${uid}-${Date.now()}.mp4`;
  const bucket = gcsStorage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(objectName);
  try {
    await file.save(videoBuffer, { contentType: 'video/mp4' });
    const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60 * 1000 });
    const createRes = await fetch(`https://graph.facebook.com/v19.0/${instagramAccountId}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type: 'REELS', video_url: signedUrl, caption: (title || '').slice(0, 2200), access_token: pageAccessToken }),
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData.id) throw new Error('Instagram rejected the video');
    const creationId = createData.id;
    let ready = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(`https://graph.facebook.com/v19.0/${creationId}?fields=status_code,status&access_token=${pageAccessToken}`);
      const statusData = await statusRes.json();
      if (statusData.error) throw new Error('Instagram status check failed');
      if (statusData.status_code === 'FINISHED') { ready = true; break; }
      if (statusData.status_code === 'ERROR') throw new Error('Instagram failed to process the video');
    }
    if (!ready) return { creationId, status: 'still_processing' };
    const publishRes = await fetch(`https://graph.facebook.com/v19.0/${instagramAccountId}/media_publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creation_id: creationId, access_token: pageAccessToken }),
    });
    const publishData = await publishRes.json();
    if (!publishRes.ok || !publishData.id) throw new Error('Instagram publish step failed');
    return { mediaId: publishData.id, status: 'complete' };
  } finally {
    file.delete().catch(() => {});
  }
}

app.post('/instagram/publish', async (req, res) => {
  if (instagramUnavailable(res)) return;
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const { title } = req.body || {};
  const resolved = await resolveExportVideo(req, 'instagram/publish');
  if (resolved.error) return res.status(400).send(resolved.error);
  try {
    const result = await doInstagramPublish(uid, resolved.buffer, title);
    res.status(result.status === 'complete' ? 200 : 202).json(result);
  } catch (err) {
    res.status(500).send(err && (err.message || String(err)));
  }
});

const MIN_LINES_TO_SPLIT = 12;
const POST_SPLIT_PARTS = 3;
const BG_SPEED = 1.35;

async function splitPostIntoSegments(post, dir, postIndex, debugTrail) {
  const lines = post.lines || [];

  if (lines.length < MIN_LINES_TO_SPLIT) {
    return [{ ...post, role: 'standalone', isPostEnd: true, isContinuation: false, postOffset: 0, postDuration: post.duration }];
  }

  const perPart = Math.ceil(lines.length / POST_SPLIT_PARTS);
  const groups = [];
  for (let i = 0; i < lines.length; i += perPart) groups.push(lines.slice(i, i + perPart));
  if (groups.length <= 1) {
    return [{ ...post, role: 'standalone', isPostEnd: true, isContinuation: false, postOffset: 0, postDuration: post.duration }];
  }

  const out = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const isFirst = g === 0;
    const isLast = g === groups.length - 1;
    const segStart = group[0].start;
    const segEnd = isLast ? post.duration : groups[g + 1][0].start;
    const segDuration = Math.max(0.1, segEnd - segStart);

    const segAudio = path.join(dir, `post_audio_${postIndex}_p${g}.wav`);
    await run('ffmpeg', ['-ss', String(segStart), '-t', String(segDuration), '-i', post.audioPath, '-c', 'copy', '-y', segAudio]);

    const rebasedLines = group.map((l) => ({
      ...l,
      start: Math.max(0, l.start - segStart),
      end: Math.max(0, l.end - segStart),
      words: (l.words || []).map((w) => ({
        ...w,
        start: Math.max(0, w.start - segStart),
        end: Math.max(0, w.end - segStart),
      })),
    }));
    const rebasedPhrases = (post.phraseSegments || [])
      .filter((ph) => ph.end > segStart && ph.start < segEnd)
      .map((ph) => ({
        ...ph,
        start: Math.max(0, ph.start - segStart),
        end: Math.min(segDuration, Math.max(0, ph.end - segStart)),
      }));

    out.push({
      imgPath: post.imgPath,
      audioPath: segAudio,
      duration: segDuration,
      lines: rebasedLines,
      phraseSegments: rebasedPhrases,
      role: `part-${g + 1}`,
      postOffset: segStart,
      postDuration: post.duration,
      isPostEnd: isLast,
      isContinuation: !isFirst,
    });
  }

  const maxLines = Math.max(...groups.map((g) => g.length));
  console.log(`post ${postIndex}: ${lines.length} lines -> ${groups.length} parts (${groups.map((g) => g.length).join(' + ')}). Largest part ${maxLines} lines -> ~${(maxLines - 2) * 5} buffered image outputs instead of ~${(lines.length - 2) * 5}.`);
  debugTrail.push(`post ${postIndex}: ${lines.length} lines -> ${groups.length} parts (${groups.map((g) => g.length).join(' + ')}) — cuts scroll memory ~${(lines.length / maxLines).toFixed(1)}x`);
  return out;
}

const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET;
console.log(SCHEDULER_SECRET
  ? `Scheduled posting: SCHEDULER_SECRET is set (length ${SCHEDULER_SECRET.length}) — /schedule/run-due will accept Cloud Scheduler calls`
  : 'Scheduled posting: SCHEDULER_SECRET is NOT set — /schedule/run-due will REJECT every call and no scheduled post will ever fire');

const SCHEDULE_ID_RE = /^[a-f0-9]{16}$/;
const SPRITE_NAME_RE = /^[a-z_]{1,32}$/;

app.post('/schedule/begin', async (req, res) => {
  if (!firestore) return res.status(503).send('Scheduling is not configured on the server right now.');
  if (!gcsStorage || !GCS_BUCKET_NAME) return res.status(503).send('Scheduling needs Cloud Storage, which is not configured.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const scheduleId = crypto.randomBytes(8).toString('hex');
  const { imageCount, spriteCount } = req.body || {};
  console.log(`[schedule ${scheduleId}] begin: uid ${uid}, expecting ${imageCount} image(s) + ${spriteCount} sprite(s)`);
  res.json({ scheduleId });
});

app.post('/schedule/upload', async (req, res) => {
  if (!gcsStorage || !GCS_BUCKET_NAME) return res.status(503).send('Scheduling needs Cloud Storage, which is not configured.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const { scheduleId, index, emotion, base64 } = req.body || {};
  if (!SCHEDULE_ID_RE.test(String(scheduleId || ''))) return res.status(400).send('Invalid scheduleId.');
  if (!base64) return res.status(400).send('Missing file data.');
  let objectName;
  if (emotion !== undefined) {
    if (!SPRITE_NAME_RE.test(String(emotion))) return res.status(400).send('Invalid sprite name.');
    objectName = `schedules/${uid}/${scheduleId}/sprite_${emotion}.png`;
  } else {
    if (!Number.isInteger(index) || index < 0 || index > 10000) return res.status(400).send('Invalid image index.');
    objectName = `schedules/${uid}/${scheduleId}/img_${index}.png`;
  }
  try {
    const buf = Buffer.from(base64, 'base64');
    await gcsStorage.bucket(GCS_BUCKET_NAME).file(objectName).save(buf, { contentType: 'image/png' });
    console.log(`[schedule ${scheduleId}] uploaded ${emotion !== undefined ? `sprite "${emotion}"` : `image ${index}`} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ ok: true });
  } catch (err) {
    const msg = err && (err.message || String(err));
    console.error(`[schedule ${scheduleId}] upload FAILED for ${emotion !== undefined ? `sprite "${emotion}"` : `image ${index}`}: ${msg}`);
    res.status(500).send(`Upload failed: ${msg}`);
  }
});

app.post('/schedule/create', async (req, res) => {
  if (!firestore) return res.status(503).send('Scheduling is not configured on the server right now.');
  if (!gcsStorage || !GCS_BUCKET_NAME) return res.status(503).send('Scheduling needs Cloud Storage, which is not configured.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');

  const { slots, mode, tiktokOptions, imagesBase64, spritesBase64, scheduleId: uploadedId, imageCount, spriteEmotions, hidePost } = req.body || {};
  if (!Array.isArray(slots) || !slots.length) return res.status(400).send('No time slots provided.');
  const orderedSlots = [...slots].sort((a, b) => a.atMs - b.atMs);
  const bucket = gcsStorage.bucket(GCS_BUCKET_NAME);

  let scheduleId, imagePaths, spriteObjects = {};
  try {
    if (uploadedId !== undefined) {
      if (!SCHEDULE_ID_RE.test(String(uploadedId))) return res.status(400).send('Invalid scheduleId.');
      if (!Number.isInteger(imageCount) || imageCount < 1) return res.status(400).send('No images provided.');
      scheduleId = uploadedId;
      const prefix = `schedules/${uid}/${scheduleId}`;
      imagePaths = Array.from({ length: imageCount }, (_, i) => `${prefix}/img_${i}.png`);
      const exists = await Promise.all(imagePaths.map((p) => bucket.file(p).exists().then((r) => r[0])));
      const missing = exists.map((ok, i) => (ok ? null : i)).filter((i) => i !== null);
      if (missing.length) {
        console.error(`[schedule ${scheduleId}] create REFUSED: ${missing.length} of ${imageCount} image(s) never arrived (indexes ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '...' : ''})`);
        return res.status(400).send(`${missing.length} of ${imageCount} photo(s) didn't finish uploading. Please try saving again.`);
      }
      for (const emotion of spriteEmotions || []) {
        if (!SPRITE_NAME_RE.test(String(emotion))) continue;
        const objectName = `${prefix}/sprite_${emotion}.png`;
        if ((await bucket.file(objectName).exists())[0]) spriteObjects[emotion] = objectName;
      }
    } else {
      if (!Array.isArray(imagesBase64) || !imagesBase64.length) return res.status(400).send('No images provided.');
      scheduleId = crypto.randomBytes(8).toString('hex');
      const prefix = `schedules/${uid}/${scheduleId}`;
      imagePaths = await Promise.all(imagesBase64.map(async (b64, i) => {
        const objectName = `${prefix}/img_${i}.png`;
        await bucket.file(objectName).save(Buffer.from(b64, 'base64'), { contentType: 'image/png' });
        return objectName;
      }));
      for (const [emotion, b64] of Object.entries(spritesBase64 || {})) {
        const objectName = `${prefix}/sprite_${emotion}.png`;
        await bucket.file(objectName).save(Buffer.from(b64, 'base64'), { contentType: 'image/png' });
        spriteObjects[emotion] = objectName;
      }
    }

    const perSlotImages = orderedSlots.map(() => []);
    imagePaths.forEach((p, i) => perSlotImages[i % orderedSlots.length].push(p));

    const entries = orderedSlots.map((slot, i) => ({
      atMs: slot.atMs,
      title: slot.title || '',
      mode: mode || 'gameplay',
      hidePost: !!hidePost,
      tiktokOptions: tiktokOptions || null,
      imagePaths: perSlotImages[i],
      spriteObjects,
      status: 'pending',
    }));

    await firestore.collection('schedules').doc(scheduleId).set({ uid, createdAt: Date.now(), entries });
    console.log(`schedule ${scheduleId}: ${entries.length} slot(s) created for uid ${uid}, ${imagePaths.length} image(s) distributed, ${Object.keys(spriteObjects).length} sprite(s)`);
    res.json({ scheduleId, entries: entries.map((e) => ({ atMs: e.atMs, title: e.title, imageCount: e.imagePaths.length })) });
  } catch (err) {
    const msg = err && (err.message || String(err));
    console.error(`[schedule ${scheduleId || '?'}] create FAILED: ${msg}`);
    res.status(500).send(`Could not save the schedule: ${msg}`);
  }
});

app.get('/schedule/draft', async (req, res) => {
  if (!firestore) return res.status(503).send('Scheduling is not configured on the server right now.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const doc = await firestore.collection('schedule_drafts').doc(uid).get();
  res.json({ entries: doc.exists ? (doc.data().entries || []) : [] });
});

app.post('/schedule/draft', async (req, res) => {
  if (!firestore) return res.status(503).send('Scheduling is not configured on the server right now.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).send('entries must be an array');
  const kept = entries.filter((e) => e && Number.isInteger(e.dayOfWeek) && e.dayOfWeek >= 0 && e.dayOfWeek <= 6);
  await firestore.collection('schedule_drafts').doc(uid).set({ entries: kept, updatedAt: Date.now() });
  res.json({ saved: kept.length });
});

app.get('/schedule/list', async (req, res) => {
  if (!firestore) return res.status(503).send('Scheduling is not configured on the server right now.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const snap = await firestore.collection('schedules').where('uid', '==', uid).get();
  const schedules = snap.docs.map((d) => ({ scheduleId: d.id, entries: d.data().entries }));
  res.json({ schedules });
});

app.post('/schedule/cancel', async (req, res) => {
  if (!firestore) return res.status(503).send('Scheduling is not configured on the server right now.');
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).send('Not signed in');
  const { scheduleId, idx } = req.body || {};
  if (!scheduleId || !Number.isInteger(idx)) return res.status(400).send('scheduleId and a numeric idx are required.');

  const ref = firestore.collection('schedules').doc(String(scheduleId));
  let cancelledEntry = null;
  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('That schedule no longer exists.');
      if (snap.data().uid !== uid) throw new Error('That schedule belongs to a different account.');
      const entries = snap.data().entries || [];
      const e = entries[idx];
      if (!e) throw new Error('That scheduled post no longer exists.');
      if (e.status !== 'pending') throw new Error(`That post can't be cancelled — it is already ${e.status}.`);
      entries[idx] = { ...e, status: 'cancelled', cancelledAt: Date.now() };
      tx.update(ref, { entries });
      cancelledEntry = e;
    });
  } catch (err) {
    return res.status(409).send(err && (err.message || String(err)));
  }

  if (gcsStorage && GCS_BUCKET_NAME) {
    const bucket = gcsStorage.bucket(GCS_BUCKET_NAME);
    for (const objName of cancelledEntry.imagePaths || []) {
      bucket.file(objName).delete().catch(() => {});
    }
  }
  console.log(`schedule ${scheduleId}[${idx}] cancelled by uid ${uid}`);
  res.json({ cancelled: true });
});

async function patchScheduleEntry(scheduleId, idx, patch) {
  const ref = firestore.collection('schedules').doc(scheduleId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const entries = snap.data().entries || [];
    if (!entries[idx]) return;
    entries[idx] = { ...entries[idx], ...patch };
    tx.update(ref, { entries });
  });
}

const SCHEDULE_STALE_PROCESSING_MS = 45 * 60 * 1000;

app.post('/schedule/run-due', async (req, res) => {
  const runId = crypto.randomBytes(4).toString('hex');
  if (!SCHEDULER_SECRET) {
    console.error(`[run-due ${runId}] REJECTED: SCHEDULER_SECRET is not set on the server, so every call is refused. Add it to env.yaml and redeploy.`);
    return res.status(401).send('Not authorized.');
  }
  const normalizeSecret = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  const expectedSecret = normalizeSecret(SCHEDULER_SECRET);
  const receivedSecret = normalizeSecret(req.headers['x-scheduler-secret']);
  const expectedBuf = Buffer.from(expectedSecret);
  const receivedBuf = Buffer.from(receivedSecret);
  const secretsMatch = expectedBuf.length > 0 && expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf);
  if (!secretsMatch) {
    const fp = (v) => `length ${v.length}, sha256 ${crypto.createHash('sha256').update(v).digest('hex').slice(0, 8)}`;
    const rawHeader = String(req.headers['x-scheduler-secret'] || '');
    console.error(`[run-due ${runId}] REJECTED: X-Scheduler-Secret header does not match.`);
    console.error(`[run-due ${runId}]   server expects (env.yaml SCHEDULER_SECRET): ${fp(expectedSecret)}`);
    console.error(`[run-due ${runId}]   scheduler sent  (--headers on the job):     ${fp(receivedSecret)}${rawHeader !== receivedSecret ? `  [raw header had extra quotes/whitespace: raw length ${rawHeader.length}]` : ''}`);
    console.error(`[run-due ${runId}]   Fix: run "gcloud scheduler jobs update http vidmasta-schedule-runner --location=us-central1 --update-headers=X-Scheduler-Secret=<the exact SCHEDULER_SECRET value from env.yaml>"`);
    return res.status(401).send('Not authorized.');
  }
  if (!firestore || !gcsStorage) {
    console.error(`[run-due ${runId}] REJECTED: Firestore or Cloud Storage is not initialised.`);
    return res.status(503).send('Scheduling storage is not configured.');
  }

  const now = Date.now();
  console.log(`[run-due ${runId}] called at ${new Date(now).toISOString()}`);

  const snap = await firestore.collection('schedules').get();
  let totalEntries = 0, pendingFuture = 0, alreadyDone = 0, alreadyError = 0, inProgress = 0;
  const candidates = [];
  snap.forEach((doc) => {
    const data = doc.data();
    (data.entries || []).forEach((entry, idx) => {
      totalEntries++;
      if (entry.status === 'done') { alreadyDone++; return; }
      if (entry.status === 'error') { alreadyError++; return; }
      if (entry.status === 'cancelled') return;
      if (entry.status === 'processing') {
        const stale = now - (entry.processingStartedAt || 0) > SCHEDULE_STALE_PROCESSING_MS;
        if (stale) candidates.push({ scheduleId: doc.id, idx, uid: data.uid, reclaim: true });
        else inProgress++;
        return;
      }
      if (entry.atMs > now) {
        pendingFuture++;
        const mins = Math.round((entry.atMs - now) / 60000);
        console.log(`[run-due ${runId}]   ${doc.id}[${idx}] not due yet — fires in ${mins} min (${new Date(entry.atMs).toISOString()})`);
        return;
      }
      candidates.push({ scheduleId: doc.id, idx, uid: data.uid, reclaim: false });
    });
  });
  console.log(`[run-due ${runId}] scanned ${snap.size} schedule(s), ${totalEntries} entr(ies): ${candidates.length} due, ${pendingFuture} not yet due, ${inProgress} already processing, ${alreadyDone} done, ${alreadyError} errored`);

  const claimed = [];
  for (const c of candidates) {
    const ref = firestore.collection('schedules').doc(c.scheduleId);
    try {
      const entry = await firestore.runTransaction(async (tx) => {
        const s2 = await tx.get(ref);
        const entries = s2.data().entries || [];
        const e = entries[c.idx];
        if (!e) return null;
        const claimable = e.status === 'pending' ||
          (e.status === 'processing' && now - (e.processingStartedAt || 0) > SCHEDULE_STALE_PROCESSING_MS);
        if (!claimable) return null;
        entries[c.idx] = { ...e, status: 'processing', processingStartedAt: now, claimedBy: runId };
        tx.update(ref, { entries });
        return e;
      });
      if (entry) {
        claimed.push({ ...c, entry });
        console.log(`[run-due ${runId}] CLAIMED ${c.scheduleId}[${c.idx}]${c.reclaim ? ' (reclaimed a stale processing entry)' : ''}`);
      } else {
        console.log(`[run-due ${runId}] skipped ${c.scheduleId}[${c.idx}] — another run claimed it first`);
      }
    } catch (err) {
      console.error(`[run-due ${runId}] could not claim ${c.scheduleId}[${c.idx}]: ${err && (err.message || err)}`);
    }
  }

  res.status(202).json({ runId, claimed: claimed.length });

  for (const { scheduleId, idx, uid, entry } of claimed) {
    const tag = `[run-due ${runId}] ${scheduleId}[${idx}]`;
    const started = Date.now();
    const jobDir = path.join(os.tmpdir(), `sched_${scheduleId}_${idx}`);
    const debugTrail = [];
    const platformResults = {};
    try {
      await fs.mkdir(jobDir, { recursive: true });
      console.log(`${tag} starting: "${entry.title || '(no title)'}", mode=${entry.mode}, ${entry.imagePaths.length} image(s), ${Object.keys(entry.spriteObjects || {}).length} sprite(s)`);

      const bucket = gcsStorage.bucket(GCS_BUCKET_NAME);
      const images = await Promise.all(entry.imagePaths.map(async (objName) => {
        const [buf] = await bucket.file(objName).download();
        return { base64: buf.toString('base64') };
      }));
      const sprites = {};
      for (const [emotion, objName] of Object.entries(entry.spriteObjects || {})) {
        const [buf] = await bucket.file(objName).download();
        sprites[emotion] = buf.toString('base64');
      }
      console.log(`${tag} downloaded inputs from Cloud Storage`);

      const finalVideoPath = await runVideoGeneration({ title: entry.title, images, sprites, mode: entry.mode, dir: jobDir, debugTrail, hidePost: !!entry.hidePost });

      let uploadPath = finalVideoPath;
      try {
        const upscaledPath = path.join(jobDir, 'platform_upload_1080.mp4');
        const t0 = Date.now();
        await run('ffmpeg', [
          '-i', finalVideoPath,
          '-vf', 'scale=1080:1920:flags=lanczos',
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-threads', FFMPEG_THREADS,
          '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart', '-y', upscaledPath,
        ]);
        uploadPath = upscaledPath;
        console.log(`${tag} made 1080x1920 platform upload copy in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (err) {
        console.error(`${tag} 1080p upload copy FAILED, uploading the original 720p file instead: ${err && (err.message || err)}`);
      }

      const videoBuffer = await fs.readFile(uploadPath);
      console.log(`${tag} rendered ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s`);

      const attempt = async (name, fn) => {
        const t0 = Date.now();
        try {
          platformResults[name] = await fn();
          console.log(`${tag} ${name}: POSTED OK in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${JSON.stringify(platformResults[name])}`);
        } catch (err) {
          platformResults[name] = { error: err && (err.message || String(err)) };
          console.error(`${tag} ${name}: FAILED — ${platformResults[name].error}`);
        }
      };
      await attempt('youtube', () => doYoutubeUpload(uid, videoBuffer, entry.title));
      await attempt('tiktok', () => {
        if (!entry.tiktokOptions) throw new Error('No TikTok options were set for this schedule, so TikTok was skipped.');
        return doTiktokPublish(uid, videoBuffer, entry.title, entry.tiktokOptions);
      });
      await attempt('instagram', () => doInstagramPublish(uid, videoBuffer, entry.title));

      const ok = Object.entries(platformResults).filter(([, r]) => !r.error).map(([n]) => n);
      const bad = Object.entries(platformResults).filter(([, r]) => r.error).map(([n]) => n);
      console.log(`${tag} FINISHED in ${((Date.now() - started) / 1000).toFixed(0)}s — posted to [${ok.join(', ') || 'none'}], failed on [${bad.join(', ') || 'none'}]`);
      await patchScheduleEntry(scheduleId, idx, { status: 'done', finishedAt: Date.now(), results: platformResults, debug: debugTrail });
    } catch (err) {
      const message = err && (err.message || String(err));
      console.error(`${tag} FAILED before posting (after ${((Date.now() - started) / 1000).toFixed(0)}s): ${message}`);
      await patchScheduleEntry(scheduleId, idx, { status: 'error', finishedAt: Date.now(), error: message, debug: debugTrail }).catch(() => {});
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (claimed.length) console.log(`[run-due ${runId}] all ${claimed.length} claimed entr(ies) processed`);
});

async function runVideoGeneration({ title, images, sprites, mode, dir, debugTrail, hidePost = false }) {
  const jobStartedAt = Date.now();
  const spritePaths = {};
  for (const [emotion, base64] of Object.entries(sprites || {})) {
    const p = path.join(dir, `sprite_${emotion}.png`);
    await fs.writeFile(p, Buffer.from(base64, 'base64'));
    spritePaths[emotion] = p;
  }
  console.log('sprites saved:', Object.keys(spritePaths).length);
  const availableEmotions = Object.keys(spritePaths);

  const posts = await Promise.all(images.map(async (image, i) => {
    const imgPath = path.join(dir, `post_${i}.png`);
    if (image.stagedPath) await fs.copyFile(image.stagedPath, imgPath);
    else await fs.writeFile(imgPath, Buffer.from(image.base64, 'base64'));
    const lines = await extractLines(imgPath, debugTrail);
    console.log(`image ${i}: OCR done, lines: ${lines.length}`);
    const imgHeight = await ffprobeImageHeight(imgPath);
    const built = await buildPostAudio(lines, imgHeight, dir, i, availableEmotions, debugTrail);
    console.log(`image ${i}: TTS done`);
    const lastLineWithWords = [...built.lines].reverse().find((l) => l && l.words && l.words.length);
    if (lastLineWithWords) {
      const lastWordEnd = lastLineWithWords.words[lastLineWithWords.words.length - 1].end;
      const mismatch = lastWordEnd > built.duration;
      console.log(`image ${i}: last word ends at ${lastWordEnd.toFixed(2)}s, actual audio file duration is ${built.duration.toFixed(2)}s${mismatch ? '  <-- MISMATCH: captions reference a timestamp beyond the actual audio, some words will be silent' : ''}`);
      if (mismatch) debugTrail.push(`WARNING: image ${i} — last word timestamp (${lastWordEnd.toFixed(2)}s) exceeds actual audio duration (${built.duration.toFixed(2)}s), meaning the end of the audio will be silent while captions still show`);
    }
    return { imgPath, audioPath: built.audioPath, duration: built.duration, lines: built.lines, phraseSegments: built.phraseSegments };
  }));

  const segments = [];
  for (let i = 0; i < posts.length; i++) {
    const parts = await splitPostIntoSegments(posts[i], dir, i, debugTrail);
    segments.push(...parts);
  }
  debugTrail.push(`render plan: ${posts.length} post(s) -> ${segments.length} clip(s) [${segments.map((sg) => sg.role || 'standalone').join(', ')}]`);
  console.log(`runVideoGeneration: ${posts.length} post(s) expanded into ${segments.length} clip(s) for rendering`);

  let bgVideo;
  if (mode === 'gameplay') {
    try {
      bgVideo = await randomFile(path.join(ASSETS, 'videos', 'gameplay'));
    } catch (err) {
      debugTrail.push('gameplay mode requested but no gameplay clips found — used default background instead');
      bgVideo = await randomFile(path.join(ASSETS, 'videos'));
    }
  } else if (mode === 'parkour') {
    try {
      bgVideo = await randomFile(path.join(ASSETS, 'videos', 'parkour'));
    } catch (err) {
      debugTrail.push('parkour mode requested but no clips found in assets/videos/parkour — used default background instead');
      bgVideo = await randomFile(path.join(ASSETS, 'videos'));
    }
  } else {
    bgVideo = await randomFile(path.join(ASSETS, 'videos'));
  }
  const music = await randomFile(path.join(ASSETS, 'music'));
  const hookSfx = path.join(ASSETS, 'sfx', 'hook.mp3');
  const transitionSfx = path.join(ASSETS, 'sfx', 'transition.mp3');
  debugTrail.push(`background video: ${path.basename(bgVideo)} (mode: ${mode || 'default'})`);
  debugTrail.push(
    upgradedVoiceAvailable === true
      ? `TTS voice: UPGRADED (${UPGRADED_TTS_MODEL} / ${UPGRADED_VOICE_NAME}) via ${upgradedVoiceShapeUsed} — pitch-per-emotion active`
        + ' — NOTE: this voice takes plain text only, so word timings for captions are ESTIMATED (proportional), not exact'
      : upgradedVoiceAvailable === false
        ? `TTS voice: FALLBACK (${FALLBACK_VOICE_NAME}) — upgraded model unavailable: ${upgradedVoiceFailureReason || 'unknown'}`
        : `TTS voice: upgraded model not yet attempted`
  );

  const bgSpecs = await ffprobeVideoSpecs(bgVideo);
  debugTrail.push(`background video specs: ${bgSpecs}`);

  const durations = segments.map((s) => s.duration);
  let bgCursor = await randomStart(bgVideo, durations.reduce((a, b) => a + b, 0) * BG_SPEED);
  const clipPaths = [];

  const SENTENCE_END_FOR_HOOK = /[.!?]["')\]]*$/;
  let hasHook = false;
  const hookCandidates = [];
  segments.forEach((seg, segIdx) => {
    let current = [];
    seg.lines.forEach((line, lineIdx) => {
      current.push(lineIdx);
      const lineText = line.words.map((w) => w.word).join(' ');
      const isLast = lineIdx === seg.lines.length - 1;
      const isChunkBoundary = line.chunkBoundaryAfter === true;
      if (isLast || isChunkBoundary || SENTENCE_END_FOR_HOOK.test(lineText.trim())) {
        const sentenceWords = current.flatMap((li) => seg.lines[li].words);
        const sentenceText = sentenceWords.map((w) => w.word).join(' ');
        const lastLineIdx = current[current.length - 1];
        hookCandidates.push({ text: sentenceText, segIdx, lineIdx: lastLineIdx, revealFrac: seg.lines[lastLineIdx].revealFrac, lineIndices: [...current] });
        current = [];
      }
    });
  });
  const HOOK_MAX_WORDS = 13;
  const shortHookCandidates = hookCandidates.filter((c) => c.text.split(/\s+/).filter(Boolean).length <= HOOK_MAX_WORDS);
  const hookCandidatePool = shortHookCandidates.length ? shortHookCandidates : hookCandidates;
  debugTrail.push(`hook: ${shortHookCandidates.length}/${hookCandidates.length} candidates were ${HOOK_MAX_WORDS} words or under`);
  const hookPick = await pickHookLine(hookCandidatePool, debugTrail);
  if (hookPick !== null) {
    try {
      const hookCandidate = hookCandidatePool[hookPick.idx];
      const hookSeg = segments[hookCandidate.segIdx];
      const hookLineIndices = hookCandidate.lineIndices || [hookCandidate.lineIdx];
      const hookPieces = [];
      let piece = [];
      hookLineIndices.forEach((li, pieceIdx) => {
        piece.push(li);
        const isLastLine = pieceIdx === hookLineIndices.length - 1;
        if (!isLastLine && hookSeg.lines[li].chunkBoundaryAfter) {
          hookPieces.push(piece);
          piece = [];
        }
      });
      if (piece.length) hookPieces.push(piece);
      const hookPieceTexts = hookPieces.map((indices) => indices.flatMap((li) => hookSeg.lines[li].words).map((w) => w.word).join(' '));
      if (hookPieceTexts.length > 1) debugTrail.push(`hook: split into ${hookPieceTexts.length} piece(s) with a pause between them`);

      const hookPhrase = HOOK_VOICE_LINES[hookPick.phraseIdx];
      const hookAudio = await synthesizeLine(hookPhrase, dir, 'hookphrase', { speakingRate: HOOK_VOICE_RATE });
      const zoomFactor = ZOOM_START - (ZOOM_START - ZOOM_END) * hookCandidate.revealFrac;
      const hookClipPath = path.join(dir, 'clip_hook.mp4');
      await renderHookClip({ bgVideo, bgStart: bgCursor, duration: hookAudio.duration + HOOK_END_PAUSE, imgPath: hookSeg.imgPath, zoomFactor, audioPath: hookAudio.audioPath, hookWords: hookAudio.words, hookText: hookPieceTexts.join(' '), hookSfxPath: hookSfx, outPath: hookClipPath, mode, debugTrail, hidePost });
      const actualHookDuration = await ffprobeDuration(hookClipPath);
      debugTrail.push(`hook clip: duration ${actualHookDuration.toFixed(2)}s`);
      clipPaths.push(hookClipPath);
      hasHook = true;
      durations.unshift(actualHookDuration);
      bgCursor += actualHookDuration * BG_SPEED;
    } catch (err) {
      debugTrail.push(`hook: render failed — ${err && (err.message || err)}`);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const clipPath = path.join(dir, `clip_${i}.mp4`);
    const wordCount = seg.lines.reduce((sum, l) => sum + l.words.length, 0);
    const emotionSegmentCount = buildEmotionSegments(seg.lines).filter((s) => s.emotion).length;
    const renderStartedAt = Date.now();
    await renderClip({ bgVideo, bgStart: bgCursor, duration: seg.duration, imgPath: seg.imgPath, spritePaths, audioPath: seg.audioPath, lines: seg.lines, phraseSegments: seg.phraseSegments, outPath: clipPath, mode, isPostEnd: seg.isPostEnd !== false, isContinuation: seg.isContinuation === true, barOffset: seg.postOffset || 0, barTotal: seg.postDuration || seg.duration, hidePost });
    const renderMs = Date.now() - renderStartedAt;
    const actualClipDuration = await ffprobeDuration(clipPath);
    const renderSpeed = seg.duration / (renderMs / 1000);
    debugTrail.push(`clip ${i}: ${seg.lines.length} line(s), ${wordCount} word(s), ${emotionSegmentCount} emotion segment(s) — requested ${seg.duration.toFixed(2)}s, actual ${actualClipDuration.toFixed(2)}s, render took ${(renderMs / 1000).toFixed(1)}s (${renderSpeed.toFixed(2)}x realtime)`);
    try {
      const clipStat = await fs.stat(clipPath);
      debugTrail.push(`clip ${i}: file ${(clipStat.size / 1024 / 1024).toFixed(0)} MB on tmpfs (RAM-backed)`);
    } catch (err) { }
    const elapsedSoFar = (Date.now() - jobStartedAt) / 1000;
    const projectedTotal = elapsedSoFar * (segments.length / (i + 1));
    if (projectedTotal > 0.8 * (35 * 60)) {
      debugTrail.push(`WARNING: projected total render ~${(projectedTotal / 60).toFixed(1)} min against a 35 min watchdog. ${wordCount} words in this clip is the driver — caption filters scale with word count.`);
      console.warn(`runVideoGeneration: projected ${(projectedTotal / 60).toFixed(1)} min total — approaching the watchdog`);
    }
    if (renderSpeed < 0.5) {
      debugTrail.push(`SLOW RENDER on clip ${i}: ${renderSpeed.toFixed(2)}x realtime. ${wordCount} words means ~${wordCount * 2} caption filters; long posts are the main driver of render time.`);
      console.warn(`renderClip ${i}: SLOW — ${renderSpeed.toFixed(2)}x realtime, ${wordCount} words, ${seg.lines.length} lines`);
    }
    console.log(`clip ${i}: cumulative job elapsed time so far: ${((Date.now() - jobStartedAt) / 1000).toFixed(1)}s (timeout is 720s)`);
    clipPaths.push(clipPath);
    bgCursor += seg.duration * BG_SPEED;
    console.log(`clip ${i} (${seg.role || 'standalone'}): background continues at ${bgCursor.toFixed(2)}s`);
  }

  const dialogueVideo = path.join(dir, 'dialogue.mp4');
  const continuationFlags = [];
  if (hasHook) continuationFlags.push(false);
  segments.forEach((sg) => continuationFlags.push(sg.isContinuation === true));
  await concatWithTransitions(clipPaths, durations, transitionSfx, hookSfx, dialogueVideo, hasHook, continuationFlags, path.join(ASSETS, 'sfx', 'line_end.mp3'));

  const lastClipPath = clipPaths[clipPaths.length - 1];
  const lastClipStreams = await ffprobeStreamDurations(lastClipPath);
  const lastClipMismatch = lastClipStreams.videoDuration != null && lastClipStreams.audioDuration != null && Math.abs(lastClipStreams.videoDuration - lastClipStreams.audioDuration) > 0.1;
  debugTrail.push(`last clip (${path.basename(lastClipPath)}) own streams — video: ${lastClipStreams.videoDuration?.toFixed(2) ?? 'unknown'}s, audio: ${lastClipStreams.audioDuration?.toFixed(2) ?? 'unknown'}s${lastClipMismatch ? '  <-- MISMATCH in the last clip itself, before concatenation' : ''}`);

  let freedMB = 0;
  for (const cp of clipPaths) {
    try {
      const st = await fs.stat(cp);
      freedMB += st.size / (1024 * 1024);
      await fs.rm(cp, { force: true });
    } catch (err) { }
  }
  console.log(`runVideoGeneration: freed ${freedMB.toFixed(0)} MB of tmpfs by deleting ${clipPaths.length} consumed clip file(s)`);
  debugTrail.push(`tmpfs: freed ${freedMB.toFixed(0)} MB after concat (Cloud Run /tmp is RAM-backed)`);
  const expectedDialogueDuration = durations.reduce((a, b) => a + b, 0) - XFADE * (clipPaths.length - 1);
  const actualDialogueDuration = await ffprobeDuration(dialogueVideo);
  debugTrail.push(`concatenated dialogue video: expected ~${expectedDialogueDuration.toFixed(2)}s, actual ${actualDialogueDuration.toFixed(2)}s`);

  const dialogueStreams = await ffprobeStreamDurations(dialogueVideo);
  debugTrail.push(`dialogue video streams — video: ${dialogueStreams.videoDuration?.toFixed(2) ?? 'unknown'}s, audio: ${dialogueStreams.audioDuration?.toFixed(2) ?? 'unknown'}s`);

  const finalVideo = path.join(dir, 'final.mp4');
  await mixMusicIntoVideo(dialogueVideo, music, finalVideo);
  try {
    const dst = await fs.stat(dialogueVideo);
    await fs.rm(dialogueVideo, { force: true });
    console.log(`runVideoGeneration: freed ${(dst.size / 1024 / 1024).toFixed(0)} MB more by deleting the consumed dialogue file`);
  } catch (err) { }
  const finalDuration = await ffprobeDuration(finalVideo);
  debugTrail.push(`final video duration: ${finalDuration.toFixed(2)}s`);

  const finalStreams = await ffprobeStreamDurations(finalVideo);
  debugTrail.push(`final video streams — video: ${finalStreams.videoDuration?.toFixed(2) ?? 'unknown'}s, audio: ${finalStreams.audioDuration?.toFixed(2) ?? 'unknown'}s`);

  const blackSegments = await detectBlackFrames(finalVideo);
  if (blackSegments.length) {
    debugTrail.push(`WARNING: ${blackSegments.length} black segment(s) detected — ${blackSegments.map((s) => `${s.start.toFixed(2)}s-${s.end.toFixed(2)}s`).join(', ')}`);
  } else {
    debugTrail.push('black-frame scan: none found');
  }

  return finalVideo;
}

const jobs = new Map();
const JOB_CLEANUP_MS = 15 * 60 * 1000;

const uploadSessions = new Map();
const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

app.post('/generate/session', async (req, res) => {
  const sessionId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), `upload_${sessionId}`);
  await fs.mkdir(dir, { recursive: true });
  uploadSessions.set(sessionId, { dir, images: new Map(), sprites: new Map(), createdAt: Date.now() });
  console.log(`upload session ${sessionId} created`);
  setTimeout(() => {
    if (uploadSessions.has(sessionId)) {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      uploadSessions.delete(sessionId);
    }
  }, UPLOAD_SESSION_TTL_MS);
  res.json({ sessionId });
});

app.post('/generate/session/:sessionId/file', async (req, res) => {
  const session = uploadSessions.get(req.params.sessionId);
  if (!session) return res.status(404).send('Upload session not found (it may have expired)');
  const { index, spriteName, base64 } = req.body || {};
  if (!base64) return res.status(400).send('Missing base64');
  try {
    const buf = Buffer.from(base64, 'base64');
    if (spriteName) {
      const p = path.join(session.dir, `sprite_${spriteName}.png`);
      await fs.writeFile(p, buf);
      session.sprites.set(spriteName, p);
      console.log(`upload session ${req.params.sessionId}: sprite "${spriteName}" staged (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      if (typeof index !== 'number') return res.status(400).send('Missing numeric index for an image');
      const p = path.join(session.dir, `staged_${index}.png`);
      await fs.writeFile(p, buf);
      session.images.set(index, p);
      console.log(`upload session ${req.params.sessionId}: image ${index} staged (${(buf.length / 1024 / 1024).toFixed(2)} MB), ${session.images.size} total`);
    }
    res.json({ images: session.images.size, sprites: session.sprites.size });
  } catch (err) {
    console.error(`upload session ${req.params.sessionId}: staging failed:`, err && (err.message || err));
    res.status(500).send(`Could not stage file: ${err && (err.message || err)}`);
  }
});

app.post('/generate/session/:sessionId/start', async (req, res) => {
  const session = uploadSessions.get(req.params.sessionId);
  if (!session) return res.status(404).send('Upload session not found (it may have expired)');
  if (!session.images.size) return res.status(400).send('No images were staged for this session');

  const { title, mode, hidePost } = req.body || {};
  const images = [...session.images.keys()].sort((a, b) => a - b).map((k) => ({ stagedPath: session.images.get(k) }));
  const sprites = {};
  for (const [name, p] of session.sprites) sprites[name] = (await fs.readFile(p)).toString('base64');

  const jobId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), `job_${jobId}`);
  await fs.mkdir(dir, { recursive: true });
  const debugTrail = [];
  debugTrail.push(`genAI available: ${genAIRegional ? 'yes' : `NO — ${aiSetupFailureReason || 'reason unknown'}`}`);
  debugTrail.push(`firebase-admin available: ${firestore && firebaseAuth ? 'yes' : 'no'}`);
  debugTrail.push(`chunked upload: ${images.length} image(s), ${Object.keys(sprites).length} sprite(s) staged across separate requests`);
  const job = { status: 'processing', debug: debugTrail, videoPath: null, dir, error: null, createdAt: Date.now() };
  jobs.set(jobId, job);
  console.log(`generate job ${jobId} started from upload session ${req.params.sessionId} [build:2026-09-09-veryfast-vision-diag], images:`, images.length);

  const JOB_TIMEOUT_MS = 35 * 60 * 1000;
  const jobTimeout = new Promise((_, reject) =>
    setTimeout(() => {
      killAllActiveProcesses(`job ${jobId} timed out`);
      reject(new Error(`Generation timed out after ${JOB_TIMEOUT_MS / 1000}s.`));
    }, JOB_TIMEOUT_MS)
  );
  Promise.race([runVideoGeneration({ title, images, sprites, mode, dir, debugTrail, hidePost: !!hidePost }), jobTimeout])
    .then((finalVideoPath) => { job.status = 'done'; job.videoPath = finalVideoPath; })
    .catch((err) => { job.status = 'error'; job.error = err && (err.message || String(err)); debugTrail.push(`FATAL: ${job.error}`); })
    .finally(() => {
      fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
      uploadSessions.delete(req.params.sessionId);
      setTimeout(() => {
        if (jobs.has(jobId)) { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); jobs.delete(jobId); }
      }, JOB_CLEANUP_MS);
    });

  res.status(202).json({ jobId });
});

app.post('/generate/start', async (req, res) => {
  const { title, images, sprites, mode, hidePost } = req.body;
  if (!images?.length) return res.status(400).send('At least one image is required');
  const jobId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), `job_${jobId}`);
  await fs.mkdir(dir, { recursive: true });
  const debugTrail = [];
  debugTrail.push(`genAI available: ${genAIRegional ? 'yes' : `NO — ${aiSetupFailureReason || 'reason unknown'}`}`);
  debugTrail.push(`firebase-admin available: ${firestore && firebaseAuth ? 'yes' : 'no'}`);
  const job = { status: 'processing', debug: debugTrail, videoPath: null, dir, error: null, createdAt: Date.now() };
  jobs.set(jobId, job);
  const jobStartedAt = Date.now();
  console.log(`generate job ${jobId} started [filter-v20-safe-timestamp-fps26], images:`, images.length);
  const JOB_TIMEOUT_MS = 35 * 60 * 1000;
  const jobTimeout = new Promise((_, reject) =>
    setTimeout(() => {
      killAllActiveProcesses(`job ${jobId} timed out`);
      reject(new Error(`Generation timed out after ${JOB_TIMEOUT_MS / 1000}s.`));
    }, JOB_TIMEOUT_MS)
  );
  Promise.race([runVideoGeneration({ title, images, sprites, mode, dir, debugTrail, hidePost: !!hidePost }), jobTimeout])
    .then((finalVideoPath) => { job.status = 'done'; job.videoPath = finalVideoPath; })
    .catch((err) => { job.status = 'error'; job.error = err && (err.message || String(err)); debugTrail.push(`FATAL: ${job.error}`); })
    .finally(() => {
      setTimeout(() => {
        if (jobs.has(jobId)) { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); jobs.delete(jobId); }
      }, JOB_CLEANUP_MS);
    });
  res.status(202).json({ jobId });
});

app.get('/generate/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json({ status: job.status, debug: job.debug, error: job.error });
});

app.get('/generate/result/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send('Job not found');
  if (job.status === 'processing') return res.status(425).send('Still processing');
  if (job.status === 'error') return res.status(500).send(job.error || 'Generation failed');

  const cleanup = async () => {
    console.log(`generate/result ${req.params.jobId}: delivered; video kept on disk for export reuse until cleanup`);
  };

  try {
    const stat = await fs.stat(job.videoPath);
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    console.log(`generate/result ${req.params.jobId}: streaming ${mb} MB`);

    res.setHeader('Content-Type', 'video/mp4');
    const stream = createReadStream(job.videoPath);

    stream.on('error', (err) => {
      console.error(`generate/result ${req.params.jobId}: read stream failed:`, err && (err.message || err));
      if (!res.headersSent) res.status(500).send(`Could not read the finished video: ${err && (err.message || err)}`);
      else res.destroy();
      cleanup();
    });
    res.on('close', () => { stream.destroy(); cleanup(); });
    stream.pipe(res);
  } catch (err) {
    console.error(`generate/result ${req.params.jobId}: failed before streaming:`, err && (err.stack || err.message || err));
    if (!res.headersSent) res.status(500).send(`Could not send the finished video: ${err && (err.message || err)}`);
    await cleanup();
  }
});

app.post('/generate', async (req, res) => {
  const { title, images, sprites, mode, hidePost } = req.body;
  if (!images?.length) return res.status(400).send('At least one image is required');
  const debugTrail = [];
  debugTrail.push(`genAI available: ${genAIRegional ? 'yes' : `NO — ${aiSetupFailureReason || 'reason unknown'}`}`);
  debugTrail.push(`firebase-admin available: ${firestore && firebaseAuth ? 'yes' : 'no'}`);
  const approxPayloadMB = (images || []).reduce((n, im) => n + (im && im.base64 ? im.base64.length : 0), 0) / (1024 * 1024);
  debugTrail.push(`upload path: SINGLE REQUEST — ${images.length} image(s) in one POST, ~${approxPayloadMB.toFixed(1)} MB of base64`);
  if (approxPayloadMB > 24) {
    debugTrail.push(`WARNING: payload ~${approxPayloadMB.toFixed(1)} MB is close to Cloud Run's hard 32 MiB per-request cap. Larger batches are rejected by the platform BEFORE this server sees them. Switch the frontend to the chunked /generate/session endpoints.`);
    console.error(`/generate/start: payload ~${approxPayloadMB.toFixed(1)} MB — near/over the 32MiB request cap`);
  }
  const dir = path.join(os.tmpdir(), `job_${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const finalVideo = await runVideoGeneration({ title, images, sprites, mode, dir, debugTrail, hidePost: !!hidePost });
    res.setHeader('X-Vidmasta-Debug', encodeURIComponent(JSON.stringify(debugTrail)).slice(0, 6000));
    const stat = await fs.stat(finalVideo);
    console.log(`generate: streaming ${(stat.size / (1024 * 1024)).toFixed(1)} MB`);
    res.setHeader('Content-Type', 'video/mp4');
    await new Promise((resolve, reject) => {
      const stream = createReadStream(finalVideo);
      stream.on('error', reject);
      res.on('close', resolve);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  } catch (err) {
    debugTrail.push(`FATAL: ${err && (err.message || err)}`);
    if (!res.headersSent) res.setHeader('X-Vidmasta-Debug', encodeURIComponent(JSON.stringify(debugTrail)).slice(0, 6000));
    res.status(500).send(err.message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function extractLines(imgPath, debugTrail) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', imgPath]);
    const [w, h] = stdout.trim().split('x').map(Number);
    console.log(`extractLines: image dimensions ${w}x${h} (${((w * h) / 1e6).toFixed(1)} megapixels)`);
    if (h > 12000 || w * h > 40e6) {
      console.warn(`extractLines: UNUSUALLY LARGE image (${w}x${h}) — this is close to or past Google Vision's documented limits and may cause OCR to fail or degrade.`);
      if (debugTrail) debugTrail.push(`WARNING: image is ${w}x${h} — unusually large, may exceed Vision API limits`);
    }
  } catch (err) {
    console.warn('extractLines: could not probe image dimensions (non-fatal):', err && (err.message || err));
  }

  let result;
  try {
    [result] = await visionClient.documentTextDetection(imgPath, { imageContext: { languageHints: ['en'] } });
  } catch (err) {
    console.error(`VISION OCR FAILED for ${imgPath}`);
    console.error(`  code: ${err && err.code}   message: ${err && err.message}`);
    console.error('  full error:', err && (err.stack || err));
    if (debugTrail) debugTrail.push(`FATAL: Vision OCR failed — ${err && (err.message || err)}`);
    throw err;
  }
  const page = result.fullTextAnnotation?.pages?.[0];
  const rawLines = [];

  if (page) {
    let curWords = [];
    let curMaxY = 0;
    let curMinY = null;
    const flushLine = () => {
      const text = curWords.join(' ').trim();
      if (text) rawLines.push({ text, bottom: curMaxY || null, top: curMinY });
      curWords = []; curMaxY = 0; curMinY = null;
    };
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const wordText = (word.symbols || []).map((s) => s.text).join('');
          if (wordText) curWords.push(wordText);
          const vertices = word.boundingBox?.vertices || [];
          const ys = vertices.map((v) => v.y).filter((y) => typeof y === 'number');
          if (ys.length) {
            curMaxY = Math.max(curMaxY, ...ys);
            const wordMinY = Math.min(...ys);
            curMinY = curMinY === null ? wordMinY : Math.min(curMinY, wordMinY);
          }
          const symbols = word.symbols || [];
          const breakType = symbols[symbols.length - 1]?.property?.detectedBreak?.type;
          if (breakType === 'EOL_SURE_SPACE' || breakType === 'LINE_BREAK') flushLine();
        }
        flushLine();
      }
    }
    flushLine();
  }

  if (!rawLines.length) {
    const fallback = (result.fullTextAnnotation?.text ?? '').split('\n');
    for (const l of fallback) rawLines.push({ text: l.trim(), bottom: null, top: null });
  }

  const rawLinesNonEmpty = rawLines.map((l, idx) => ({ ...l, origIndex: idx })).filter((l) => l.text.trim());

  let mentionsStripped = 0;
  let mentionStrippedLines = rawLinesNonEmpty.map((l) => {
    const original = l.text.trim();
    let stripped = stripLeadingMention(original);
    stripped = stripTrailingCTA(stripped);
    stripped = stripLeadingRedditTags(stripped);
    stripped = stripLeadingReplyingToHeader(stripped);
    stripped = stripIfunnyWatermarkAnywhere(stripped);
    stripped = stripReplyHeaderAnywhere(stripped);
    stripped = stripTrailingTimestamp(stripped);
    stripped = stripEmbeddedChrome(stripped);
    if (stripped !== original) { mentionsStripped++; console.log(`stripLeadingMention (pre-classification): "${original}" -> "${stripped}"`); }
    return { text: stripped, bottom: l.bottom, top: l.top, origIndex: l.origIndex };
  }).filter((l) => l.text);
  debugTrail.push(`mention stripping: checked ${rawLinesNonEmpty.length} raw line(s), stripped a leading @mention/trailing CTA word from ${mentionsStripped} before classification`);

  const rawTextsForHeaderCheck = rawLinesNonEmpty.map((l) => l.text.trim());
  const headerOrigIndexes = new Set();
  rawLinesNonEmpty.forEach((line, i) => {
    if (isDisplayNameHeaderInContext(rawTextsForHeaderCheck, i)) headerOrigIndexes.add(line.origIndex);
  });
  if (headerOrigIndexes.size) {
    const headerFilteredLines = mentionStrippedLines.filter((line) => {
      if (!headerOrigIndexes.has(line.origIndex)) return true;
      console.log(`display-name header dropped (adjacent to an identity marker): "${line.text}"`);
      debugTrail.push(`display-name filter: dropped a header line adjacent to a handle/timestamp ("${line.text.slice(0, 60)}")`);
      return false;
    });
    if (headerFilteredLines.length) mentionStrippedLines = headerFilteredLines;
  }

  const rawTexts = mentionStrippedLines.map((l) => l.text);
  console.log(`=== OCR LINE TRACE (${rawLinesNonEmpty.length} raw lines) ===`);
  rawLinesNonEmpty.forEach((orig) => {
    const survivor = mentionStrippedLines.find((l) => l.origIndex === orig.origIndex);
    console.log(`  [${orig.origIndex}] RAW: ${JSON.stringify(orig.text.trim())}`);
    console.log(`       ->  ${survivor ? JSON.stringify(survivor.text) : '(removed before classification)'}`);
  });
  console.log('=== END OCR LINE TRACE ===');
  let mask = await aiKeepMaskFromImage(imgPath, rawTexts, path.dirname(imgPath), path.basename(imgPath, '.png'), debugTrail);
  let visionClassifierUsed = !!mask;
  let classifierUsed = mask ? `VISION (${mask.modelUsed || 'unknown model'} saw the screenshot)` : 'NONE — Gemini unavailable, pattern filters only';
  debugTrail.push(`classifier used: ${classifierUsed} on ${rawTexts.length} OCR line(s)`);
  console.log(`extractLines: classifier used = ${classifierUsed}, ${rawTexts.length} OCR lines`);
  if (mask) {
    const dropped = rawTexts.filter((_, i) => !mask[i]);
    if (dropped.length) {
      console.log(`extractLines: classifier DROPPED ${dropped.length} line(s):`);
      dropped.forEach((t) => console.log(`    - ${JSON.stringify(t)}`));
      debugTrail.push(`classifier dropped ${dropped.length} line(s): ${dropped.slice(0, 8).map((t) => JSON.stringify(t.slice(0, 40))).join(', ')}${dropped.length > 8 ? ' …' : ''}`);
    }
  }

  let candidateLines;
  if (mask) {
    const keptIndexSet = new Set(mentionStrippedLines.filter((_, i) => mask[i]).map((l) => l.origIndex));

    for (let i = 0; i < mentionStrippedLines.length - 1; i++) {
      if (!mask[i]) continue;
      const nextLine = mentionStrippedLines[i + 1];
      if (BARE_HANDLE_LINE.test(nextLine.text.trim())) {
        const line = mentionStrippedLines[i];
        if (keptIndexSet.delete(line.origIndex)) {
          debugTrail.push(`handle-pairing safety net: dropped a name line paired with the next line's bare handle ("${line.text.slice(0, 60)}")`);
        }
      }
    }

    const rescueNetsEnabled = !visionClassifierUsed;
    if (!rescueNetsEnabled) {
      debugTrail.push('rescue safety nets: SKIPPED — the vision classifier made the decision and is trusted');
      console.log('extractLines: rescue safety nets skipped (vision classifier was used)');
    }

    let currentRun = [];
    const flushRun = () => {
      if (!rescueNetsEnabled) { currentRun = []; return; }
      if (currentRun.length >= 2) {
        for (const line of currentRun) {
          keptIndexSet.add(line.origIndex);
          debugTrail.push(`consecutive-run safety net: restored a line the AI had dropped as part of a larger misclassified block ("${stripLeadingMention(cleanLine(line.text)).slice(0, 60)}")`);
        }
      }
      currentRun = [];
    };
    for (let i = 0; i < mentionStrippedLines.length; i++) {
      const line = mentionStrippedLines[i];
      const rescuedText = mask[i] ? null : stripLeadingMention(cleanLine(line.text));
      const isCandidate = !mask[i] && rescuedText && rescuedText.split(/\s+/).filter(Boolean).length >= 2;
      if (isCandidate) currentRun.push(line);
      else flushRun();
    }
    flushRun();

    for (let i = mentionStrippedLines.length - 1; rescueNetsEnabled && i >= 0; i--) {
      if (mask[i]) break;
      const line = mentionStrippedLines[i];
      const rescuedText = stripLeadingMention(cleanLine(line.text));
      if (rescuedText && rescuedText.split(/\s+/).filter(Boolean).length >= 2) {
        keptIndexSet.add(line.origIndex);
        debugTrail.push(`trailing safety net: restored a near-final line the AI had dropped`);
      }
    }

    const SENTENCE_END_FOR_CONTINUATION = /[.!?]["')\]]*$/;
    for (let i = 1; rescueNetsEnabled && i < mentionStrippedLines.length; i++) {
      if (mask[i]) continue;
      const line = mentionStrippedLines[i];
      if (keptIndexSet.has(line.origIndex)) continue;
      let prevIdx = i - 1;
      while (prevIdx >= 0 && !keptIndexSet.has(mentionStrippedLines[prevIdx].origIndex)) prevIdx--;
      if (prevIdx < 0) continue;
      const prevLine = mentionStrippedLines[prevIdx];
      if (SENTENCE_END_FOR_CONTINUATION.test(prevLine.text.trim())) continue;
      const rescuedText = stripLeadingMention(cleanLine(line.text));
      if (rescuedText && rescuedText.split(/\s+/).filter(Boolean).length >= 2) {
        keptIndexSet.add(line.origIndex);
        debugTrail.push(`continuation safety net: restored a line following an unterminated kept line`);
      }
    }

    candidateLines = mentionStrippedLines.filter((l) => keptIndexSet.has(l.origIndex));
  } else {
    candidateLines = mentionStrippedLines;
  }

  const beforePattern = candidateLines.length;
  const finalLines = candidateLines.map((l) => ({ text: stripEmbeddedChrome(stripReplyHeaderAnywhere(stripIfunnyWatermarkAnywhere(stripLeadingReplyingToHeader(stripTrailingTimestamp(stripLeadingRedditTags(stripTrailingCTA(stripLeadingMention(cleanLine(l.text))))))))), bottom: l.bottom, top: l.top, origIndex: l.origIndex })).filter((l) => l.text);
  if (finalLines.length !== beforePattern) debugTrail.push(`pattern safety-net: removed ${beforePattern - finalLines.length} more line(s) after AI pass`);

  const normalizeForDupeCheck = (s) => s.toLowerCase().replace(/[.\u2026]+$/, '').replace(/[^\w\s]/g, '').trim();
  const MIN_DUPE_LENGTH_RATIO = 0.35;
  const MAX_DUPE_LENGTH_RATIO = 0.97;
  const dedupedLines = [];
  let dupesRemoved = 0;
  for (let idx = 0; idx < finalLines.length; idx++) {
    const line = finalLines[idx];
    if (idx === finalLines.length - 1) { dedupedLines.push(line); continue; }
    const norm = normalizeForDupeCheck(line.text);
    const isDupe = norm.length >= 8 && dedupedLines.some((earlier) => {
      const earlierNorm = normalizeForDupeCheck(earlier.text);
      if (earlierNorm.length < 8) return false;
      const isSubstring = earlierNorm.includes(norm) || norm.includes(earlierNorm);
      if (!isSubstring) return false;
      const lengthRatio = Math.min(norm.length, earlierNorm.length) / Math.max(norm.length, earlierNorm.length);
      return lengthRatio >= MIN_DUPE_LENGTH_RATIO && lengthRatio < MAX_DUPE_LENGTH_RATIO;
    });
    if (isDupe) { dupesRemoved++; }
    else dedupedLines.push(line);
  }
  if (dupesRemoved) debugTrail.push(`near-duplicate filter: removed ${dupesRemoved} truncated/repeated preview line(s)`);

  const finalAtSignGuard = (arr) =>
    arr
      .map((l) => ({ ...l, text: l.text.replace(/@\s*\S+/g, '').replace(/\s{2,}/g, ' ').trim() }))
      .filter((l) => l.text);

  if (dedupedLines.length) return finalAtSignGuard(dedupedLines);
  debugTrail.push('WARNING: all lines were filtered out — falling back to raw OCR content to avoid a silent post');
  return finalAtSignGuard(mentionStrippedLines.length ? mentionStrippedLines : [{ text: '...', bottom: null, origIndex: -1 }]);
}

function wrapTextForHookCaption(text, maxCharsPerLine = 22) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length > maxCharsPerLine && currentLine) { lines.push(currentLine); currentLine = word; }
    else currentLine = candidate;
  }
  if (currentLine) lines.push(currentLine);
  return lines.join('\n');
}

const HOOK_VOICE_RATE = 1.15;
const HOOK_END_PAUSE = 0.9;
const HOOK_VOICE_LINES = [
  "I genuinely didn't expect this to happen",
  "Wait until you see what happens at the end.",
  "And the reason why is absolutely insane.",
  "I probably shouldn't be showing you this…",
  "you won't believe this",
  "And somehow, that wasn't even the craziest part.",
  "Wait until you hear why.",
  "But you need to hear what happened next.",
  "Only 1% can figure out why.",
  "…And God still hasn't ended humanity?",
  "Only people with elite meme knowledge will get this.",
  "Today they did something crazy.",
  "This took me way too long to learn.",
  "Nobody warned me about this.",
  "I actually can't make this up.",
  "I don't know who needs to hear this, but…",
  "I wish I knew this earlier.",
  "Pause for a second.",
  "Ever notice this pattern.",
  "You may not agree with this.",
  "I just figured this out.",
  "Try to figure out what's really happening before the reveal.",
  "Welp… Anyone got eye bleach?",
  "Can someone explain this?",
  "I almost didn't post this.",
  "This person is truly the scum of the earth.",
  "I have a question…",
  "You weren't supposed to see this.",
  "Most of you will skip this, but this gets crazy…",
  "Can you predict where they screwed up?",
  "Can you find the ONE thing in this image that's actually real?",
  "Can you predict the exact second they realized they messed up?",
  "Only an intellect realizes what this actually means.",
  "If you catch this before the reveal, you're seriously observant.",
  "You'll understand why at the very end.",
  "Most people completely miss what's happening here.",
  "Trust me, you need to hear the rest.",
  "There's more to this than you think.",
  "You won't believe what happened next.",
  "And somehow, it gets even crazier.",
  "No one talks about this.",
  "This might trigger you, but…",
  "Never ever ever do this.",
  "Here's a secret you wish you knew sooner.",
];

async function pickHookLine(candidates, debugTrail) {
  if (!candidates.length) return null;
  const randomPhrase = () => Math.floor(Math.random() * HOOK_VOICE_LINES.length);
  const fallbackIdx = candidates.reduce((best, c, i) => (c.text.length < candidates[best].text.length ? i : best), 0);
  if (!genAIRegional) {
    debugTrail.push(`hook: AI unavailable — using line ${fallbackIdx} and a random voice line`);
    return { idx: fallbackIdx, phraseIdx: randomPhrase() };
  }
  try {
    const numbered = candidates.map((c, i) => `${i}: ${c.text}`).join('\n');
    const phrases = HOOK_VOICE_LINES.map((p, i) => `${i}: ${p}`).join('\n');
    const prompt =
      'These are all the lines of real content that will be narrated across ' +
      'a short-form video.\n\n' +
      'STEP 1 — Pick ONE line as the ON-SCREEN HOOK: the single most ' +
      'shocking, surprising, funny, or emotionally charged standalone ' +
      'statement, no more than about 13 words.\n\n' +
      'STEP 2 — Pick ONE spoken hook phrase from the second list that best ' +
      'suits that line and the post overall, and would make a viewer keep ' +
      'watching.\n\n' +
      'Return ONLY the two numbers separated by a comma: LINE,PHRASE\n\n' +
      'LINES:\n' + numbered + '\n\nSPOKEN PHRASES:\n' + phrases;
    const rawText = await generateWithFallback(prompt, { temperature: 0 }, debugTrail);
    const nums = (rawText || '').match(/\d+/g) || [];
    let idx = nums.length ? parseInt(nums[0], 10) : NaN;
    let phraseIdx = nums.length > 1 ? parseInt(nums[1], 10) : NaN;
    if (!(idx >= 0 && idx < candidates.length)) idx = fallbackIdx;
    if (!(phraseIdx >= 0 && phraseIdx < HOOK_VOICE_LINES.length)) phraseIdx = randomPhrase();
    debugTrail.push(`hook: on-screen line ${idx} — "${candidates[idx].text.slice(0, 60)}"; voiced phrase ${phraseIdx} — "${HOOK_VOICE_LINES[phraseIdx]}"`);
    return { idx, phraseIdx };
  } catch (err) {
    debugTrail.push(`hook: AI selection failed (${err && (err.message || err)}) — using line ${fallbackIdx} and a random voice line`);
    return { idx: fallbackIdx, phraseIdx: randomPhrase() };
  }
}

async function ffprobeImageHeight(imgPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'default=noprint_wrappers=1:nokey=1', imgPath]);
  return parseInt(stdout.trim(), 10);
}

function escapeSsml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const MAX_SSML_WORDS = 150;
const TTS_SAMPLE_RATE = 24000;
const TTS_SPEED_MULTIPLIER = 1.25;

const FFMPEG_THREADS = String(Math.max(2, os.cpus().length));
console.log(`ffmpeg thread count set to ${FFMPEG_THREADS} (container reports ${os.cpus().length} CPU(s))`);

const UPGRADED_TTS_MODEL = process.env.TTS_UPGRADED_MODEL || 'gemini-3.1-flash-tts-preview';
const UPGRADED_VOICE_NAME = process.env.TTS_UPGRADED_VOICE || 'Sadachbia';
const FALLBACK_VOICE_NAME = 'en-US-Chirp3-HD-Sadachbia';
let upgradedVoiceAvailable = null;
let upgradedVoiceFailureReason = null;
let upgradedVoiceShapeUsed = null;

async function synthesizeOneRequest(text, dir, tag, audioConfigOverrides = {}) {
  const words = text.split(/\s+/).filter(Boolean);
  const ssml = `<speak>${words.map((w, idx) => `<mark name="w${idx}"/>${escapeSsml(w)}`).join(' ')}</speak>`;
  const ssmlBytes = Buffer.byteLength(ssml);
  if (ssmlBytes > 5000) {
    console.error(`TTS: SSML for "${tag}" is ${ssmlBytes} bytes, over Google's 5000-byte limit — this request will fail.`);
  }
  const baseAudio = {
    audioEncoding: 'LINEAR16',
    sampleRateHertz: TTS_SAMPLE_RATE,
    speakingRate: 1.45 * TTS_SPEED_MULTIPLIER,
    volumeGainDb: 6.0,
  };
  let response = null;

  if (upgradedVoiceAvailable !== false) {
    const describeErr = (e) => {
      if (!e) return 'no error object returned';
      const parts = [];
      if (e.code !== undefined) parts.push(`code=${e.code}`);
      if (e.status !== undefined && e.status !== e.code) parts.push(`status=${e.status}`);
      if (e.message) parts.push(e.message);
      if (e.details) parts.push(`details=${typeof e.details === 'string' ? e.details : JSON.stringify(e.details)}`);
      if (!parts.length) {
        try { parts.push(JSON.stringify(e)); } catch { }
      }
      if (!parts.length) parts.push(String(e));
      return parts.join(' | ');
    };

    const audio = { ...baseAudio, ...audioConfigOverrides };
    const plainText = text;
    const shapes = [
      { label: 'voice.modelName + text', req: { input: { text: plainText }, voice: { languageCode: 'en-US', name: UPGRADED_VOICE_NAME, modelName: UPGRADED_TTS_MODEL }, audioConfig: audio } },
      { label: 'top-level model + text', req: { input: { text: plainText }, model: UPGRADED_TTS_MODEL, voice: { languageCode: 'en-US', name: UPGRADED_VOICE_NAME }, audioConfig: audio } },
    ];

    const restAttempt = async () => {
      const tokenRes = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } },
      );
      if (!tokenRes.ok) throw new Error(`metadata token fetch failed: http ${tokenRes.status}`);
      const { access_token: accessToken } = await tokenRes.json();
      const body = {
        input: { text: plainText },
        voice: { languageCode: 'en-US', name: UPGRADED_VOICE_NAME, modelName: UPGRADED_TTS_MODEL },
        audioConfig: audio,
      };
      const r = await fetch('https://texttospeech.googleapis.com/v1beta1/text:synthesize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(`http ${r.status}: ${JSON.stringify(json.error || json).slice(0, 400)}`);
      if (!json.audioContent) throw new Error(`no audioContent in response: ${JSON.stringify(json).slice(0, 300)}`);
      return {
        audioContent: Buffer.from(json.audioContent, 'base64'),
        timepoints: [],
        _estimatedTimings: true,
      };
    };

    const attemptErrors = [];
    for (const shape of shapes) {
      try {
        [response] = await ttsClient.synthesizeSpeech(shape.req);
        if (response) response._estimatedTimings = true;
        if (upgradedVoiceAvailable === null) {
          upgradedVoiceAvailable = true;
          upgradedVoiceShapeUsed = shape.label;
          console.log(`TTS: upgraded voice ACTIVE — model="${UPGRADED_TTS_MODEL}" voice="${UPGRADED_VOICE_NAME}" via "${shape.label}" (pitch control enabled)`);
        }
        break;
      } catch (err) {
        attemptErrors.push(`[${shape.label}] ${describeErr(err)}`);
        response = null;
      }
    }

    if (!response) {
      try {
        response = await restAttempt();
        if (upgradedVoiceAvailable === null) {
          upgradedVoiceAvailable = true;
          upgradedVoiceShapeUsed = 'REST v1beta1 (SDK bypassed)';
          console.log(`TTS: upgraded voice ACTIVE via REST — model="${UPGRADED_TTS_MODEL}" voice="${UPGRADED_VOICE_NAME}" (pitch control enabled)`);
        }
      } catch (err) {
        attemptErrors.push(`[REST v1beta1] ${describeErr(err)}`);
        response = null;
      }
    }

    if (!response && upgradedVoiceAvailable === null) {
      upgradedVoiceFailureReason = attemptErrors.join('  ||  ') || 'all request shapes failed with no error detail';
      console.error(`TTS: upgraded voice UNAVAILABLE — falling back to ${FALLBACK_VOICE_NAME} for the rest of this process.`);
      console.error(`  model attempted: ${UPGRADED_TTS_MODEL}   voice: ${UPGRADED_VOICE_NAME}`);
      attemptErrors.forEach((e) => console.error(`  ${e}`));
      console.error('  FIX: enable the model on this project, or set TTS_UPGRADED_MODEL /');
      console.error('  TTS_UPGRADED_VOICE in env.yaml to values you do have access to.');
    }
    if (!response) upgradedVoiceAvailable = false;
  }

  if (!response) {
    const { pitch, ...fallbackOverrides } = audioConfigOverrides;
    [response] = await ttsClient.synthesizeSpeech({
      input: { ssml },
      voice: { languageCode: 'en-US', name: FALLBACK_VOICE_NAME },
      audioConfig: { ...baseAudio, ...fallbackOverrides },
      enableTimePointing: ['SSML_MARK'],
    });
  }
  const audioPath = path.join(dir, `line_${tag}.wav`);
  await fs.writeFile(audioPath, response.audioContent, 'binary');
  const duration = await ffprobeDuration(audioPath);
  const marks = (response.timepoints || []).sort((a, b) => Number(a.markName.slice(1)) - Number(b.markName.slice(1)));
  const noMarks = marks.length === 0 || response._estimatedTimings === true;

  if (noMarks && words.length && Number.isFinite(duration) && duration > 0) {
    try {
      const { pitch, ...refOverrides } = audioConfigOverrides;
      const [refResponse] = await ttsClient.synthesizeSpeech({
        input: { ssml },
        voice: { languageCode: 'en-US', name: FALLBACK_VOICE_NAME },
        audioConfig: { ...baseAudio, ...refOverrides },
        enableTimePointing: ['SSML_MARK'],
      });
      const refPath = path.join(dir, `timingref_${tag}.wav`);
      await fs.writeFile(refPath, refResponse.audioContent, 'binary');
      const refDuration = await ffprobeDuration(refPath);
      await fs.rm(refPath, { force: true }).catch(() => {});

      const refMarks = (refResponse.timepoints || [])
        .sort((a, b) => Number(a.markName.slice(1)) - Number(b.markName.slice(1)));

      if (refMarks.length && Number.isFinite(refDuration) && refDuration > 0) {
        const scale = duration / refDuration;
        const scaled = words.map((w, idx) => {
          const rawStart = refMarks[idx]?.timeSeconds ?? (idx * refDuration) / words.length;
          const rawEnd = refMarks[idx + 1]?.timeSeconds ?? refDuration;
          const start = rawStart * scale;
          const end = Math.max(start, rawEnd * scale);
          return { word: w.toUpperCase(), start, end };
        });
        if (scaled.every((x) => Number.isFinite(x.start) && Number.isFinite(x.end))) {
          console.log(`TTS: "${tag}" used REFERENCE-VOICE timings (${refMarks.length} marks from ${FALLBACK_VOICE_NAME}, scaled ${refDuration.toFixed(2)}s -> ${duration.toFixed(2)}s, x${scale.toFixed(3)})`);
          return { audioPath, words: scaled, duration, referenceTimings: true };
        }
      }
      console.warn(`TTS: "${tag}" reference-voice pass produced no usable marks — falling back to proportional estimate.`);
    } catch (err) {
      console.warn(`TTS: "${tag}" reference-voice timing pass failed (${err && (err.message || err)}) — falling back to proportional estimate.`);
    }
  }

  if (noMarks && words.length && Number.isFinite(duration) && duration > 0) {
    const weights = words.map((w) => Math.max(1, w.length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = 0;
    const proportional = words.map((w, idx) => {
      const share = (weights[idx] / totalWeight) * duration;
      const start = cursor;
      cursor += share;
      return { word: w.toUpperCase(), start, end: cursor };
    });
    console.log(`TTS: "${tag}" used ESTIMATED word timings (plain-text voice, no SSML marks) across ${duration.toFixed(2)}s`);
    return { audioPath, words: proportional, duration, estimatedTimings: true };
  }

  const timedWords = words.map((w, idx) => {
    const safeDuration = Number.isFinite(duration) ? duration : 0;
    const evenSplit = words.length > 0 ? safeDuration / words.length : 0;
    const rawStart = marks[idx]?.timeSeconds ?? idx * evenSplit;
    const rawEnd = marks[idx + 1]?.timeSeconds ?? (idx + 1) * evenSplit;
    const start = Number.isFinite(rawStart) ? rawStart : 0;
    const end = Number.isFinite(rawEnd) ? rawEnd : start;
    return { word: w.toUpperCase(), start, end };
  });
  return { audioPath, words: timedWords, duration };
}

async function synthesizeLine(text, dir, tag, audioConfigOverrides = {}) {
  const allWords = text.split(/\s+/).filter(Boolean);
  if (allWords.length <= MAX_SSML_WORDS) {
    return synthesizeOneRequest(text, dir, tag, audioConfigOverrides);
  }

  const batches = [];
  for (let i = 0; i < allWords.length; i += MAX_SSML_WORDS) {
    batches.push(allWords.slice(i, i + MAX_SSML_WORDS));
  }
  console.log(`TTS: "${tag}" is ${allWords.length} words — split into ${batches.length} batches to stay under Google's 5000-byte SSML limit.`);

  const results = [];
  for (let bi = 0; bi < batches.length; bi++) {
    results.push(await synthesizeOneRequest(batches[bi].join(' '), dir, `${tag}_b${bi}`, audioConfigOverrides));
  }

  const inputs = [];
  results.forEach((r) => inputs.push('-i', r.audioPath));
  const concatRefs = results.map((_, idx) => `[${idx}:a]`).join('');
  const combinedPath = path.join(dir, `line_${tag}.wav`);
  await run('ffmpeg', [...inputs, '-filter_complex', `${concatRefs}concat=n=${results.length}:v=0:a=1[aout]`, '-map', '[aout]', '-y', combinedPath]);
  const duration = await ffprobeDuration(combinedPath);

  let offset = 0;
  const words = [];
  results.forEach((r) => {
    r.words.forEach((w) => words.push({ word: w.word, start: offset + w.start, end: offset + w.end }));
    offset += r.duration;
  });

  return { audioPath: combinedPath, words, duration };
}

const HOOK_AUDIO_CONFIG = { volumeGainDb: 14, speakingRate: 1.65 * TTS_SPEED_MULTIPLIER };
async function synthesizeHookPieces(pieces, dir) {
  if (pieces.length === 1) return synthesizeLine(pieces[0], dir, 'hook', HOOK_AUDIO_CONFIG);
  const CHUNK_PAUSE_SECONDS = 0.15;
  const pieceResults = [];
  for (let i = 0; i < pieces.length; i++) pieceResults.push(await synthesizeLine(pieces[i], dir, `hook_p${i}`, HOOK_AUDIO_CONFIG));
  const inputs = [];
  pieceResults.forEach((p) => inputs.push('-i', p.audioPath));
  const filterParts = [];
  const concatRefs = [];
  pieceResults.forEach((_, idx) => {
    concatRefs.push(`[${idx}:a]`);
    if (idx < pieceResults.length - 1) { filterParts.push(`aevalsrc=0:d=${CHUNK_PAUSE_SECONDS}:s=48000[hsil${idx}]`); concatRefs.push(`[hsil${idx}]`); }
  });
  filterParts.push(`${concatRefs.join('')}concat=n=${concatRefs.length}:v=0:a=1[aout]`);
  const combinedPath = path.join(dir, 'hook_combined.wav');
  await run('ffmpeg', [...inputs, '-filter_complex', filterParts.join(';'), '-map', '[aout]', '-y', combinedPath]);
  const duration = await ffprobeDuration(combinedPath);
  let offset = 0;
  const words = [];
  pieceResults.forEach((p, idx) => {
    p.words.forEach((w) => words.push({ word: w.word, start: offset + w.start, end: offset + w.end }));
    offset += p.duration;
    if (idx < pieceResults.length - 1) offset += CHUNK_PAUSE_SECONDS;
  });
  return { audioPath: combinedPath, words, duration };
}

function splitIntoPhrases(text) {
  return text.split(/(?<=[.,!?;:])\s+/).filter((p) => p.trim());
}

async function synthesizeChunkWithPhraseEmotions(combinedText, availableEmotions, dir, tag, debugTrail) {
  const phrases = splitIntoPhrases(combinedText);
  if (phrases.length <= 1 || !availableEmotions.length) {
    const result = await synthesizeLine(combinedText, dir, tag);
    return { ...result, phraseSegments: [{ emotion: null, start: 0, end: result.duration }] };
  }

  const phraseEmotions = await aiDetectEmotions(phrases, availableEmotions, debugTrail);
  const resolvedPhraseEmotions = phrases.map((p, idx) => {
    const e = phraseEmotions ? phraseEmotions[idx] : null;
    if (e) return e;
    const kw = keywordEmotion(p);
    return kw && availableEmotions.includes(kw) ? kw : null;
  });
  let lastGood = availableEmotions[0];
  for (let idx = 0; idx < resolvedPhraseEmotions.length; idx++) {
    if (!resolvedPhraseEmotions[idx]) resolvedPhraseEmotions[idx] = lastGood;
    lastGood = resolvedPhraseEmotions[idx];
  }

  const groups = [];
  phrases.forEach((phraseText, idx) => {
    const emotion = resolvedPhraseEmotions[idx];
    const prevGroup = groups[groups.length - 1];
    if (prevGroup && prevGroup.emotion === emotion) {
      prevGroup.text += ' ' + phraseText;
    } else {
      groups.push({ text: phraseText, emotion });
    }
  });

  if (debugTrail && groups.length > 1) {
    debugTrail.push(`chunk ${tag}: split into ${groups.length} phrase-emotion group(s): [${groups.map((g) => g.emotion).join(', ')}]`);
  }

  const groupResults = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const override = EMOTION_VOICE_CONFIG[groups[gi].emotion] || {};
    console.log(`post chunk ${tag} phrase-group ${gi}: synthesizing "${groups[gi].text}" (emotion=${groups[gi].emotion}, speakingRate=${override.speakingRate ?? 'default'})`);
    groupResults.push(await synthesizeLine(groups[gi].text, dir, `${tag}_pg${gi}`, override));
  }

  if (groupResults.length === 1) {
    return { ...groupResults[0], phraseSegments: [{ emotion: groups[0].emotion, start: 0, end: groupResults[0].duration }] };
  }

  const inputs = [];
  groupResults.forEach((g) => inputs.push('-i', g.audioPath));
  const concatRefs = groupResults.map((_, idx) => `[${idx}:a]`).join('');
  const filterComplex = `${concatRefs}concat=n=${groupResults.length}:v=0:a=1[aout]`;
  const combinedPath = path.join(dir, `chunk_${tag}_phrases.wav`);
  await run('ffmpeg', [...inputs, '-filter_complex', filterComplex, '-map', '[aout]', '-y', combinedPath]);
  const duration = await ffprobeDuration(combinedPath);

  let offset = 0;
  const words = [];
  const phraseSegments = [];
  groupResults.forEach((g, idx) => {
    g.words.forEach((w) => words.push({ word: w.word, start: offset + w.start, end: offset + w.end }));
    phraseSegments.push({ emotion: groups[idx].emotion, start: offset, end: offset + g.duration });
    offset += g.duration;
  });

  return { audioPath: combinedPath, words, duration, phraseSegments };
}

const EMOTION_VOICE_CONFIG = {
  excited:     { speakingRate: 1.55 * TTS_SPEED_MULTIPLIER, pitch: 3.5 },
  shocked:     { speakingRate: 1.55 * TTS_SPEED_MULTIPLIER, pitch: 4.5 },
  happy:       { speakingRate: 1.48 * TTS_SPEED_MULTIPLIER, pitch: 2.0 },
  mad:         { speakingRate: 1.50 * TTS_SPEED_MULTIPLIER, pitch: -1.5 },
  sad:         { speakingRate: 1.25 * TTS_SPEED_MULTIPLIER, pitch: -3.5 },
  confused:    { speakingRate: 1.35 * TTS_SPEED_MULTIPLIER, pitch: 1.0 },
  grossed_out: { speakingRate: 1.40 * TTS_SPEED_MULTIPLIER, pitch: -2.0 },
  afraid:      { speakingRate: 1.50 * TTS_SPEED_MULTIPLIER, pitch: 2.5 },
  goofy_mood:        { speakingRate: 1.52 * TTS_SPEED_MULTIPLIER, pitch: 3.0 },
  building_suspense: { speakingRate: 1.20 * TTS_SPEED_MULTIPLIER, pitch: -2.5 },
};

async function buildPostAudio(textLines, imgHeight, dir, i, availableEmotions, debugTrail) {
  const lineTexts = textLines.map((tl) => tl.text);
  const resolvedEmotions = await resolveLineEmotions(lineTexts, availableEmotions || [], debugTrail);

  const SENTENCE_END = /[.!?]["')\]]*$/;
  const LARGE_GAP_MULTIPLIER = 1.45;
  const chunks = [];
  const chunkBoundaryAfter = new Array(textLines.length).fill(false);
  let current = [];
  for (let j = 0; j < textLines.length; j++) {
    current.push(j);
    const isLast = j === textLines.length - 1;
    const sentenceEnds = SENTENCE_END.test(textLines[j].text.trim());
    let newCommentGap = false;
    let largeVisualGap = false;
    if (!isLast) {
      const cur = textLines[j];
      const next = textLines[j + 1];
      if (typeof cur.origIndex === 'number' && typeof next.origIndex === 'number' && next.origIndex - cur.origIndex > 1) newCommentGap = true;
      if (cur.bottom != null && cur.top != null && next.top != null) {
        const lineHeight = cur.bottom - cur.top;
        const gap = next.top - cur.bottom;
        if (lineHeight > 0 && gap > lineHeight * LARGE_GAP_MULTIPLIER) largeVisualGap = true;
      }
    }
    if (isLast || sentenceEnds || newCommentGap || largeVisualGap) {
      chunks.push(current);
      if (!isLast && (newCommentGap || largeVisualGap)) chunkBoundaryAfter[j] = true;
      current = [];
    }
  }

  let runningMax = 0;
  const fracs = textLines.map((tl, idx) => {
    const raw = imgHeight && tl.bottom != null ? tl.bottom / imgHeight : (idx + 1) / textLines.length;
    runningMax = Math.max(runningMax, Math.min(1, raw));
    return runningMax;
  });
  if (fracs.length) fracs[fracs.length - 1] = 1;

  let offset = 0;
  const lines = new Array(textLines.length);
  const allPhraseSegments = [];
  const chunkAudioPaths = [];
  const CHUNK_PAUSE_SECONDS = 0.15;
  const LARGE_GAP_PAUSE_SECONDS = 0.4;
  const chunkPauseDurations = chunks.map((chunkLineIndices) => {
    const lastLineOfChunk = chunkLineIndices[chunkLineIndices.length - 1];
    return chunkBoundaryAfter[lastLineOfChunk] ? LARGE_GAP_PAUSE_SECONDS : CHUNK_PAUSE_SECONDS;
  });
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunkLineIndices = chunks[chunkIdx];
    const combinedText = chunkLineIndices.map((idx) => textLines[idx].text).join(' ');
    console.log(`post ${i} chunk ${chunkIdx}: synthesizing "${combinedText}"`);
    const leakChecks = [
      [/@/, 'contains an @ symbol'],
      [/\b\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\b/i, 'contains a relative timestamp'],
      [/\b\d{1,2}:\d{2}\s*(am|pm)\b/i, 'contains a clock time'],
      [/\btwitter (for|web app)\b/i, 'contains an app signature'],
      [/\breplying to\b/i, 'contains a reply-context label'],
      [/\b\d[\d.,]*\s*(likes?|retweets?|views?|comments?|shares?)\b/i, 'contains an engagement count'],
    ];
    for (const [re, label] of leakChecks) {
      if (re.test(combinedText)) {
        console.error(`CHROME LEAK REACHED TTS (post ${i} chunk ${chunkIdx}): ${label}`);
        console.error(`  text: ${JSON.stringify(combinedText)}`);
        debugTrail.push(`LEAK: chunk sent to TTS ${label} — "${combinedText.slice(0, 120)}"`);
      }
    }
    if (combinedText.includes('@')) debugTrail.push(`WARNING: chunk sent to TTS still contains @ — "${combinedText}"`);
    const chunk = await synthesizeChunkWithPhraseEmotions(combinedText, availableEmotions || [], dir, `${i}_c${chunkLineIndices[0]}`, debugTrail);
    chunkAudioPaths.push(chunk.audioPath);
    (chunk.phraseSegments || []).forEach((seg) => {
      allPhraseSegments.push({ emotion: seg.emotion, start: offset + seg.start, end: offset + seg.end });
    });
    let wordCursor = 0;
    for (const lineIdx of chunkLineIndices) {
      const lineWordCount = textLines[lineIdx].text.split(/\s+/).filter(Boolean).length;
      const lineWords = chunk.words.slice(wordCursor, wordCursor + lineWordCount);
      wordCursor += lineWordCount;
      const lineStart = lineWords.length ? lineWords[0].start : 0;
      const lineEnd = lineWords.length ? lineWords[lineWords.length - 1].end : 0;
      lines[lineIdx] = {
        emotion: resolvedEmotions[lineIdx], start: offset + lineStart, end: offset + lineEnd,
        revealFrac: fracs[lineIdx], chunkBoundaryAfter: chunkBoundaryAfter[lineIdx],
        words: lineWords.map((w) => ({ word: w.word, start: offset + w.start, end: offset + w.end })),
      };
    }
    offset += chunk.duration;
    if (chunkIdx < chunks.length - 1) offset += chunkPauseDurations[chunkIdx];
  }

  const audioPath = path.join(dir, `post_audio_${i}.wav`);
  const rawAudioPath = path.join(dir, `post_audio_raw_${i}.wav`);
  if (chunkAudioPaths.length === 1) {
    await fs.copyFile(chunkAudioPaths[0], rawAudioPath);
  } else {
    const inputs = [];
    chunkAudioPaths.forEach((p) => inputs.push('-i', p));
    const filterParts = [];
    const concatRefs = [];
    chunkAudioPaths.forEach((_, idx) => {
      concatRefs.push(`[${idx}:a]`);
      if (idx < chunkAudioPaths.length - 1) { filterParts.push(`aevalsrc=0:d=${chunkPauseDurations[idx]}:s=48000[sil${idx}]`); concatRefs.push(`[sil${idx}]`); }
    });
    filterParts.push(`${concatRefs.join('')}concat=n=${concatRefs.length}:v=0:a=1[aout]`);
    await run('ffmpeg', [...inputs, '-filter_complex', filterParts.join(';'), '-map', '[aout]', '-y', rawAudioPath]);
  }

  const AUDIO_PAD_SECONDS = 0.6;
  await run('ffmpeg', ['-i', rawAudioPath, '-af', `apad=pad_dur=${AUDIO_PAD_SECONDS}`, '-y', audioPath]);
  const realDuration = await ffprobeDuration(audioPath);
  return { audioPath, duration: realDuration, lines, phraseSegments: allPhraseSegments };
}

async function ffprobeDuration(filePath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  return parseFloat(stdout.trim());
}

async function ffprobeStreamDurations(filePath) {
  const getStreamDuration = async (streamSelector) => {
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', streamSelector, '-show_entries', 'stream=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
      const val = parseFloat(stdout.trim());
      return Number.isFinite(val) ? val : null;
    } catch (err) { return null; }
  };
  const [videoDuration, audioDuration] = await Promise.all([getStreamDuration('v:0'), getStreamDuration('a:0')]);
  return { videoDuration, audioDuration };
}

async function detectBlackFrames(videoPath) {
  try {
    const { stderr } = await run('ffmpeg', ['-i', videoPath, '-vf', 'blackdetect=d=0.05:pic_th=0.98', '-an', '-f', 'null', '-']);
    const segments = [];
    const regex = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
    let match;
    while ((match = regex.exec(stderr)) !== null) segments.push({ start: parseFloat(match[1]), end: parseFloat(match[2]), duration: parseFloat(match[3]) });
    return segments;
  } catch (err) { return []; }
}

async function ffprobeVideoSpecs(filePath) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,bit_rate', '-of', 'default=noprint_wrappers=1', filePath]);
    return stdout.trim().replace(/\n/g, ', ');
  } catch (err) { return `ffprobe failed to read specs: ${err.message}`; }
}

async function ffprobeSampleRate(filePath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  return parseInt(stdout.trim(), 10) || 44100;
}

async function randomFile(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (!files.length) throw new Error(`No files in ${dirPath}`);
  return path.join(dirPath, files[Math.floor(Math.random() * files.length)]);
}

async function randomStart(videoPath, neededDuration) {
  const total = await ffprobeDuration(videoPath);
  return total <= neededDuration ? 0 : Math.random() * (total - neededDuration);
}

function buildEmotionSegments(lines) {
  const segments = [];
  for (const line of lines) {
    const prev = segments[segments.length - 1];
    if (prev && prev.emotion === line.emotion) prev.end = line.end;
    else segments.push({ emotion: line.emotion, start: line.start, end: line.end });
  }
  return segments;
}

const EMOTION_TINTS = {
  sad: '0x1E50FF',
  afraid: '0x4B0082',
  grossed_out: '0x2EB82E',
  mad: '0xFF1A1A',
  excited: '0xFFD700',
  confused: '0x808080',
  shocked: '0xFF69B4',
  goofy_mood: '0xFF8C00',
  building_suspense: '0x3B0A5C',
};
function addEmotionTint(f, last, emotionSegs) {
  const TINT_ALPHA = 0.26, TINT_FADE = 0.25;
  const runs = [];
  for (const sg of emotionSegs || []) {
    const color = EMOTION_TINTS[sg.emotion];
    if (!color || !(sg.end > sg.start)) continue;
    const prev = runs[runs.length - 1];
    if (prev && prev.color === color && Math.abs(prev.end - sg.start) < 0.05) prev.end = sg.end;
    else runs.push({ color, start: sg.start, end: sg.end });
  }
  runs.forEach((r, k) => {
    const len = Math.max(TINT_FADE * 2, r.end - r.start) + TINT_FADE;
    f.push(`color=c=${r.color}@${TINT_ALPHA}:s=${WIDTH}x${HEIGHT}:d=${len.toFixed(3)}:r=30,format=rgba,fade=t=in:st=0:d=${TINT_FADE}:alpha=1,fade=t=out:st=${(len - TINT_FADE).toFixed(3)}:d=${TINT_FADE}:alpha=1,setpts=PTS+${r.start.toFixed(3)}/TB[tint${k}]`);
    f.push(`[${last}][tint${k}]overlay=0:0:eof_action=pass[tinted${k}]`);
    last = `tinted${k}`;
  });
  return last;
}

function addProgressBar(f, last, { x, y, w, duration, offset, total }) {
  const H = 4;
  const frac = `min(1\\,max(0\\,(${offset.toFixed(3)}+T)/${total.toFixed(3)}))`;
  const filled = `lt(X\\,W*${frac})`;
  f.push(`color=c=black:s=${w}x${H}:d=${duration.toFixed(3)}:r=30,format=rgba,geq=r='if(${filled}\\,255*min(1\\,2*(1-${frac}))\\,0)':g='if(${filled}\\,255*min(1\\,2*${frac})\\,0)':b='0':a='255'[pbar]`);
  f.push(`[${last}][pbar]overlay=${Math.round(x)}:${Math.round(y) - H}[withbar]`);
  return 'withbar';
}

function addCaptionShake(f, last, words, isRed) {
  const DUR = 1.0, ZOOM = 1.08, AMP = 24;
  const wins = [];
  words.forEach((w, i) => {
    if (!isRed(w) || (i > 0 && isRed(words[i - 1]))) return;
    const prevWin = wins[wins.length - 1];
    if (prevWin && w.start < prevWin.end) prevWin.end = Math.max(prevWin.end, w.start + DUR);
    else wins.push({ start: w.start, end: w.start + DUR });
  });
  if (!wins.length) return last;
  const inWin = (s, e) => `between(t\\,${s.toFixed(3)}\\,${e.toFixed(3)})`;
  const strength = wins.map((w) => `${inWin(w.start, w.end)}*(1-(t-${w.start.toFixed(3)})/${(w.end - w.start).toFixed(3)})`).join('+');
  const even = (v) => { const n = Math.round(v); return n % 2 ? n + 1 : n; };
  f.push(`[${last}]split[shA][shB]`);
  f.push(`[shB]scale=${even(WIDTH * ZOOM)}:${even(HEIGHT * ZOOM)},crop=${WIDTH}:${HEIGHT}:x='(iw-ow)/2+${AMP}*(${strength})*sin(2*PI*13*t)':y='(ih-oh)/2+${AMP}*(${strength})*cos(2*PI*17*t)'[shk]`);
  f.push(`[shA][shk]overlay=0:0:enable='${wins.map((w) => inWin(w.start, w.end)).join('+')}'[shaken]`);
  return 'shaken';
}

async function renderClip({ bgVideo, bgStart, duration, imgPath, spritePaths, audioPath, lines, phraseSegments, outPath, mode, isPostEnd = true, isContinuation = false, barOffset = 0, barTotal = null, hidePost = false }) {
  const emotionSourceForSprites = phraseSegments && phraseSegments.length ? phraseSegments : lines;
  const spriteReadySegments = buildEmotionSegments(emotionSourceForSprites).map((s) => {
    if (s.emotion && spritePaths[s.emotion]) return s;
    if (spritePaths.happy) return { ...s, emotion: 'happy' };
    return s;
  });
  const segments = spriteReadySegments.filter((s) => {
    if (!s.emotion || !spritePaths[s.emotion]) return false;
    const ok = Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start;
    if (!ok) {
      console.error(`renderClip: DISCARDED a bad sprite segment — emotion=${s.emotion} start=${s.start} end=${s.end} (would have produced an invalid ffmpeg duration)`);
    }
    return ok;
  });
  const inputArgs = [];
  let idx = 0;
  const push = (...args) => inputArgs.push(...args);
  push('-ss', String(bgStart), '-t', String(duration * BG_SPEED), '-i', bgVideo); const bgIdx = idx++;
  push('-loop', '1', '-t', String(duration), '-i', imgPath); const imgIdx = idx++;
  push('-i', audioPath); const audioIdx = idx++;

  const segSpriteIdx = [];
  for (const seg of segments) {
    push('-itsoffset', String(seg.start), '-loop', '1', '-t', String(seg.end - seg.start), '-r', '5', '-i', spritePaths[seg.emotion]);
    segSpriteIdx.push(idx++);
  }
  const sfxEntries = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prevEmotion = i === 0 ? null : segments[i - 1].emotion;
    if (seg.emotion === prevEmotion) continue;
    const sfxPath = path.join(ASSETS, 'sfx', `emotion_${seg.emotion}.mp3`);
    try { await fs.access(sfxPath); } catch { console.warn(`renderClip: ${path.basename(sfxPath)} not found — no sound effect for "${seg.emotion}"`); continue; }
    push('-i', sfxPath); sfxEntries.push({ segIndex: i, inputIdx: idx++ });
  }

  const lineEndSfxPath = path.join(ASSETS, 'sfx', 'line_end.mp3');
  let lineEndSfxAvailable = false;
  try {
    await fs.access(lineEndSfxPath);
    lineEndSfxAvailable = true;
  } catch (err) {
    console.warn(`line_end.mp3 not found at ${lineEndSfxPath} — skipping this sound effect for this clip (drop a file there to enable it).`);
  }
  const lineEndSfxEntries = [];
  let lineEndSfxInputIdx = null;
  if (lineEndSfxAvailable) {
    const needed = Math.max(0, lines.length - 1);
    if (needed > 0) {
      push('-i', lineEndSfxPath);
      lineEndSfxInputIdx = idx++;
      lines.forEach((l, i) => {
        if (i === lines.length - 1) return;
        lineEndSfxEntries.push({ lineIndex: i });
      });
      console.log(`renderClip: line_end.mp3 loaded ONCE and split ${needed} ways (previously ${needed} separate inputs)`);
    }
  }

  const f = [];
  const SQUARE_SIZE = WIDTH;
  const SQUARE_TOP = 300;
  const SQUARE_BOTTOM = SQUARE_TOP + SQUARE_SIZE;
  const BLUR_SMALL_W = 90;
  const BLUR_SMALL_SIGMA = 6;
  const STACKED = mode === 'gameplay' || mode === 'parkour';
  if (mode === 'parkour') {
    f.push(`[${bgIdx}:v]setpts=PTS/${BG_SPEED},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1[bg]`);
    console.log('renderClip: parkour mode — full-frame background, no square crop, no blur');
  } else if (mode === 'gameplay') {
    f.push(`[${bgIdx}:v]setpts=PTS/${BG_SPEED},scale=${WIDTH}:${SQUARE_SIZE}:force_original_aspect_ratio=increase,crop=${WIDTH}:${SQUARE_SIZE},setsar=1[sq]`);
    f.push(`[sq]split=3[sqmain][sqtop][sqbot]`);
    f.push(`[sqtop]crop=${WIDTH}:${SQUARE_SIZE / 2}:0:0,scale=${BLUR_SMALL_W}:-2,gblur=sigma=${BLUR_SMALL_SIGMA},scale=${WIDTH}:${SQUARE_TOP}:flags=bilinear[blurtop]`);
    f.push(`[sqbot]crop=${WIDTH}:${SQUARE_SIZE / 2}:0:${SQUARE_SIZE / 2},scale=${BLUR_SMALL_W}:-2,gblur=sigma=${BLUR_SMALL_SIGMA},scale=${WIDTH}:${HEIGHT - SQUARE_BOTTOM}:flags=bilinear[blurbot]`);
    f.push(`color=c=black:s=${WIDTH}x${HEIGHT}:d=${duration}[canvas]`);
    f.push(`[canvas][blurtop]overlay=0:0[bgc1]`);
    f.push(`[bgc1][blurbot]overlay=0:${SQUARE_BOTTOM}[bgc2]`);
    f.push(`[bgc2][sqmain]overlay=0:${SQUARE_TOP}[bg]`);
    console.log(`renderClip: gameplay square ${SQUARE_SIZE}x${SQUARE_SIZE} at y=${SQUARE_TOP}..${SQUARE_BOTTOM}, blurred halves computed at ${BLUR_SMALL_W}px wide then upscaled`);
  } else {
    f.push(`[${bgIdx}:v]setpts=PTS/${BG_SPEED},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}[bg]`);
  }
  const postTopMargin = STACKED ? 16 : 140;
  let postMaxHeight = null;
  if (STACKED) postMaxHeight = SQUARE_TOP - postTopMargin - 10;

  const targetW = WIDTH;
  const postX = 0;
  const VIEWPORT_FRACTION = 1 / 6;
  const GLIDE_DURATION = 0.28;
  const GLIDE_STEPS = 1;

  const SPRITE_MAX_W = STACKED ? 110 : 170;
  const SPRITE_CLEARANCE = 12;
  const spriteTopY = STACKED
    ? 1150
    : HEIGHT - 200;
  const postAvailableH = STACKED
    ? Math.max(120, SQUARE_TOP - postTopMargin - 10)
    : Math.max(200, spriteTopY - postTopMargin - SPRITE_CLEARANCE);
  console.log(`renderClip: post width ${targetW}px, available height ${postAvailableH}px; sprite ${SPRITE_MAX_W}px at y=${spriteTopY}`);

  const scaledCropCount = lines.reduce((n, l, i) => {
    if (i === lines.length - 1) return isPostEnd ? n : n + 1;
    if (i === 0) {
      return isContinuation ? n + 1 : n;
    }
    return n + GLIDE_STEPS;
  }, 0);
  if (!hidePost && scaledCropCount > 0) {
    f.push(`[${imgIdx}:v]scale=w=${targetW}:h=-1[postscaled]`);
    if (scaledCropCount === 1) f.push(`[postscaled]null[psrc0]`);
    else f.push(`[postscaled]split=${scaledCropCount}${Array.from({ length: scaledCropCount }, (_, k) => `[psrc${k}]`).join('')}`);
    console.log(`renderClip: post image scaled ONCE and split ${scaledCropCount} ways (previously ${scaledCropCount} separate scale filters)`);
  }
  let scaledCropCursor = 0;

  let last = 'bg';
  lines.forEach((l, i) => {
    if (hidePost) return;
    const isLastLine = i === lines.length - 1;
    const prevFrac = i === 0 ? 0 : lines[i - 1].revealFrac;
    const targetFrac = l.revealFrac;
    const buildScaledCrop = (label, frac) => {
      const src = `psrc${scaledCropCursor++}`;
      const h = `min(ih*${frac.toFixed(4)}\\,${postAvailableH})`;
      const y = `max(0\\,ih*${frac.toFixed(4)}-${h})`;
      f.push(`[${src}]crop=w=iw:h='${h}':x=0:y='${y}',format=rgba,colorchannelmixer=aa=0.7[${label}]`);
    };
    if (isLastLine && isPostEnd) {
      const fitLabel = `lastfit${i}`;
      f.push(`[${imgIdx}:v]scale=w=${targetW}:h=${postAvailableH}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.7[${fitLabel}]`);
      f.push(`[${last}][${fitLabel}]overlay=(W-w)/2:${postTopMargin}:enable='gte(t,${l.start})'[withpost${i}]`);
      last = `withpost${i}`;
      return;
    }
    if (i === 0 && !isContinuation) {
      const FIRST_LINE_TOP_MARGIN = STACKED ? postTopMargin : 67;
      const firstLineAvailableH = STACKED
        ? Math.max(120, SQUARE_TOP - FIRST_LINE_TOP_MARGIN - 10)
        : Math.max(200, spriteTopY - FIRST_LINE_TOP_MARGIN - SPRITE_CLEARANCE);
      const scaledLabel = 'firstlines';
      f.push(`[${imgIdx}:v]scale=w=${targetW}:h=-1[${scaledLabel}]`);
      f.push(`[${scaledLabel}]crop=w=iw:h='min(ih\\,${firstLineAvailableH})':x=0:y=0[firstlinecrop]`);
      f.push(`[firstlinecrop]drawbox=x=0:y='ih*(${targetFrac.toFixed(4)})':w=iw:h='ih*(1-(${targetFrac.toFixed(4)}))':color=0x333333@1.0:t=fill,format=rgba,colorchannelmixer=aa=0.7[firstlinebox]`);
      f.push(`[${last}][firstlinebox]overlay=${postX}:${FIRST_LINE_TOP_MARGIN}:enable='between(t,${l.start},${l.end})'[withpost${i}]`);
      last = `withpost${i}`;
      return;
    }
    if (i === 0 && isContinuation) {
      const cropLabel = `contstart${i}`;
      buildScaledCrop(cropLabel, targetFrac);
      f.push(`[${last}][${cropLabel}]overlay=${postX}:${postTopMargin}:enable='between(t,${l.start},${l.end})'[withpost${i}]`);
      last = `withpost${i}`;
      return;
    }
    const stepDur = GLIDE_DURATION / GLIDE_STEPS;
    let stepLast = last;
    for (let k = 0; k < GLIDE_STEPS; k++) {
      const stepFrac = prevFrac + (targetFrac - prevFrac) * (k + 1) / GLIDE_STEPS;
      const stepStartAbs = l.start + k * stepDur;
      const stepEndAbs = k === GLIDE_STEPS - 1 ? l.end : l.start + (k + 1) * stepDur;
      const cropLabel = `scrollcrop${i}_${k}`;
      buildScaledCrop(cropLabel, stepFrac);
      const withLabel = `withpost${i}_${k}`;
      f.push(`[${stepLast}][${cropLabel}]overlay=${postX}:${postTopMargin}:enable='between(t,${stepStartAbs.toFixed(3)},${stepEndAbs.toFixed(3)})'[${withLabel}]`);
      stepLast = withLabel;
    }
    last = stepLast;
  });

  const SPRITE_FADE = 0.15;
  const GROW_DURATION = 0.12;
  const GROW_START_FRAC = 0.2;
  const GROW_STEPS = 2;
  segments.forEach((seg, i) => {
    const segDur = seg.end - seg.start;
    const fd = Math.max(0.03, Math.min(SPRITE_FADE, segDur / 3));
    const isLast = i === segments.length - 1;
    const growStepDur = GROW_DURATION / GROW_STEPS;
    let stepLast = last;
    for (let k = 0; k < GROW_STEPS; k++) {
      const stepFrac = GROW_START_FRAC + (1 - GROW_START_FRAC) * (k + 1) / GROW_STEPS;
      const stepW = Math.round(SPRITE_MAX_W * stepFrac);
      const stepStartAbs = seg.start + k * growStepDur;
      const stepEndAbs = k === GROW_STEPS - 1 ? seg.end : seg.start + (k + 1) * growStepDur;
      let chain = `[${segSpriteIdx[i]}:v]scale=w=${stepW}:h=-1`;
      if (k === 0) chain += `,fade=t=in:st=${seg.start.toFixed(3)}:d=${fd.toFixed(3)}:alpha=1`;
      if (!isLast && k === GROW_STEPS - 1) { const fadeOutStart = Math.max(seg.start, seg.end - fd); chain += `,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fd.toFixed(3)}:alpha=1`; }
      if (STACKED) chain += `,format=rgba,colorchannelmixer=aa=0.8`;
      const sprLabel = `spr${i}_${k}`;
      chain += `[${sprLabel}]`;
      f.push(chain);
      const spritePos = STACKED ? `(W-w)/2:${spriteTopY}` : 'W-180:H-200';
      const withLabel = `withspr${i}_${k}`;
      f.push(`[${stepLast}][${sprLabel}]overlay=${spritePos}:enable='between(t,${stepStartAbs.toFixed(3)},${stepEndAbs.toFixed(3)})'[${withLabel}]`);
      stepLast = withLabel;
    }
    last = stepLast;
  });

  last = addEmotionTint(f, last, buildEmotionSegments(emotionSourceForSprites));
  last = addProgressBar(f, last, {
    x: STACKED ? (WIDTH - SPRITE_MAX_W) / 2 : WIDTH - 180,
    y: spriteTopY,
    w: SPRITE_MAX_W,
    duration,
    offset: barOffset,
    total: barTotal || duration,
  });

  const allWords = lines.flatMap((l) => l.words.map((w) => ({ ...w, emotion: l.emotion })));
  const EMPHASIS_EMOTIONS = new Set(['shocked', 'excited']);

  const CAPTION_NORMAL_SIZE = 44;
  const CAPTION_EMPHASIS_SIZE = 54;
  const CAPTION_ACTIVE_SCALE = 1.15;
  const CAPTION_PAUSE_GAP = 0.28;
  const CAPTION_WORD_SPACING = 24;
  const CAPTION_LINE_HEIGHT = CAPTION_NORMAL_SIZE + 14;
  const CAPTION_MAX_WORDS = 4;
  const CAPTION_MAX_ROWS = 2;
  const CAPTION_MARGIN = 28;
  const CAPTION_MAX_WIDTH = WIDTH - CAPTION_MARGIN * 2;
  const CAPTION_GAP_BELOW_SPRITE = 18;
  const spriteBottomY = spriteTopY + SPRITE_MAX_W;
  const captionTopY = STACKED
    ? SQUARE_BOTTOM + 10
    : Math.min(
        spriteBottomY + CAPTION_GAP_BELOW_SPRITE,
        HEIGHT - CAPTION_LINE_HEIGHT * CAPTION_MAX_ROWS - 24,
      );

  const CHAR_W = 0.72;
  const estW = (word, size) => Math.max(size * CHAR_W, word.length * size * CHAR_W);
  const fitSize = (word, preferred) => {
    let s = preferred;
    while (s > 18 && estW(word, s) > CAPTION_MAX_WIDTH) s -= 2;
    return s;
  };

  const CAPTION_ALLOWED = /[^A-Za-z0-9?!]/g;
  const wordsMeasured = allWords
    .map((w) => {
      const safe = String(w.word).replace(CAPTION_ALLOWED, '');
      return { ...w, safe };
    })
    .filter((w) => w.safe.length > 0)
    .map((w) => {
      const baseSize = fitSize(w.safe, CAPTION_NORMAL_SIZE);
      return { ...w, baseSize, pxWidth: estW(w.safe, baseSize) };
    });

  const screens = [];
  let pending = [];
  const flushPending = () => {
    if (!pending.length) return;
    const rows = [];
    let row = [];
    let cursor = 0;
    pending.forEach((w) => {
      const need = row.length === 0 ? w.pxWidth : CAPTION_WORD_SPACING + w.pxWidth;
      if (row.length && cursor + need > CAPTION_MAX_WIDTH) {
        rows.push(row);
        row = [];
        cursor = 0;
      }
      row.push(w);
      cursor += (row.length > 1 ? CAPTION_WORD_SPACING : 0) + w.pxWidth;
    });
    if (row.length) rows.push(row);
    screens.push({ rows, start: pending[0].start, end: pending[pending.length - 1].end });
    pending = [];
  };

  wordsMeasured.forEach((w, i) => {
    const prev = wordsMeasured[i - 1];
    const pauseBefore = prev ? w.start - prev.end : 0;
    if (pending.length >= CAPTION_MAX_WORDS) flushPending();
    else if (pending.length && pauseBefore >= CAPTION_PAUSE_GAP) flushPending();
    pending.push(w);
  });
  flushPending();

  console.log(`renderClip: captions — ${wordsMeasured.length} words in ${screens.length} screen(s) of at most ${CAPTION_MAX_WORDS} words`);

  let capIdx = 0;
  screens.forEach((sc) => {
    sc.rows.forEach((row, rowIdx) => {
      const rowWidth = row.reduce((n, w) => n + w.pxWidth, 0) + CAPTION_WORD_SPACING * (row.length - 1);
      let cursorX = CAPTION_MARGIN + Math.max(0, (CAPTION_MAX_WIDTH - rowWidth) / 2);
      const rowY = captionTopY + rowIdx * CAPTION_LINE_HEIGHT;

      row.forEach((word) => {
        const isEmphasis = EMPHASIS_EMOTIONS.has(word.emotion);
        const activeColor = isEmphasis ? 'red' : CAPTION_GREEN;
        const activeSize = fitSize(word.safe, Math.round((isEmphasis ? CAPTION_EMPHASIS_SIZE : CAPTION_NORMAL_SIZE) * CAPTION_ACTIVE_SCALE));
        const slotCenterX = Math.round(cursorX + word.pxWidth / 2);
        const activeY = rowY - Math.round((activeSize - word.baseSize) * 0.75);

        f.push(`[${last}]drawtext=text='${word.safe}':fontcolor=${CAPTION_WHITE}:fontsize=${word.baseSize}:fontfile=${FONT}:borderw=10:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.8:x=${slotCenterX}-text_w/2:y=${rowY}:enable='gte(t,${sc.start})*lt(t,${sc.end})*(1-(gte(t,${word.start})*lt(t,${word.end})))'[cap${capIdx}]`);
        last = `cap${capIdx++}`;
        f.push(`[${last}]drawtext=text='${word.safe}':fontcolor=${activeColor}:fontsize=${activeSize}:fontfile=${FONT}:borderw=10:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.8:x=${slotCenterX}-text_w/2:y=${activeY}:enable='gte(t,${word.start})*lt(t,${word.end})'[cap${capIdx}]`);
        last = `cap${capIdx++}`;

        cursorX += word.pxWidth + CAPTION_WORD_SPACING;
      });
    });
  });

  last = addCaptionShake(f, last, allWords, (w) => EMPHASIS_EMOTIONS.has(w.emotion));

  f.push(`[${audioIdx}:a]volume=2.5[dlg]`);
  const emotionSfxLabels = [];
  sfxEntries.forEach(({ segIndex, inputIdx }, i) => {
    const ms = Math.round(segments[segIndex].start * 1000);
    f.push(`[${inputIdx}:a]adelay=${ms}|${ms},volume=0.25[esfx${i}]`);
    emotionSfxLabels.push(`[esfx${i}]`);
  });
  const lineEndSfxLabels = [];
  if (lineEndSfxEntries.length && lineEndSfxInputIdx !== null) {
    if (lineEndSfxEntries.length === 1) {
      f.push(`[${lineEndSfxInputIdx}:a]anull[lsrc0]`);
    } else {
      f.push(`[${lineEndSfxInputIdx}:a]asplit=${lineEndSfxEntries.length}${lineEndSfxEntries.map((_, k) => `[lsrc${k}]`).join('')}`);
    }
    lineEndSfxEntries.forEach(({ lineIndex }, i) => {
      const ms = Math.round(lines[lineIndex].end * 1000);
      f.push(`[lsrc${i}]adelay=${ms}|${ms},volume=1.5[lsfx${i}]`);
      lineEndSfxLabels.push(`[lsfx${i}]`);
    });
  }
  const allSfxLabels = [...emotionSfxLabels, ...lineEndSfxLabels];
  if (allSfxLabels.length) { const mixIn = ['[dlg]', ...allSfxLabels].join(''); f.push(`${mixIn}amix=inputs=${allSfxLabels.length + 1}:duration=first:normalize=0[aout]`); }
  else f.push(`[dlg]anull[aout]`);

  const filterGraph = f.join(';');
  console.log(`renderClip: filter graph has ${f.length} filters (${allWords.length} caption words -> ${allWords.length} drawtext, one per word). Caption count is the dominant cost on long posts.`);
  const filterScriptPath = path.join(path.dirname(outPath), `filter_${path.basename(outPath, '.mp4')}.txt`);
  await fs.writeFile(filterScriptPath, filterGraph);
  console.log(`renderClip: filter graph is ${filterGraph.length} bytes, written to ${path.basename(filterScriptPath)} (passed via -filter_complex_script to avoid the 128KB single-argument limit)`);

  await run('ffmpeg', [...inputArgs, '-filter_complex_script', filterScriptPath, '-map', `[${last}]`, '-map', '[aout]', '-t', String(duration), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-threads', FFMPEG_THREADS, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-y', outPath]);
}

async function analyzeSfxEnvelope(sfxPath, dir, fps) {
  try { await fs.access(sfxPath); } catch { return null; }
  const SR = 8000;
  const rawPath = path.join(dir, `sfxenv_${crypto.randomBytes(3).toString('hex')}.raw`);
  try {
    await run('ffmpeg', ['-i', sfxPath, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-y', rawPath]);
    const buf = await fs.readFile(rawPath);
    const samples = Math.floor(buf.length / 2);
    const win = Math.max(1, Math.round(SR / fps));
    const env = [];
    for (let i = 0; i < samples; i += win) {
      let sum = 0, n = 0;
      for (let j = i; j < Math.min(i + win, samples); j++) { const v = buf.readInt16LE(j * 2) / 32768; sum += v * v; n++; }
      env.push(Math.sqrt(sum / Math.max(1, n)));
    }
    const max = Math.max(...env, 1e-9);
    const norm = env.map((v) => v / max);
    const peakIdx = norm.indexOf(Math.max(...norm));

    const oWin = Math.max(1, Math.round(SR * 0.005));
    const oEnv = [];
    for (let i = 0; i < samples; i += oWin) {
      let sum = 0, n = 0;
      for (let j = i; j < Math.min(i + oWin, samples); j++) { const v = buf.readInt16LE(j * 2) / 32768; sum += v * v; n++; }
      oEnv.push(Math.sqrt(sum / Math.max(1, n)));
    }
    const oMax = Math.max(...oEnv, 1e-9);
    const oIdx = oEnv.findIndex((v) => v >= 0.4 * oMax);
    const onsetOffset = (oIdx < 0 ? peakIdx * (win / SR) : oIdx * (oWin / SR));
    return { env: norm, peakOffset: (peakIdx + 0.5) / fps, onsetOffset, duration: samples / SR };
  } catch (err) {
    console.error(`analyzeSfxEnvelope failed for ${sfxPath}: ${err && (err.message || err)}`);
    return null;
  } finally {
    fs.rm(rawPath, { force: true }).catch(() => {});
  }
}

async function renderHookClip({ bgVideo, bgStart, duration, imgPath, zoomFactor, audioPath, hookWords, hookText, hookSfxPath, outPath, mode, debugTrail, hidePost = false }) {
  const HOOK_FPS = 30;
  const HOOK_LAND_TIME = 0.25;
  const env = hookSfxPath ? await analyzeSfxEnvelope(hookSfxPath, path.dirname(outPath), HOOK_FPS) : null;
  const T_HIT = HOOK_LAND_TIME;
  const T_UP = T_HIT * 0.56;
  const T_DOWN = T_HIT - T_UP;
  const sfxStart = env ? T_HIT - env.onsetOffset : 0;
  duration = Math.max(duration, T_HIT + 0.6);
  if (debugTrail) debugTrail.push(env
    ? `hook: box completes its rise and drop at ${T_HIT.toFixed(2)}s, the instant the vine boom hits (its sudden jump in volume is ${env.onsetOffset.toFixed(2)}s into hook.mp3; its loudest frame is ${env.peakOffset.toFixed(2)}s). ${sfxStart >= 0 ? `Boom starts at ${sfxStart.toFixed(2)}s` : `First ${(-sfxStart).toFixed(2)}s of hook.mp3 skipped`}`
    : `hook: hook.mp3 not found — box completes its rise and drop at ${T_HIT.toFixed(2)}s without the boom`);

  const inputArgs = [];
  let idx = 0;
  const push = (...args) => inputArgs.push(...args);
  push('-ss', String(bgStart), '-t', String(duration * BG_SPEED), '-i', bgVideo); const bgIdx = idx++;
  push('-loop', '1', '-t', String(duration), '-i', imgPath); const imgIdx = idx++;
  push('-i', audioPath); const audioIdx = idx++;
  let boomIdx = null;
  if (env) { push('-i', hookSfxPath); boomIdx = idx++; }

  const f = [];
  const SQUARE_SIZE = WIDTH;
  const SQUARE_TOP = 300;
  const SQUARE_BOTTOM = SQUARE_TOP + SQUARE_SIZE;
  const BLUR_SMALL_W = 90;
  const BLUR_SMALL_SIGMA = 6;
  const STACKED = mode === 'gameplay' || mode === 'parkour';
  if (mode === 'parkour') {
    f.push(`[${bgIdx}:v]setpts=PTS/${BG_SPEED},fps=${HOOK_FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1[bg]`);
  } else if (mode === 'gameplay') {
    f.push(`[${bgIdx}:v]setpts=PTS/${BG_SPEED},scale=${WIDTH}:${SQUARE_SIZE}:force_original_aspect_ratio=increase,crop=${WIDTH}:${SQUARE_SIZE},setsar=1[sq]`);
    f.push(`[sq]split=3[sqmain][sqtop][sqbot]`);
    f.push(`[sqtop]crop=${WIDTH}:${SQUARE_SIZE / 2}:0:0,scale=${BLUR_SMALL_W}:-2,gblur=sigma=${BLUR_SMALL_SIGMA},scale=${WIDTH}:${SQUARE_TOP}:flags=bilinear[blurtop]`);
    f.push(`[sqbot]crop=${WIDTH}:${SQUARE_SIZE / 2}:0:${SQUARE_SIZE / 2},scale=${BLUR_SMALL_W}:-2,gblur=sigma=${BLUR_SMALL_SIGMA},scale=${WIDTH}:${HEIGHT - SQUARE_BOTTOM}:flags=bilinear[blurbot]`);
    f.push(`color=c=black:s=${WIDTH}x${HEIGHT}:d=${duration}:r=${HOOK_FPS}[canvas]`);
    f.push(`[canvas][blurtop]overlay=0:0[bgc1]`);
    f.push(`[bgc1][blurbot]overlay=0:${SQUARE_BOTTOM}[bgc2]`);
    f.push(`[bgc2][sqmain]overlay=0:${SQUARE_TOP}[bg]`);
  } else {
    f.push(`[${bgIdx}:v]setpts=PTS/${BG_SPEED},fps=${HOOK_FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}[bg]`);
  }

  const targetW = STACKED ? WIDTH : WIDTH - 53;
  const postTopMargin = STACKED ? 16 : 140;
  const zoom = zoomFactor.toFixed(4);
  if (hidePost) {
    f.push(`[bg]null[withpost]`);
  } else {
    if (STACKED) {
      const postMaxHeight = SQUARE_TOP - postTopMargin - 10;
      const zoomedMaxH = Math.round(postMaxHeight * zoomFactor);
      f.push(`[${imgIdx}:v]scale=w='round(${targetW}*${zoom})':h=${zoomedMaxH}:force_original_aspect_ratio=decrease[hookscaled]`);
    } else {
      f.push(`[${imgIdx}:v]scale=w='round(${targetW}*${zoom})':h=-1[hookscaled]`);
    }
    f.push(`[hookscaled]crop=w='iw/${zoom}':h='ih/${zoom}':x='(iw-iw/${zoom})/2':y=0[hookcrop]`);
    f.push(`[bg][hookcrop]overlay=${STACKED ? '(W-w)/2' : '27'}:${postTopMargin}[withpost]`);
  }
  let last = 'withpost';

  const fullHookText = (hookText || hookWords.map((w) => w.word).join(' ')).toUpperCase();
  const wrapped = wrapTextForHookCaption(fullHookText);
  const safeHook = wrapped.split('\n').map((ln) => ln.replace(/[^A-Za-z0-9?! ]/g, '')).join('\n');

  const HOOK_FONT_SIZE = 40;
  const HOOK_LINE_SPACING = 10;
  const HOOK_PAD_X = 34;
  const HOOK_PAD_Y = 22;
  const HOOK_RADIUS = 26;
  const hookLines = safeHook.split('\n');
  const hookTextW = Math.max(...hookLines.map((ln) => ln.length * HOOK_FONT_SIZE * 0.72));
  const hookTextH = hookLines.length * HOOK_FONT_SIZE + (hookLines.length - 1) * HOOK_LINE_SPACING;
  const plateW = Math.min(WIDTH - 24, Math.round(hookTextW + HOOK_PAD_X * 2));
  const plateH = Math.round(hookTextH + HOOK_PAD_Y * 2);
  const hw = plateW / 2;
  const hh = plateH / 2;
  const hdx = `max(0\\,abs(X-${hw.toFixed(1)})-${(hw - HOOK_RADIUS).toFixed(1)})`;
  const hdy = `max(0\\,abs(Y-${hh.toFixed(1)})-${(hh - HOOK_RADIUS).toFixed(1)})`;
  const roundedAlpha = `if(lte((${hdx})*(${hdx})+(${hdy})*(${hdy})\\,${HOOK_RADIUS * HOOK_RADIUS})\\,255\\,0)`;
  f.push(`color=c=red:s=${plateW}x${plateH}:d=${duration}:r=${HOOK_FPS},format=rgba,geq=r='255':g='0':b='0':a='${roundedAlpha}'[hookplate]`);
  f.push(`[hookplate]drawtext=text='${safeHook}':fontcolor=white:fontsize=${HOOK_FONT_SIZE}:fontfile=${FONT}:borderw=8:bordercolor=black:line_spacing=${HOOK_LINE_SPACING}:x=(w-text_w)/2:y=(h-text_h)/2[hookbox]`);

  const P = `if(lt(t\\,${T_UP.toFixed(3)})\\,sin(PI/2*t/${T_UP.toFixed(3)})\\,if(lt(t\\,${T_HIT.toFixed(3)})\\,cos(PI/2*(t-${T_UP.toFixed(3)})/${T_DOWN.toFixed(3)})\\,0))`;
  const TILT_DEG = 15;
  const tiltRad = (TILT_DEG * Math.PI) / 180;
  const restCY = HEIGHT / 2;
  const tiltedHalfH = (plateH / 2) * Math.cos(tiltRad) + (plateW / 2) * Math.sin(tiltRad);
  const peakCY = STACKED ? SQUARE_TOP + 6 + tiltedHalfH : restCY - 260;
  const rise = Math.max(0, restCY - Math.max(peakCY, tiltedHalfH + 10));

  let D = Math.ceil(Math.hypot(plateW, plateH)) + 4;
  if (D % 2) D++;
  f.push(`[hookbox]rotate=a='-${tiltRad.toFixed(5)}*(${P})':c=black@0:ow=${D}:oh=${D}[hookrot]`);

  const LEVELS = 8;
  const GROW = 1.35;
  const peakScale = Math.min(1.15, (WIDTH - 10) / plateW);
  const restScale = peakScale / GROW;
  const frameCount = Math.ceil(duration * HOOK_FPS);
  const levelAt = (n) => {
    if (!env) return 0;
    const u = n / HOOK_FPS - sfxStart;
    const e = u >= 0 && u < env.duration ? env.env[Math.min(env.env.length - 1, Math.floor(u * HOOK_FPS))] || 0 : 0;
    return Math.round(e * (LEVELS - 1));
  };
  const runsByLevel = new Map();
  let runStart = 0, runLevel = levelAt(0);
  for (let n = 1; n <= frameCount; n++) {
    const lv = n < frameCount ? levelAt(n) : -1;
    if (lv !== runLevel) {
      if (!runsByLevel.has(runLevel)) runsByLevel.set(runLevel, []);
      runsByLevel.get(runLevel).push([runStart === 0 ? -1 : (runStart - 0.5) / HOOK_FPS, n === frameCount ? duration + 1 : (n - 0.5) / HOOK_FPS]);
      runStart = n; runLevel = lv;
    }
  }
  const usedLevels = [...runsByLevel.keys()].sort((a, b) => a - b);
  if (usedLevels.length === 1) f.push(`[hookrot]null[hr${usedLevels[0]}]`);
  else f.push(`[hookrot]split=${usedLevels.length}${usedLevels.map((lv) => `[hr${lv}]`).join('')}`);
  let boxLast = last;
  usedLevels.forEach((lv) => {
    const sc = restScale + (peakScale - restScale) * (lv / (LEVELS - 1));
    let size = Math.round(D * sc);
    if (size % 2) size++;
    f.push(`[hr${lv}]scale=${size}:${size}[hs${lv}]`);
    const enable = runsByLevel.get(lv).map(([a, b]) => `gte(t\\,${a.toFixed(4)})*lt(t\\,${b.toFixed(4)})`).join('+');
    f.push(`[${boxLast}][hs${lv}]overlay=x='(W-w)/2':y='${restCY.toFixed(1)}-${rise.toFixed(1)}*(${P})-h/2':enable='${enable}'[hb${lv}]`);
    boxLast = `hb${lv}`;
  });
  let last2 = boxLast;

  if (boomIdx !== null) {
    const ms = Math.round(sfxStart * 1000);
    const boomPlace = sfxStart >= 0
      ? `adelay=${ms}|${ms}`
      : `atrim=start=${(-sfxStart).toFixed(3)},asetpts=PTS-STARTPTS`;
    f.push(`[${audioIdx}:a]volume=2.5,apad[hookvoice]`);
    f.push(`[${boomIdx}:a]${boomPlace},volume=1.7[hookboom]`);
    f.push(`[hookvoice][hookboom]amix=inputs=2:duration=first:normalize=0[aout]`);
  } else {
    f.push(`[${audioIdx}:a]volume=2.5,apad[aout]`);
  }

  await run('ffmpeg', [...inputArgs, '-filter_complex', f.join(';'), '-map', `[${last2}]`, '-map', '[aout]', '-t', String(duration), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-threads', FFMPEG_THREADS, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-y', outPath]);
}

async function concatWithTransitions(clipPaths, durations, transitionSfx, hookSfx, outPath, hasHook, isContinuation = [], lineSfx = null) {
  const midPost = (i) => isContinuation[i] === true;
  const midPostJoinTimes = [];
  const inputs = [];
  clipPaths.forEach((p) => inputs.push('-i', p));
  inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:d=${INTRO_XFADE}:r=30`);
  inputs.push('-i', hookSfx, '-i', transitionSfx, '-i', lineSfx);
  const hookIdx = clipPaths.length + 1, transIdx = clipPaths.length + 2, lineSfxIdx = clipPaths.length + 3;
  const TRANSITION_PAUSE = 0.3;

  const f = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const isLastClip = i === clipPaths.length - 1;
    const nextContinuesSamePost = !isLastClip && midPost(i + 1);
    if (isLastClip || nextContinuesSamePost) f.push(`[${i}:v]fps=30,format=yuv420p[clip${i}v]`);
    else f.push(`[${i}:v]fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=${TRANSITION_PAUSE}[clip${i}v]`);
  }

  let v, a, cumulative;
  const clip0Padded = clipPaths.length > 1 && !midPost(1);
  const clip0EffectiveDuration = durations[0] + (clip0Padded ? TRANSITION_PAUSE : 0);
  v = 'clip0v'; a = '0:a'; cumulative = clip0EffectiveDuration;

  for (let i = 1; i < clipPaths.length; i++) {
    const isHookToFirstPost = hasHook && i === 1;

    if (isHookToFirstPost) {
      const offset = cumulative - HOOK_PIXELIZE_DURATION;
      f.push(`[${v}][clip${i}v]xfade=transition=pixelize:duration=${HOOK_PIXELIZE_DURATION}:offset=${offset}[v${i}]`);
      const silLabel = `transsil${i}`;
      f.push(`aevalsrc=0:d=${TRANSITION_PAUSE}:s=48000[${silLabel}]`);
      f.push(`[${a}][${silLabel}][${i}:a]concat=n=3:v=0:a=1[a${i}]`);
      v = `v${i}`; a = `a${i}`;
      cumulative += durations[i] - HOOK_PIXELIZE_DURATION;
      continue;
    }

    const cutLabel = `vcut${i}`;
    f.push(`[${v}][clip${i}v]concat=n=2:v=1:a=0[${cutLabel}]`);
    if (midPost(i)) {
      f.push(`[${a}][${i}:a]concat=n=2:v=0:a=1[a${i}]`);
      v = cutLabel; a = `a${i}`;
      midPostJoinTimes.push(cumulative + durations[i]);
      cumulative += durations[i];
    } else {
      const silLabel = `transsil${i}`;
      f.push(`aevalsrc=0:d=${TRANSITION_PAUSE}:s=48000[${silLabel}]`);
      f.push(`[${a}][${silLabel}][${i}:a]concat=n=3:v=0:a=1[a${i}]`);
      v = cutLabel; a = `a${i}`;
      cumulative += durations[i] + TRANSITION_PAUSE;
    }
  }

  if (!hasHook) f.push(`[${hookIdx}:a]volume=1.7[hook]`);
  const whooshLabels = [];
  let cursor = 0;
  for (let i = 0; i < clipPaths.length - 1; i++) {
    cursor += durations[i] - XFADE / 2;
    if (midPost(i + 1)) continue;
    f.push(`[${transIdx}:a]adelay=${Math.round(cursor * 1000)}|${Math.round(cursor * 1000)},volume=0.5[w${i}]`);
    whooshLabels.push(`[w${i}]`);
  }
  const lineJoinLabels = [];
  midPostJoinTimes.forEach((tSec, n) => {
    const ms = Math.round(tSec * 1000);
    f.push(`[${lineSfxIdx}:a]adelay=${ms}|${ms},volume=1.5[lj${n}]`);
    lineJoinLabels.push(`[lj${n}]`);
  });

  const hookLabels = hasHook ? [] : ['[hook]'];
  const mixIn = [`[${a}]`, ...hookLabels, ...whooshLabels, ...lineJoinLabels].join('');
  f.push(`${mixIn}amix=inputs=${whooshLabels.length + lineJoinLabels.length + hookLabels.length + 1}:duration=first:normalize=0[premix];[premix]alimiter=limit=0.95:attack=5:release=50[aoutfinal]`);

  await run('ffmpeg', [...inputs, '-filter_complex', f.join(';'), '-map', `[${v}]`, '-map', '[aoutfinal]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-threads', FFMPEG_THREADS, '-r', '30', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-y', outPath]);
}

async function mixMusicIntoVideo(videoPath, musicPath, outPath) {
  const duration = await ffprobeDuration(videoPath);
  const musicDuration = await ffprobeDuration(musicPath);
  const start = musicDuration <= duration ? 0 : Math.random() * (musicDuration - duration);
  const remaining = Math.max(musicDuration - start, 1);
  const sampleRate = await ffprobeSampleRate(musicPath);
  const loopSeconds = Math.min(remaining, duration);
  const loopSize = Math.ceil(loopSeconds * sampleRate);
  console.log(`mixMusicIntoVideo: music start ${start.toFixed(1)}s, aloop buffer ${loopSize} samples (~${((loopSize * 8) / 1024 / 1024).toFixed(0)} MB) for a ${duration.toFixed(1)}s video`);
  await run('ffmpeg', [
    '-i', videoPath, '-ss', String(start), '-i', musicPath,
    '-filter_complex',
    `[0:a]apad=whole_dur=${duration}[dlgpad];[1:a]aloop=loop=-1:size=${loopSize}[looped];[looped]asetpts=PTS-STARTPTS,atrim=duration=${duration},aresample=48000:resampler=soxr:precision=28,volume=0.26[music];[dlgpad][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed];[mixed]alimiter=limit=0.95:attack=5:release=50[aout]`,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '16', '-threads', FFMPEG_THREADS,
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-movflags', '+faststart', '-t', String(duration), '-y', outPath,
  ]);
}

const port = process.env.PORT || 8080;
process.on('unhandledRejection', (reason) => console.error('FATAL: unhandledRejection —', reason && (reason.stack || reason)));
process.on('uncaughtException', (err) => console.error('FATAL: uncaughtException —', err && (err.stack || err)));
console.log(`About to start server on port ${port}...`);
try {
  const server = app.listen(port, () => console.log(`Render service [build:2026-09-24-schedule-upload-cancel] listening on ${port}`));
  server.on('error', (err) => console.error('FATAL: server.listen() emitted an error event —', err && (err.stack || err)));
} catch (err) {
  console.error('FATAL: app.listen() threw synchronously —', err && (err.stack || err));
}