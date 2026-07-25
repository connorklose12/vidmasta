import { Injectable } from '@angular/core';
import { Auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, user } from '@angular/fire/auth';
import { Storage, ref, uploadBytes, getDownloadURL } from '@angular/fire/storage';
import { Firestore, collection, addDoc, doc, setDoc, serverTimestamp } from '@angular/fire/firestore';

export const EMOTIONS = ['happy', 'excited', 'sad', 'mad', 'confused', 'grossed_out', 'afraid', 'shocked'] as const;
export type Emotion = (typeof EMOTIONS)[number];

@Injectable({ providedIn: 'root' })
export class AuthService {
   user$;
  constructor(private auth: Auth) {
    this.user$ = user(this.auth);}
  login(email: string, password: string) { return signInWithEmailAndPassword(this.auth, email, password); }
  signup(email: string, password: string) { return createUserWithEmailAndPassword(this.auth, email, password); }
  logout() { return signOut(this.auth); }
}

@Injectable({ providedIn: 'root' })
export class PostService {
  constructor(private storage: Storage, private firestore: Firestore, private auth: Auth) {}

  private get uid() {
    const uid = this.auth.currentUser?.uid;
    if (!uid) throw new Error('Not logged in');
    return uid;
  }

  // Save a user's custom emotion sprite — linked to their account, reused on every future job
  async uploadSprite(file: File, emotion: Emotion) {
    const r = ref(this.storage, `users/${this.uid}/sprites/${emotion}.png`);
    await uploadBytes(r, file);
    const url = await getDownloadURL(r);
    await setDoc(doc(this.firestore, `users/${this.uid}/sprites/${emotion}`), { emotion, url, updatedAt: serverTimestamp() }, { merge: true });
  }

  // Upload all post screenshots + a title, create the render job doc.
  // A Cloud Function trigger (see functions/src/index.ts) picks up "queued" jobs.
  async createJob(files: File[], title: string, sprites: Partial<Record<Emotion, File>>) {
    for (const emotion of EMOTIONS) {
      const file = sprites[emotion];
      if (file) await this.uploadSprite(file, emotion);
    }

    const jobRef = await addDoc(collection(this.firestore, `users/${this.uid}/jobs`), {
      title, status: 'uploading', createdAt: serverTimestamp(),
    });

    const imageUrls: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const r = ref(this.storage, `users/${this.uid}/jobs/${jobRef.id}/images/${i}_${files[i].name}`);
      await uploadBytes(r, files[i]);
      imageUrls.push(await getDownloadURL(r));
    }

    await setDoc(doc(this.firestore, `users/${this.uid}/jobs/${jobRef.id}`), { imageUrls, status: 'queued' }, { merge: true });
    return jobRef.id;
  }
}