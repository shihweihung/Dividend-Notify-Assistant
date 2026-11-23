export async function sendTelegramMsg(botToken: string, toChatId: number | string, textToSend: string) {
  if (textToSend.length > 4000) {
    console.log(`[Telegram Send] Text length ${textToSend.length} exceeds 4000, splitting into multiple messages...`);
    const chunks: string[] = [];
    for (let i = 0; i < textToSend.length; i += 4000) {
      chunks.push(textToSend.substring(i, i + 4000));
    }
    let lastResponse: any = null;
    for (let idx = 0; idx < chunks.length; idx++) {
      console.log(`[Telegram Send] Sending chunk ${idx + 1}/${chunks.length} for ChatID ${toChatId}`);
      lastResponse = await sendSingleTelegramMsg(botToken, toChatId, chunks[idx]);
    }
    return lastResponse;
  } else {
    return sendSingleTelegramMsg(botToken, toChatId, textToSend);
  }
}

export async function sendSingleTelegramMsg(botToken: string, toChatId: number | string, textToSend: string) {
  console.log(`[Telegram Send] Attempting to send to ChatID ${toChatId}, message length: ${textToSend.length}`);
  try {
    // First attempt with Markdown
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: toChatId,
        text: textToSend,
        parse_mode: "Markdown",
      }),
    });

    if (response.ok) {
      console.log(`[Telegram Send Success] Delivered to ChatID ${toChatId}`);
      return response;
    }

    // First attempt failed
    let errDetails: any = null;
    try {
      errDetails = await response.json();
    } catch (jsonErr) {
      errDetails = "Unparseable JSON response";
    }

    console.warn(`[Telegram Send Warning] Markdown failed for ChatID ${toChatId}, status: ${response.status}, response: ${JSON.stringify(errDetails)}`);

    // Second attempt (plain text fallback, no parse_mode)
    console.log(`[Telegram Send] Attempting plain-text fallback for ChatID ${toChatId}`);
    const fallbackResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: toChatId,
        text: textToSend,
      }),
    });

    if (fallbackResponse.ok) {
      console.log(`[Telegram Send Success] Plain text fallback delivered to ChatID ${toChatId}`);
      return fallbackResponse;
    }

    // Fallback failed too
    let fallbackErrDetails: any = null;
    try {
      fallbackErrDetails = await fallbackResponse.json();
    } catch (jsonErr) {
      fallbackErrDetails = "Unparseable JSON response";
    }

    console.error(`[Telegram Send Fatal] Both attempts failed for ChatID ${toChatId}, status: ${fallbackResponse.status}, response: ${JSON.stringify(fallbackErrDetails)}`);
    return fallbackResponse;

  } catch (err: any) {
    console.error(`[Telegram Send Exception] ChatID ${toChatId}:`, err instanceof Error ? err.stack : err);
  }
}

// 帶按鈕的訊息（記帳確認卡用）；純文字，不用 Markdown 以免股名特殊字元出錯
export async function sendTelegramButtons(
  botToken: string,
  chatId: number | string,
  text: string,
  buttons: { text: string; data: string }[],
) {
  return telegramCall(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] },
  });
}

export async function editTelegramMessage(botToken: string, chatId: number | string, messageId: number, text: string) {
  return telegramCall(botToken, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

export async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string) {
  return telegramCall(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

async function telegramCall(botToken: string, method: string, body: any) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[Telegram ${method}] status ${res.status}: ${await res.text()}`);
    return res;
  } catch (err) {
    console.error(`[Telegram ${method}] failed:`, err);
    return null;
  }
}
