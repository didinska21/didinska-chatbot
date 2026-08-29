const CLAUDE_BASE = "https://co.agentrouter.org";
const OPENAI_BASE = "https://co.agentrouter.org/v1";

function isClaude(model) {
  return /^claude(?:-|$)/i.test(model);
}

function systemPrompt(project) {
  return `You are a private senior software engineer and coding assistant.\n\nRules:\n- Give production-quality, practical code.\n- When modifying code, preserve existing behavior unless the user asks otherwise.\n- For bugs, explain the root cause briefly, then provide corrected code.\n- Prefer complete files or clearly marked patches when useful.\n- Never claim you executed code unless execution actually happened.\n- For MQL5, pay attention to strict compilation, symbol/point/digits handling, trade retcodes, risk, and broker constraints.\n- If requirements are ambiguous, make a reasonable assumption and state it briefly.\n\nCurrent project: ${project || "none"}.`;
}

async function fetchWithTimeout(url, options, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function tg(env, method, body) {
  const r = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, 15000);
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || "unknown error"}`);
  return data.result;
}

async function sendText(env, chatId, text) {
  const chunks = splitForTelegram(text, 3900);
  for (const chunk of chunks) await tg(env, "sendMessage", { chat_id: chatId, text: chunk });
}

function splitForTelegram(text, max = 3900) {
  const out = [];
  let rest = String(text || "");
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < 1000) cut = rest.lastIndexOf(" ", max);
    if (cut < 1000) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}

async function getState(env, userId) {
  const row = await env.DB.prepare("SELECT * FROM conversations WHERE user_id = ?").bind(String(userId)).first();
  if (!row) return { model: env.DEFAULT_MODEL || "claude-opus-5", project: null, history: [] };
  let history = [];
  try { history = JSON.parse(row.history_json || "[]"); } catch {}
  return { model: row.model, project: row.project, history };
}

async function saveState(env, userId, state) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO conversations(user_id, model, project, history_json, updated_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET model=excluded.model, project=excluded.project,
    history_json=excluded.history_json, updated_at=excluded.updated_at`)
    .bind(String(userId), state.model, state.project, JSON.stringify(state.history), now).run();
}

async function callClaude(env, model, messages, project) {
  const start = Date.now();
  const r = await fetchWithTimeout(`${CLAUDE_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.AGENTROUTER_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model, max_tokens: 12000, system: systemPrompt(project), messages })
  }, 60000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${data?.error?.message || text.slice(0, 1000)}`);
  const answer = (data.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
  return { answer, ms: Date.now() - start, usage: data.usage || null };
}

async function callOpenAI(env, model, messages, project) {
  const start = Date.now();
  const r = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.AGENTROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, max_tokens: 12000, messages: [{ role: "system", content: systemPrompt(project) }, ...messages] })
  }, 60000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${data?.error?.message || text.slice(0, 1000)}`);
  return { answer: data.choices?.[0]?.message?.content || "", ms: Date.now() - start, usage: data.usage || null };
}

async function ask(env, model, messages, project) {
  return isClaude(model) ? callClaude(env, model, messages, project) : callOpenAI(env, model, messages, project);
}

function authorized(env, userId) {
  const allowed = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return allowed && String(userId) === allowed;
}

async function handleCommand(env, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = (cmdRaw || "").split("@")[0].toLowerCase();
  const arg = args.join(" ").trim();

  // Cek /id dan otorisasi DULU, sebelum menyentuh DB.
  // Sebelumnya getState() dipanggil untuk SEMUA pesan (termasuk dari user
  // yang tidak diizinkan), yang boros dan bisa membuat /id ikut gagal
  // kalau D1 belum ter-migrate / bermasalah.
  if (cmd === "/id") {
    await sendText(env, chatId, `Telegram User ID: ${userId}`);
    return;
  }
  if (!authorized(env, userId)) {
    await sendText(env, chatId, `⛔ Akses ditolak.\nTelegram User ID kamu: ${userId}`);
    return;
  }

  const state = await getState(env, userId);

  if (cmd === "/start" || cmd === "/help") {
    await sendText(env, chatId, `🤖 DIDINSKA CODING ASSISTANT\n\nModel: ${state.model}\nProject: ${state.project || "none"}\n\nKirim pesan biasa untuk coding.\n\nPerintah:\n/model <model-id>\n/models\n/project <nama>\n/clear\n/test\n/id\n/help\n\nContoh:\n/model claude-opus-5\n/project XAUUSD_EA\n\nBuatkan EA MQL5 dengan EMA 200 dan RSI.`);
    return;
  }
  if (cmd === "/model") {
    if (!arg) return sendText(env, chatId, `Model sekarang: ${state.model}\nGunakan /model <model-id>`);
    state.model = arg;
    await saveState(env, userId, state);
    await sendText(env, chatId, `✅ Model diubah ke: ${arg}\nProtokol: ${isClaude(arg) ? "Anthropic Messages" : "OpenAI-compatible Chat Completions"}`);
    return;
  }
  if (cmd === "/models") {
    await sendText(env, chatId, `Model ID mengikuti akses AgentRouter API key kamu.\n\nContoh:\n• claude-opus-5\n• claude-opus-4-8\n• deepseek-v4-flash\n• glm-5.3\n• gpt-5.6-sol\n\nGunakan /model <model-id>.`);
    return;
  }
  if (cmd === "/project") {
    if (!arg) return sendText(env, chatId, `Project sekarang: ${state.project || "none"}\nGunakan /project <nama>`);
    state.project = arg;
    await saveState(env, userId, state);
    await sendText(env, chatId, `📁 Project aktif: ${arg}`);
    return;
  }
  if (cmd === "/clear") {
    state.history = [];
    await saveState(env, userId, state);
    await sendText(env, chatId, "🧹 Context percakapan dihapus. Model dan project tetap.");
    return;
  }
  if (cmd === "/test") {
    try {
      const result = await ask(env, state.model, [{ role: "user", content: "Reply with exactly: API BERHASIL" }], state.project);
      await sendText(env, chatId, `🧪 API TEST\n\nModel: ${state.model}\nStatus: ✅ SUCCESS\nLatency: ${result.ms} ms\nResponse: ${result.answer || "(empty)"}`);
    } catch (e) {
      await sendText(env, chatId, `🧪 API TEST\n\nModel: ${state.model}\nStatus: ❌ FAILED\n\n${e.message}`);
    }
    return;
  }
  if (cmd.startsWith("/")) {
    await sendText(env, chatId, "Perintah tidak dikenal. Gunakan /help.");
  }
}

async function handleText(env, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!authorized(env, userId)) {
    await sendText(env, chatId, `⛔ Akses ditolak.\nTelegram User ID kamu: ${userId}`);
    return;
  }
  const content = msg.text || "";

  // Guard ukuran pesan masuk. MAX_FILE_BYTES sudah dideklarasikan di
  // wrangler.toml tapi sebelumnya tidak pernah dipakai di kode manapun.
  const maxBytes = Number(env.MAX_FILE_BYTES || 200000);
  if (content.length > maxBytes) {
    await sendText(env, chatId, `⚠️ Pesan terlalu panjang (${content.length} karakter, maks ${maxBytes}). Silakan pecah jadi beberapa pesan.`);
    return;
  }

  const maxHistory = Number(env.MAX_HISTORY || 20);
  const state = await getState(env, userId);
  state.history.push({ role: "user", content });
  // Slice sekali saja, SETELAH push, supaya jumlah pesan yang dikirim ke
  // model tidak pernah lebih dari maxHistory (sebelumnya di-slice sebelum
  // push juga, sehingga request ke API bisa berisi maxHistory+1 pesan).
  state.history = state.history.slice(-maxHistory);
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const result = await ask(env, state.model, state.history, state.project);
    state.history.push({ role: "assistant", content: result.answer });
    state.history = state.history.slice(-maxHistory);
    await saveState(env, userId, state);
    await sendText(env, chatId, result.answer || "(AI returned an empty response)");
  } catch (e) {
    state.history.pop();
    await saveState(env, userId, state);
    await sendText(env, chatId, `❌ API ERROR\n\nModel: ${state.model}\n${e.message}`);
  }
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "GET") {
        return new Response("didinska-chatbot is running.", { status: 200 });
      }
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

      const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (expectedSecret) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== expectedSecret) return new Response("Unauthorized", { status: 401 });
      }

      const update = await request.json();
      const msg = update.message;
      if (!msg) return new Response("OK", { status: 200 });

      if (msg.text?.startsWith("/")) await handleCommand(env, msg);
      else if (msg.text) await handleText(env, msg);
      else if (authorized(env, msg.from?.id)) {
        // Sebelumnya pesan non-teks (foto, dokumen, stiker, voice, dll)
        // dibiarkan tanpa balasan sama sekali, membuat bot terkesan macet.
        await sendText(env, msg.chat.id, "ℹ️ Bot ini hanya memproses pesan teks. Kirim pertanyaan/kode sebagai teks ya.");
      }

      return new Response("OK", { status: 200 });
    } catch (e) {
      console.error(e);
      return new Response("OK", { status: 200 });
    }
  }
};
