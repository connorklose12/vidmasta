import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, VideoService, EMOTIONS, Emotion } from './services';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  template: `
    <div class="upload-box">
      <h2>Create a Video</h2>

      <input type="text" [(ngModel)]="title" placeholder="Video title" />

      <label>Post screenshots (in order)</label>
      <input type="file" accept="image/*" multiple (change)="postFiles = pick($event)" />

      <h3>Emotion sprites (optional — used for this video only, not saved anywhere)</h3>
      <div *ngFor="let emotion of emotions">
        <span>{{ emotion }}</span>
        <input type="file" accept="image/png" (change)="sprites[emotion] = pick($event)[0]" />
      </div>

      <button (click)="submit()" [disabled]="submitting">
        {{ submitting ? 'Generating... this can take a few minutes' : 'Generate Video' }}
      </button>

      <p class="error" *ngIf="error">{{ error }}</p>

      <div *ngIf="videoBase64" class="result">
        <video [src]="musicOn ? videoSrc : videoNoMusicSrc" controls width="280"></video>
        <br />
        <button (click)="musicOn = !musicOn">{{ musicOn ? 'Turn Music Off' : 'Turn Music On' }}</button>
        <a [href]="musicOn ? videoSrc : videoNoMusicSrc" download="video.mp4">Download</a>
      </div>
    </div>
  `,
})
export class UploadComponent {
  emotions = EMOTIONS;
  title = ''; postFiles: File[] = []; sprites: Partial<Record<Emotion, File>> = {};
  submitting = false; error = '';

  videoBase64: string | null = null;
  videoNoMusicBase64: string | null = null;
  videoSrc = ''; videoNoMusicSrc = '';
  musicOn = true;

  constructor(private videos: VideoService) {}

  pick(event: Event): File[] {
    const input = event.target as HTMLInputElement;
    return input.files ? Array.from(input.files) : [];
  }

  async submit() {
    this.error = '';
    if (!this.postFiles.length) { this.error = 'Add at least one screenshot.'; return; }
    this.submitting = true;
    try {
      const result = await this.videos.generateVideo(this.postFiles, this.title || 'Untitled', this.sprites);
      this.videoBase64 = result.videoBase64;
      this.videoNoMusicBase64 = result.videoNoMusicBase64;
      this.videoSrc = `data:video/mp4;base64,${this.videoBase64}`;
      this.videoNoMusicSrc = `data:video/mp4;base64,${this.videoNoMusicBase64}`;
    } catch (e: any) { this.error = e.message; }
    finally { this.submitting = false; }
  }
}