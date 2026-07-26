import { Routes } from '@angular/router';
import { LoginComponent, CreateComponent, ExportComponent } from './video-features';

export const routes: Routes = [
{ path: 'login', component: LoginComponent },
{ path: 'create', component: CreateComponent },
{ path: 'export/:jobId', component: ExportComponent },

];
