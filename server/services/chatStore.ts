import path from "path";
import fs from "fs";
import { ctx, logFirestoreError } from "../context";

export const getChatFromFirestore = async (chatId: string) => {
  if (ctx.firestoreAvailable === false) {
    return ctx.inMemoryTelegramChats.get(chatId) || null;
  }
  try {
    const doc = await ctx.adminDb.collection("telegram_chats").doc(chatId).get();
    return doc.exists ? doc.data() : null;
  } catch (e: any) {
    logFirestoreError(`getChatFromFirestore for chatId ${chatId}`, e);
    return ctx.inMemoryTelegramChats.get(chatId) || null;
  }
};

export const saveChatToFirestore = async (chatId: string, data: any) => {
  ctx.inMemoryTelegramChats.set(chatId, data);
  if (ctx.firestoreAvailable === false) {
    return;
  }
  try {
    await ctx.adminDb.collection("telegram_chats").doc(chatId).set({
      ...data,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (e: any) {
    logFirestoreError(`saveChatToFirestore for chatId ${chatId}`, e);
  }
};

export async function migrateLegacyJsonDb() {
  // Migrate JSON DB to Firestore
  const dbPath = path.join(process.cwd(), "telegram_chats_db.json");
  if (fs.existsSync(dbPath)) {
    try {
      const dbData = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      for (const chatId in dbData) {
        if (ctx.firestoreAvailable !== false) {
          try {
            await ctx.adminDb.collection("telegram_chats").doc(chatId).set(dbData[chatId]);
          } catch (e: any) {
            logFirestoreError(`Migrate JSON DB element for ${chatId}`, e);
          }
        }
        ctx.inMemoryTelegramChats.set(chatId, dbData[chatId]);
      }
      fs.unlinkSync(dbPath);
      console.log("Migration complete: telegram_chats_db.json -> Firestore/InMemory fallback");
    } catch (e) {
      console.error("Migration error:", e);
    }
  }
}
