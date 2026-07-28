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

@Injectable({ providedIn: 'root' })
export class VideoService {
  // Sends everything in one request — nothing is saved to Storage or Firestore.
  // The finished video comes straight back in the response.
  async generateVideo(
    postFiles: File[],
    title: string,
    sprites: Partial<Record<Emotion, File>>
  ): Promise<{ videoBase64: string; videoNoMusicBase64: string }> {
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
    return res.json();
  }
}