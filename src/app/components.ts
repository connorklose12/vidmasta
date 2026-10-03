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
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 3px;
    margin: 5px 0 4px;
  }

  .connect-row {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }

  .connect-col {
    flex: 1;
    min-width: 0;
  }

  .connect-col button {
    width: 100%;
    font-size: 6.5px;
    padding: 5px 3px;
  }

  .connect-col .error {
    font-size: 6px;
    text-align: center;
    margin-top: 2px;
  }

  .sprite-card {
    background: #F1F5FF;
    border: 2px solid #14171A;
    border-radius: 6px;
    padding: 2px 3px;
    min-width: 0;
  }
  .sprite-card:nth-child(5n+2) { background: #FFE9E4; }
  .sprite-card:nth-child(5n+3) { background: #FFF6D6; }
  .sprite-card:nth-child(5n+4) { background: #E4FBF6; }
  .sprite-card:nth-child(5n+5) { background: #EFE6FF; }
  .sprite-card input[type="file"] {
    font-size: 5px;
    width: 100%;
    margin: 0;
  }

  .sprite-card .emotion-name {
    display: block;
    font-weight: 800;
    text-transform: capitalize;
    margin-bottom: 1px;
    font-size: 6px;
    overflow-wrap: anywhere;
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

  .folder-summary summary {
    cursor: pointer;
    font-weight: 700;
  }

  .folder-summary span {
    display: block;
    margin-top: 3px;
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

  .debug-panel summary {
    cursor: pointer;
    color: #FDF6EC;
    font-size: 7px;
    text-transform: uppercase;
    font-weight: 700;
  }

  .debug-panel pre {
    margin: 4px 0 0;
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

  .legal-links {
    max-width: 340px;
    margin: 8px auto 0;
    text-align: center;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .legal-links a {
    color: #14171A;
    text-decoration: underline;
    margin: 0 6px;
  }

  .landing-hero {
    max-width: 460px;
    margin: 0 auto;
    text-align: center;
  }

  .landing-hero h1 {
    font-weight: 800;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    font-size: 22px;
    margin: 10px 0 6px;
  }

  .landing-hero .tagline {
    font-size: 11px;
    color: #444;
    margin-bottom: 14px;
    line-height: 1.5;
  }

  .landing-features {
    max-width: 460px;
    margin: 14px auto;
    text-align: left;
    background: #ffffff;
    border: 2px solid #14171A;
    border-radius: 9px;
    padding: 12px 14px;
    box-shadow: 3px 3px 0 #14171A;
  }

  .landing-features li {
    font-size: 10px;
    margin-bottom: 6px;
    line-height: 1.5;
  }

  .landing-cta {
    font-size: 11px !important;
    padding: 10px 22px !important;
    margin-top: 6px;
  }

  .landing-section {
    max-width: 460px;
    margin: 22px auto;
    text-align: left;
  }

  .landing-section h2 {
    font-size: 15px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: -0.01em;
    margin-bottom: 10px;
  }

  .landing-steps {
    background: #ffffff;
    border: 2px solid #14171A;
    border-radius: 9px;
    padding: 14px 14px 14px 30px;
    box-shadow: 3px 3px 0 #14171A;
  }

  .landing-steps li {
    font-size: 10.5px;
    line-height: 1.55;
    margin-bottom: 10px;
  }

  .landing-steps li:last-child {
    margin-bottom: 0;
  }

  .landing-faq {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .faq-item {
    background: #ffffff;
    border: 2px solid #14171A;
    border-radius: 9px;
    padding: 10px 14px;
    box-shadow: 3px 3px 0 #14171A;
  }

  .faq-item h3 {
    font-size: 11px;
    font-weight: 700;
    margin-bottom: 4px;
  }

  .faq-item p {
    font-size: 10.5px;
    color: #444;
    line-height: 1.5;
    margin: 0;
  }
`;

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule],
  styles: [APP_STYLES],
  template: `
    <div class="landing-hero">
      <span class="logo">Vid<span>masta</span></span>
      <h1>Turn any screenshot into a short-form video</h1>
      <p class="tagline">
        Upload a screenshot of a social media post, Vidmasta automatically extracts the text, generates
        narration, adds captions, background music, sound effects, and optional reaction sprites,
        then lets you publish the finished video directly to YouTube Shorts, TikTok, and Instagram.
      </p>

      <ul class="landing-features">
        <li>Upload one or more post screenshots, text is extracted automatically via OCR</li>
        <li>Realistic text-to-speech narration is generated for every line</li>
        <li>Optional AI-detected emotion sprites react to what's being said</li>
        <li>A finished vertical video is rendered with captions, music, and sound effects</li>
        <li>Connect your YouTube, TikTok, or Instagram account and publish in one click</li>
      </ul>

      <button type="button" class="landing-cta" (click)="goToLogin()">Log In / Sign Up to Get Started</button>
    </div>

    <section class="landing-section">
      <h2>How Vidmasta Works</h2>
      <ol class="landing-steps">
        <li>
          <strong>Upload a screenshot.</strong> Take a screenshot of any social media post, comment thread,
          or reply chain, and upload it directly through the browser. You can submit one image for a single
          post, or several images in sequence to compile a multi-post video.
        </li>
        <li>
          <strong>Text is read automatically.</strong> Vidmasta uses optical character recognition to read
          every line of text in the screenshot, then applies filtering so usernames, timestamps, and interface
          elements like "Reply" or "1 day ago" are left out of the narration.
        </li>
        <li>
          <strong>Narration and captions are generated.</strong> Every kept line is converted into natural
          spoken narration, with word-by-word captions displayed on screen in sync with the audio.
        </li>
        <li>
          <strong>The video is assembled.</strong> A background video, background music, sound effects, and
          (if you've uploaded a set of reaction images) emotion-matched reaction sprites are combined with
          the narration into a finished vertical video, sized for TikTok, YouTube Shorts, and Instagram Reels.
        </li>
        <li>
          <strong>Publish directly to your accounts.</strong> Once signed in and connected, you can publish
          the finished video straight to YouTube Shorts, TikTok, or Instagram without leaving the page.
        </li>
      </ol>
    </section>

    <section class="landing-section">
      <h2>Frequently Asked Questions</h2>
      <div class="landing-faq">
        <div class="faq-item">
          <h3>What kind of screenshots can I use?</h3>
          <p>
            Any screenshot containing readable text works — a single social media post, a reply thread, a
            comment section, or a text message conversation. Vidmasta reads whatever text is visible in the
            image and narrates it.
          </p>
        </div>
        <div class="faq-item">
          <h3>Do I need to provide my own reaction images?</h3>
          <p>
            No — emotion sprites are entirely optional. If you upload a folder of your own reaction images,
            Vidmasta will automatically detect the emotional tone of each line and display a matching image
            on screen. If you don't upload any, the video is generated without them.
          </p>
        </div>
        <div class="faq-item">
          <h3>Which platforms can I publish to?</h3>
          <p>
            YouTube Shorts, TikTok, and Instagram Reels, each through that platform's own official account
            connection. You choose per-video where you'd like it published.
          </p>
        </div>
        <div class="faq-item">
          <h3>Is my data shared with anyone?</h3>
          <p>
            No. Vidmasta only accesses what's needed to generate and publish your videos, and does not sell
            or share user data. Full details are in the Privacy Policy linked below.
          </p>
        </div>
        <div class="faq-item">
          <h3>Is Vidmasta free to use?</h3>
          <p>
            Vidmasta is currently in testing. Publishing directly to social platforms is limited to approved
            test accounts while the app is under platform review — reach out using the contact email below if
            you'd like access.
          </p>
        </div>
      </div>
    </section>
    <p class="legal-links">
      <a href="https://vidmasta-7e113.web.app/terms-of-service.html" target="_blank" rel="noopener">Terms of Service</a>
      <a href="https://vidmasta-7e113.web.app/privacy-policy.html" target="_blank" rel="noopener">Privacy Policy</a>
      <a href="video-example.mp4" target="_blank" rel="noopener">Video Example</a>
    </p>
  `,
})
export class LandingComponent {
  constructor(private router: Router) {}
  goToLogin() {
    this.router.navigate(['/login']);
  }
}

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
      On this website, you submit a social media post/s, and in the press of a button, it automatically adds text to speech, oddly satisfying background videos, captions, sound effects, background music, etc. You can also submit reaction sprites, where AI detects the emotion of each line of the code and adds them to the screen. It helps to create a folder with all your sprites labeled as "Happy.png", "Excited.png" etc. You can also upload the vid to your TikTok, YouTube Shorts, and Instagram IN THE CLICK OF A BUTTON. (If you're unable to post on a platform, send me an email at <a href="mailto:connorklose12@gmail.com">connorklose12&#64;gmail.com</a>. Thanks!)
    </p>
    <p class="legal-links">
      <a href="https://vidmasta-7e113.web.app/terms-of-service.html" target="_blank" rel="noopener">Terms of Service</a>
      <a href="https://vidmasta-7e113.web.app/privacy-policy.html" target="_blank" rel="noopener">Privacy Policy</a>
      <a href="video-example.mp4" target="_blank" rel="noopener">Video Example</a>
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
      <label class="field-label">Video title</label>
      <input type="text" [(ngModel)]="title" placeholder="Video title" />

      <label class="field-label">Post screenshots (in order)</label>
      <input type="file" accept="image/*" multiple (change)="postFiles = pick($event)" />

      <h3>Emotion sprites (this is optional)</h3>

      <input #folderInput type="file" webkitdirectory multiple style="display:none" (change)="onFolderPicked($event)" />
      <button type="button" class="folder" (click)="folderInput.click()">📁 Load sprites from a folder</button>
      <details class="folder-summary" *ngIf="folderLoadSummary.length">
        <summary>Assigned alphabetically (click to expand)</summary>
        <span *ngFor="let line of folderLoadSummary">{{ line }}<br /></span>
      </details>

      <div class="sprite-grid">
        <div class="sprite-card" *ngFor="let emotion of emotions">
          <span class="emotion-name">{{ emotion }}</span>
          <input type="file" accept="image/png" (change)="sprites[emotion] = pick($event)[0]" />
        </div>
      </div>

      <div class="connect-row">
        <div class="connect-col">
          <button type="button" (click)="connectYoutube()" [disabled]="youtubeConnecting">
            {{ youtubeStatus === 'connected' ? ' YouTube Connected' : (youtubeConnecting ? 'Connecting...' : 'Connect YouTube') }}
          </button>
          <p class="error" *ngIf="youtubeStatus === 'failed'">Failed — try again.</p>
        </div>
        <div class="connect-col">
          <button type="button" (click)="connectTiktok()" [disabled]="tiktokConnecting">
            {{ tiktokStatus === 'connected' ? ' TikTok Connected' : (tiktokConnecting ? 'Connecting...' : 'Connect TikTok') }}
          </button>
          <p class="error" *ngIf="tiktokStatus === 'failed'">Failed — try again.</p>
        </div>
        <div class="connect-col">
          <button type="button" (click)="connectInstagram()" [disabled]="instagramConnecting">
            {{ instagramStatus === 'connected' ? ' Instagram Connected' : (instagramConnecting ? 'Connecting...' : 'Connect Instagram') }}
          </button>
          <p class="error" *ngIf="instagramStatus === 'failed'">Failed — try again.</p>
        </div>
      </div>

      <button type="button" (click)="toggleSchedule()">
        {{ scheduleOpen ? '▾' : '▸' }} Schedule posts
      </button>
      <div *ngIf="scheduleOpen" style="border:1px solid #14171A; padding:10px; margin-top:6px;">
        <div *ngFor="let day of scheduleDays; let d = index" style="margin-bottom:8px;">
          <strong>{{ day.label }}</strong>
          <span *ngFor="let t of day.times; let i = index" style="display:inline-flex; align-items:center; gap:4px; margin-left:8px;">
            <input type="time" [(ngModel)]="t.time" [ngModelOptions]="{standalone: true}" (blur)="saveScheduleDraft()" />
            <input type="text" placeholder="Title (optional)" [(ngModel)]="t.title" [ngModelOptions]="{standalone: true}" style="width:140px;" (blur)="saveScheduleDraft()" />
            <button type="button" (click)="removeScheduleTime(d, i)">×</button>
          </span>
          <button type="button" (click)="addScheduleTime(d)">+ time</button>
        </div>

        <label class="field-label" style="display:block;">Photos for this schedule</label>
        <input type="file" accept="image/*" multiple (change)="scheduleFiles = pick($event)" />
        <p style="font-size:12px;">{{ scheduleFiles.length }} photo(s) — cycles through your times in order if there are more photos than times.</p>

        <label class="field-label" style="display:block; margin-top:6px;">Background style</label>
        <button type="button" (click)="scheduleMode = 'satisfying'" [style.fontWeight]="scheduleMode === 'satisfying' ? 'bold' : 'normal'">Oddly Satisfying</button>
        <button type="button" (click)="scheduleMode = 'gameplay'" [style.fontWeight]="scheduleMode === 'gameplay' ? 'bold' : 'normal'">Gameplay</button>
        <button type="button" (click)="scheduleMode = 'parkour'" [style.fontWeight]="scheduleMode === 'parkour' ? 'bold' : 'normal'">Parkour</button>

        <div *ngIf="scheduleTiktokCreatorInfo">
          <label class="field-label" style="display:block; margin-top:8px;">TikTok — who can see these?</label>
          <select [(ngModel)]="scheduleTiktokPrivacyLevel" [ngModelOptions]="{standalone: true}">
            <option value="" disabled selected>Choose who can see this</option>
            <option
              *ngFor="let level of scheduleTiktokCreatorInfo.privacy_level_options"
              [value]="level"
              [disabled]="scheduleBrandedContent && level === 'SELF_ONLY'"
            >
              {{ tiktokPrivacyLabel(level) }}
            </option>
          </select>
          <label class="field-label" style="display:block;">
            <input type="checkbox" [(ngModel)]="scheduleAllowComment" [ngModelOptions]="{standalone: true}" [disabled]="scheduleTiktokCreatorInfo.comment_disabled" /> Allow comments
          </label>
          <label class="field-label" style="display:block;">
            <input type="checkbox" [(ngModel)]="scheduleAllowDuet" [ngModelOptions]="{standalone: true}" [disabled]="scheduleTiktokCreatorInfo.duet_disabled" /> Allow duet
          </label>
          <label class="field-label" style="display:block;">
            <input type="checkbox" [(ngModel)]="scheduleAllowStitch" [ngModelOptions]="{standalone: true}" [disabled]="scheduleTiktokCreatorInfo.stitch_disabled" /> Allow stitch
          </label>
          <label class="field-label" style="display:block; margin-top:4px;">
            <input type="checkbox" [(ngModel)]="scheduleDisclosureEnabled" [ngModelOptions]="{standalone: true}" (ngModelChange)="onScheduleDisclosureChange()" />
            This content promotes myself or a brand
          </label>
          <div *ngIf="scheduleDisclosureEnabled" style="margin-left:20px;">
            <label class="field-label" style="display:block;"><input type="checkbox" [(ngModel)]="scheduleYourBrand" [ngModelOptions]="{standalone: true}" /> Your Brand</label>
            <label class="field-label" style="display:block;"><input type="checkbox" [(ngModel)]="scheduleBrandedContent" [ngModelOptions]="{standalone: true}" (ngModelChange)="onScheduleBrandedContentChange()" /> Branded Content</label>
          </div>
        </div>

        <button
          type="button"
          (click)="submitSchedule()"
          [disabled]="scheduleSubmitting || !scheduleFiles.length || !scheduleHasAnyTime() || (scheduleTiktokCreatorInfo && (!scheduleTiktokPrivacyLevel || (scheduleDisclosureEnabled && !scheduleYourBrand && !scheduleBrandedContent)))"
          style="margin-top:8px;"
        >
          {{ scheduleSubmitting ? (scheduleProgress || 'Saving...') : 'Save Schedule' }}
        </button>
        <p class="error" *ngIf="scheduleStatus === 'failed'">{{ scheduleError }}</p>
        <p *ngIf="scheduleStatus === 'done'">Schedule saved — {{ scheduleSavedCount }} post(s) queued.</p>

        <div style="margin-top:10px; border-top:1px solid #14171A; padding-top:8px;">
          <strong>Upcoming posts</strong>
          <button type="button" (click)="loadUpcoming()" style="margin-left:6px;">Refresh</button>
          <p *ngIf="upcomingLoading">Loading...</p>
          <p class="error" *ngIf="upcomingError">{{ upcomingError }}</p>
          <p *ngIf="!upcomingLoading && !upcomingError && !upcoming.length" style="font-size:12px;">Nothing queued.</p>
          <div *ngFor="let u of upcoming" style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:13px;">
            <span>{{ u.atMs | date:'EEE MMM d, h:mm a' }}</span>
            <span>— {{ u.title || '(no title)' }}</span>
            <span style="opacity:0.7;">({{ u.imageCount }} photo{{ u.imageCount === 1 ? '' : 's' }}, {{ u.mode }})</span>
            <button type="button" (click)="cancelUpcoming(u)" [disabled]="u.cancelling">{{ u.cancelling ? 'Deleting...' : 'Delete' }}</button>
          </div>
        </div>
      </div>

      <button type="button" (click)="hidePost = !hidePost" [style.fontWeight]="hidePost ? 'bold' : 'normal'" style="font-size:11px; padding:3px 8px;">
        {{ hidePost ? '☑ Post hidden in video (tap to show)' : '☐ Hide post in video' }}
      </button>
      <h3>Background style</h3>
      <button (click)="submit('satisfying')" [disabled]="submitting">
        {{ submitting && activeMode === 'satisfying' ? 'Generating (Oddly Satisfying)...' : 'Generate (Oddly Satisfying)' }}
      </button>
      <button (click)="submit('gameplay')" [disabled]="submitting">
        {{ submitting && activeMode === 'gameplay' ? 'Generating (Gameplay)...' : 'Generate (Gameplay)' }}
      </button>
     <button (click)="submit('parkour')" [disabled]="submitting">
  {{ submitting && activeMode === 'parkour' ? 'Generating (Parkour)...' : 'Generate (Parkour)' }}
</button>


      <p class="error" *ngIf="error">{{ error }}</p>

      <details *ngIf="debug.length" class="debug-panel">
        <summary>Debug info</summary>
        <pre>{{ debug.join('\n') }}</pre>
      </details>

      <div *ngIf="videoUrl" class="result">
        <video [src]="videoUrl" controls width="280" autoplay></video>
        <a [href]="videoUrl" download="video.mp4">Download Video</a>
        <br />
        <button type="button" (click)="exportToYoutube()" [disabled]="exporting || youtubeStatus !== 'connected'">
          {{ exporting ? 'Uploading...' : 'Export to YouTube Shorts' }}
        </button>
        <p class="success" *ngIf="exportStatus === 'done'">✅ Uploaded to YouTube Shorts!</p>
        <p class="error" *ngIf="exportStatus === 'failed'">❌ {{ exportError }}</p>

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
            Posting to TikTok account: <strong>{{ tiktokCreatorInfo.creator_nickname }}</strong> (&#64;{{ tiktokCreatorInfo.creator_username }})
          </div>

          <label class="field-label" style="display:block; margin-top:6px;">Preview of your post</label>
          <video [src]="videoUrl" controls playsinline width="140"></video>

          <p class="error" *ngIf="tiktokDurationTooLong">
            ❌ This video is {{ videoDurationSec | number:'1.0-0' }}s, longer than the
            {{ tiktokCreatorInfo.max_video_post_duration_sec }}s this account can currently post to TikTok.
          </p>

          <label class="field-label" style="display:block; margin-top:6px;">Title (you can edit this, including hashtags)</label>
          <input type="text" maxlength="150" [(ngModel)]="tiktokTitle" [ngModelOptions]="{standalone: true}" />

          <label class="field-label" style="margin-top:6px;">Who can see this?</label>
          <select [(ngModel)]="tiktokPrivacyLevel" [ngModelOptions]="{standalone: true}">
            <option value="" disabled selected>Choose who can see this</option>
            <option
              *ngFor="let level of tiktokCreatorInfo.privacy_level_options"
              [value]="level"
              [disabled]="tiktokBrandedContent && level === 'SELF_ONLY'"
              [attr.title]="tiktokBrandedContent && level === 'SELF_ONLY' ? 'Branded content visibility cannot be set to private.' : null"
            >
              {{ tiktokPrivacyLabel(level) }}{{ tiktokBrandedContent && level === 'SELF_ONLY' ? ' — Branded content visibility cannot be set to private.' : '' }}
            </option>
          </select>

          <label class="field-label" style="display:block; margin-top:6px;" [style.opacity]="tiktokCreatorInfo.comment_disabled ? 0.5 : 1">
            <input type="checkbox" [(ngModel)]="tiktokAllowComment" [ngModelOptions]="{standalone: true}" [disabled]="tiktokCreatorInfo.comment_disabled" />
            Allow comments<span *ngIf="tiktokCreatorInfo.comment_disabled"> (turned off in your TikTok settings)</span>
          </label>
          <label class="field-label" style="display:block;" [style.opacity]="tiktokCreatorInfo.duet_disabled ? 0.5 : 1">
            <input type="checkbox" [(ngModel)]="tiktokAllowDuet" [ngModelOptions]="{standalone: true}" [disabled]="tiktokCreatorInfo.duet_disabled" />
            Allow duet<span *ngIf="tiktokCreatorInfo.duet_disabled"> (turned off in your TikTok settings)</span>
          </label>
          <label class="field-label" style="display:block; margin-bottom:6px;" [style.opacity]="tiktokCreatorInfo.stitch_disabled ? 0.5 : 1">
            <input type="checkbox" [(ngModel)]="tiktokAllowStitch" [ngModelOptions]="{standalone: true}" [disabled]="tiktokCreatorInfo.stitch_disabled" />
            Allow stitch<span *ngIf="tiktokCreatorInfo.stitch_disabled"> (turned off in your TikTok settings)</span>
          </label>

          <label class="field-label" style="display:block; margin-top:6px;">
            <input
              type="checkbox"
              [(ngModel)]="tiktokDisclosureEnabled"
              [ngModelOptions]="{standalone: true}"
              (ngModelChange)="onTiktokDisclosureChange()"
            />
            Disclose video content — this content promotes yourself, a brand, product or service
          </label>

          <div *ngIf="tiktokDisclosureEnabled" style="margin-left:20px;">
            <label class="field-label" style="display:block;">
              <input type="checkbox" [(ngModel)]="tiktokYourBrand" [ngModelOptions]="{standalone: true}" />
              Your brand — you are promoting yourself or your own business
            </label>
            <label class="field-label" style="display:block;" [style.opacity]="tiktokPrivacyLevel === 'SELF_ONLY' ? 0.5 : 1" [attr.title]="tiktokPrivacyLevel === 'SELF_ONLY' ? 'Branded content visibility cannot be set to private.' : null">
              <input
                type="checkbox"
                [(ngModel)]="tiktokBrandedContent"
                [ngModelOptions]="{standalone: true}"
                [disabled]="tiktokPrivacyLevel === 'SELF_ONLY'"
                (ngModelChange)="onTiktokBrandedContentChange()"
              />
              Branded content — you are promoting another brand or a third party
            </label>
            <p class="error" *ngIf="tiktokPrivacyLevel === 'SELF_ONLY'">
              Branded content visibility cannot be set to private.
            </p>
            <p class="error" *ngIf="!tiktokYourBrand && !tiktokBrandedContent">
              You need to indicate if your content promotes yourself, a third party, or both.
            </p>
            <p style="font-size:12px;" *ngIf="tiktokBrandedContent">Your photo/video will be labeled as 'Paid partnership'</p>
            <p style="font-size:12px;" *ngIf="tiktokYourBrand && !tiktokBrandedContent">Your photo/video will be labeled as 'Promotional content'</p>
          </div>

          <p style="font-size:12px; margin-top:8px;" *ngIf="!tiktokBrandedContent">
            By posting, you agree to TikTok's
            <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.
          </p>
          <p style="font-size:12px; margin-top:8px;" *ngIf="tiktokBrandedContent">
            By posting, you agree to TikTok's
            <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener">Branded Content Policy</a> and
            <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.
          </p>

          <p style="font-size:12px;">After you post, it may take a few minutes for your video to finish processing and be visible on your TikTok profile.</p>

          <span [attr.title]="(tiktokDisclosureEnabled && !tiktokYourBrand && !tiktokBrandedContent) ? 'You need to indicate if your content promotes yourself, a third party, or both.' : null">
            <button
              type="button"
              (click)="publishToTiktok()"
              [disabled]="tiktokPublishing || !tiktokPrivacyLevel || tiktokDurationTooLong || (tiktokDisclosureEnabled && !tiktokYourBrand && !tiktokBrandedContent)"
            >
              {{ tiktokPublishing ? 'Posting...' : 'Confirm & Post to TikTok' }}
            </button>
          </span>
        </div>
        <p class="success" *ngIf="tiktokPublishStatus === 'done'">✅ Sent to TikTok. It may take a few minutes to finish processing and be visible on your TikTok profile.</p>
        <p class="success" *ngIf="tiktokPublishStatus === 'processing'">⏳ TikTok is still processing your video. It may take a few minutes to be visible on your TikTok profile.</p>
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
    <p class="legal-links">
      <a href="https://vidmasta-7e113.web.app/terms-of-service.html" target="_blank" rel="noopener">Terms of Service</a>
      <a href="https://vidmasta-7e113.web.app/privacy-policy.html" target="_blank" rel="noopener">Privacy Policy</a>
      <a href="video-example.mp4" target="_blank" rel="noopener">Video Example</a>
    </p>
  `,
})
export class UploadComponent implements OnInit {
  emotions = EMOTIONS;
  title = ''; postFiles: File[] = []; sprites: Partial<Record<Emotion, File>> = {};
  submitting = false; error = '';
  activeMode: 'satisfying' | 'gameplay' | 'parkour' = 'satisfying';
  folderLoadSummary: string[] = [];
  debug: string[] = [];

  videoUrl: string | null = null;
  videoBlob: Blob | null = null;
  videoJobId: string | null = null;

  scheduleOpen = false;
  scheduleDays: { label: string; dateISO: string; dayOfWeek: number; times: { time: string; title: string }[] }[] = [];
  scheduleFiles: File[] = [];
  scheduleMode: 'satisfying' | 'gameplay' | 'parkour' = 'gameplay';
  scheduleTiktokCreatorInfo: TiktokCreatorInfo | null = null;
  scheduleTiktokPrivacyLevel = '';
  scheduleAllowComment = false;
  scheduleAllowDuet = false;
  scheduleAllowStitch = false;
  scheduleDisclosureEnabled = false;
  scheduleYourBrand = false;
  scheduleBrandedContent = false;
  scheduleSubmitting = false;
  scheduleStatus: '' | 'done' | 'failed' = '';
  scheduleError = '';
  scheduleSavedCount = 0;
  scheduleProgress = '';
  hidePost = false;
  upcoming: { scheduleId: string; idx: number; atMs: number; title: string; imageCount: number; mode: string; cancelling?: boolean }[] = [];
  upcomingLoading = false;
  upcomingError = '';

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
  tiktokAllowComment = false;
  tiktokAllowDuet = false;
  tiktokAllowStitch = false;
  tiktokDisclosureEnabled = false;
  tiktokYourBrand = false;
  tiktokBrandedContent = false;
  tiktokDurationTooLong = false;
  videoDurationSec: number | null = null;
  tiktokPublishing = false;
  tiktokPublishStatus: '' | 'done' | 'processing' | 'failed' = '';
  tiktokPublishError = '';
  tiktokTitle = '';

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
      await this.youtube.uploadShort(this.videoJobId!, this.title || 'Untitled');
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
      const result = await this.instagram.publish(this.videoJobId!, this.title || 'Untitled');
      this.instagramPublishStatus = result.status === 'complete' ? 'done' : 'processing';
    } catch (e: any) {
      this.instagramPublishStatus = 'failed';
      this.instagramPublishError = e.message;
    } finally {
      this.instagramPublishing = false;
    }
  }

  private readVideoDuration(videoUrl: string): Promise<number | null> {
    return new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        const d = Number.isFinite(probe.duration) ? probe.duration : null;
        resolve(d);
      };
      probe.onerror = () => resolve(null);
      probe.src = videoUrl;
    });
  }

  async loadTiktokOptions() {
    this.tiktokLoadingInfo = true;
    this.tiktokPublishStatus = '';
    try {
      this.tiktokCreatorInfo = await this.tiktok.getCreatorInfo();
      this.tiktokTitle = this.title || '';
      this.tiktokPrivacyLevel = '';
      this.tiktokAllowComment = false;
      this.tiktokAllowDuet = false;
      this.tiktokAllowStitch = false;
      this.tiktokDisclosureEnabled = false;
      this.tiktokYourBrand = false;
      this.tiktokBrandedContent = false;
      this.tiktokDurationTooLong =
        this.videoDurationSec != null &&
        this.videoDurationSec > this.tiktokCreatorInfo.max_video_post_duration_sec;
    } catch (e: any) {
      this.tiktokPublishStatus = 'failed';
      this.tiktokPublishError = e.message;
    } finally {
      this.tiktokLoadingInfo = false;
    }
  }

  onTiktokDisclosureChange() {
    if (!this.tiktokDisclosureEnabled) {
      this.tiktokYourBrand = false;
      this.tiktokBrandedContent = false;
    }
  }

  onTiktokBrandedContentChange() {
    if (this.tiktokBrandedContent && this.tiktokPrivacyLevel === 'SELF_ONLY') {
      this.tiktokPrivacyLevel = '';
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


  toggleSchedule() {
    this.scheduleOpen = !this.scheduleOpen;
    if (this.scheduleOpen) this.loadUpcoming();
    if (this.scheduleOpen && !this.scheduleDays.length) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const today = new Date();
      this.scheduleDays = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        const dateISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return { label: i === 0 ? `Today (${dayNames[d.getDay()]})` : dayNames[d.getDay()], dateISO, dayOfWeek: d.getDay(), times: [] };
      });
      this.videos.loadScheduleDraft().then((saved) => {
        for (const entry of saved) {
          const day = this.scheduleDays.find((d) => d.dayOfWeek === entry.dayOfWeek);
          if (day) day.times.push({ time: entry.time, title: entry.title });
        }
      }).catch(() => {});
    }
    if (this.scheduleOpen && !this.scheduleTiktokCreatorInfo && this.tiktokStatus === 'connected') {
      this.tiktok.getCreatorInfo().then((info) => (this.scheduleTiktokCreatorInfo = info)).catch(() => {});
    }
  }

  addScheduleTime(dayIndex: number) {
    this.scheduleDays[dayIndex].times.push({ time: '', title: '' });
    this.saveScheduleDraft();
  }

  removeScheduleTime(dayIndex: number, timeIndex: number) {
    this.scheduleDays[dayIndex].times.splice(timeIndex, 1);
    this.saveScheduleDraft();
  }

  saveScheduleDraft() {
    const entries = this.scheduleDays.flatMap((day) =>
      day.times.filter((t) => t.time).map((t) => ({ dayOfWeek: day.dayOfWeek, time: t.time, title: t.title }))
    );
    this.videos.saveScheduleDraft(entries).catch(() => {});
  }

  scheduleHasAnyTime(): boolean {
    return this.scheduleDays.some((d) => d.times.some((t) => t.time));
  }

  onScheduleDisclosureChange() {
    if (!this.scheduleDisclosureEnabled) {
      this.scheduleYourBrand = false;
      this.scheduleBrandedContent = false;
    }
  }

  onScheduleBrandedContentChange() {
    if (this.scheduleBrandedContent && this.scheduleTiktokPrivacyLevel === 'SELF_ONLY') {
      this.scheduleTiktokPrivacyLevel = '';
    }
  }

  async submitSchedule() {
    const slots: { atMs: number; title: string }[] = [];
    for (const day of this.scheduleDays) {
      for (const t of day.times) {
        if (!t.time) continue;
        const [y, m, d] = day.dateISO.split('-').map(Number);
        const [hh, mm] = t.time.split(':').map(Number);
        slots.push({ atMs: new Date(y, m - 1, d, hh, mm).getTime(), title: t.title || this.title });
      }
    }
    if (!slots.length || !this.scheduleFiles.length) return;

    this.scheduleSubmitting = true;
    this.scheduleStatus = '';
    try {
      const tiktokOptions = this.scheduleTiktokCreatorInfo
        ? {
            privacyLevel: this.scheduleTiktokPrivacyLevel,
            allowComment: this.scheduleAllowComment,
            allowDuet: this.scheduleAllowDuet,
            allowStitch: this.scheduleAllowStitch,
            yourBrand: this.scheduleDisclosureEnabled && this.scheduleYourBrand,
            brandedContent: this.scheduleDisclosureEnabled && this.scheduleBrandedContent,
          }
        : null;
      const result = await this.videos.createSchedule(this.scheduleFiles, this.sprites, this.scheduleMode, slots, tiktokOptions,
        (done, total) => (this.scheduleProgress = `Uploading ${done}/${total}...`), this.hidePost);
      this.scheduleSavedCount = result.entries.length;
      this.loadUpcoming();
      this.scheduleStatus = 'done';
    } catch (e: any) {
      this.scheduleStatus = 'failed';
      this.scheduleError = e.message;
    } finally {
      this.scheduleSubmitting = false;
      this.scheduleProgress = '';
    }
  }

  async loadUpcoming() {
    this.upcomingLoading = true;
    this.upcomingError = '';
    try {
      this.upcoming = await this.videos.listUpcomingScheduled();
    } catch (e: any) {
      this.upcomingError = e.message;
    } finally {
      this.upcomingLoading = false;
    }
  }

  async cancelUpcoming(u: { scheduleId: string; idx: number; cancelling?: boolean }) {
    u.cancelling = true;
    try {
      await this.videos.cancelScheduled(u.scheduleId, u.idx);
      this.upcoming = this.upcoming.filter((x) => x !== u);
    } catch (e: any) {
      this.upcomingError = e.message;
      u.cancelling = false;
      this.loadUpcoming();
    }
  }

  async publishToTiktok() {
    if (!this.videoJobId || !this.tiktokPrivacyLevel) return;
    if (this.tiktokDurationTooLong) return;
    if (this.tiktokDisclosureEnabled && !this.tiktokYourBrand && !this.tiktokBrandedContent) return;
    this.tiktokPublishing = true;
    this.tiktokPublishStatus = '';
    try {
      const result = await this.tiktok.publish(this.videoJobId!, this.tiktokTitle || 'Untitled', {
        privacyLevel: this.tiktokPrivacyLevel,
        allowComment: this.tiktokAllowComment,
        allowDuet: this.tiktokAllowDuet,
        allowStitch: this.tiktokAllowStitch,
        yourBrand: this.tiktokDisclosureEnabled && this.tiktokYourBrand,
        brandedContent: this.tiktokDisclosureEnabled && this.tiktokBrandedContent,
      });
      this.tiktokPublishStatus = result.status === 'complete' ? 'done' : 'processing';
    } catch (e: any) {
      this.tiktokPublishStatus = 'failed';
      this.tiktokPublishError = e.message;
    } finally {
      this.tiktokPublishing = false;
    }
  }

  async submit(mode: 'satisfying' | 'gameplay' | 'parkour') {
    this.error = '';
    if (!this.postFiles.length) { this.error = 'Add at least one screenshot.'; return; }
    this.activeMode = mode;
    this.submitting = true;
    this.exportStatus = '';
    this.tiktokPublishStatus = '';
    this.tiktokCreatorInfo = null;
    this.instagramPublishStatus = '';
    try {
      const result = await this.videos.generateVideo(this.postFiles, this.title || 'Untitled', this.sprites, mode, this.hidePost);
      this.videoUrl = result.videoUrl;
      this.debug = result.debug;
      this.videoBlob = result.videoBlob;
      this.videoJobId = result.jobId;
      this.videoDurationSec = await this.readVideoDuration(result.videoUrl);
    } catch (e: any) {
      this.error = e.message;
      if (e.debug) this.debug = e.debug;
    }
    finally { this.submitting = false; }
  }
}