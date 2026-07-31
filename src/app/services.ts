import { Injectable } from '@angular/core';
import { Auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, user } from '@angular/fire/auth';

export const EMOTIONS = ['happy', 'excited', 'sad', 'mad', 'confused', 'grossed_out', 'afraid', 'shocked'] as const;
export type Emotion = (typeof EMOTIONS)[number];

// Point this at your deployed Cloud Run render service.
export const RENDER_SERVICE_URL = 'https://vidmasta-render-48588159973.us-central1.run.app';

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: ReturnType<typeof user>;
  constructor(private auth: Auth) {
    this.user$ = user(this.auth);
  }
  login(email: string, password: string) { return signInWithEmailAndPassword(this.auth, email, password); }
  signup(email: string, password: string) { return createUserWithEmailAndPassword(this.auth, email, password); }
  logout() { return signOut(this.auth); }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]); // strip data: prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// The render service streams the finished video + music back as a single
// multipart/mixed HTTP response (not JSON) — this is what lets the server
// avoid Cloud Run's response-size ceiling without uploading anywhere. This
// splits that response into two Blobs and hands back local object URLs,
// which <video>/<audio> elements can use exactly like any other URL.
async function parseMultipartResponse(res: Response): Promise<{ videoUrl: string; musicUrl: string }> {
  const contentType = res.headers.get('Content-Type') || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw new Error('Unexpected response format from render service');
  const boundary = '--' + boundaryMatch[1];

  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // latin1 maps each byte to one char 1:1, so string indices line up exactly
  // with byte offsets — safe for finding the boundary even inside binary data.
  const text = new TextDecoder('latin1').decode(bytes);

  const parts: { contentType: string; start: number; end: number }[] = [];
  let cursor = text.indexOf(boundary);
  while (cursor !== -1) {
    const nextBoundary = text.indexOf(boundary, cursor + boundary.length);
    if (nextBoundary === -1) break;
    const section = text.slice(cursor + boundary.length, nextBoundary);
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = section.slice(0, headerEnd);
      const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
      const bodyStart = cursor + boundary.length + headerEnd + 4;
      const bodyEnd = nextBoundary - 2; // trailing \r\n before the next boundary
      if (ctMatch) parts.push({ contentType: ctMatch[1].trim(), start: bodyStart, end: bodyEnd });
    }
    cursor = nextBoundary;
  }

  const videoPart = parts.find((p) => p.contentType.startsWith('video/'));
  const musicPart = parts.find((p) => p.contentType.startsWith('audio/'));
  if (!videoPart || !musicPart) throw new Error('Render response was missing the video or music part');

  const videoBlob = new Blob([bytes.slice(videoPart.start, videoPart.end)], { type: videoPart.contentType });
  const musicBlob = new Blob([bytes.slice(musicPart.start, musicPart.end)], { type: musicPart.contentType });

  return { videoUrl: URL.createObjectURL(videoBlob), musicUrl: URL.createObjectURL(musicBlob) };
}

@Injectable({ providedIn: 'root' })
export class VideoService {
  // Sends everything in one request — nothing is saved to Storage or Firestore.
  // The finished video/music stream straight back in the same response.
  async generateVideo(
    postFiles: File[],
    title: string,
    sprites: Partial<Record<Emotion, File>>
  ): Promise<{ videoUrl: string; musicUrl: string }> {
    const images = await Promise.all(postFiles.map(async (f) => ({ base64: await fileToBase64(f) })));

    const spriteEntries: [string, string][] = [];
    for (const [emotion, file] of Object.entries(sprites)) {
      if (file) spriteEntries.push([emotion, await fileToBase64(file)]);
    }

    const res = await fetch(`${RENDER_SERVICE_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, images, sprites: Object.fromEntries(spriteEntries) }),
    });

    if (!res.ok) throw new Error(await res.text());
    return parseMultipartResponse(res);
  }
}