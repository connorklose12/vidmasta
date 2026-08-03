import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, VideoService, EMOTIONS, Emotion } from './services';

const APP_STYLES = `
  :host {
    display: block;
    min-height: 100vh;
    background: #FDF6EC;
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #14171A;
    padding: 16px;
    box-sizing: border-box;
  }

  h2, h3 {
    font-weight: 800;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    margin: 0 0 10px;
  }

  h2 { font-size: 24px; }
  h3 { font-size: 14px; margin-top: 14px; }

  .auth-box, .upload-box {
    max-width: 560px;
    margin: 0 auto;
    background: #ffffff;
    border: 2px solid #14171A;
    border-radius: 16px;
    padding: 18px 22px;
    box-shadow: 5px 5px 0 #14171A;
  }

  input[type="text"], input[type="email"], input[type="password"] {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    margin-bottom: 8px;
    border: 2px solid #14171A;
    border-radius: 8px;
    font-size: 13px;
    font-family: inherit;
    background: #FFF9F0;
  }

  input[type="file"] {
    font-family: inherit;
    font-size: 12px;
    margin: 3px 0;
  }

  button {
    font-family: inherit;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    font-size: 12px;
    border: 2px solid #14171A;
    border-radius: 10px;
    padding: 9px 16px;
    background: #FF6B5B;
    color: #14171A;
    cursor: pointer;
    box-shadow: 3px 3px 0 #14171A;
    transition: transform 0.08s ease, box-shadow 0.08s ease;
  }

  button:hover:not(:disabled) {
    transform: translate(-1px, -1px);
    box-shadow: 4px 4px 0 #14171A;
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
    margin-top: 2px;
    padding: 8px 12px;
  }

  .toggle {
    cursor: pointer;
    text-decoration: underline;
    font-size: 12px;
    margin-top: 6px;
  }

  .error {
    color: #B3261E;
    font-weight: 700;
    font-size: 12px;
    margin-top: 8px;
  }

  .field-label {
    display: block;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }

  .sprite-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
    margin: 10px 0 6px;
  }

  .sprite-card {
    background: #F1F5FF;
    border: 2px solid #14171A;
    border-radius: 10px;
    padding: 8px;
  }
  .sprite-card:nth-child(4n+2) { background: #FFE9E4; }
  .sprite-card:nth-child(4n+3) { background: #FFF6D6; }
  .sprite-card:nth-child(4n+4) { background: #E4FBF6; }

  .sprite-card .emotion-name {
    display: block;
    font-weight: 800;
    text-transform: capitalize;
    margin-bottom: 4px;
    font-size: 11px;
  }

  .folder-summary {
    background: #14171A;
    color: #FDF6EC;
    border-radius: 8px;
    padding: 8px 10px;
    margin-top: 8px;
    font-size: 11px;
    font-family: 'SFMono-Regular', Menlo, monospace;
    line-height: 1.5;
  }

  .result {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 2px dashed #14171A;
  }

  .result video {
    width: 100%;
    max-width: 200px;
    max-height: 30vh;
    border-radius: 10px;
    border: 2px solid #14171A;
    display: block;
    margin: 0 auto 10px;
  }

  .result a {
    display: inline-block;
    font-weight: 800;
    text-transform: uppercase;
    text-decoration: none;
    font-size: 12px;
    color: #14171A;
    border-bottom: 2px solid #FF6B5B;
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

      <button (click)="submit()" [disabled]="submitting">
        {{ submitting ? 'Generating... this can take a few minutes' : 'Generate Video' }}
      </button>

      <p class="error" *ngIf="error">{{ error }}</p>

      <div *ngIf="videoUrl" class="result">
        <video [src]="videoUrl" controls width="280" autoplay></video>
        <a [href]="videoUrl" download="video.mp4">Download Video</a>
      </div>
    </div>
  `,
})
export class UploadComponent {
  emotions = EMOTIONS;
  title = ''; postFiles: File[] = []; sprites: Partial<Record<Emotion, File>> = {};
  submitting = false; error = '';
  folderLoadSummary: string[] = [];

  videoUrl: string | null = null;

  constructor(private videos: VideoService) {}

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

  async submit() {
    this.error = '';
    if (!this.postFiles.length) { this.error = 'Add at least one screenshot.'; return; }
    this.submitting = true;
    try {
      const result = await this.videos.generateVideo(this.postFiles, this.title || 'Untitled', this.sprites);
      this.videoUrl = result.videoUrl;
    } catch (e: any) { this.error = e.message; }
    finally { this.submitting = false; }
  }
}