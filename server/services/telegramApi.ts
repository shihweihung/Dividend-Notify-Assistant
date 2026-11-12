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
