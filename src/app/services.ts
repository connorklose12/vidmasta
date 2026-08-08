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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}


function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

@Injectable({ providedIn: 'root' })
export class VideoService {

  async generateVideo(
    postFiles: File[],
    title: string,
    sprites: Partial<Record<Emotion, File>>
  ): Promise<{ videoUrl: string; videoBlob: Blob; debug: string[] }> {
    return withTimeout(this.generateVideoInner(postFiles, title, sprites), 3 * 60 * 1000, 'Video generation');
  }

  private async generateVideoInner(
    postFiles: File[],
    title: string,
    sprites: Partial<Record<Emotion, File>>
  ): Promise<{ videoUrl: string; videoBlob: Blob; debug: string[] }> {
    console.log('[Vidmasta] generateVideo: encoding', postFiles.length, 'screenshot(s) to base64...');
    const images = await Promise.all(postFiles.map(async (f) => ({ base64: await fileToBase64(f) })));

    const spriteEntries: [string, string][] = [];
    for (const [emotion, file] of Object.entries(sprites)) {
      if (file) spriteEntries.push([emotion, await fileToBase64(file)]);
    }
    console.log('[Vidmasta] generateVideo: encoded', spriteEntries.length, 'sprite(s), sending /generate request...');

    const res = await fetch(`${RENDER_SERVICE_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, images, sprites: Object.fromEntries(spriteEntries) }),
    });
    console.log('[Vidmasta] generateVideo: /generate responded with status', res.status);

    let debug: string[] = [];
    const rawDebug = res.headers.get('X-Vidmasta-Debug');
    if (rawDebug) {
      try {
        debug = JSON.parse(decodeURIComponent(rawDebug));
      } catch {
        debug = [rawDebug];
      }
      console.log('[Vidmasta] generate debug trail:', debug);
    } else {
      console.warn('[Vidmasta] No X-Vidmasta-Debug header on the response — either the server is running an older build, or something between the browser and the render service is stripping custom headers.');
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error('[Vidmasta] /generate failed:', errText, debug);
      const err: any = new Error(errText);
      err.debug = debug;
      throw err;
    }

    console.log('[Vidmasta] generateVideo: reading response body as blob...');
    const videoBlob = await res.blob();
    console.log('[Vidmasta] generateVideo: blob received,', videoBlob.size, 'bytes — creating object URL');
    const videoUrl = URL.createObjectURL(videoBlob);
    console.log('[Vidmasta] generateVideo: done.');
    return { videoUrl, videoBlob, debug };
  }
}

@Injectable({ providedIn: 'root' })
export class YouTubeService {
  constructor(private auth: Auth) {}

  private async idToken(): Promise<string> {
    const u = this.auth.currentUser;
    if (!u) throw new Error('Not signed in.');
    return withTimeout(u.getIdToken(), 10000, 'Fetching your sign-in token');
  }

  async status(): Promise<boolean> {
    try {
      const idToken = await this.idToken();
      const res = await fetch(`${RENDER_SERVICE_URL}/youtube/status`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        console.error('[Vidmasta] /youtube/status failed:', res.status, await res.text());
        return false;
      }
      return !!(await res.json()).connected;
    } catch (err) {
      console.error('[Vidmasta] /youtube/status error:', err);
      return false;
    }
  }

  async connect(): Promise<void> {
    const popup = window.open('', 'youtube-connect', 'width=520,height=650');
    if (!popup) {
      console.error('[Vidmasta] YouTube connect: popup was blocked by the browser.');
      throw new Error('Popup blocked — please allow popups for this site and try again.');
    }

    try {
      const idToken = await this.idToken();
      const res = await withTimeout(
        fetch(`${RENDER_SERVICE_URL}/youtube/auth-url`, {
          headers: { Authorization: `Bearer ${idToken}` },
        }),
        10000,
        'Requesting the YouTube connect URL'
      );
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Vidmasta] /youtube/auth-url failed: ${res.status}`, errText);
        throw new Error(`Server said: ${errText}`);
      }
      const { url } = await res.json();
      popup.location.href = url;
    } catch (err) {
      console.error('[Vidmasta] YouTube connect failed:', err);
      popup.close();
      throw err;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        clearInterval(poll);
        clearTimeout(giveUp);
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'vidmasta-youtube-connected') {
          if (event.data.success === false) {
            console.error('[Vidmasta] YouTube OAuth callback reported failure — check the /youtube/callback logs in Cloud Run for the real reason.');
          }
          finish();
        }
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup.closed) finish();
      }, 500);
      const giveUp = setTimeout(() => {
        console.error('[Vidmasta] YouTube connect: timed out after 5 minutes waiting for the popup to finish — it may still be open, or window.close()/postMessage never fired.');
        finish();
      }, 5 * 60 * 1000);
    });
  }

  private async freshAccessToken(): Promise<string> {
    const idToken = await this.idToken();
    const res = await fetch(`${RENDER_SERVICE_URL}/youtube/access-token`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[Vidmasta] /youtube/access-token failed:', res.status, errText);
      throw new Error(errText);
    }
    return (await res.json()).accessToken;
  }

  async uploadShort(videoBlob: Blob, title: string): Promise<void> {
    console.log('[Vidmasta] uploadShort: encoding', videoBlob.size, 'bytes to base64...');
    const idToken = await this.idToken();
    const videoBase64 = await blobToBase64(videoBlob);
    console.log('[Vidmasta] uploadShort: sending to /youtube/upload...');

    const res = await fetch(`${RENDER_SERVICE_URL}/youtube/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ title, videoBase64 }),
    });
    console.log('[Vidmasta] uploadShort: /youtube/upload responded with status', res.status);
    if (!res.ok) {
      const errText = await res.text();
      console.error('[Vidmasta] /youtube/upload failed:', res.status, errText);
      throw new Error(errText);
    }
  }
}


export interface TiktokCreatorInfo {
  creator_username: string;
  creator_nickname: string;
  creator_avatar_url: string;
  privacy_level_options: string[];
  max_video_post_duration_sec: number;
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
}


export interface TiktokPostOptions {
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
}

@Injectable({ providedIn: 'root' })
export class TikTokService {
  constructor(private auth: Auth) {}

  private async idToken(): Promise<string> {
    const u = this.auth.currentUser;
    if (!u) throw new Error('Not signed in.');
    return withTimeout(u.getIdToken(), 10000, 'Fetching your sign-in token');
  }

  async status(): Promise<boolean> {
    try {
      const idToken = await this.idToken();
      const res = await fetch(`${RENDER_SERVICE_URL}/tiktok/status`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        console.error('[Vidmasta] /tiktok/status failed:', res.status, await res.text());
        return false;
      }
      return !!(await res.json()).connected;
    } catch (err) {
      console.error('[Vidmasta] /tiktok/status error:', err);
      return false;
    }
  }

  async connect(): Promise<void> {
    const popup = window.open('', 'tiktok-connect', 'width=520,height=650');
    if (!popup) {
      console.error('[Vidmasta] TikTok connect: popup was blocked by the browser.');
      throw new Error('Popup blocked — please allow popups for this site and try again.');
    }

    try {
      const idToken = await this.idToken();
      const res = await withTimeout(
        fetch(`${RENDER_SERVICE_URL}/tiktok/auth-url`, {
          headers: { Authorization: `Bearer ${idToken}` },
        }),
        10000,
        'Requesting the TikTok connect URL'
      );
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Vidmasta] /tiktok/auth-url failed: ${res.status}`, errText);
        throw new Error(`Server said: ${errText}`);
      }
      const { url } = await res.json();
      popup.location.href = url;
    } catch (err) {
      console.error('[Vidmasta] TikTok connect failed:', err);
      popup.close();
      throw err;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        clearInterval(poll);
        clearTimeout(giveUp);
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'vidmasta-tiktok-connected') {
          if (event.data.success === false) {
            console.error('[Vidmasta] TikTok OAuth callback reported failure — check the /tiktok/callback logs in Cloud Run for the real reason.');
          }
          finish();
        }
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup.closed) finish();
      }, 500);
      const giveUp = setTimeout(() => {
        console.error('[Vidmasta] TikTok connect: timed out after 5 minutes waiting for the popup to finish.');
        finish();
      }, 5 * 60 * 1000);
    });
  }

  async getCreatorInfo(): Promise<TiktokCreatorInfo> {
    const idToken = await this.idToken();
    const res = await fetch(`${RENDER_SERVICE_URL}/tiktok/creator-info`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[Vidmasta] /tiktok/creator-info failed:', res.status, errText);
      throw new Error(errText);
    }
    return res.json();
  }

  async publish(videoBlob: Blob, title: string, options: TiktokPostOptions): Promise<{ publishId: string; status: string }> {
    console.log('[Vidmasta] tiktok publish: encoding', videoBlob.size, 'bytes to base64...');
    const idToken = await this.idToken();
    const videoBase64 = await blobToBase64(videoBlob);
    console.log('[Vidmasta] tiktok publish: sending to /tiktok/publish', options);

    const res = await withTimeout(
      fetch(`${RENDER_SERVICE_URL}/tiktok/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ title, videoBase64, ...options }),
      }),
      3 * 60 * 1000,
      'Posting to TikTok'
    );
    console.log('[Vidmasta] tiktok publish: /tiktok/publish responded with status', res.status);
    if (!res.ok && res.status !== 202) {
      const errText = await res.text();
      console.error('[Vidmasta] /tiktok/publish failed:', res.status, errText);
      throw new Error(errText);
    }
    return res.json();
  }
}

@Injectable({ providedIn: 'root' })
export class InstagramService {
  constructor(private auth: Auth) {}

  private async idToken(): Promise<string> {
    const u = this.auth.currentUser;
    if (!u) throw new Error('Not signed in.');
    return withTimeout(u.getIdToken(), 10000, 'Fetching your sign-in token');
  }

  async status(): Promise<boolean> {
    try {
      const idToken = await this.idToken();
      const res = await fetch(`${RENDER_SERVICE_URL}/instagram/status`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        console.error('[Vidmasta] /instagram/status failed:', res.status, await res.text());
        return false;
      }
      return !!(await res.json()).connected;
    } catch (err) {
      console.error('[Vidmasta] /instagram/status error:', err);
      return false;
    }
  }

  async connect(): Promise<void> {
    const popup = window.open('', 'instagram-connect', 'width=520,height=650');
    if (!popup) {
      console.error('[Vidmasta] Instagram connect: popup was blocked by the browser.');
      throw new Error('Popup blocked — please allow popups for this site and try again.');
    }

    try {
      const idToken = await this.idToken();
      const res = await withTimeout(
        fetch(`${RENDER_SERVICE_URL}/instagram/auth-url`, {
          headers: { Authorization: `Bearer ${idToken}` },
        }),
        10000,
        'Requesting the Instagram connect URL'
      );
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Vidmasta] /instagram/auth-url failed: ${res.status}`, errText);
        throw new Error(`Server said: ${errText}`);
      }
      const { url } = await res.json();
      popup.location.href = url;
    } catch (err) {
      console.error('[Vidmasta] Instagram connect failed:', err);
      popup.close();
      throw err;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        clearInterval(poll);
        clearTimeout(giveUp);
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'vidmasta-instagram-connected') {
          if (event.data.success === false) {
            console.error('[Vidmasta] Instagram OAuth callback reported failure — check the /instagram/callback logs in Cloud Run for the real reason.');
          }
          finish();
        }
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup.closed) finish();
      }, 500);
      const giveUp = setTimeout(() => {
        console.error('[Vidmasta] Instagram connect: timed out after 5 minutes waiting for the popup to finish.');
        finish();
      }, 5 * 60 * 1000);
    });
  }

  async publish(videoBlob: Blob, title: string): Promise<{ mediaId?: string; status: string }> {
    console.log('[Vidmasta] instagram publish: encoding', videoBlob.size, 'bytes to base64...');
    const idToken = await this.idToken();
    const videoBase64 = await blobToBase64(videoBlob);
    console.log('[Vidmasta] instagram publish: sending to /instagram/publish...');

    const res = await withTimeout(
      fetch(`${RENDER_SERVICE_URL}/instagram/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ title, videoBase64 }),
      }),
      4 * 60 * 1000,
      'Posting to Instagram'
    );
    console.log('[Vidmasta] instagram publish: /instagram/publish responded with status', res.status);
    if (!res.ok && res.status !== 202) {
      const errText = await res.text();
      console.error('[Vidmasta] /instagram/publish failed:', res.status, errText);
      throw new Error(errText);
    }
    return res.json();
  }
}