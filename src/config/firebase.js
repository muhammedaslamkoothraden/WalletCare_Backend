const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

let isFirebaseInitialized = false;

try {
    // process.cwd() points to the root 'WalletCare_Backend/' folder 
    const serviceAccountPath = path.join(process.cwd(), "serviceAccountKey.json");
    const serviceAccount = require(serviceAccountPath);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    isFirebaseInitialized = true;
    console.log("🔥 Firebase Admin initialized successfully.");
} catch (error) {
    console.warn("⚠️ Firebase Admin skipped: Init failed.");
    console.error(error); // Log the actual error to find the true cause
}

module.exports = { admin, isFirebaseInitialized };