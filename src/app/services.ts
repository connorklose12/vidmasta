import { Injectable } from '@angular/core';
import { Auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, user, authState } from '@angular/fire/auth';
import { firstValueFrom } from 'rxjs';

export const EMOTIONS = ['happy', 'excited', 'sad', 'mad', 'goofy_mood', 'confused', 'grossed_out', 'afraid', 'shocked', 'building_suspense'] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const RENDER_SERVICE_URL = 'https://vidmasta-render-48588159973.us-central1.run.app';
console.log('[Vidmasta] frontend build: 2026-09-24-schedule-upload-cancel');

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
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
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
  constructor(private auth: Auth) {}

  private async idToken(): Promise<string> {
    const u = await withTimeout(firstValueFrom(authState(this.auth)), 10000, 'Restoring your sign-in session');
    if (!u) throw new Error('Not signed in.');
    return withTimeout(u.getIdToken(), 10000, 'Fetching your sign-in token');
  }

  async generateVideo(
    postFiles: File[],
    title: string,
    sprites: Partial<Record<Emotion, File>>,
    mode: 'satisfying' | 'gameplay' | 'parkour' = 'satisfying',
    hidePost = false
  ): Promise<{ videoUrl: string; videoBlob: Blob; debug: string[]; jobId: string }> {
    return withTimeout(this.generateVideoInner(postFiles, title, sprites, mode, hidePost), 35 * 60 * 1000, 'Video generation');
  }

  private async generateVideoInner(
    postFiles: File[],
    title: string,
    sprites: Partial<Record<Emotion, File>>,
    mode: 'satisfying' | 'gameplay' | 'parkour',
    hidePost = false
  ): Promise<{ videoUrl: string; videoBlob: Blob; debug: string[]; jobId: string }> {
    console.log('[Vidmasta] generateVideo: encoding', postFiles.length, 'screenshot(s) to base64...');
    const images = await Promise.all(postFiles.map(async (f) => ({ base64: await fileToBase64(f) })));

    const spriteEntries: [string, string][] = [];
    for (const [emotion, file] of Object.entries(sprites)) {
      if (file) spriteEntries.push([emotion, await fileToBase64(file)]);
    }
    console.log('[Vidmasta] generateVideo: encoded', spriteEntries.length, 'sprite(s), mode =', mode, ', starting job...');

    const startRes = await fetch(`${RENDER_SERVICE_URL}/generate/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, images, sprites: Object.fromEntries(spriteEntries), mode, hidePost }),
    });
    if (!startRes.ok) {
      const errText = await startRes.text();
      console.error('[Vidmasta] /generate/start failed:', errText);
      throw new Error(errText);
    }
    const { jobId } = await startRes.json();
    console.log('[Vidmasta] generateVideo: job started, id =', jobId, '— polling for completion...');

    let debug: string[] = [];
    while (true) {
      await new Promise((r) => setTimeout(r, 4000));
      const statusRes = await fetch(`${RENDER_SERVICE_URL}/generate/status/${jobId}`);
      if (!statusRes.ok) {
        console.warn('[Vidmasta] generateVideo: one status poll failed, will retry:', statusRes.status);
        continue;
      }
      const statusData = await statusRes.json();
      debug = statusData.debug || debug;
      if (statusData.status === 'not_found') {
        throw new Error('Generation job expired or was not found — please try again.');
      }
      if (statusData.status === 'error') {
        console.error('[Vidmasta] generate job failed:', statusData.error, debug);
        const err: any = new Error(statusData.error || 'Video generation failed');
        err.debug = debug;
        throw err;
      }
      if (statusData.status === 'done') {
        console.log('[Vidmasta] generate debug trail:', debug);
        break;
      }
    }

    console.log('[Vidmasta] generateVideo: fetching finished video...');
    const resultRes = await fetch(`${RENDER_SERVICE_URL}/generate/result/${jobId}`);
    if (!resultRes.ok) {
      const errText = await resultRes.text();
      console.error('[Vidmasta] /generate/result failed:', errText, debug);
      const err: any = new Error(errText);
      err.debug = debug;
      throw err;
    }

    console.log('[Vidmasta] generateVideo: reading response body as blob...');
    const videoBlob = await resultRes.blob();
    console.log('[Vidmasta] generateVideo: blob received,', videoBlob.size, 'bytes — creating object URL');
    const videoUrl = URL.createObjectURL(videoBlob);
    console.log('[Vidmasta] generateVideo: done.');
    return { videoUrl, videoBlob, debug, jobId };
  }

  async createSchedule(
    files: File[],
    sprites: Partial<Record<Emotion, File>>,
    mode: 'satisfying' | 'gameplay' | 'parkour',
    slots: { atMs: number; title: string }[],
    tiktokOptions: TiktokPostOptions | null,
    onProgress?: (done: number, total: number) => void,
    hidePost = false
  ): Promise<{ scheduleId: string; entries: { atMs: number; title: string; imageCount: number }[] }> {
    const spriteList = Object.entries(sprites).filter(([, f]) => !!f) as [string, File][];
    const total = files.length + spriteList.length;
    console.log(`[Vidmasta] schedule: starting — ${files.length} photo(s), ${spriteList.length} sprite(s), ${slots.length} time slot(s)`);

    const post = async (pathName: string, body: any) => {
      const idToken = await this.idToken();
      return fetch(`${RENDER_SERVICE_URL}${pathName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
      });
    };

    const beginRes = await post('/schedule/begin', { imageCount: files.length, spriteCount: spriteList.length });
    if (!beginRes.ok) throw new Error(`Could not start the schedule upload: ${await beginRes.text()}`);
    const { scheduleId } = await beginRes.json();

    const uploadOne = async (label: string, file: File, body: any) => {
      const base64 = await fileToBase64(file);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await post('/schedule/upload', { scheduleId, base64, ...body });
          if (r.ok) return;
          const text = await r.text();
          if (attempt === 2) throw new Error(text || `HTTP ${r.status}`);
          console.warn(`[Vidmasta] schedule: ${label} failed (HTTP ${r.status}), retrying once:`, text);
        } catch (e: any) {
          if (attempt === 2) throw new Error(`${label} ("${file.name}", ${(file.size / 1024 / 1024).toFixed(1)} MB) failed to upload: ${e.message}`);
          console.warn(`[Vidmasta] schedule: ${label} network error, retrying once:`, e.message);
        }
      }
    };

    const jobs: (() => Promise<void>)[] = [
      ...files.map((f, i) => () => uploadOne(`Photo ${i + 1} of ${files.length}`, f, { index: i })),
      ...spriteList.map(([emotion, f]) => () => uploadOne(`Sprite "${emotion}"`, f, { emotion })),
    ];
    let done = 0;
    onProgress?.(0, total);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
        done++;
        onProgress?.(done, total);
        if (done % 10 === 0 || done === total) console.log(`[Vidmasta] schedule: uploaded ${done}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));

    const res = await post('/schedule/create', {
      slots, mode, tiktokOptions, scheduleId, hidePost,
      imageCount: files.length,
      spriteEmotions: spriteList.map(([e]) => e),
    });
    if (!res.ok) throw new Error(`Could not save the schedule: ${await res.text()}`);
    console.log(`[Vidmasta] schedule ${scheduleId}: saved`);
    return res.json();
  }

  async loadScheduleDraft(): Promise<{ dayOfWeek: number; time: string; title: string }[]> {
    const idToken = await this.idToken();
    const res = await fetch(`${RENDER_SERVICE_URL}/schedule/draft`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()).entries;
  }

  async saveScheduleDraft(entries: { dayOfWeek: number; time: string; title: string }[]): Promise<void> {
    const idToken = await this.idToken();
    const res = await fetch(`${RENDER_SERVICE_URL}/schedule/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) throw new Error(await res.text());
  }

  async listUpcomingScheduled(): Promise<{ scheduleId: string; idx: number; atMs: number; title: string; imageCount: number; mode: string }[]> {
    const idToken = await this.idToken();
    const res = await fetch(`${RENDER_SERVICE_URL}/schedule/list`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error(await res.text());
    const { schedules } = await res.json();
    const upcoming: { scheduleId: string; idx: number; atMs: number; title: string; imageCount: number; mode: string }[] = [];
    for (const sch of schedules) {
      (sch.entries || []).forEach((e: any, idx: number) => {
        if (e.status === 'pending') {
          upcoming.push({ scheduleId: sch.scheduleId, idx, atMs: e.atMs, title: e.title, imageCount: (e.imagePaths || []).length, mode: e.mode });
        }
      });
    }
    return upcoming.sort((a, b) => a.atMs - b.atMs);
  }

  async cancelScheduled(scheduleId: string, idx: number): Promise<void> {
    const idToken = await this.idToken();
    const res = await fetch(`${RENDER_SERVICE_URL}/schedule/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ scheduleId, idx }),
    });
    if (!res.ok) throw new Error(await res.text());
  }
}

@Injectable({ providedIn: 'root' })
export class YouTubeService {
  constructor(private auth: Auth) {}

  private async idToken(): Promise<string> {
    const u = await withTimeout(firstValueFrom(authState(this.auth)), 10000, 'Restoring your sign-in session');
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

  async uploadShort(jobId: string, title: string): Promise<void> {
    const idToken = await this.idToken();
    console.log('[Vidmasta] uploadShort: sending jobId to /youtube/upload...');

    const res = await fetch(`${RENDER_SERVICE_URL}/youtube/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ title, jobId }),
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
  yourBrand: boolean;
  brandedContent: boolean;
}

@Injectable({ providedIn: 'root' })
export class TikTokService {
  constructor(private auth: Auth) {}

  private async idToken(): Promise<string> {
    const u = await withTimeout(firstValueFrom(authState(this.auth)), 10000, 'Restoring your sign-in session');
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

  async publish(jobId: string, title: string, options: TiktokPostOptions): Promise<{ publishId: string; status: string }> {
    const idToken = await this.idToken();
    console.log('[Vidmasta] tiktok publish: sending jobId to /tiktok/publish', options);

    const res = await withTimeout(
      fetch(`${RENDER_SERVICE_URL}/tiktok/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ title, jobId, ...options }),
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
    const u = await withTimeout(firstValueFrom(authState(this.auth)), 10000, 'Restoring your sign-in session');
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

  async publish(jobId: string, title: string): Promise<{ mediaId?: string; status: string }> {
    const idToken = await this.idToken();
    console.log('[Vidmasta] instagram publish: sending jobId to /instagram/publish...');

    const res = await withTimeout(
      fetch(`${RENDER_SERVICE_URL}/instagram/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ title, jobId }),
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