import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  standalone: true,
  template: '<router-outlet></router-outlet>',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('vidmast2');
}
