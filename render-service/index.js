// render-service/index.js
// One HTTP endpoint that does everything: OCR the screenshots, generate speech,
// composite the final video with FFmpeg, and hand the finished video straight
// back in the response. Nothing is written to Cloud Storage or a database —
// sprites, post images, and the rendered video/music only ever exist for the
// life of this one request, streamed straight back in the HTTP response.

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

// Cloud Run auto-attaches a service account; Railway doesn't, so we load
// credentials explicitly from an env var containing the full JSON key.
// Set GOOGLE_CREDENTIALS_JSON in Railway's dashboard (paste the whole key file's contents).
const credentials = process.env.GOOGLE_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
  : undefined;

const visionClient = new vision.ImageAnnotatorClient(credentials ? { credentials } : undefined);
const ttsClient = new textToSpeech.TextToSpeechClient(credentials ? { credentials } : undefined);

const WIDTH = 360, HEIGHT = 640, XFADE = 0.4;
const CAPTION_GREEN = '0x39FF14';
const ASSETS = path.join(__dirname, 'assets'); // videos/, music/, sfx/ — bundled in the Docker image

const CHROME = [
  /^\d+(\.\d+)?[km]?\s*(likes?|upvotes?|comments?|shares?|retweets?|replies?)$/i,
  /^(reply|share|save|report|follow|like|retweet|quote)$/i,
  /^u\/|^r\/|@\w+$/,
  /^\d+[hdwm]$/,
];
const EMOTION_KEYWORDS = {
  happy: ['happy', 'glad', 'great', 'love'], excited: ['excited', "can't wait", 'amazing'],
  sad: ['sad', 'crying', 'miss'], mad: ['mad', 'angry', 'furious'],
  confused: ['confused', 'huh', "doesn't make sense"], grossed_out: ['gross', 'disgusting', 'ew'],
  afraid: ['scared', 'afraid', 'terrified'], shocked: ['shocked', "can't believe", 'no way'],
};

const app = express();
app.use(cors()); // frontend (GitHub Pages) and backend (Railway) are different origins
app.use(express.json({ limit: '30mb' }));

// Quick way to confirm the service is alive by just visiting the URL in a browser
app.get('/', (req, res) => res.send('Vidmasta render service is running.'));

app.post('/generate', async (req, res) => {
  const { title, images, sprites } = req.body;
  if (!images?.length) return res.status(400).send('At least one image is required');
  console.log('generate started, images:', images.length);

  const dir = path.join(os.tmpdir(), `job_${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });

  try {
    // 1. OCR + emotion + TTS per screenshot
    const segments = [];
    for (let i = 0; i < images.length; i++) {
      const imgPath = path.join(dir, `post_${i}.png`);
      await fs.writeFile(imgPath, Buffer.from(images[i].base64, 'base64'));
      const text = await extractText(imgPath);
      console.log(`image ${i}: OCR done`);
      const emotion = tagEmotion(text);
      const { audioPath, words } = await synthesizeSpeech(text, dir, i);
      console.log(`image ${i}: TTS done`);
      segments.push({ imgPath, text, emotion, audioPath, words });
    }

    // 2. Sprites — decoded straight from the request, written to temp only
    const spritePaths = {};
    for (const [emotion, base64] of Object.entries(sprites || {})) {
      const p = path.join(dir, `sprite_${emotion}.png`);
      await fs.writeFile(p, Buffer.from(base64, 'base64'));
      spritePaths[emotion] = p;
    }
    console.log('sprites saved:', Object.keys(spritePaths).length);

    // 3. Pick background clip + music from the bundled asset folders
    const bgVideo = await randomFile(path.join(ASSETS, 'videos'));
    const music = await randomFile(path.join(ASSETS, 'music'));
    const hookSfx = path.join(ASSETS, 'sfx', 'hook.mp3');
    const transitionSfx = path.join(ASSETS, 'sfx', 'transition.mp3');
    console.log('background assets picked');

    // 4. Render each post as its own clip
    const durations = await Promise.all(segments.map((s) => ffprobeDuration(s.audioPath)));
    let bgCursor = await randomStart(bgVideo, durations.reduce((a, b) => a + b, 0));
    let lastEmotion = null;
    const clipPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const duration = durations[i];
      const spritePath = spritePaths[seg.emotion] || null;
      const emotionChanged = spritePath && seg.emotion !== lastEmotion;
      lastEmotion = seg.emotion;
      const emotionSfx = emotionChanged ? path.join(ASSETS, 'sfx', `emotion_${seg.emotion}.mp3`) : null;

      const clipPath = path.join(dir, `clip_${i}.mp4`);
      await renderClip({ bgVideo, bgStart: bgCursor, duration, imgPath: seg.imgPath, spritePath, audioPath: seg.audioPath, emotionSfx, words: seg.words, outPath: clipPath });
      console.log(`clip ${i} rendered`);
      clipPaths.push(clipPath);
      bgCursor += duration;
    }

    // 5. Stitch with transitions + SFX, then produce with/without-music versions
    const dialogueVideo = path.join(dir, 'dialogue.mp4');
    await concatWithTransitions(clipPaths, durations, transitionSfx, hookSfx, dialogueVideo);
    console.log('clips concatenated');

    const musicClipPath = path.join(dir, 'music.mp3');
    await extractMusicClip(dialogueVideo, music, musicClipPath);
    console.log('music clip extracted, streaming response');

    // 6. Stream both files back in one multipart response instead of uploading
    // anywhere. Cloud Run's ~32MB response ceiling only applies to buffered
    // (non-streaming) responses — writing chunks directly like this, with no
    // Content-Length on the overall response, avoids that ceiling entirely,
    // with nothing ever touching storage of any kind.
    const videoBuffer = await fs.readFile(dialogueVideo);
    const musicBuffer = await fs.readFile(musicClipPath);
    const boundary = `vidmasta-${crypto.randomBytes(8).toString('hex')}`;

    res.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${boundary}` });
    res.write(`--${boundary}\r\nContent-Type: video/mp4\r\nContent-Length: ${videoBuffer.length}\r\n\r\n`);
    res.write(videoBuffer);
    res.write(`\r\n--${boundary}\r\nContent-Type: audio/mpeg\r\nContent-Length: ${musicBuffer.length}\r\n\r\n`);
    res.write(musicBuffer);
    res.write(`\r\n--${boundary}--`);
    res.end();
    console.log('response sent');
  } catch (err) {
    console.error('generate failed:', err);
    res.status(500).send(err.message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- helpers ----------

async function extractText(imgPath) {
  const [result] = await visionClient.textDetection(imgPath);
  const lines = (result.fullTextAnnotation?.text ?? '').split('\n');
  return lines.filter((l) => !CHROME.some((re) => re.test(l.trim()))).join(' ').replace(/\s+/g, ' ').trim();
}

function tagEmotion(text) {
  const lower = text.toLowerCase();
  for (const [emotion, words] of Object.entries(EMOTION_KEYWORDS)) {
    if (words.some((w) => lower.includes(w))) return emotion;
  }
  return 'neutral';
}

async function synthesizeSpeech(text, dir, i) {
  const words = text.split(/\s+/).filter(Boolean);
  const ssml = `<speak>${words.map((w, idx) => `<mark name="w${idx}"/>${w.replace(/&/g, '&amp;')}`).join(' ')}</speak>`;
  const [response] = await ttsClient.synthesizeSpeech({
    input: { ssml },
    voice: { languageCode: 'en-US', name: 'en-US-Neural2-C' },
    audioConfig: { audioEncoding: 'MP3' },
    enableTimePointing: ['SSML_MARK'],
  });
  const audioPath = path.join(dir, `audio_${i}.mp3`);
  await fs.writeFile(audioPath, response.audioContent, 'binary');
  const duration = await ffprobeDuration(audioPath);
  const marks = (response.timepoints || []).sort((a, b) => Number(a.markName.slice(1)) - Number(b.markName.slice(1)));
  const timedWords = words.map((w, idx) => ({
    word: w.toUpperCase(),
    start: marks[idx]?.timeSeconds ?? (idx * duration) / words.length,
    end: marks[idx + 1]?.timeSeconds ?? duration,
  }));
  return { audioPath, words: timedWords };
}

async function ffprobeDuration(filePath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  return parseFloat(stdout.trim());
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

async function renderClip({ bgVideo, bgStart, duration, imgPath, spritePath, audioPath, emotionSfx, words, outPath }) {
  const inputs = ['-ss', String(bgStart), '-t', String(duration), '-i', bgVideo, '-loop', '1', '-t', String(duration), '-i', imgPath, '-i', audioPath];
  if (spritePath) inputs.push('-loop', '1', '-t', String(duration), '-i', spritePath);
  if (emotionSfx) inputs.push('-i', emotionSfx);

  const f = [];
  f.push(`[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}[bg]`);
  f.push(`[1:v]scale=${WIDTH - 53}:-1[postimg]`);
  f.push(`[postimg]drawbox=x=0:y='ih*min(1\\,t/${duration})':w=iw:h='ih*(1-min(1\\,t/${duration}))':color=black@1.0:t=fill[reveal]`);
  f.push(`[bg][reveal]overlay=27:67[withpost]`);
  let last = 'withpost';
  if (spritePath) {
    f.push(`[3:v]scale=87:-1,fade=t=in:d=0.25:alpha=1[sprite]`);
    f.push(`[${last}][sprite]overlay=W-93:H-140[withsprite]`);
    last = 'withsprite';
  }
  words.forEach((w, i) => {
    const safe = w.word.replace(/[:'\\]/g, '');
    f.push(`[${last}]drawtext=text='${safe}':fontcolor=white:fontsize=21:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=h-107:enable='not(between(t,${w.start},${w.end}))'[c${i}a]`);
    f.push(`[c${i}a]drawtext=text='${safe}':fontcolor=${CAPTION_GREEN}:fontsize=23:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=h-107:enable='between(t,${w.start},${w.end})'[c${i}]`);
    last = `c${i}`;
  });
  if (emotionSfx) {
    const sfxInputIdx = spritePath ? 4 : 3;
    f.push(`[${sfxInputIdx}:a]volume=0.9,apad[sfxpad]`);
    f.push(`[2:a][sfxpad]amix=inputs=2:duration=first[aout]`);
  } else {
    f.push(`[2:a]anull[aout]`);
  }

  await run('ffmpeg', [...inputs, '-filter_complex', f.join(';'), '-map', `[${last}]`, '-map', '[aout]', '-t', String(duration), '-r', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', '-y', outPath]);
}

async function concatWithTransitions(clipPaths, durations, transitionSfx, hookSfx, outPath) {
  const inputs = [];
  clipPaths.forEach((p) => inputs.push('-i', p));
  inputs.push('-i', hookSfx, '-i', transitionSfx);
  const hookIdx = clipPaths.length, transIdx = clipPaths.length + 1;

  const f = [];
  let v = '0:v', a = '0:a', cumulative = durations[0];
  for (let i = 1; i < clipPaths.length; i++) {
    const offset = cumulative - XFADE;
    f.push(`[${v}][${i}:v]xfade=transition=circleopen:duration=${XFADE}:offset=${offset}[v${i}]`);
    f.push(`[${a}][${i}:a]acrossfade=d=${XFADE}[a${i}]`);
    v = `v${i}`; a = `a${i}`;
    cumulative += durations[i] - XFADE;
  }
  f.push(`[${hookIdx}:a]anull[hook]`);
  const whooshLabels = [];
  let cursor = 0;
  for (let i = 0; i < clipPaths.length - 1; i++) {
    cursor += durations[i] - XFADE / 2;
    f.push(`[${transIdx}:a]adelay=${Math.round(cursor * 1000)}|${Math.round(cursor * 1000)}[w${i}]`);
    whooshLabels.push(`[w${i}]`);
  }
  const mixIn = ['[hook]', ...whooshLabels, `[${a}]`].join('');
  f.push(`${mixIn}amix=inputs=${whooshLabels.length + 2}:duration=first[aoutfinal]`);

  // If there was only one clip, video never went through -filter_complex, so it
  // must be mapped as a raw input stream (no brackets) rather than a filter label.
  const videoMap = v === '0:v' ? '0:v' : `[${v}]`;

  // Single clip = video was never touched by a filter, so just copy it instead of re-encoding
  const videoCodecArgs = v === '0:v' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-r', '20'];

  await run('ffmpeg', [...inputs, '-filter_complex', f.join(';'), '-map', videoMap, '-map', '[aoutfinal]', ...videoCodecArgs, '-c:a', 'aac', '-y', outPath]);
}

// Trims the background-music track down to the finished video's duration,
// starting at a random offset — kept separate from the dialogue video so the
// frontend can mix/mute it independently instead of us rendering two full videos.
async function extractMusicClip(videoPath, musicPath, outPath) {
  const duration = await ffprobeDuration(videoPath);
  const start = await randomStart(musicPath, duration);
  await run('ffmpeg', ['-ss', String(start), '-t', String(duration), '-i', musicPath, '-c:a', 'copy', '-y', outPath]);
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Render service listening on ${port}`));