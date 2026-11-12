import path from "path";
import fs from "fs";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

// 伺服器共用狀態（原本是 startServer() 內的區域變數）
export const ctx = {
  // Firestore connection health
  firestoreAvailable: null as boolean | null,
  firestoreErrorLogged: false,
  isProduction: process.env.NODE_ENV === "production" || !!process.env.K_SERVICE,
  adminDb: null as any,

  // In-memory fallback caches
  inMemoryProcessedMessages: new Set<string>(),
  inMemoryRateLimits: new Map<string, number[]>(),
  inMemoryTelegramChats: new Map<string, any>(),
};

export function logFirestoreError(context: string, error: any) {
  if (ctx.isProduction) {
    console.error(`[Firestore Error] ${context}:`, error);
  } else {
    if (!ctx.firestoreErrorLogged) {
      console.warn(`[Firestore Warning] ${context} (this is expected in dev environments without Firestore access):`, error.message || error);
      ctx.firestoreErrorLogged = true;
    }
  }
}

export async function initFirestore() {
  // Initialize Firebase Admin dynamically securely connected to Firestore
  const fbConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(fbConfigPath)) {
    try {
      const firebaseConfig = JSON.parse(fs.readFileSync(fbConfigPath, "utf-8"));
      const firebaseApp = admin.apps.length > 0 ? admin.apps[0]! : admin.initializeApp({
        projectId: firebaseConfig.projectId,
      });
      ctx.adminDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
      console.log(`[Firebase Admin] Fully initialized with Project ID: ${firebaseConfig.projectId}, Database ID: ${firebaseConfig.firestoreDatabaseId}`);

      // 2. Perform connection check at startup
      try {
        await ctx.adminDb.collection("telegram_chats").limit(1).get();
        ctx.firestoreAvailable = true;
        console.log("[Firestore] Health check passed");
      } catch (hcErr: any) {
        ctx.firestoreAvailable = false;
        console.warn("[Firestore] Not accessible in this environment. Some features will be disabled.", hcErr.message || hcErr);
      }
    } catch (fbErr) {
      console.error("[Firebase Admin] Initialization failed:", fbErr);
      ctx.firestoreAvailable = false;
    }
  } else {
    ctx.firestoreAvailable = false;
  }
}
