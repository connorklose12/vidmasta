// Tests for the render service. Run:  node --test debug.test.js
//

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'test',
  GEMINI_API_KEY: 'test',
  SCHEDULER_SECRET: 'test-secret',
  GCS_TEMP_BUCKET: 'test-bucket',
});

//  loading the real backend with fakes in place of the cloud libraries 

const fake = {}; // tests fill in fake.claude / fake.tts / fake.bucket / fake.db as they need them
const logs = []; // everything index.js logs ends up here so tests can read it
globalThis.__backendConsole = new Proxy({}, { get: () => (...args) => logs.push(args.join(' ')) });

function loadBackend() {
  const routes = {};

  // fake express: it only remembers which handler was registered for each route
  const app = new Proxy({}, {
    get: (_, verb) => (route, ...handlers) => {
      if (typeof route === 'string') routes[`${String(verb).toUpperCase()} ${route}`] = handlers.at(-1);
    },
  });
  const express = new Proxy(() => app, { get: () => () => () => {} });

  const packages = {
    express,
    cors: () => () => {},
    '@google-cloud/vision': { ImageAnnotatorClient: class {} },
    '@google-cloud/text-to-speech': { TextToSpeechClient: class { synthesizeSpeech(req) { return fake.tts(req); } } },
    '@google-cloud/storage': { Storage: class { bucket() { return fake.bucket; } } },
    '@anthropic-ai/sdk': class { constructor() { this.messages = { create: (args) => fake.claude(args) }; } },
    'firebase-admin/app': { initializeApp() {}, getApps: () => [{}] },
    'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'test-user' }) }) },
    'firebase-admin/firestore': { getFirestore: () => fake.db },
  };
  const builtins = new Set(['fs', 'fs/promises', 'path', 'os', 'crypto', 'child_process', 'async_hooks']);
  const fakeRequire = (name) =>
    packages[name] || (builtins.has(name) ? require(name) : new Proxy(function () {}, { get: () => () => {} }));

  let source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  source = source.replace(/try \{\r?\n  const server = app\.listen[\s\S]*$/, ''); // don't start a server
  source = 'const console = globalThis.__backendConsole;\n' + source
    + '\nmodule.exports = { renderClip, renderHookClip, hookPoolFor, pickHookLine, synthesizeLine, geminiGenerate, jobOptions, HOOK_VOICE_LINES };';

  // index.js registers its own uncaughtException handlers, which would swallow real test
  // failures, so take any new ones back off after loading
  const events = ['uncaughtException', 'unhandledRejection'];
  const before = events.map((e) => new Set(process.listeners(e)));
  const mod = { exports: {} };
  vm.runInThisContext(require('module').wrap(source))
    .call(mod.exports, mod.exports, fakeRequire, mod, path.join(FIX, 'index.js'), FIX);
  events.forEach((e, i) => process.listeners(e).forEach((fn) => { if (!before[i].has(fn)) process.removeListener(e, fn); }));

  return { ...mod.exports, routes };
}

//  tiny synthetic media, made once with ffmpeg

const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmasta-test-'));
after(() => fs.rmSync(FIX, { recursive: true, force: true }));

const FONT = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  'C:\\Windows\\Fonts\\arialbd.ttf',
].find(fs.existsSync);
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every((bin) => spawnSync(bin, ['-version']).status === 0);
const noMedia = hasFfmpeg && FONT ? false : 'needs ffmpeg, ffprobe and a system font';

const file = (name) => path.join(FIX, name);
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mediaMade = false;
function makeMedia() {
  if (mediaMade) return;
  mediaMade = true;
  fs.mkdirSync(file('assets/fonts'), { recursive: true });
  fs.mkdirSync(file('assets/sfx'), { recursive: true });
  fs.copyFileSync(FONT, file('assets/fonts/TikTokSans-Black.ttf'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=800:d=0.2', file('assets/sfx/line_end.mp3'));
  // a boom with a quiet lead-in and then a sudden hit, like the real vine boom
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=60:d=2', '-af', "volume='if(lt(t,0.55),0.02,exp(-(t-0.55)*2.5))':eval=frame", file('assets/sfx/hook.mp3'));
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x808080:s=1280x720:r=30', '-t', '30', '-pix_fmt', 'yuv420p', file('bg.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x1a1a2e:s=650x1900', '-frames:v', '1', file('post.png'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=220:d=3', '-ar', '24000', '-ac', '1', file('voice.wav'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=300:d=2.4', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', file('tts.wav'));
}

//  measuring helpers for the hook tests

// where the red hook box is on frame n: its vertical centre (in output pixels) and its width
function redBox(video, n) {
  const pixels = execFileSync('ffmpeg', [
    '-v', 'error', '-i', video, '-vf', `select='eq(n\\,${n})',scale=360:640`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1 << 26 });
  let top = 1e9, bottom = -1, left = 1e9, right = -1;
  for (let y = 160; y < 640; y++) {
    for (let x = 0; x < 360; x++) {
      const i = (y * 360 + x) * 3;
      if (pixels[i] > 200 && pixels[i + 1] < 60 && pixels[i + 2] < 60) {
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        left = Math.min(left, x); right = Math.max(right, x);
      }
    }
  }
  return { y: top + bottom, w: right - left + 1 };
}

function readPcm(input, filter = 'anull') {
  const bytes = execFileSync('ffmpeg', [
    '-v', 'error', '-i', input, '-vn', '-af', filter, '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
  ], { maxBuffer: 1 << 26 });
  return Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2) / 32768);
}

// time of the first sudden jump in volume (40% of the maximum), in 5ms steps
function soundOnset(samples, rate = 8000) {
  const win = rate * 0.005;
  const energy = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    energy.push(Math.sqrt(sum / win));
  }
  const max = Math.max(...energy);
  return energy.findIndex((e) => e >= 0.4 * max) * 0.005;
}

describe('hook animation', () => {
  it('puts the box back on the ground at 0.25s, when the boom hits', { skip: noMedia, timeout: 120000 }, async (t) => {
    makeMedia();
    const backend = loadBackend();
    const out = file('hook.mp4');
    const trail = [];
    await backend.renderHookClip({
      bgVideo: file('bg.mp4'), bgStart: 1, duration: 2.9, imgPath: file('post.png'), zoomFactor: 1.2,
      audioPath: file('voice.wav'), hookWords: [], hookText: 'U LOOK LIKE A COW IN THE MOST CUTEST WAY',
      hookSfxPath: file('assets/sfx/hook.mp3'), outPath: out, mode: 'gameplay', debugTrail: trail,
    });

    // 30fps, so frame 8 is the first one after 0.25s and frame 7 the last one before it
    const rest = redBox(out, 0);
    const midair = redBox(out, 4);
    const peak = redBox(out, 7);
    const landed = redBox(out, 8);
    const later = redBox(out, 13);

    assert.ok(rest.y - midair.y > 100, 'should be well off the ground mid-swing');
    assert.ok(Math.abs(landed.y - rest.y) <= 8, 'should be back on the ground by frame 8');
    assert.ok(peak.w / rest.w >= 1.25, 'should be at its biggest as it lands');
    assert.ok(Math.abs(later.w - rest.w) <= 4, 'should be back to normal size afterwards');

    // the mixed audio minus the voice leaves just the boom
    const voice = readPcm(file('voice.wav'), 'volume=2.5');
    const boom = soundOnset(readPcm(out).map((v, i) => v - (voice[i] || 0)));
    t.diagnostic(`box ${rest.w}px -> ${peak.w}px wide, landed at y=${landed.y} (rest ${rest.y}), boom heard at ${boom.toFixed(3)}s`);
    assert.ok(Math.abs(boom - 0.25) <= 1 / 30);
    assert.match(trail.join('\n'), /rise and drop at 0\.25s/);
  });

  // soundOnset decides whether the boom counts as on time, so make sure it can actually say no
  it('sound check notices a boom that is 200ms late', () => {
    const boomAt = (sec) => Array.from({ length: 16000 }, (_, i) =>
      (i / 8000 >= sec ? Math.sin(i) * Math.exp(-(i / 8000 - sec) * 3) : 0.001));
    assert.ok(Math.abs(soundOnset(boomAt(0.25)) - 0.25) <= 0.01);
    assert.ok(Math.abs(soundOnset(boomAt(0.45)) - 0.25) > 1 / 30);
  });
});

//  scheduler

// Just enough Firestore to run the real handler. Transactions run one at a time, which is the
// guarantee the real thing gives you.
class FakeDb {
  constructor(docs) {
    this.docs = new Map(Object.entries(docs).map(([id, doc]) => [id, structuredClone(doc)]));
    this.lock = Promise.resolve();
  }

  collection() {
    const db = this;
    return {
      get: async () => ({
        size: db.docs.size,
        forEach: (cb) => [...db.docs].forEach(([id, doc]) => cb({ id, data: () => structuredClone(doc) })),
      }),
      doc: (id) => ({
        id,
        get: async () => ({ exists: db.docs.has(id), data: () => structuredClone(db.docs.get(id)) }),
        update: async (patch) => { Object.assign(db.docs.get(id), structuredClone(patch)); },
      }),
    };
  }

  runTransaction(fn) {
    const run = this.lock.then(async () => {
      const writes = [];
      const result = await fn({ get: (ref) => ref.get(), update: (ref, patch) => writes.push([ref, patch]) });
      for (const [ref, patch] of writes) await ref.update(patch);
      return result;
    });
    this.lock = run.catch(() => {});
    return run;
  }
}

const duePost = (overrides = {}) => ({
  atMs: Date.now() - 60000,
  status: 'pending',
  title: 't',
  mode: 'gameplay',
  imagePaths: ['img_0.png'],
  spriteObjects: {},
  ...overrides,
});

// Calls the real /schedule/run-due handler `calls` times at once. Storage fails on purpose, so
// the number of download attempts tells us how many runs actually started the job.
async function runDue({ entry, calls = 1, secret = 'test-secret' }) {
  const downloads = [];
  fake.bucket = {
    file: (name) => ({
      download: async () => {
        downloads.push(name);
        await sleep(5);
        throw new Error('simulated storage outage');
      },
    }),
  };
  fake.db = new FakeDb({ s1: { uid: 'u1', entries: [entry] } });
  const backend = loadBackend();
  logs.length = 0;

  const res = await Promise.all(Array.from({ length: calls }, async () => {
    const r = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(body) { this.body = body; return this; },
      send(body) { this.body = body; return this; },
    };
    await backend.routes['POST /schedule/run-due']({ headers: { 'x-scheduler-secret': secret }, body: {} }, r);
    return r;
  }));
  return { downloads, res, doc: fake.db.docs.get('s1') };
}

describe('scheduler', () => {
  it('only sends a post once when two runs overlap', async (t) => {
    // The first version marked a post "done" only AFTER rendering and uploading it, so a second
    // run that started while the first was busy sent the same video again. Recreate that:
    const db = new FakeDb({ s1: { entries: [duePost()] } });
    let sent = 0;
    const oldRunDue = async () => {
      const due = [];
      (await db.collection().get()).forEach((d) =>
        d.data().entries.forEach((e, i) => { if (e.status === 'pending') due.push([d.id, i]); }));
      for (const [id, i] of due) {
        sent++;
        await sleep(10);
        const doc = db.collection().doc(id);
        const data = (await doc.get()).data();
        data.entries[i].status = 'done';
        await doc.update(data);
      }
    };
    await Promise.all([oldRunDue(), oldRunDue()]);
    assert.equal(sent, 2);

    // now the real handler, which claims the post in a transaction before doing any work
    const { downloads, res, doc } = await runDue({ entry: duePost(), calls: 2 });
    t.diagnostic(`two overlapping runs started ${downloads.length} job (the old way: ${sent})`);
    assert.equal(downloads.length, 1);
    assert.equal(res.reduce((n, r) => n + r.body.claimed, 0), 1);
    assert.equal(doc.entries[0].status, 'error'); // the fake storage fails, and that gets recorded
  });

  it('retakes a post whose run died, but leaves one that is still going', async () => {
    const dead = duePost({ status: 'processing', processingStartedAt: Date.now() - 46 * 60000 });
    const running = duePost({ status: 'processing', processingStartedAt: Date.now() - 60000 });
    assert.equal((await runDue({ entry: dead })).downloads.length, 1);
    assert.equal((await runDue({ entry: running })).downloads.length, 0);
  });

  it('refuses a wrong secret and keeps both secrets out of the logs', async () => {
    const { res } = await runDue({ entry: duePost(), secret: 'nope' });
    assert.equal(res[0].code, 401);
    const text = logs.join('\n');
    assert.match(text, /REJECTED: X-Scheduler-Secret header does not match/);
    assert.ok(!text.includes('test-secret') && !text.includes('nope'));
  });
});

// gemini retries

// Swaps global fetch for a scripted one (the last response repeats) and writes down the waits
// instead of actually sleeping through them.
async function withFakeNetwork(script, run) {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const hosts = [];
  const waits = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).host);
    const [status, body] = script[Math.min(hosts.length - 1, script.length - 1)];
    return { ok: status === 200, status, json: async () => body };
  };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) { waits.push(ms); ms = 0; }
    return realSetTimeout(fn, ms, ...rest);
  };
  try {
    const trail = [];
    return { result: await run(trail), trail, hosts, waits };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
}

const OK = [200, { candidates: [{ content: { parts: [{ text: '[true]' }] } }] }];
const BUSY = [503, { error: { message: 'high demand' } }];

describe('gemini retries', () => {
  const ask = (script) => withFakeNetwork(script, (trail) =>
    loadBackend().geminiGenerate([{ text: 'x' }], 'screenshot filter', trail));

  it('keeps trying while Google is busy, waiting longer each time', async () => {
    const { result, waits, trail } = await ask([BUSY, BUSY, OK]);
    assert.equal(result, '[true]');
    assert.deepEqual(waits, [2000, 4000]);
    assert.match(trail.join(' '), /succeeded after 2 retries/);
  });

  it('gives up after 5 tries and returns null instead of throwing', async (t) => {
    const { result, hosts, waits, trail } = await ask([BUSY]);
    t.diagnostic(`${hosts.length} attempts, waits ${waits.join('/')}ms`);
    assert.equal(result, null);
    assert.equal(hosts.length, 5);
    assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
    assert.match(trail.join(' '), /FAILED after retrying/);
  });

  it('tries the other endpoint, without waiting, if the key is rejected', async () => {
    const { hosts, waits } = await ask([[403, { error: { message: 'key not valid' } }], OK]);
    assert.deepEqual(hosts, ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com']);
    assert.deepEqual(waits, []);
  });
});

// accurate captions toggle

// Sets up a fake text-to-speech client that records each call. "second" is the extra silent
// voice that measures word timings, which is the one that costs money.
function voiceSetup() {
  makeMedia();
  const calls = [];
  const wav = fs.readFileSync(file('tts.wav'));
  fake.tts = async (req) => {
    const ssml = req.input.ssml;
    calls.push(ssml ? 'second' : 'main');
    const marks = ssml ? (ssml.match(/<mark /g) || []).length : 0;
    return [{
      audioContent: wav,
      timepoints: Array.from({ length: marks }, (_, i) => ({ markName: `w${i}`, timeSeconds: 0.1 + i * 0.25 })),
    }];
  };
  const backend = loadBackend();
  const say = (settings, tag) => backend.jobOptions.run(settings, () =>
    backend.synthesizeLine('she cares and she communicated clearly', FIX, tag));
  return { calls, say };
}

describe('accurate captions toggle', { skip: noMedia, timeout: 60000 }, () => {
  it('uses the second voice to measure word timings when on', async () => {
    const { calls, say } = voiceSetup();
    const line = await say({ accurateCaptions: true }, 'on');
    assert.deepEqual(calls, ['main', 'second']);
    assert.ok(line.referenceTimings);
  });

  it('skips the second voice when off, and estimates the timings instead', async (t) => {
    const { calls, say } = voiceSetup();
    const line = await say({ accurateCaptions: false }, 'off');
    t.diagnostic(`voice calls when off: ${calls.length} (on: 2)`);
    assert.deepEqual(calls, ['main']);
    assert.ok(line.estimatedTimings && !line.referenceTimings);
  });

  it('still defaults to accurate for jobs saved before the setting existed', async () => {
    const { calls, say } = voiceSetup();
    await say({}, 'old');
    assert.deepEqual(calls, ['main', 'second']);
  });

  it('keeps settings separate when two jobs run at the same time', async () => {
    const { calls, say } = voiceSetup();
    const [a, b] = await Promise.all([say({ accurateCaptions: true }, 'a'), say({ accurateCaptions: false }, 'b')]);
    assert.ok(a.referenceTimings && !b.referenceTimings);
    assert.equal(calls.length, 3);

    // why it isn't a plain global variable: with one, the second job overwrites the first's value
    let flag;
    const setFlag = async (value) => { flag = value; await sleep(1); return flag; };
    assert.notDeepEqual(await Promise.all([setFlag(true), setFlag(false)]), [true, false]);
  });
});

// hook choice

const candidate = (text, segIdx, lineIndices) => ({ text, segIdx, lineIdx: lineIndices.at(-1), lineIndices });
const POOL = [
  candidate('AITA for hiding the heirlooms', 0, [0]), // first phrase of the first post
  candidate('He started yelling', 0, [4]),
  candidate('I hid seven birds', 0, [5]),
  candidate('Second post opener', 1, [0]),
];

function hookSetup(reply = '1') {
  const prompts = [];
  const state = { reply };
  fake.claude = async (args) => {
    prompts.push(args.messages[0].content);
    if (state.reply === 'THROW') throw new Error('api down');
    return { content: [{ text: state.reply }] };
  };
  return { backend: loadBackend(), prompts, state };
}

describe('hook choice', () => {
  it('drops only the first phrase of the first post when the voice reads the hook', () => {
    const { backend } = hookSetup();
    assert.equal(backend.hookPoolFor(POOL, true).length, 4);
    const pool = backend.hookPoolFor(POOL, false);
    assert.ok(!pool.includes(POOL[0]));
    assert.ok(pool.includes(POOL[3])); // line 0 of a LATER post is fine
    assert.equal(backend.hookPoolFor([POOL[0]], false).length, 1); // but never leave a video with no hook
  });

  it('only asks the AI for a line when the voice reads the hook, and for a phrase otherwise', async () => {
    const { backend, prompts, state } = hookSetup('1');
    const trail = [];
    const line = await backend.pickHookLine(backend.hookPoolFor(POOL, false), trail, { phraseHook: false });
    assert.deepEqual(line, { idx: 1, phraseIdx: null });
    assert.ok(!prompts.at(-1).includes('SPOKEN PHRASES'));
    assert.ok(trail.some((l) => l.includes('shown AND read aloud')));

    state.reply = '2,5';
    const phrase = await backend.pickHookLine(POOL, trail, { phraseHook: true });
    assert.equal(phrase.phraseIdx, 5);
    assert.ok(trail.some((l) => l.includes(backend.HOOK_VOICE_LINES[5])));
  });

  it('falls back to something valid when the AI is useless', async () => {
    const { backend, state } = hookSetup();
    for (const reply of ['sorry, no idea', '99,99', 'THROW']) {
      state.reply = reply;
      const pick = await backend.pickHookLine(POOL, [], { phraseHook: true });
      assert.ok(pick.idx >= 0 && pick.idx < POOL.length, `bad line for "${reply}"`);
      assert.ok(pick.phraseIdx >= 0 && pick.phraseIdx < backend.HOOK_VOICE_LINES.length, `bad phrase for "${reply}"`);
    }
  });
});

//  captions

describe('captions', () => {
  // quotes and colons in the caption text used to break ffmpeg's drawtext and kill the render
  it('cleans up punctuation before it reaches the ffmpeg filter graph', { skip: noMedia, timeout: 120000 }, async () => {
    makeMedia();
    const backend = loadBackend();
    const words = ['(Sorry', "don't", '"abandoning"', '[edited]', 'time:', '2.5', '...', 'Hello!'];
    const lines = [{
      text: words.join(' '), start: 0, end: 3, revealFrac: 0.3, emotion: 'happy',
      words: words.map((word, i) => ({ word, start: i * 0.35, end: i * 0.35 + 0.33 })),
    }];
    await backend.renderClip({
      bgVideo: file('bg.mp4'), bgStart: 1, duration: 3.2, imgPath: file('post.png'), spritePaths: {},
      audioPath: file('voice.wav'), lines, phraseSegments: [], outPath: file('cap.mp4'), mode: 'gameplay',
    });

    assert.ok(fs.statSync(file('cap.mp4')).size > 1000); // ffmpeg accepted it and rendered
    const graph = fs.readFileSync(file('filter_cap.txt'), 'utf8');
    const shown = [...new Set([...graph.matchAll(/drawtext=text='([^']*)'/g)].map((m) => m[1]))];
    assert.ok(shown.every((s) => /^[A-Za-z0-9?!]+$/.test(s)), `unexpected characters in: ${shown}`);
    assert.deepEqual(shown.sort(), ['25', 'Hello!', 'Sorry', 'abandoning', 'dont', 'edited', 'time']);
  });
});

// repo guard
// After the env.yaml / 474 MB video mess when pushing to GitHub: fail loudly if something
// like that is ever tracked again.

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /GOCSPX-[A-Za-z0-9_-]{10,}/,
  /AQ\.Ab[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function findProblems(files) {
  const problems = [];
  for (const f of files) {
    if (/(^|\/)env\.yaml$/.test(f.path)) problems.push(`${f.path}: secrets file is tracked`);
    if (/(^|\/)node_modules\//.test(f.path)) problems.push(`${f.path}: dependencies are tracked`);
    if (f.size > 50 * 1048576) problems.push(`${f.path}: ${Math.round(f.size / 1048576)} MB (GitHub warns at 50, rejects at 100)`);
    for (const pattern of SECRET_PATTERNS) {
      if (f.text && pattern.test(f.text)) problems.push(`${f.path}: looks like it contains a secret`);
    }
  }
  return problems;
}

describe('repo guard', () => {
  it('flags the env.yaml / node_modules / huge video mess, but not a normal file', () => {
    // built at runtime so this file doesn't itself contain something key-shaped
    const fakeKey = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');
    const problems = findProblems([
      { path: 'render-service/env.yaml', size: 400, text: `ANTHROPIC_API_KEY: ${fakeKey}` },
      { path: 'render-service/node_modules/ws/index.js', size: 9 },
      { path: 'assets/videoplayback.mp4', size: 420 * 1048576 },
    ]);
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.deepEqual(findProblems([{ path: 'src/app.ts', size: 900, text: 'export const x = 1;' }]), []);
  });

  it('finds nothing risky tracked by git right now', (t) => {
    const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    const root = process.env.REPO_ROOT || git(['rev-parse', '--show-toplevel'], __dirname).stdout.trim();
    if (!root) return t.skip('not inside a git checkout');

    const files = git(['ls-files', '-z'], root).stdout.split('\0').filter(Boolean).map((p) => {
      try {
        const { size } = fs.statSync(path.join(root, p));
        const buf = size < 1.5e6 ? fs.readFileSync(path.join(root, p)) : null;
        return { path: p, size, text: buf && !buf.includes(0) ? buf.toString('utf8') : '' };
      } catch {
        return null; // deleted but still listed
      }
    }).filter(Boolean);

    t.diagnostic(`scanned ${files.length} tracked files`);
    assert.deepEqual(findProblems(files), []);
  });
});