// ============================================================
// video-features.ts — everything the frontend needs: models, auth
// service, and the 3 pages (login / create / export).
// ============================================================
import { Component, OnInit, Injectable } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { Observable } from 'rxjs';
import {
  Auth, authState, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, User
} from '@angular/fire/auth';
import { Storage, ref, uploadBytes } from '@angular/fire/storage';
import {
  Firestore, doc, setDoc, docData, collection, collectionData
} from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';

// ---------- models ----------
export type Emotion = 'happy' | 'excited' | 'sad' | 'mad' | 'confused' | 'grossed_out' | 'afraid' | 'shocked';
export const EMOTIONS: Emotion[] = ['happy', 'excited', 'sad', 'mad', 'confused', 'grossed_out', 'afraid', 'shocked'];

export interface VideoJob {
  id: string; uid: string; title: string;
  status: 'queued' | 'ocr' | 'tts' | 'rendering' | 'done' | 'error';
  imagePaths: string[]; musicOn: boolean;
  outputUrl?: string; outputUrlNoMusic?: string; error?: string; createdAt: number;
}

export interface Connection {
  platform: 'youtube' | 'tiktok' | 'instagram';
  connected: boolean; handle?: string; message?: string;
}

// ---------- auth service ----------
@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: Observable<User | null>;
  constructor(private auth: Auth) { this.user$ = authState(this.auth); }
  login(email: string, password: string) { return signInWithEmailAndPassword(this.auth, email, password); }
  signup(email: string, password: string) { return createUserWithEmailAndPassword(this.auth, email, password); }
  logout() { return signOut(this.auth); }
  get uid(): string | null { return this.auth.currentUser?.uid ?? null; }
}

// ---------- page 1: login / signup ----------
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="auth-box">
      <h2>{{ mode === 'login' ? 'Log In' : 'Sign Up' }}</h2>
      <input [(ngModel)]="email" placeholder="Email" type="email" />
      <input [(ngModel)]="password" placeholder="Password" type="password" />
      <button (click)="submit()">{{ mode === 'login' ? 'Log In' : 'Sign Up' }}</button>
      <p class="error" *ngIf="error">{{ error }}</p>
      <a (click)="mode = mode === 'login' ? 'signup' : 'login'; error = ''">
        {{ mode === 'login' ? "Need an account? Sign up" : "Have an account? Log in" }}
      </a>
    </div>`,
  styles: [`
    .auth-box { max-width: 320px; margin: 80px auto; display: flex; flex-direction: column; gap: 10px; }
    input, button { padding: 10px; font-size: 1rem; }
    .error { color: red; }
    a { cursor: pointer; color: #4a90e2; }
  `]
})
export class LoginComponent {
  mode: 'login' | 'signup' = 'login';
  email = ''; password = ''; error = '';
  constructor(private authService: AuthService, private router: Router) {}

  async submit() {
    this.error = '';
    try {
      await (this.mode === 'login'
        ? this.authService.login(this.email, this.password)
        : this.authService.signup(this.email, this.password));
      this.router.navigateByUrl('/create');
    } catch (e: any) { this.error = e.message; }
  }
}

// ---------- page 2: create video ----------
@Component({
  selector: 'app-create',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="wrap">
      <h2>New Video</h2>

      <label>Title</label>
      <input [(ngModel)]="title" placeholder="Video title" />

      <label>Post screenshot(s) — in order</label>
      <input type="file" accept="image/*" multiple (change)="postFiles = asFiles($event)" />
      <div class="thumbs"><span *ngFor="let f of postFiles; let i = index">{{ i + 1 }}. {{ f.name }}</span></div>

      <label>Character sprites (optional — one PNG per emotion)</label>
      <div class="sprite-grid">
        <div *ngFor="let e of emotions">
          <span>{{ e }}</span>
          <input type="file" accept="image/png" (change)="spriteFiles[e] = asFiles($event)[0]" />
        </div>
      </div>

      <button [disabled]="!postFiles.length || submitting" (click)="submit()">
        {{ submitting ? 'Uploading…' : 'Create Video' }}
      </button>

      <div class="status" *ngIf="job">
        <p>Status: <b>{{ job.status }}</b></p>
        <p *ngIf="job.status === 'error'" class="error">{{ job.error }}</p>
        <div *ngIf="job.status === 'done'">
          <video [src]="job.outputUrl" controls width="300"></video>
          <button (click)="router.navigate(['/export', jobId])">Continue to Export →</button>
        </div>
      </div>
    </div>`,
  styles: [`
    .wrap { max-width: 480px; margin: 40px auto; display: flex; flex-direction: column; gap: 12px; }
    label { font-weight: 600; margin-top: 8px; }
    .thumbs { font-size: 0.85rem; color: #555; }
    .sprite-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .sprite-grid div { display: flex; flex-direction: column; gap: 4px; }
    button { padding: 10px; font-size: 1rem; }
    .error { color: red; }
  `]
})
export class CreateComponent {
  title = '';
  postFiles: File[] = [];
  spriteFiles: Partial<Record<Emotion, File>> = {};
  emotions = EMOTIONS;
  submitting = false;
  jobId = '';
  job: VideoJob | null = null;

  constructor(
    private storage: Storage, private firestore: Firestore,
    private functions: Functions, private auth: AuthService, public router: Router
  ) {}

  asFiles(e: Event): File[] {
    return Array.from((e.target as HTMLInputElement).files ?? []);
  }

  async submit() {
    const uid = this.auth.uid;
    if (!uid) return;
    this.submitting = true;
    this.jobId = `${uid}_${Date.now()}`;

    const imagePaths: string[] = [];
    for (let i = 0; i < this.postFiles.length; i++) {
      const path = `users/${uid}/jobs/${this.jobId}/post_${i}.png`;
      await uploadBytes(ref(this.storage, path), this.postFiles[i]);
      imagePaths.push(path);
    }
    for (const emotion of this.emotions) {
      const file = this.spriteFiles[emotion];
      if (file) await uploadBytes(ref(this.storage, `users/${uid}/sprites/${emotion}.png`), file);
    }

    await setDoc(doc(this.firestore, `jobs/${this.jobId}`), {
      id: this.jobId, uid, title: this.title || 'Untitled',
      status: 'queued', imagePaths, musicOn: true, createdAt: Date.now()
    });

    docData(doc(this.firestore, `jobs/${this.jobId}`)).subscribe((j: any) => (this.job = j));
    await httpsCallable(this.functions, 'startRender')({ jobId: this.jobId });
    this.submitting = false;
  }
}

// ---------- page 3: export / publish ----------
@Component({
  selector: 'app-export',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="wrap" *ngIf="job">
      <h2>Export "{{ job.title }}"</h2>
      <video [src]="musicOn ? job.outputUrl : job.outputUrlNoMusic" controls width="320"></video>
      <button (click)="musicOn = !musicOn">{{ musicOn ? 'Turn Music Off' : 'Turn Music On' }}</button>

      <h3>Connect Accounts</h3>
      <div class="platform">
        <span>YouTube Shorts</span>
        <button (click)="connectYoutube()">{{ conn['youtube']?.connected ? 'Reconnect' : 'Connect' }}</button>
        <span class="msg">{{ statusText('youtube') }}</span>
      </div>
      <div class="platform">
        <span>TikTok</span>
        <input [(ngModel)]="tiktokHandle" placeholder="@yourhandle" />
        <button (click)="connect('tiktok', tiktokHandle)">Connect</button>
        <span class="msg">{{ statusText('tiktok') }}</span>
      </div>
      <div class="platform">
        <span>Instagram Reels</span>
        <input [(ngModel)]="instagramHandle" placeholder="@yourhandle" />
        <button (click)="connect('instagram', instagramHandle)">Connect</button>
        <span class="msg">{{ statusText('instagram') }}</span>
      </div>

      <h3>Publish</h3>
      <div class="publish-row">
        <button [disabled]="!conn['youtube']?.connected" (click)="publish('youtube')">Publish to YouTube Shorts</button>
        <button [disabled]="!conn['tiktok']?.connected" (click)="publish('tiktok')">Publish to TikTok</button>
        <button [disabled]="!conn['instagram']?.connected" (click)="publish('instagram')">Publish to Instagram Reels</button>
      </div>
      <p class="error" *ngIf="publishMsg">{{ publishMsg }}</p>
    </div>`,
  styles: [`
    .wrap { max-width: 480px; margin: 40px auto; display: flex; flex-direction: column; gap: 12px; }
    .platform { display: flex; align-items: center; gap: 8px; }
    .msg { font-size: 0.8rem; color: #555; }
    .publish-row { display: flex; flex-direction: column; gap: 8px; }
    button, input { padding: 8px; }
  `]
})
export class ExportComponent implements OnInit {
  jobId = '';
  job: VideoJob | null = null;
  musicOn = true;
  conn: Partial<Record<string, Connection>> = {};
  tiktokHandle = ''; instagramHandle = ''; publishMsg = '';

  constructor(
    private route: ActivatedRoute, private firestore: Firestore,
    private functions: Functions, private auth: AuthService
  ) {}

  ngOnInit() {
    this.jobId = this.route.snapshot.paramMap.get('jobId') || '';
    docData(doc(this.firestore, `jobs/${this.jobId}`)).subscribe((j: any) => (this.job = j));
    const uid = this.auth.uid;
    if (uid) {
      collectionData(collection(this.firestore, `users/${uid}/connections`))
        .subscribe((rows: any[]) => { for (const r of rows) this.conn[r.platform] = r; });
    }
  }

  statusText(platform: string) {
    const c = this.conn[platform];
    if (!c) return 'Not connected';
    return c.connected ? `Connected as ${c.handle}` : (c.message || 'Connection failed');
  }

  async connectYoutube() {
    const res: any = await httpsCallable(this.functions, 'connectYoutube')({});
    window.open(res.data.authUrl, '_blank', 'width=500,height=600');
  }

  async connect(platform: 'tiktok' | 'instagram', handle: string) {
    await httpsCallable(this.functions, 'connectSocial')({ platform, handle });
  }

  async publish(platform: 'youtube' | 'tiktok' | 'instagram') {
    this.publishMsg = 'Publishing…';
    try {
      const res: any = await httpsCallable(this.functions, 'publishVideo')(
        { jobId: this.jobId, platform, musicOn: this.musicOn }
      );
      this.publishMsg = res.data.message;
    } catch (e: any) { this.publishMsg = e.message; }
  }
}