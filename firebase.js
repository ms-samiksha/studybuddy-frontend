// studybuddy/studybuddy/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCRQTt-H1oHiFGW1nn9uFlOqM3bv8c6go4",
  authDomain: "studybuddy-6f680.firebaseapp.com",
  projectId: "studybuddy-6f680",
  storageBucket: "studybuddy-6f680.appspot.com",
  messagingSenderId: "314943736899",
  appId: "1:314943736899:web:a4cc2f63af7790b2ac58f6",
  measurementId: "G-NB35SRBGMY"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Firebase exports
export const auth = getAuth(app);
export const db = getFirestore(app);
export { signOut }; // Export signOut function for use in other files
