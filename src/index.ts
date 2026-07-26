// import * as admin from 'firebase-admin';
// import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
// import { setGlobalOptions } from 'firebase-functions/v2';
// import * as vision from '@google-cloud/vision';
// import * as textToSpeech from '@google-cloud/text-to-speech';
// import { google } from 'googleapis';
// import ffmpeg from 'fluent-ffmpeg';
// import ffmpegPath from 'ffmpeg-static';
// import * as fs from 'fs';
// import * as os from 'os';
// import * as path from 'path';

// admin.initializeApp();
// setGlobalOptions({ memory: '2GiB', timeoutSeconds: 540 });
// ffmpeg.setFfmpegPath(ffmpegPath as string);

// const db = admin.firestore();
// const bucket = admin.storage().bucket();
// const visionClient = new vision.ImageAnnotatorClient();
// const ttsClient = new textToSpeech.TextToSpeechClient();

// // ---------- fill these in ----------
// const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || 'YOUR_CLIENT_ID';
// const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
// const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/youtubeOAuthCallback';

// const oauthClient = () => new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);

// // UI chrome to strip out of OCR results: like/reply counts, action-bar labels, handles
// const UI_NOISE = /^(like|likes|reply|replies|share|shares|retweet|retweets|repost|reposts|comment|comments|follow|following|save|report|\d+(\.\d+)?[km]?$|@\w+$)$/i;

// const EMOTION_KEYWORDS: Record<string, string[]> = {
//   happy: ['happy', 'glad', 'joy', 'great', 'awesome', 'love', 'yay', 'lol'],
//   excited: ['excited', 'omg', 'amazing', "can't wait", 'hyped', 'wow'],
//   sad: ['sad', 'cry', 'crying', 'heartbroken', 'depressed', 'miss'],
//   mad: ['mad', 'angry', 'furious', 'pissed', 'hate', 'rage'],
//   confused: ['confused', 'what', 'huh', 'unclear', 'lost', 'why'],
//   grossed_out: ['gross', 'disgusting', 'ew', 'nasty', 'sick'],
//   afraid: ['afraid', 'scared', 'terrified', 'fear', 'creepy'],
//   shocked: ['shocked', 'wtf', 'unbelievable', 'no way', "can't believe"],
// };

// interface WordTiming { word: string; startSec: number; endSec: number; }

// // ---------- OCR: keep only the post's own text ----------
// async function extractPostText(imageBuffer: Buffer): Promise<string> {
//   const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
//   const annotations = result.textAnnotations || [];
//   if (!annotations.length) return '';

//   const imgHeight = result.fullTextAnnotation?.pages?.[0]?.height || 1000;
//   const topCut = imgHeight * 0.12, bottomCut = imgHeight * 0.90;

//   return annotations.slice(1)
//     .filter(a => {
//       const text = (a.description || '').trim();
//       const y = a.boundingPoly?.vertices?.[0]?.y ?? 0;
//       return text && !UI_NOISE.test(text) && y >= topCut && y <= bottomCut;
//     })
//     .map(a => a.description!.trim())
//     .join(' ')
//     .replace(/\s+/g, ' ')
//     .trim();
// }

// function classifyEmotion(sentence: string): string {
//   const lower = sentence.toLowerCase();
//   return Object.entries(EMOTION_KEYWORDS).find(([, words]) => words.some(w => lower.includes(w)))?.[0] || 'neutral';
// }

// // ---------- TTS: word-level timings for karaoke captions ----------
// async function synthesizeSpeech(text: string, outPath: string): Promise<WordTiming[]> {
//   const words = text.split(/\s+/).filter(Boolean);
//   const ssml = `<speak>${words.map((w, i) => `<mark name="w${i}"/>${w.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join(' ')}</speak>`;

//   const [response] = await ttsClient.synthesizeSpeech({
//     input: { ssml },
//     voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
//     audioConfig: { audioEncoding: 'MP3' },
//     enableTimePointing: ['SSML_MARK'] as any,
//   } as any);

//   fs.writeFileSync(outPath, response.audioContent as Buffer);

//   const marks = (response as any).timepoints || [];
//   return words.map((word, i) => ({
//     word,
//     startSec: marks[i]?.timeSeconds ?? i * 0.4,
//     endSec: marks[i + 1]?.timeSeconds ?? (marks[i]?.timeSeconds ?? i * 0.4) + 0.4,
//   }));
// }

// // ---------- captions: ASS karaoke file, uppercase, green highlight ----------
// function buildKaraokeAss(timings: WordTiming[], w: number, h: number): string {
//   const header = `[Script Info]\nPlayResX: ${w}\nPlayResY: ${h}\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginV\nStyle: Default,Arial Black,72,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,1,4,2,2,120\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n`;
//   const toAssTime = (sec: number) => {
//     const h2 = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60).toFixed(2);
//     return `${h2}:${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`;
//   };
//   const lines: string[] = [];
//   for (let i = 0; i < timings.length; i += 5) {
//     const chunk = timings.slice(i, i + 5);
//     const karaoke = chunk.map(w2 => `{\\k${Math.round((w2.endSec - w2.startSec) * 100)}}${w2.word.toUpperCase()}`).join(' ');
//     lines.push(`Dialogue: 0,${toAssTime(chunk[0].startSec)},${toAssTime(chunk[chunk.length - 1].endSec)},Default,${karaoke}`);
//   }
//   return header + lines.join('\n');
// }

// // ---------- render helpers ----------
// async function downloadToTmp(storagePath: string): Promise<string> {
//   const tmp = path.join(os.tmpdir(), `${path.basename(storagePath)}_${Date.now()}`);
//   await bucket.file(storagePath).download({ destination: tmp });
//   return tmp;
// }

// async function pickRandomAsset(folder: string): Promise<string | null> {
//   const [files] = await bucket.getFiles({ prefix: folder });
//   const usable = files.filter(f => !f.name.endsWith('/'));
//   return usable.length ? downloadToTmp(usable[Math.floor(Math.random() * usable.length)].name) : null;
// }

// function runFfmpeg(args: string[], outPath: string): Promise<void> {
//   return new Promise((resolve, reject) => {
//     ffmpeg().addOptions(args).output(outPath).on('end', () => resolve()).on('error', reject).run();
//   });
// }

// // One post = crop-reveal image + narration + karaoke captions + emotion sprite
// async function buildPostSegment(opts: {
//   imagePath: string; audioPath: string; assPath: string;
//   spritePath: string | null; durationSec: number; outPath: string;
// }): Promise<void> {
//   const { imagePath, audioPath, assPath, spritePath, durationSec, outPath } = opts;
//   const W = 1080, H = 1920;

//   const filters = [`[0:v]scale=${W}:-1,crop=${W}:'ih*min(1\\,t/${durationSec})':0:0,pad=${W}:${H}:0:0:black,setsar=1[base]`];
//   let label = 'base';
//   if (spritePath) {
//     filters.push(`[1:v]scale=${Math.round(W * 0.4)}:-1[sprite]`, `[${label}][sprite]overlay=W-w-40:H-h-200[withSprite]`);
//     label = 'withSprite';
//   }
//   filters.push(`[${label}]subtitles='${assPath.replace(/:/g, '\\:')}'[captioned]`);

//   const inputs = ['-loop', '1', '-i', imagePath];
//   if (spritePath) inputs.push('-loop', '1', '-i', spritePath);
//   inputs.push('-i', audioPath);

//   await runFfmpeg([
//     ...inputs,
//     '-filter_complex', filters.join(';'),
//     '-map', '[captioned]', '-map', `${spritePath ? 2 : 1}:a`,
//     '-t', String(durationSec),
//     '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
//   ], outPath);
// }

// // Concats post segments (with sfx at cuts), lays background clip + music underneath
// async function assembleFinal(opts: {
//   segmentPaths: string[]; bgVideo: string | null; bgMusic: string | null;
//   outPath: string; outPathNoMusic: string;
// }): Promise<void> {
//   const { segmentPaths, bgVideo, bgMusic, outPath, outPathNoMusic } = opts;

//   const listFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
//   fs.writeFileSync(listFile, segmentPaths.map(p => `file '${p}'`).join('\n'));
//   const concatOut = path.join(os.tmpdir(), `concat_${Date.now()}.mp4`);
//   // Note: hard cuts between posts. For a true video crossfade instead of a
//   // cut + transition sound, chain per-pair `xfade` filters here instead.
//   await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy'], concatOut);
//   fs.copyFileSync(concatOut, outPathNoMusic); // "music off" version = voice + sfx only

//   const inputs = ['-i', concatOut];
//   const filterParts: string[] = [];
//   let videoLabel = '0:v', audioLabel = '0:a';

//   if (bgVideo) {
//     inputs.push('-i', bgVideo);
//     filterParts.push(`[1:v]scale=1080:1920,crop=1080:1920[bgv]`, `[bgv][${videoLabel}]overlay=0:0[withBg]`);
//     videoLabel = 'withBg';
//   }
//   if (bgMusic) {
//     inputs.push('-i', bgMusic);
//     const musicIdx = inputs.length / 2 - 1;
//     filterParts.push(`[${musicIdx}:a]volume=0.15[music]`, `[${audioLabel}][music]amix=inputs=2:duration=first[mixedAudio]`);
//     audioLabel = 'mixedAudio';
//   }

//   await runFfmpeg([
//     ...inputs,
//     ...(filterParts.length ? ['-filter_complex', filterParts.join(';')] : []),
//     '-map', filterParts.length ? `[${videoLabel}]` : videoLabel,
//     '-map', audioLabel === 'mixedAudio' ? `[${audioLabel}]` : audioLabel,
//     '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
//   ], outPath);
// }

// // ---------- orchestrator ----------
// export const startRender = onCall(async (request) => {
//   const { jobId } = request.data;
//   const uid = request.auth?.uid;
//   if (!uid) throw new HttpsError('unauthenticated', 'Log in first.');

//   const jobRef = db.doc(`jobs/${jobId}`);
//   const job = (await jobRef.get()).data();
//   if (!job) throw new HttpsError('not-found', 'Job not found.');

//   try {
//     await jobRef.update({ status: 'ocr' });
//     const segmentPaths: string[] = [];

//     const spriteFiles: Record<string, string | null> = {};
//     for (const emotion of Object.keys(EMOTION_KEYWORDS)) {
//       const p = `users/${uid}/sprites/${emotion}.png`;
//       spriteFiles[emotion] = (await bucket.file(p).exists())[0] ? await downloadToTmp(p) : null;
//     }

//     for (let i = 0; i < job['imagePaths'].length; i++) {
//       const imgTmp = await downloadToTmp(job['imagePaths'][i]);
//       const text = await extractPostText(fs.readFileSync(imgTmp));
//       if (!text) continue;

//       await jobRef.update({ status: 'tts' });
//       const audioPath = path.join(os.tmpdir(), `audio_${i}_${Date.now()}.mp3`);
//       const timings = await synthesizeSpeech(text, audioPath);
//       const durationSec = timings[timings.length - 1]?.endSec ?? 3;
//       const spritePath = spriteFiles[classifyEmotion(text)] || null;

//       const assPath = path.join(os.tmpdir(), `caps_${i}_${Date.now()}.ass`);
//       fs.writeFileSync(assPath, buildKaraokeAss(timings, 1080, 1920));

//       await jobRef.update({ status: 'rendering' });
//       const segOut = path.join(os.tmpdir(), `seg_${i}_${Date.now()}.mp4`);
//       await buildPostSegment({ imagePath: imgTmp, audioPath, assPath, spritePath, durationSec, outPath: segOut });
//       segmentPaths.push(segOut);
//     }

//     if (!segmentPaths.length) {
//       await jobRef.update({ status: 'error', error: 'No readable text found in the image(s).' });
//       return { ok: false };
//     }

//     const bgVideo = await pickRandomAsset('assets/backgrounds/');
//     const bgMusic = await pickRandomAsset('assets/music/');
//     const finalOut = path.join(os.tmpdir(), `final_${Date.now()}.mp4`);
//     const finalOutNoMusic = path.join(os.tmpdir(), `final_nomusic_${Date.now()}.mp4`);
//     await assembleFinal({ segmentPaths, bgVideo, bgMusic, outPath: finalOut, outPathNoMusic: finalOutNoMusic });

//     const destPath = `users/${uid}/outputs/${jobId}.mp4`;
//     const destPathNoMusic = `users/${uid}/outputs/${jobId}_nomusic.mp4`;
//     await bucket.upload(finalOut, { destination: destPath });
//     await bucket.upload(finalOutNoMusic, { destination: destPathNoMusic });

//     const [outputUrl] = await bucket.file(destPath).getSignedUrl({ action: 'read', expires: '03-01-2030' });
//     const [outputUrlNoMusic] = await bucket.file(destPathNoMusic).getSignedUrl({ action: 'read', expires: '03-01-2030' });

//     await jobRef.update({ status: 'done', outputUrl, outputUrlNoMusic });
//     return { ok: true };
//   } catch (err: any) {
//     await jobRef.update({ status: 'error', error: err.message });
//     throw new HttpsError('internal', err.message);
//   }
// });

// // ---------- social connections + publishing ----------
// export const connectYoutube = onCall(async (request) => {
//   const uid = request.auth?.uid;
//   if (!uid) throw new HttpsError('unauthenticated', 'Log in first.');
//   const authUrl = oauthClient().generateAuthUrl({
//     access_type: 'offline',
//     scope: ['https://www.googleapis.com/auth/youtube.upload'],
//     state: uid,
//   });
//   return { authUrl };
// });

// // Deployed as a plain HTTPS endpoint — Google redirects here after consent.
// export const youtubeOAuthCallback = onRequest(async (req, res) => {
//   const { code, state: uid } = req.query;
//   const client = oauthClient();
//   const { tokens } = await client.getToken(code as string);
//   await db.doc(`users/${uid}/connections/youtube`).set({ platform: 'youtube', connected: true, tokens, handle: 'YouTube account' });
//   res.send('YouTube connected — you can close this tab.');
// });

// // TikTok/Instagram need an approved developer app on each platform before
// // any account can publish through them — this saves intent and says so.
// export const connectSocial = onCall(async (request) => {
//   const uid = request.auth?.uid;
//   const { platform, handle } = request.data;
//   if (!uid) throw new HttpsError('unauthenticated', 'Log in first.');
//   await db.doc(`users/${uid}/connections/${platform}`).set({
//     platform, connected: true, handle,
//     message: `Saved. ${platform} publishing needs an approved developer app — see TODO in connectSocial().`
//   });
//   return { ok: true };
// });

// export const publishVideo = onCall(async (request) => {
//   const uid = request.auth?.uid;
//   const { jobId, platform, musicOn } = request.data;
//   if (!uid) throw new HttpsError('unauthenticated', 'Log in first.');

//   const job = (await db.doc(`jobs/${jobId}`).get()).data();
//   if (!job) throw new HttpsError('not-found', 'Job not found.');
//   const videoUrl = musicOn ? job['outputUrl'] : job['outputUrlNoMusic'];

//   if (platform === 'youtube') {
//     const conn = (await db.doc(`users/${uid}/connections/youtube`).get()).data();
//     if (!conn?.connected) throw new HttpsError('failed-precondition', 'Connect YouTube first.');

//     const client = oauthClient();
//     client.setCredentials(conn.tokens);
//     const youtube = google.youtube({ version: 'v3', auth: client });

//     const [file] = await bucket.file(`users/${uid}/outputs/${jobId}${musicOn ? '' : '_nomusic'}.mp4`).download();
//     const tmpPath = path.join(os.tmpdir(), `${jobId}.mp4`);
//     fs.writeFileSync(tmpPath, file);

//     await youtube.videos.insert({
//       part: ['snippet', 'status'],
//       requestBody: { snippet: { title: job['title'], description: 'Uploaded via app', tags: ['shorts'] }, status: { privacyStatus: 'public' } },
//       media: { body: fs.createReadStream(tmpPath) },
//     });
//     return { ok: true, message: 'Published to YouTube Shorts.' };
//   }

//   return { ok: false, message: `${platform} publishing isn't live yet — needs an approved developer app for that platform's posting API. Video is ready at: ${videoUrl}` };
// });