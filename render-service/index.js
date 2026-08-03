// render-service/index.js

const express = require('express');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const textToSpeech = require('@google-cloud/text-to-speech');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const run = promisify(execFile);

// Cloud Run auto-attaches a service account
const credentials = process.env.GOOGLE_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
  : undefined;

const visionClient = new vision.ImageAnnotatorClient(credentials ? { credentials } : undefined);
const ttsClient = new textToSpeech.TextToSpeechClient(credentials ? { credentials } : undefined);

// AI chrome-line + emotion detection 
let GoogleGenAI = null;
try {
  ({ GoogleGenAI } = require('@google/genai'));
} catch {
  GoogleGenAI = null;
}

const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'vidmasta-7e113';
const GCP_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

const GEMINI_MODEL_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];

const genAIRegional = GoogleGenAI ? new GoogleGenAI({ vertexai: true, project: GCP_PROJECT, location: GCP_LOCATION }) : null;
const genAIGlobal = GoogleGenAI ? new GoogleGenAI({ vertexai: true, project: GCP_PROJECT, location: 'global' }) : null;

// Tries each candidate model against the regional client first, then (only
// if every attempt fails with a "not found" style error) against
// the global endpoint. 
async function generateWithFallback(prompt, config) {
  let lastErr = null;
  for (const client of [genAIRegional, genAIGlobal]) {
    if (!client) continue;
    for (const model of GEMINI_MODEL_CANDIDATES) {
      try {
        const response = await client.models.generateContent({ model, contents: prompt, config });
        return response.text || '';
      } catch (err) {
        const notFound = err?.status === 404 || err?.status === 'NOT_FOUND' || err?.code === 404;
        if (!notFound) throw err; // a real error (auth, quota, etc.) don't keep guessing models
        lastErr = err; // otherwise: this model isn't available here, try the next candidate
      }
    }
  }
  if (lastErr) console.warn('AI: every candidate model/region 404\'d. Last attempt error:', lastErr);
  return null;
}

const WIDTH = 360, HEIGHT = 640, XFADE = 0.4;
const INTRO_XFADE = 0.6; // length of the liquid-style intro transition
const CAPTION_GREEN = '0x39FF14';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const ASSETS = path.join(__dirname, 'assets'); // videos/, music/, sfx/  bundled in the Docker image

// "chrome" (UI, not post text) filtering
// Each of these matches a single UI FRAGMENT... a vote/comment count, a
// username marker, a relative timestamp, a button label. This is so the text to speech doesnt say say the likes, comments, etc.

const CHROME_PATTERNS = [
  /^\d+(\.\d+)?[kKmM]?\+?\s*(likes?|upvotes?|downvotes?|comments?|shares?|retweets?|replies?|views?|awards?|points?|karma)$/i,
  /^(reply|share|save|report|follow|following|unfollow|like|retweet|repost|quote|award|gift|more|see more|show more|edit|edited|delete|pin|pinned|op)$/i,
  /^u\/\S+$|^r\/\S+$|^@\w+$/,
  /^\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?$/i, // e.g. "39m", "7h", "3d ago"
  /^\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(just now|yesterday|today)$/i,
  /^\d+(\.\d+)?[kKmM]?$/, // bare vote/count numbers
  /^\d+%\s*(upvoted)?$/i,
  /^(posted by|submitted by)\s+u\/\S+/i,
  /^[•\-–—·|]+$/,
  // dates and post timestamps ("8:41 PM")
  /^[A-Za-z]{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{2,4}$/i,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^\d{1,2}:\d{2}\s*(am|pm)?$/i,
  /^(posted|submitted|edited)\s+(on\s+)?.{0,20}$/i,
  // "View 12 comments", "3 more replies"
  /^(view\s+)?\d+(\.\d+)?[kKmM]?\s*(more\s+)?(repl(y|ies)|comments?)$/i,
];

function isChromeFragment(text) {
  return CHROME_PATTERNS.some((re) => re.test(text));
}

// Catches "username 7y" / "SomeHandle23 3mo" style lines 
const USERNAME_TIMESTAMP_LINE = /^\S{2,25}\s+\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?$/i;

// Catches reply "bylines", a display name plus an @handle plus a relative
// time, all on one plain-space-separated 
const REPLY_BYLINE_LINE = /@\w+/i;
const TRAILING_RELATIVE_TIME = /\b\d+\s*(mo|min|mins|hr|hrs|h|d|w|m|y)\s*(ago)?$/i;

// A single bare UI word, a button label with no count attached to it.
// Used by isAllTokensChrome below to catch rows like icon-row text where
// there's no bullet character between pieces at all.
const BARE_CHROME_WORD = /^(share|reply|save|report|follow|following|unfollow|like|retweet|repost|quote|award|gift|more|edit|edited|delete|pin|pinned|op)$/i;

// Catches rows where several UI bits sit on one OCR line with NOTHING
// separating them 
function isAllTokensChrome(line) {
  const tokens = line.trim().split(/\s+/).map((t) => t.replace(/^[^\w%]+|[^\w%]+$/g, '')).filter(Boolean);
  if (tokens.length < 2) return false; // single tokens are handled by isChromeFragment already
  return tokens.every((t) => /^\d+(\.\d+)?[kKmM]?%?$/.test(t) || BARE_CHROME_WORD.test(t));
}

// Splits an OCR line on the separators platforms use to mash UI bits
// together ("OP · 39m", "4 upvotes | 7 comments"), drops whichever
// fragments look like chrome, and keeps the rest.
function cleanLine(rawText) {
  const trimmed = rawText.trim();
  if (USERNAME_TIMESTAMP_LINE.test(trimmed)) return '';
  if (REPLY_BYLINE_LINE.test(trimmed) && TRAILING_RELATIVE_TIME.test(trimmed)) return '';
  if (isAllTokensChrome(trimmed)) return '';
  const parts = trimmed.split(/\s*[•·|]\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.filter((p) => !isChromeFragment(p)).join(' ');
}

///// AI pass: catches whatever the regex filter above misses

async function aiKeepMask(lines) {
  if (!genAIRegional) {
    console.warn('AI chrome filter: @google/genai package not installed — using pattern filter only');
    return null;
  }
  if (!lines.length) return null;
  try {
    const numbered = lines.map((l, i) => `${i}: ${l}`).join('\n');
    const prompt =
      'These are OCR lines from a screenshot of a social media post or comment ' +
      '(Reddit, Twitter/X, etc), already run through a first filtering pass, so ' +
      'most obvious UI chrome is already gone — look closely for what remains. ' +
      'For each numbered line, decide if it is part of the actual text a person ' +
      'WROTE (the post body or comment text), or if it is still leftover ' +
      'interface "chrome": a username or @handle (alone or combined with a ' +
      'display name and/or a relative time, e.g. "Graham @user 4h" is a reply ' +
      'byline, not content), a relative or absolute date/time, a like/upvote/' +
      'comment/share count, or a button label like Reply/Share/Follow. ' +
      `Return ONLY a JSON array of exactly ${lines.length} booleans, in order — ` +
      'true = real written content to keep, false = UI chrome to discard.\n\n' +
      numbered;

    const text = await generateWithFallback(prompt, { temperature: 0, responseMimeType: 'application/json' });
    if (text == null) {
      console.warn('AI chrome filter: no candidate model was available in', GCP_LOCATION, 'or global');
      return null;
    }
    const mask = JSON.parse(text);
    if (!Array.isArray(mask) || mask.length !== lines.length) {
      console.warn('AI chrome filter: unexpected response shape, raw text was:', text);
      return null;
    }
    console.log('AI chrome filter: classified', lines.length, 'lines, kept', mask.filter(Boolean).length);
    return mask.map(Boolean);
  } catch (err) {
    // Logging the FULL error
    console.warn('AI chrome filter unavailable, using pattern filter only:', err);
    return null;
  }
}

const EMOTION_KEYWORDS = {
  happy: ['happy', 'glad', 'great', 'love'], excited: ['excited', "can't wait", 'amazing'],
  sad: ['sad', 'crying', 'miss'], mad: ['mad', 'angry', 'furious'],
  confused: ['confused', 'huh', "doesn't make sense"], grossed_out: ['gross', 'disgusting', 'ew'],
  afraid: ['scared', 'afraid', 'terrified'], shocked: ['shocked', "can't believe", 'no way'],
};

function keywordEmotion(text) {
  const lower = text.toLowerCase();
  for (const [emotion, words] of Object.entries(EMOTION_KEYWORDS)) {
    if (words.some((w) => lower.includes(w))) return emotion;
  }
  return null;
}

// emotion per line, forced onto one of the uploaded sprites 
async function aiDetectEmotions(lineTexts, availableEmotions) {
  if (!genAIRegional || !lineTexts.length || !availableEmotions.length) return null;
  try {
    const numbered = lineTexts.map((l, i) => `${i}: ${l}`).join('\n');
    const prompt =
      'These are consecutive lines of a social media post or comment. For each ' +
      'numbered line, pick whichever ONE of these emotions its tone is closest ' +
      `to — you must always pick one, there is no "neutral" option: ${availableEmotions.join(', ')}. ` +
      `Return ONLY a JSON array of exactly ${lineTexts.length} strings, in order, ` +
      'each exactly one of the allowed emotion words (lowercase).\n\n' +
      numbered;

    const text = await generateWithFallback(prompt, { temperature: 0, responseMimeType: 'application/json' });
    if (text == null) return null;
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== lineTexts.length) return null;
    return arr.map((e) => {
      const norm = String(e).trim().toLowerCase();
      return availableEmotions.includes(norm) ? norm : null;
    });
  } catch (err) {
    console.warn('AI emotion detection unavailable, using keyword fallback:', err);
    return null;
  }
}

// Resolves a final emotion for every line, given only the emotions the
// person actually uploaded a sprite for
async function resolveLineEmotions(lineTexts, availableEmotions) {
  if (!availableEmotions.length) return lineTexts.map(() => null);
  const aiResult = await aiDetectEmotions(lineTexts, availableEmotions);
  const resolved = [];
  let lastGood = availableEmotions[0];
  for (let i = 0; i < lineTexts.length; i++) {
    let e = aiResult ? aiResult[i] : null;
    if (!e) {
      const kw = keywordEmotion(lineTexts[i]);
      e = kw && availableEmotions.includes(kw) ? kw : null;
    }
    if (!e) e = lastGood; // keep the previous sprite up rather than leaving a gap
    lastGood = e;
    resolved.push(e);
  }
  return resolved;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

app.get('/', (req, res) => res.send('Vidmasta render service is running.'));

app.post('/generate', async (req, res) => {
  const { title, images, sprites } = req.body;
  if (!images?.length) return res.status(400).send('At least one image is required');
  console.log('generate started, images:', images.length);

  const dir = path.join(os.tmpdir(), `job_${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });

  try {
    // Sprites 
    const spritePaths = {};
    for (const [emotion, base64] of Object.entries(sprites || {})) {
      const p = path.join(dir, `sprite_${emotion}.png`);
      await fs.writeFile(p, Buffer.from(base64, 'base64'));
      spritePaths[emotion] = p;
    }
    console.log('sprites saved:', Object.keys(spritePaths).length);
    const availableEmotions = Object.keys(spritePaths);

    // 2. OCR + per-line TTS for every screenshot
    const segments = [];
    for (let i = 0; i < images.length; i++) {
      const imgPath = path.join(dir, `post_${i}.png`);
      await fs.writeFile(imgPath, Buffer.from(images[i].base64, 'base64'));
      const lines = await extractLines(imgPath);
      console.log(`image ${i}: OCR done, lines: ${lines.length}`);
      const imgHeight = await ffprobeImageHeight(imgPath);
      const built = await buildPostAudio(lines, imgHeight, dir, i, availableEmotions);
      console.log(`image ${i}: TTS done`);
      segments.push({ imgPath, audioPath: built.audioPath, duration: built.duration, lines: built.lines });
    }
    console.log('background assets picked');

    // 3. Pick background clip + music from the bundled asset folders
    const bgVideo = await randomFile(path.join(ASSETS, 'videos'));
    const music = await randomFile(path.join(ASSETS, 'music'));
    const hookSfx = path.join(ASSETS, 'sfx', 'hook.mp3');
    const transitionSfx = path.join(ASSETS, 'sfx', 'transition.mp3');
    console.log('background assets picked');

    // 4. Render each post as its own clip
    const durations = segments.map((s) => s.duration);
    let bgCursor = await randomStart(bgVideo, durations.reduce((a, b) => a + b, 0));
    const clipPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipPath = path.join(dir, `clip_${i}.mp4`);
      await renderClip({
        bgVideo, bgStart: bgCursor, duration: seg.duration, imgPath: seg.imgPath,
        spritePaths, audioPath: seg.audioPath, lines: seg.lines, outPath: clipPath,
      });
      console.log(`clip ${i} rendered`);
      clipPaths.push(clipPath);
      bgCursor += seg.duration;
    }

    // 5. Stitch with the liquid-style intro + transitions/SFX between posts
    const dialogueVideo = path.join(dir, 'dialogue.mp4');
    await concatWithTransitions(clipPaths, durations, transitionSfx, hookSfx, dialogueVideo);
    console.log('clips concatenated');

    // 6. Mix the music directly into the video's own audio track
    const finalVideo = path.join(dir, 'final.mp4');
    await mixMusicIntoVideo(dialogueVideo, music, finalVideo);
    console.log('music mixed into video, streaming response');

    // 7. Stream the single finished file back 
    const videoBuffer = await fs.readFile(finalVideo);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', videoBuffer.length);
    res.end(videoBuffer);
    console.log('response sent');
  } catch (err) {
    console.error('generate failed:', err);
    res.status(500).send(err.message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
});


// Uses Vision's DOCUMENT_TEXT_DETECTION 
async function extractLines(imgPath) {
  const [result] = await visionClient.documentTextDetection(imgPath);
  const page = result.fullTextAnnotation?.pages?.[0];
  const rawLines = [];

  if (page) {
    let curWords = [];
    let curMaxY = 0;

    const flushLine = () => {
      const text = curWords.join(' ').trim();
      if (text) rawLines.push({ text, bottom: curMaxY || null });
      curWords = [];
      curMaxY = 0;
    };

    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const wordText = (word.symbols || []).map((s) => s.text).join('');
          if (wordText) curWords.push(wordText);

          const vertices = word.boundingBox?.vertices || [];
          const ys = vertices.map((v) => v.y).filter((y) => typeof y === 'number');
          if (ys.length) curMaxY = Math.max(curMaxY, ...ys);

          const symbols = word.symbols || [];
          const breakType = symbols[symbols.length - 1]?.property?.detectedBreak?.type;
          if (breakType === 'EOL_SURE_SPACE' || breakType === 'LINE_BREAK') flushLine();
        }
        flushLine(); // also break at paragraph boundaries
      }
    }
    flushLine(); // flush whatever's left
  }

  // Fallback for the rare case Vision returns no structured data at all.
  if (!rawLines.length) {
    const fallback = (result.fullTextAnnotation?.text ?? '').split('\n');
    for (const l of fallback) rawLines.push({ text: l.trim(), bottom: null });
  }

  // Pass 1: fast, free, pattern-based chrome stripping (usernames, counts,
  // dates, timestamps, button labels, reply bylines)
  const lines = rawLines
    .map((l) => ({ text: cleanLine(l.text), bottom: l.bottom }))
    .filter((l) => l.text);

  // Pass 2: AI catches whatever pass 1 missed.
  const mask = await aiKeepMask(lines.map((l) => l.text));
  const finalLines = mask ? lines.filter((_, i) => mask[i]) : lines;

  return finalLines.length ? finalLines : [{ text: '...', bottom: null }];
}

// Real pixel height of the source screenshot, used to turn a detected line's
// bounding-box bottom into a 0..1 fraction of the image.
async function ffprobeImageHeight(imgPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=height',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    imgPath,
  ]);
  return parseInt(stdout.trim(), 10);
}

function escapeSsml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Synthesizes ONE line of text on its own, so a problem on one line can never
// swallow the rest of the post 
async function synthesizeLine(text, dir, tag) {
  const words = text.split(/\s+/).filter(Boolean);
  const ssml = `<speak>${words.map((w, idx) => `<mark name="w${idx}"/>${escapeSsml(w)}`).join(' ')}</speak>`;
  const [response] = await ttsClient.synthesizeSpeech({
    input: { ssml },
    voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1.25 }, // a little faster
    enableTimePointing: ['SSML_MARK'],
  });
  const audioPath = path.join(dir, `line_${tag}.mp3`);
  await fs.writeFile(audioPath, response.audioContent, 'binary');
  const duration = await ffprobeDuration(audioPath);
  const marks = (response.timepoints || []).sort((a, b) => Number(a.markName.slice(1)) - Number(b.markName.slice(1)));

  const timedWords = words.map((w, idx) => {
    const start = marks[idx]?.timeSeconds ?? (idx * duration) / words.length;
    const end = marks[idx + 1]?.timeSeconds ?? ((idx + 1) * duration) / words.length;
    return { word: w.toUpperCase(), start, end };
  });
  return { audioPath, words: timedWords, duration };
}

// Synthesizes every line of a post separately, then stitches them into one
// audio file while tracking each line's absolute start/end time 
async function buildPostAudio(textLines, imgHeight, dir, i, availableEmotions) {
  const emotions = await resolveLineEmotions(textLines.map((tl) => tl.text), availableEmotions || []);

  const lineData = [];
  for (let j = 0; j < textLines.length; j++) {
    const line = await synthesizeLine(textLines[j].text, dir, `${i}_${j}`);
    lineData.push({ text: textLines[j].text, bottom: textLines[j].bottom, emotion: emotions[j], ...line });
  }

  // Turn each line's AI-detected bounding-box bottom into a 0..1 reveal fraction of the whole image, with a
  // running max so the reveal only ever grows. 
  let runningMax = 0;
  const fracs = textLines.map((tl, idx) => {
    const raw = imgHeight && tl.bottom != null ? tl.bottom / imgHeight : (idx + 1) / textLines.length;
    runningMax = Math.max(runningMax, Math.min(1, raw));
    return runningMax;
  });

  let offset = 0;
  const lines = lineData.map((ld, idx) => {
    const entry = {
      emotion: ld.emotion,
      start: offset,
      end: offset + ld.duration,
      revealFrac: fracs[idx],
      words: ld.words.map((w) => ({ word: w.word, start: w.start + offset, end: w.end + offset })),
    };
    offset += ld.duration;
    return entry;
  });

  const audioPath = path.join(dir, `post_audio_${i}.mp3`);
  if (lineData.length === 1) {
    await fs.copyFile(lineData[0].audioPath, audioPath);
  } else {
    const inputs = [];
    lineData.forEach((ld) => inputs.push('-i', ld.audioPath));
    const refs = lineData.map((_, idx) => `[${idx}:a]`).join('');
    await run('ffmpeg', [...inputs, '-filter_complex', `${refs}concat=n=${lineData.length}:v=0:a=1[aout]`, '-map', '[aout]', '-y', audioPath]);
  }

  return { audioPath, duration: offset, lines };
}

// ffmpeg helpers

async function ffprobeDuration(filePath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  return parseFloat(stdout.trim());
}

// Real sample rate of the source audio file, used to size the aloop buffer
// in mixMusicIntoVideo exactly, so we allocate enough samples to loop the
// whole (trimmed) clip without over-allocating.
async function ffprobeSampleRate(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return parseInt(stdout.trim(), 10) || 44100;
}

async function randomFile(dirPath) {
  const files = await fs.readdir(dirPath);
  if (!files.length) throw new Error(`No files in ${dirPath} — add some to the render-service/assets folder.`);
  return path.join(dirPath, files[Math.floor(Math.random() * files.length)]);
}

async function randomStart(videoPath, neededDuration) {
  const total = await ffprobeDuration(videoPath);
  return total <= neededDuration ? 0 : Math.random() * (total - neededDuration);
}

async function renderClip({ bgVideo, bgStart, duration, imgPath, spritePaths, audioPath, lines, outPath }) {
  const uniqueEmotions = [...new Set(lines.map((l) => l.emotion))].filter((e) => e && spritePaths[e]);

  const inputArgs = [];
  let idx = 0;
  const push = (...args) => inputArgs.push(...args);

  push('-ss', String(bgStart), '-t', String(duration), '-i', bgVideo); const bgIdx = idx++;
  push('-loop', '1', '-t', String(duration), '-i', imgPath); const imgIdx = idx++;
  push('-i', audioPath); const audioIdx = idx++;

  const spriteIdx = {};
  for (const emotion of uniqueEmotions) {
    push('-loop', '1', '-t', String(duration), '-i', spritePaths[emotion]);
    spriteIdx[emotion] = idx++;
  }

  const sfxEvents = [];
  let prevEmotion = null;
  for (const line of lines) {
    if (line.emotion && spritePaths[line.emotion] && line.emotion !== prevEmotion) sfxEvents.push({ emotion: line.emotion, time: line.start });
    prevEmotion = line.emotion;
  }
  const sfxIdx = [];
  for (const ev of sfxEvents) {
    push('-i', path.join(ASSETS, 'sfx', `emotion_${ev.emotion}.mp3`));
    sfxIdx.push(idx++);
  }

  const f = [];
  f.push(`[${bgIdx}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}[bg]`);
  f.push(`[${imgIdx}:v]scale=${WIDTH - 53}:-1[postimg]`);


  let last = 'postimg';
  lines.forEach((l, i) => {
    const enable = i === lines.length - 1 ? `gte(t,${l.start})` : `between(t,${l.start},${l.end})`;
    f.push(`[${last}]drawbox=x=0:y='ih*(${l.revealFrac})':w=iw:h='ih*(1-(${l.revealFrac}))':color=black@1.0:t=fill:enable='${enable}'[reveal${i}]`);
    last = `reveal${i}`;
  });
  f.push(`[bg][${last}]overlay=27:67[withpost]`);
  last = 'withpost';

  uniqueEmotions.forEach((emotion, i) => {
    const windows = lines.filter((l) => l.emotion === emotion).map((l) => `between(t,${l.start},${l.end})`).join('+');
    f.push(`[${spriteIdx[emotion]}:v]scale=170:-1,fade=t=in:d=0.1:alpha=1[sprite${i}]`);
    f.push(`[${last}][sprite${i}]overlay=W-180:H-200:enable='${windows}'[withsprite${i}]`);
    last = `withsprite${i}`;
  });

  const allWords = lines.flatMap((l) => l.words);
  allWords.forEach((w, i) => {
    const safe = w.word.replace(/[:'\\]/g, '');
    f.push(`[${last}]drawtext=text='${safe}':fontcolor=${CAPTION_GREEN}:fontsize=24:fontfile=${FONT}:borderw=3:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.7:x=(w-text_w)/2:y=h-107:enable='gte(t,${w.start})*lt(t,${w.end})'[cap${i}]`);
    last = `cap${i}`;
  });

  f.push(`[${audioIdx}:a]volume=3.0[dlg]`); // narration much louder
  sfxEvents.forEach((ev, i) => {
    const ms = Math.round(ev.time * 1000);
    f.push(`[${sfxIdx[i]}:a]adelay=${ms}|${ms},volume=1.8[sfx${i}]`);
  });
  if (sfxEvents.length) {
    const mixIn = ['[dlg]', ...sfxEvents.map((_, i) => `[sfx${i}]`)].join('');
    f.push(`${mixIn}amix=inputs=${sfxEvents.length + 1}:duration=first[aout]`);
  } else {
    f.push(`[dlg]anull[aout]`);
  }

  await run('ffmpeg', [...inputArgs, '-filter_complex', f.join(';'), '-map', `[${last}]`, '-map', '[aout]', '-t', String(duration), '-r', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', '-y', outPath]);
}

// Stitches all clips together
async function concatWithTransitions(clipPaths, durations, transitionSfx, hookSfx, outPath) {
  const inputs = [];
  clipPaths.forEach((p) => inputs.push('-i', p));
  inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:d=${INTRO_XFADE}:r=20`);
  inputs.push('-i', hookSfx, '-i', transitionSfx);
  const blackIdx = clipPaths.length, hookIdx = clipPaths.length + 1, transIdx = clipPaths.length + 2;

  const f = [];
  
  f.push(`[${blackIdx}:v]fps=20,format=yuv420p[introsrc]`);
  f.push(`[0:v]fps=20,format=yuv420p[clip0v]`);
  
  f.push(`[introsrc][clip0v]xfade=transition=distance:duration=${INTRO_XFADE}:offset=0[vintro]`);
  let v = 'vintro', a = '0:a', cumulative = durations[0];

  for (let i = 1; i < clipPaths.length; i++) {
    const offset = cumulative - XFADE;
   
    f.push(`[${i}:v]fps=20,format=yuv420p[clip${i}v]`);
    f.push(`[${v}][clip${i}v]xfade=transition=circleopen:duration=${XFADE}:offset=${offset}[v${i}]`);
    f.push(`[${a}][${i}:a]acrossfade=d=${XFADE}[a${i}]`);
    v = `v${i}`; a = `a${i}`;
    cumulative += durations[i] - XFADE;
  }

  f.push(`[${hookIdx}:a]volume=3.5[hook]`); // hook significantly louder
  const whooshLabels = [];
  let cursor = 0;
  for (let i = 0; i < clipPaths.length - 1; i++) {
    cursor += durations[i] - XFADE / 2;
    f.push(`[${transIdx}:a]adelay=${Math.round(cursor * 1000)}|${Math.round(cursor * 1000)},volume=2.5[w${i}]`); // transition whoosh louder
    whooshLabels.push(`[w${i}]`);
  }
  
  const mixIn = [`[${a}]`, '[hook]', ...whooshLabels].join('');
  f.push(`${mixIn}amix=inputs=${whooshLabels.length + 2}:duration=first[aoutfinal]`);

  await run('ffmpeg', [...inputs, '-filter_complex', f.join(';'), '-map', `[${v}]`, '-map', '[aoutfinal]', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-r', '20', '-c:a', 'aac', '-y', outPath]);
}

async function mixMusicIntoVideo(videoPath, musicPath, outPath) {
  const duration = await ffprobeDuration(videoPath);
  const musicDuration = await ffprobeDuration(musicPath);
  const start = musicDuration <= duration ? 0 : Math.random() * (musicDuration - duration);
  const remaining = Math.max(musicDuration - start, 1);
  const sampleRate = await ffprobeSampleRate(musicPath);
  const loopSize = Math.ceil(remaining * sampleRate);

  await run('ffmpeg', [
    '-i', videoPath,
    '-ss', String(start), '-i', musicPath,
    '-filter_complex',
    `[1:a]aloop=loop=-1:size=${loopSize}[looped];[looped]asetpts=PTS-STARTPTS,atrim=duration=${duration},volume=0.35[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-threads', '2',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-t', String(duration),
    '-y', outPath,
  ]);
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Render service listening on ${port}`));