import { Routes } from '@angular/router';
import { LandingComponent, LoginComponent, UploadComponent } from './components';

export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'login', component: LoginComponent },
  { path: 'upload', component: UploadComponent },
  { path: '**', redirectTo: '' },
];