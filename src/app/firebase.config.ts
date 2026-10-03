// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyBOKoqdPBGZG-gZuHTkV9RztsxuieeIzkA",
  authDomain: "vidmasta-7e113.firebaseapp.com",
  projectId: "vidmasta-7e113",
  storageBucket: "vidmasta-7e113.firebasestorage.app",
  messagingSenderId: "48588159973",
  appId: "1:48588159973:web:2dbd684c5084409aeacd0c",
  measurementId: "G-K0KL0SVECR"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);