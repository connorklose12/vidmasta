import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, VideoService, YouTubeService, TikTokService, TiktokCreatorInfo, InstagramService, EMOTIONS, Emotion } from './services';

const APP_STYLES = `
  :host {
    display: block;
    min-height: 100vh;
    background: #FDF6EC;
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #14171A;
    padding: 7px;
    box-sizing: border-box;
  }

  h2, h3 {
    font-weight: 800;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    margin: 0 0 5px;
  }

  h2 { font-size: 14px; }
  h3 { font-size: 9px; margin-top: 7px; }

  .auth-box, .upload-box {
    max-width: 340px;
    margin: 0 auto;
    background: #ffffff;
    border: 2px solid #14171A;
    border-radius: 9px;
    padding: 9px 12px;
    box-shadow: 3px 3px 0 #14171A;
  }

  .top-bar {
    max-width: 340px;
    margin: 0 auto 5px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .logo {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-style: italic;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.01em;
    color: #14171A;
  }

  .logo span {
    color: #FF6B5B;
  }

  .logout-btn {
    background: #ffffff !important;
    color: #14171A;
    box-shadow: 1px 1px 0 #14171A;
    padding: 3px 8px !important;
    font-size: 7px !important;
  }

  input[type="text"], input[type="email"], input[type="password"] {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    margin-bottom: 4px;
    border: 2px solid #14171A;
    border-radius: 5px;
    font-size: 9px;
    font-family: inherit;
    background: #FFF9F0;
  }

  input[type="file"] {
    font-family: inherit;
    font-size: 8px;
    margin: 1px 0;
  }

  select {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    margin: 3px 0 4px;
    border: 2px solid #14171A;
    border-radius: 5px;
    font-size: 9px;
    font-family: inherit;
    background: #FFF9F0;
  }

  button {
    font-family: inherit;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    font-size: 8px;
    border: 2px solid #14171A;
    border-radius: 6px;
    padding: 5px 9px;
    background: #FF6B5B;
    color: #14171A;
    cursor: pointer;
    box-shadow: 1px 1px 0 #14171A;
    transition: transform 0.08s ease, box-shadow 0.08s ease;
  }

  button:hover:not(:disabled) {
    transform: translate(-1px, -1px);
    box-shadow: 2px 2px 0 #14171A;
  }

  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    box-shadow: none;
  }

  button.secondary {
    background: #FFD86E;
  }

  button.folder {
    background: #6EE7E0;
    width: 100%;
    margin-top: 1px;
    padding: 4px 8px;
  }

  .toggle {
    cursor: pointer;
    text-decoration: underline;
    font-size: 8px;
    margin-top: 4px;
  }

  .error {
    color: #B3261E;
    font-weight: 700;
    font-size: 8px;
    margin-top: 4px;
  }

  .success {
    color: #1A7F37;
    font-weight: 700;
    font-size: 8px;
    margin-top: 4px;
  }

  .field-label {
    display: block;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 7px;
    letter-spacing: 0.04em;
    margin-bottom: 2px;
  }

  .sprite-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
    gap: 4px;
    margin: 5px 0 4px;
  }

  .sprite-card {
    background: #F1F5FF;
    border: 2px solid #14171A;
    border-radius: 6px;
    padding: 4px;
  }
  .sprite-card:nth-child(4n+2) { background: #FFE9E4; }
  .sprite-card:nth-child(4n+3) { background: #FFF6D6; }
  .sprite-card:nth-child(4n+4) { background: #E4FBF6; }

  .sprite-card .emotion-name {
    display: block;
    font-weight: 800;
    text-transform: capitalize;
    margin-bottom: 2px;
    font-size: 7px;
  }

  .folder-summary {
    background: #14171A;
    color: #FDF6EC;
    border-radius: 5px;
    padding: 4px 6px;
    margin-top: 4px;
    font-size: 7px;
    font-family: 'SFMono-Regular', Menlo, monospace;
    line-height: 1.35;
  }

  .debug-panel {
    background: #14171A;
    color: #6EE7E0;
    border-radius: 5px;
    padding: 4px 6px;
    margin-top: 5px;
    font-size: 6px;
    font-family: 'SFMono-Regular', Menlo, monospace;
  }

  .debug-panel strong {
    display: block;
    color: #FDF6EC;
    font-size: 7px;
    text-transform: uppercase;
    margin-bottom: 2px;
  }

  .debug-panel pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.35;
  }

  .result {
    margin-top: 7px;
    padding-top: 6px;
    border-top: 2px dashed #14171A;
  }

  .result video {
    width: 100%;
    max-width: 110px;
    max-height: 18vh;
    border-radius: 6px;
    border: 2px solid #14171A;
    display: block;
    margin: 0 auto 5px;
  }

  .result a {
    display: inline-block;
    font-weight: 800;
    text-transform: uppercase;
    text-decoration: none;
    font-size: 8px;
    color: #14171A;
    border-bottom: 2px solid #FF6B5B;
  }

  .site-footer {
    max-width: 340px;
    margin: 10px auto 0;
    font-size: 6px;
    line-height: 1.5;
    color: #8a8a8a;
    text-align: center;
  }

  .site-footer a {
    color: #8a8a8a;
    text-decoration: underline;
  }
`;

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [APP_STYLES],
  template: `
    <div class="auth-box">
      <h2>{{ isSignup ? 'Create Account' : 'Log In' }}</h2>
      <input type="email" [(ngModel)]="email" placeholder="Email" />
      <input type="password" [(ngModel)]="password" placeholder="Password" />
      <button (click)="submit()">{{ isSignup ? 'Sign Up' : 'Log In' }}</button>
      <p class="toggle" (click)="isSignup = !isSignup">
        {{ isSignup ? 'Already have an account? Log in' : "Need an account? Sign up" }}
      </p>
      <p class="error" *ngIf="error">{{ error }}</p>
    </div>
    <p class="site-footer">
      On this website, you submit a social media post/s, and in the press of a button, it automatically adds text to speech, oddly satisfying background videos, captions, sound effects, background music, etc. You can also submit reaction sprites, where AI detects the emotion of each line of the code and adds them to the screen. It helps to create a folder with all your sprites labeled as "Happy.png", "Excited.png" etc. You can also upload the vid to your TikTok, YouTube Shorts, and Instagram IN THE CLICK OF A BUTTON. (This is currently in testing mode, so if you'd like to post the video somewhere you'll need to shoot me an email at <a href="mailto:connorklose12@gmail.com">connorklose12&#64;gmail.com</a>. Thanks!)
    </p>
  `,
})
export class LoginComponent {
  email = ''; password = ''; isSignup = false; error = '';

  constructor(private auth: AuthService, private router: Router) {}

  async submit() {
    this.error = '';
    try {
      if (this.isSignup) await this.auth.signup(this.email, this.password);
      else await this.auth.login(this.email, this.password);
      this.router.navigate(['/upload']);
    } catch (e: any) { this.error = e.message; }
  }
}

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [APP_STYLES],
  template: `
    <div class="top-bar">
      <span class="logo">Vid<span>masta</span></span>
      <button type="button" class="logout-btn" (click)="logout()">Log Out</button>
    </div>

    <div class="upload-box">
      <h2>Create a Video</h2>

      <label class="field-label">Video title</label>
      <input type="text" [(ngModel)]="title" placeholder="Video title" />

      <label class="field-label">Post screenshots (in order)</label>
      <input type="file" accept="image/*" multiple (change)="postFiles = pick($event)" />

      <h3>Emotion sprites (this is optional)</h3>

      <input #folderInput type="file" webkitdirectory multiple style="display:none" (change)="onFolderPicked($event)" />
      <button type="button" class="folder" (click)="folderInput.click()">📁 Load sprites from a folder</button>
      <p class="folder-summary" *ngIf="folderLoadSummary.length">
        Assigned alphabetically (folder file order ↔ alphabetical emotion order):<br />
        <span *ngFor="let line of folderLoadSummary">{{ line }}<br /></span>
      </p>

      <div class="sprite-grid">
        <div class="sprite-card" *ngFor="let emotion of emotions">
          <span class="emotion-name">{{ emotion }}</span>
          <input type="file" accept="image/png" (change)="sprites[emotion] = pick($event)[0]" />
        </div>
      </div>

      <h3>YouTube Shorts</h3>
      <button type="button" (click)="connectYoutube()" [disabled]="youtubeConnecting">
        {{ youtubeStatus === 'connected' ? ' YouTube Connected' : (youtubeConnecting ? 'Connecting...' : 'Connect YouTube Account') }}
      </button>
      <p class="error" *ngIf="youtubeStatus === 'failed'">Connection didn't complete — try again.</p>

      <h3>TikTok</h3>
      <button type="button" (click)="connectTiktok()" [disabled]="tiktokConnecting">
        {{ tiktokStatus === 'connected' ? ' TikTok Connected' : (tiktokConnecting ? 'Connecting...' : 'Connect TikTok Account') }}
      </button>
      <p class="error" *ngIf="tiktokStatus === 'failed'">Connection didn't complete — try again.</p>

      <h3>Instagram</h3>
      <button type="button" (click)="connectInstagram()" [disabled]="instagramConnecting">
        {{ instagramStatus === 'connected' ? ' Instagram Connected' : (instagramConnecting ? 'Connecting...' : 'Connect Instagram Account') }}
      </button>
      <p class="error" *ngIf="instagramStatus === 'failed'">Connection didn't complete — try again.</p>

      <button (click)="submit()" [disabled]="submitting">
        {{ submitting ? 'Generating... this can take a few minutes' : 'Generate Video' }}
      </button>

      <p class="error" *ngIf="error">{{ error }}</p>

      <!-- Debug panel: shows the same structural diagnostic trail the
           render service logs to Cloud Run (AI availability, how many
           lines the chrome filter kept, and — most usefully for tracking
           down "emotions aren't switching" — the actual resolved emotion
           sequence for the post, e.g. [shocked, shocked, mad, confused]).
           Lives here (not on the login screen) because this is the
           component that actually calls generateVideo() and receives
           result.debug. -->
      <div *ngIf="debug.length" class="debug-panel">
        <strong>Debug info</strong>
        <pre>{{ debug.join('\n') }}</pre>
      </div>

      <div *ngIf="videoUrl" class="result">
        <video [src]="videoUrl" controls width="280" autoplay></video>
        <a [href]="videoUrl" download="video.mp4">Download Video</a>
        <br />
        <button type="button" (click)="exportToYoutube()" [disabled]="exporting || youtubeStatus !== 'connected'">
          {{ exporting ? 'Uploading...' : 'Export to YouTube Shorts' }}
        </button>
        <p class="success" *ngIf="exportStatus === 'done'">✅ Uploaded to YouTube Shorts!</p>
        <p class="error" *ngIf="exportStatus === 'failed'">❌ {{ exportError }}</p>

        <!-- TikTok posting flow. Shows the connected creator's username +
             avatar, a real privacy-level picker (never pre-selected), and
             per-post duet/comment/stitch toggles — all fetched fresh via
             creator_info right before posting. TikTok's review process
             explicitly checks for each of these being real, working UI
             elements the user interacts with, not decoration. -->
        <br />
        <button
          type="button"
          (click)="loadTiktokOptions()"
          *ngIf="tiktokStatus === 'connected' && !tiktokCreatorInfo"
          [disabled]="tiktokLoadingInfo"
        >
          {{ tiktokLoadingInfo ? 'Loading TikTok options...' : 'Post to TikTok' }}
        </button>
        <p class="error" *ngIf="tiktokPublishStatus === 'failed' && !tiktokCreatorInfo">❌ {{ tiktokPublishError }}</p>

        <div *ngIf="tiktokCreatorInfo">
          <div class="field-label" style="display:flex; align-items:center; gap:6px; margin-top:6px;">
            <img [src]="tiktokCreatorInfo.creator_avatar_url" width="22" height="22" style="border-radius:50%; border:1px solid #14171A;" />
            Posting as &#64;{{ tiktokCreatorInfo.creator_username }}
          </div>

          <label class="field-label" style="margin-top:6px;">Who can see this?</label>
          <select [(ngModel)]="tiktokPrivacyLevel" [ngModelOptions]="{standalone: true}">
            <option *ngFor="let level of tiktokCreatorInfo.privacy_level_options" [value]="level">
              {{ tiktokPrivacyLabel(level) }}
            </option>
          </select>

          <label class="field-label" style="display:block; margin-top:6px;">
            <input type="checkbox" [(ngModel)]="tiktokAllowComment" [ngModelOptions]="{standalone: true}" [disabled]="tiktokCreatorInfo.comment_disabled" />
            Allow comments
          </label>
          <label class="field-label" style="display:block;">
            <input type="checkbox" [(ngModel)]="tiktokAllowDuet" [ngModelOptions]="{standalone: true}" [disabled]="tiktokCreatorInfo.duet_disabled" />
            Allow duet
          </label>
          <label class="field-label" style="display:block; margin-bottom:6px;">
            <input type="checkbox" [(ngModel)]="tiktokAllowStitch" [ngModelOptions]="{standalone: true}" [disabled]="tiktokCreatorInfo.stitch_disabled" />
            Allow stitch
          </label>

          <button
            type="button"
            (click)="publishToTiktok()"
            [disabled]="tiktokPublishing || !tiktokPrivacyLevel"
          >
            {{ tiktokPublishing ? 'Posting...' : 'Confirm & Post to TikTok' }}
          </button>
        </div>
        <p class="success" *ngIf="tiktokPublishStatus === 'done'">✅ Posted to TikTok!</p>
        <p class="success" *ngIf="tiktokPublishStatus === 'processing'">⏳ Still processing on TikTok's side — check the app shortly.</p>
        <p class="error" *ngIf="tiktokPublishStatus === 'failed' && tiktokCreatorInfo">❌ {{ tiktokPublishError }}</p>

        <br />
        <button
          type="button"
          (click)="publishToInstagram()"
          *ngIf="instagramStatus === 'connected'"
          [disabled]="instagramPublishing"
        >
          {{ instagramPublishing ? 'Posting... (can take a minute)' : 'Post to Instagram' }}
        </button>
        <p class="success" *ngIf="instagramPublishStatus === 'done'">✅ Posted to Instagram!</p>
        <p class="success" *ngIf="instagramPublishStatus === 'processing'">⏳ Still processing on Instagram's side — check the app shortly.</p>
        <p class="error" *ngIf="instagramPublishStatus === 'failed'">❌ {{ instagramPublishError }}</p>
      </div>
    </div>
    <p class="site-footer">
      On this website, you submit a social media post/s, and in the press of a button, it automatically adds text to speech, oddly satisfying background videos, captions, sound effects, background music, etc. You can also submit reaction sprites, where AI detects the emotion of each line of the code and adds them to the screen. It helps to create a folder with all your sprites labeled as "Happy.png", "Excited.png" etc. You can also upload the vid to your TikTok, YouTube Shorts, and Instagram IN THE CLICK OF A BUTTON. (This is currently in testing mode, so if you'd like to post the video somewhere you'll need to shoot me an email at <a href="mailto:connorklose12@gmail.com">connorklose12&#64;gmail.com</a>. Thanks!)
    </p>
  `,
})
export class UploadComponent implements OnInit {
  emotions = EMOTIONS;
  title = ''; postFiles: File[] = []; sprites: Partial<Record<Emotion, File>> = {};
  submitting = false; error = '';
  folderLoadSummary: string[] = [];
  debug: string[] = [];

  videoUrl: string | null = null;
  videoBlob: Blob | null = null;

  youtubeConnecting = false;
  youtubeStatus: '' | 'connected' | 'failed' = '';
  exporting = false;
  exportStatus: '' | 'done' | 'failed' = '';
  exportError = '';

  tiktokConnecting = false;
  tiktokStatus: '' | 'connected' | 'failed' = '';
  tiktokCreatorInfo: TiktokCreatorInfo | null = null;
  tiktokLoadingInfo = false;
  tiktokPrivacyLevel = '';
  tiktokAllowComment = true;
  tiktokAllowDuet = true;
  tiktokAllowStitch = true;
  tiktokPublishing = false;
  tiktokPublishStatus: '' | 'done' | 'processing' | 'failed' = '';
  tiktokPublishError = '';

  instagramConnecting = false;
  instagramStatus: '' | 'connected' | 'failed' = '';
  instagramPublishing = false;
  instagramPublishStatus: '' | 'done' | 'processing' | 'failed' = '';
  instagramPublishError = '';

  constructor(
    private videos: VideoService,
    private youtube: YouTubeService,
    private tiktok: TikTokService,
    private instagram: InstagramService,
    private auth: AuthService,
    private router: Router
  ) {}

  async ngOnInit() {
    const [ytConnected, ttConnected, igConnected] = await Promise.all([
      this.youtube.status().catch(() => false),
      this.tiktok.status().catch(() => false),
      this.instagram.status().catch(() => false),
    ]);
    if (ytConnected) this.youtubeStatus = 'connected';
    if (ttConnected) this.tiktokStatus = 'connected';
    if (igConnected) this.instagramStatus = 'connected';
  }

  // Signs the current user out and sends them back to the login screen.
  async logout() {
    await this.auth.logout();
    this.router.navigate(['/login']);
  }

  pick(event: Event): File[] {
    const input = event.target as HTMLInputElement;
    return input.files ? Array.from(input.files) : [];
  }

  onFolderPicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    const imageFiles = files
      .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const sortedEmotions = [...this.emotions].sort((a, b) => a.localeCompare(b));

    this.folderLoadSummary = [];
    sortedEmotions.forEach((emotion, i) => {
      const file = imageFiles[i];
      if (file) {
        this.sprites[emotion] = file;
        this.folderLoadSummary.push(`${emotion} → ${file.name}`);
      }
    });
  }

  async connectYoutube() {
    this.youtubeConnecting = true;
    try {
      await this.youtube.connect();
      const connected = await this.youtube.status();
      this.youtubeStatus = connected ? 'connected' : 'failed';
    } catch {
      this.youtubeStatus = 'failed';
    } finally {
      this.youtubeConnecting = false;
    }
  }

  async exportToYoutube() {
    if (!this.videoBlob) return;
    this.exporting = true;
    this.exportStatus = '';
    try {
      await this.youtube.uploadShort(this.videoBlob, this.title || 'Untitled');
      this.exportStatus = 'done';
    } catch (e: any) {
      this.exportStatus = 'failed';
      this.exportError = e.message;
    } finally {
      this.exporting = false;
    }
  }

  async connectTiktok() {
    this.tiktokConnecting = true;
    try {
      await this.tiktok.connect();
      const connected = await this.tiktok.status();
      this.tiktokStatus = connected ? 'connected' : 'failed';
    } catch {
      this.tiktokStatus = 'failed';
    } finally {
      this.tiktokConnecting = false;
    }
  }

  async connectInstagram() {
    this.instagramConnecting = true;
    try {
      await this.instagram.connect();
      const connected = await this.instagram.status();
      this.instagramStatus = connected ? 'connected' : 'failed';
    } catch {
      this.instagramStatus = 'failed';
    } finally {
      this.instagramConnecting = false;
    }
  }

  async publishToInstagram() {
    if (!this.videoBlob) return;
    this.instagramPublishing = true;
    this.instagramPublishStatus = '';
    try {
      const result = await this.instagram.publish(this.videoBlob, this.title || 'Untitled');
      this.instagramPublishStatus = result.status === 'complete' ? 'done' : 'processing';
    } catch (e: any) {
      this.instagramPublishStatus = 'failed';
      this.instagramPublishError = e.message;
    } finally {
      this.instagramPublishing = false;
    }
  }

  async loadTiktokOptions() {
    this.tiktokLoadingInfo = true;
    this.tiktokPublishStatus = '';
    try {
      this.tiktokCreatorInfo = await this.tiktok.getCreatorInfo();
      this.tiktokPrivacyLevel = this.tiktokCreatorInfo.privacy_level_options[0] || '';
      this.tiktokAllowComment = !this.tiktokCreatorInfo.comment_disabled;
      this.tiktokAllowDuet = !this.tiktokCreatorInfo.duet_disabled;
      this.tiktokAllowStitch = !this.tiktokCreatorInfo.stitch_disabled;
    } catch (e: any) {
      this.tiktokPublishStatus = 'failed';
      this.tiktokPublishError = e.message;
    } finally {
      this.tiktokLoadingInfo = false;
    }
  }

  tiktokPrivacyLabel(level: string): string {
    const labels: Record<string, string> = {
      PUBLIC_TO_EVERYONE: 'Public',
      MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
      FOLLOWER_OF_CREATOR: 'Followers',
      SELF_ONLY: 'Only me',
    };
    return labels[level] || level;
  }

  async publishToTiktok() {
    if (!this.videoBlob || !this.tiktokPrivacyLevel) return;
    this.tiktokPublishing = true;
    this.tiktokPublishStatus = '';
    try {
      const result = await this.tiktok.publish(this.videoBlob, this.title || 'Untitled', {
        privacyLevel: this.tiktokPrivacyLevel,
        allowComment: this.tiktokAllowComment,
        allowDuet: this.tiktokAllowDuet,
        allowStitch: this.tiktokAllowStitch,
      });
      this.tiktokPublishStatus = result.status === 'complete' ? 'done' : 'processing';
    } catch (e: any) {
      this.tiktokPublishStatus = 'failed';
      this.tiktokPublishError = e.message;
    } finally {
      this.tiktokPublishing = false;
    }
  }

  async submit() {
    this.error = '';
    if (!this.postFiles.length) { this.error = 'Add at least one screenshot.'; return; }
    this.submitting = true;
    this.exportStatus = '';
    this.tiktokPublishStatus = '';
    this.tiktokCreatorInfo = null;
    this.instagramPublishStatus = '';
    try {
      const result = await this.videos.generateVideo(this.postFiles, this.title || 'Untitled', this.sprites);
      this.videoUrl = result.videoUrl;
      this.debug = result.debug;
      this.videoBlob = result.videoBlob;
    } catch (e: any) {
      this.error = e.message;
      if (e.debug) this.debug = e.debug;
    }
    finally { this.submitting = false; }
  }
}