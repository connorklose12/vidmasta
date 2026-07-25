import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, PostService, EMOTIONS, Emotion } from './services';

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

      <h3>Emotion sprites (optional, saved to your account)</h3>
      <div *ngFor="let emotion of emotions">
        <span>{{ emotion }}</span>
        <input type="file" accept="image/png" (change)="sprites[emotion] = pick($event)[0]" />
      </div>

      <button (click)="submit()" [disabled]="submitting">{{ submitting ? 'Uploading...' : 'Generate Video' }}</button>

      <p class="error" *ngIf="error">{{ error }}</p>
      <p class="success" *ngIf="jobId">Queued! Job ID: {{ jobId }}</p>
    </div>
  `,
})
export class UploadComponent {
  emotions = EMOTIONS;
  title = ''; postFiles: File[] = []; sprites: Partial<Record<Emotion, File>> = {};
  submitting = false; jobId: string | null = null; error = '';

  constructor(private posts: PostService) {}

  pick(event: Event): File[] {
    const input = event.target as HTMLInputElement;
    return input.files ? Array.from(input.files) : [];
  }

  async submit() {
    this.error = '';
    if (!this.postFiles.length) { this.error = 'Add at least one screenshot.'; return; }
    this.submitting = true;
    try {
      this.jobId = await this.posts.createJob(this.postFiles, this.title || 'Untitled', this.sprites);
    } catch (e: any) { this.error = e.message; }
    finally { this.submitting = false; }
  }
}