import { Routes } from '@angular/router';
import { LoginComponent, UploadComponent } from './components';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  { path: 'upload', component: UploadComponent },
];