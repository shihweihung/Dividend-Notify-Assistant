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

export function initFirestoreClient() {
  if (ctx.adminDb) return;
  const fbConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (!fs.existsSync(fbConfigPath)) {
    ctx.firestoreAvailable = false;
    return;
  }
  try {
    const firebaseConfig = JSON.parse(fs.readFileSync(fbConfigPath, "utf-8"));
    const firebaseApp = admin.apps.length > 0 ? admin.apps[0]! : admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });
    ctx.adminDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
    console.log(`[Firebase Admin] Fully initialized with Project ID: ${firebaseConfig.projectId}, Database ID: ${firebaseConfig.firestoreDatabaseId}`);
  } catch (fbErr) {
    console.error("[Firebase Admin] Initialization failed:", fbErr);
    ctx.firestoreAvailable = false;
  }
}

export async function checkFirestoreHealth(timeoutMs = 2500) {
  if (!ctx.adminDb) {
    ctx.firestoreAvailable = false;
    return false;
  }
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ctx.adminDb.collection("telegram_chats").limit(1).get(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Firestore health check timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    ctx.firestoreAvailable = true;
    console.log("[Firestore] Health check passed");
    return true;
  } catch (hcErr: any) {
    ctx.firestoreAvailable = false;
    console.warn("[Firestore] Not accessible in this environment. Some features will be disabled.", hcErr.message || hcErr);
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function initFirestore() {
  initFirestoreClient();
  await checkFirestoreHealth();
}
