import { makeWASocket, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import { getUser, addTransaction, getFinancialSummary, getTransactions, updateUserBudget, getBotSessions, createBotSession, updateBotSessionStatus, deleteBotSession, isMessageProcessed, markMessageProcessed, clearSessionAuth } from '../lib/db.js';
import { usePgAuthState } from './dbAuth.js';
import { parseFinancialInput, parseReceiptImage, parseAudioVoice } from './gemini.js';

// Map of running sessions: id -> { id, name, ownerPhone, botPhone, sock, status, qr, client }
const sessions = new Map();

const logFile = path.resolve(process.cwd(), 'data', 'bot.log');
const processedMsgIds = new Set();
const sentMsgIds = new Set();

function logLine(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  try {
    fs.appendFileSync(logFile, msg + '\n');
  } catch {}
  console.log(msg);
}

function makeSession(sess) {
  return {
    id: sess.id,
    name: sess.name || sess.id,
    ownerPhone: sess.owner_phone || sess.ownerPhone || '',
    botPhone: sess.bot_phone || sess.botPhone || '',
    sock: null,
    status: 'disconnected',
    qr: null,
    client: null,
    failCount: 0
  };
}

async function sendText(sock, jid, text) {
  try {
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) {
      sentMsgIds.add(sent.key.id);
      if (sentMsgIds.size > 300) {
        const first = sentMsgIds.values().next().value;
        sentMsgIds.delete(first);
      }
    }
    return sent;
  } catch (e) {
    logLine('[SEND ERROR] ' + e.message);
    return null;
  }
}

function genSessionId() {
  return 'bot-' + Math.random().toString(36).slice(2, 6);
}

export async function startSession(sess, { pairingMode = false } = {}) {
  const session = sessions.get(sess.id) || makeSession(sess);
  session.status = 'connecting';
  session.sock = null;

  const { state, saveCreds } = await usePgAuthState(session.id);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !pairingMode,
    logger: pino({ level: 'silent' }),
  });

  session.sock = sock;
  sessions.set(session.id, session);
  try { await updateBotSessionStatus(session.id, 'connecting'); } catch {}

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      session.status = 'qr_ready';
      qrcodeTerminal.generate(qr, { small: true });
      try { await updateBotSessionStatus(session.id, 'qr_ready'); } catch {}
    }

    if (connection === 'close') {
      session.status = 'disconnected';
      session.qr = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      logLine(`[${session.id}] Connection closed: ${lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown'} reconnecting=${shouldReconnect}`);
      try { await updateBotSessionStatus(session.id, 'disconnected'); } catch {}
      if (shouldReconnect) {
        session.failCount++;
        if (session.failCount <= 10) {
          logLine(`[${session.id}] Reconnect attempt ${session.failCount}/10`);
          setTimeout(() => startSession(session), 3000);
        } else {
          session.status = 'failed';
          logLine(`[${session.id}] Giving up reconnecting after ${session.failCount} attempts. Use the pairing page to re-link.`);
          try { await updateBotSessionStatus(session.id, 'failed'); } catch {}
        }
      }
    } else if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      session.failCount = 0;
      session.client = sock.user;
      const myId = sock.user?.id || '';
      session.botPhone = myId.split(':')[0].split('@')[0];
      logLine(`[${session.id}] WhatsApp connected as ${myId} (owner: ${session.ownerPhone})`);
      try { await updateBotSessionStatus(session.id, 'connected', session.botPhone); } catch {}
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    await handleMessages(session, messages, type);
  });

  return session;
}

export async function startAllSessions() {
  let list = [];
  try {
    list = await getBotSessions();
  } catch (e) {
    logLine('getBotSessions failed: ' + e.message);
  }
  for (const s of list) {
    try {
      await startSession(s);
    } catch (e) {
      logLine(`[${s.id}] start error: ${e.message}`);
    }
  }
  return sessions.size;
}

export async function requestPairingCode(id, { name, phone, botPhone } = {}) {
  if (process.env.VERCEL) {
    throw new Error('الربط يتم فقط من localhost:3000 حيث يعمل البوت');
  }
  const cleanedBot = String(botPhone || '').replace(/\D/g, '');
  if (!cleanedBot) throw new Error('رقم البوت مطلوب');

  let session = sessions.get(id);
  if (session) {
    try { if (session.sock) await session.sock.end(undefined); } catch {}
    sessions.delete(id);
  }

  // Clear old auth state to prevent conflicts
  await clearSessionAuth(id);

  const ownerPhone = String(phone || '').replace(/\D/g, '');
  if (!ownerPhone) throw new Error('رقم المستخدم مطلوب');
  await createBotSession({ id, name, ownerPhone, botPhone: cleanedBot });
  try { await getUser(ownerPhone); } catch {}
  session = await startSession({ id, name, ownerPhone, botPhone: cleanedBot }, { pairingMode: true });

  if (!session.sock) throw new Error('WhatsApp socket not initialized');

  logLine(`[${session.id}] Requesting pairing code for ${cleanedBot}`);
  const pairingCode = await session.sock.requestPairingCode(cleanedBot);
  logLine(`[${session.id}] Pairing code: ${pairingCode}`);
  return pairingCode;
}

export async function removeSession(id) {
  const session = sessions.get(id);
  if (session?.sock) {
    try { await session.sock.logout(); } catch {}
    try { await session.sock.end(undefined); } catch {}
  }
  sessions.delete(id);
  try { await deleteBotSession(id); } catch {}
}

export async function getWhatsAppStatus() {
  let dbSessions = [];
  try {
    dbSessions = await getBotSessions();
  } catch {}

  const merged = dbSessions.map(db => {
    const r = sessions.get(db.id);
    return {
      id: db.id,
      name: db.name || db.id,
      ownerPhone: db.owner_phone,
      botPhone: r?.botPhone || db.bot_phone || '',
      status: r?.status || 'disconnected',
      qr: r?.qr || null,
      client: r?.client ? { id: r.client.id, name: r.client.name } : null
    };
  });

  return { sessions: merged };
}

async function handleMessages(session, messages, type) {
  const sock = session.sock;
  const phone = session.ownerPhone; // all data is keyed by the session owner's personal number
  const myPhone = session.botPhone;

  for (const msg of messages || []) {
    try {
      if (!msg.message) continue;

      const msgId = msg.key?.id || '';
      const remoteJid = msg.key?.remoteJid || '';
      const fromMe = !!msg.key?.fromMe;

      // Only process fresh messages (avoid replaying old history after reconnect)
      const msgTs = msg.messageTimestamp;
      const tsSec = typeof msgTs === 'object' ? Number(msgTs.low || 0) : Number(msgTs || 0);
      if (tsSec && Date.now() / 1000 - tsSec > 120) continue;

      // Persistent dedup: same message must never be processed twice (reconnects/restarts)
      if (msgId) {
        if (sentMsgIds.has(msgId)) continue;
        if (processedMsgIds.has(msgId)) continue;
        const dbKey = session.id + ':' + msgId;
        try {
          if (await isMessageProcessed(dbKey)) continue;
        } catch {}
        processedMsgIds.add(msgId);
        if (processedMsgIds.size > 2000) {
          const first = processedMsgIds.values().next().value;
          processedMsgIds.delete(first);
        }
        try { await markMessageProcessed(dbKey); } catch {}
      }

      const messageType = Object.keys(msg.message)[0];

      // Skip bot's own echoed replies
      if (fromMe) {
        const txt = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const botPrefix = /^(🎧|🔄|💸|📥|📊|📜|✅|🤖|😅|⚠️|تم تسجيل|عذراً|حدث خطأ)/;
        if (botPrefix.test(txt) || sentMsgIds.has(msgId)) continue;
      }

      if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter')) continue;

      // Only process messages from the owner's own chat (self-chat)
      const ownerJid = phone + '@s.whatsapp.net';
      if (remoteJid !== ownerJid && !fromMe) continue;

      // Reply to the sender (or to self-chat using the bot's own number)
      const replyJid = fromMe ? (myPhone + '@s.whatsapp.net') : (remoteJid.endsWith('@lid') ? (phone + '@s.whatsapp.net') : remoteJid);
      const pushName = msg.pushName || 'صديقي';

      await getUser(phone);

      let textMessage = '';
      let mediaBuffer = null;
      let mediaMime = '';
      let isImage = false;
      let isAudio = false;

      if (messageType === 'conversation') {
        textMessage = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        textMessage = msg.message.extendedTextMessage.text;
      } else if (messageType === 'imageMessage') {
        textMessage = msg.message.imageMessage.caption || '';
        isImage = true;
        try {
          mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
          mediaMime = msg.message.imageMessage.mimetype || 'image/jpeg';
        } catch (e) {
          logLine('[IMG DL ERROR] ' + e.message);
        }
      } else if (messageType === 'audioMessage') {
        isAudio = true;
        try {
          mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
          mediaMime = msg.message.audioMessage.mimetype || 'audio/ogg';
          logLine(`[${session.id}] Audio mime: ${mediaMime}, size: ${mediaBuffer ? mediaBuffer.length : 0}`);
        } catch (e) {
          logLine('[AUDIO DL ERROR] ' + e.message);
        }
      }

      logLine(`[${session.id}] MSG id=${msgId} type=${type} msgType=${messageType} fromMe=${fromMe} jid=${remoteJid} text=${(textMessage || '[media]').substring(0, 60)}`);

      if ((isAudio || isImage) && !mediaBuffer) {
        await sendText(sock, replyJid, '😅 عذراً، لم أستطع تحميل الوسائط. أرسل الرسالة مرة أخرى أو جرب نصاً مكتوباً.');
        continue;
      }

      if (!textMessage && !mediaBuffer) continue;

      let aiResult = null;

      if (isImage && mediaBuffer) {
        await sendText(sock, replyJid, '🔄 جاري قراءة وتحليل الفاتورة بالذكاء الاصطناعي...');
        aiResult = await parseReceiptImage(mediaBuffer, mediaMime);
      } else if (isAudio && mediaBuffer) {
        await sendText(sock, replyJid, '🎧 جاري الاستماع للرسالة الصوتية وتحليلها...');
        aiResult = await parseAudioVoice(mediaBuffer, mediaMime);
      } else if (textMessage) {
        const lower = textMessage.trim().toLowerCase();
        if (lower === 'ملخص' || lower === 'رصيد' || lower === 'تقرير' || lower === 'summary') {
          const summary = await getFinancialSummary(phone);
          const responseText = `📊 *ملخصك المالي لل${summary.periodLabel} الحالي:*\n\n` +
            `👤 أهلًا ${pushName}\n` +
            `💰 الميزانية ${summary.periodLabel === 'اليوم' ? 'اليومية' : summary.periodLabel === 'الأسبوع' ? 'الأسبوعية' : summary.periodLabel === 'السنة' ? 'السنوية' : 'الشهرية'}: *${summary.monthlyBudget} جنيه*\n` +
            `💸 إجمالي المصروفات (${summary.periodLabel}): *${summary.totalExpenses} جنيه*\n` +
            `📥 إجمالي الدخل (${summary.periodLabel}): *${summary.totalIncome} جنيه*\n` +
            `🟢 المتبقي من الميزانية: *${summary.remainingBudget} جنيه*\n\n` +
            `🏷 *المصروفات حسب التصنيف:*\n` +
            (summary.byCategory.length ? summary.byCategory.map(c => `• ${c.category}: ${c.total} ج`).join('\n') : 'لا توجد مصروفات مسجلة بعد.');

          await sendText(sock, replyJid, responseText);
          continue;
        }

        if (lower === 'آخر عمليات' || lower === 'transactions') {
          const txs = await getTransactions(phone, 5);
          let txText = `📜 *آخر 5 عمليات مسجلة:*\n\n`;
          if (txs.length === 0) {
            txText += 'لا توجد عمليات مسجلة.';
          } else {
            txs.forEach((t, i) => {
              const sign = t.type === 'income' ? '📥 (+)' : '📤 (-)';
              txText += `${i+1}. ${sign} *${t.amount} ج* (${t.category})\n   📝 ${t.description || 'بدون وصف'} - 🕒 ${t.date.substring(0,10)}\n`;
            });
          }
          await sendText(sock, replyJid, txText);
          continue;
        }

        if (lower.startsWith('ميزانيتي') || lower.startsWith('budget')) {
          const parts = textMessage.trim().split(/\s+/);
          let period = null;
          const periodMap = { 'شهري': 'monthly', 'شهريه': 'monthly', 'الشهر': 'monthly', 'شهر': 'monthly',
                             'اسبوعي': 'weekly', 'اسبوعيه': 'weekly', 'الاسبوع': 'weekly', 'أسبوعي': 'weekly', 'أسبوعيه': 'weekly', 'اسبوع': 'weekly',
                             'يومي': 'daily', 'يوميه': 'daily', 'اليوم': 'daily', 'يوم': 'daily',
                             'سنوي': 'yearly', 'سنويه': 'yearly', 'السنة': 'yearly', 'السنه': 'yearly', 'سنة': 'yearly', 'سنه': 'yearly' };
          for (const p of parts) {
            const key = p.replace(/[0-9.,\u0660-\u0669]/g, '');
            if (periodMap[key]) { period = periodMap[key]; break; }
          }
          let num = null;
          for (const p of parts) {
            const converted = p.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
            const n = parseFloat(converted.replace(/[^\d.]/g, ''));
            if (!isNaN(n)) { num = n; break; }
          }
          if (num !== null) {
            await updateUserBudget(phone, num, period);
            const periodName = period ? (period === 'daily' ? 'اليومية' : period === 'weekly' ? 'الأسبوعية' : period === 'yearly' ? 'السنوية' : 'الشهرية') : 'الشهرية';
            await sendText(sock, replyJid, `✅ تم تحديث ميزانيتك *${periodName}* لتصبح *${num} جنيه*.`);
          } else {
            await sendText(sock, replyJid, '⚠️ برجاء كتابة المبلغ صحيحاً، مثل: *ميزانيتي 6000* أو *ميزانيتي 3000 اسبوعي*');
          }
          continue;
        }

        if (lower === 'مساعدة' || lower === 'help') {
          const helpText = `🤖 *مرحباً بك في مساعدك المالي الذكي عبر واتساب!*\n\n` +
            `يمكنك التحدث معي بكل حرية (كتابة، صوت، أو صور):\n` +
            `• *تسجيل مصروف:* "صرفت 150 جنيه عشاء كافيه"\n` +
            `• *تسجيل دخل:* "قبضت المرتب 9000 جنيه"\n` +
            `• *إرسال فاتورة:* صور أي فاتورة وسأقوم بتسجيلها تلقائياً!\n` +
            `• *إرسال فويس:* تكلّم بالعامية وسأفهمك!\n` +
            `• *معرفة الرصيد:* اكتب "ملخص" أو "رصيد"\n` +
            `• *آخر العمليات:* اكتب "آخر عمليات"\n` +
            `• *تعديل الميزانية:* اكتب "ميزانيتي 7000"`;
          await sendText(sock, replyJid, helpText);
          continue;
        }

        aiResult = await parseFinancialInput(textMessage);
      }

      if (aiResult) {
        logLine(`[${session.id}] AI RESULT type=${aiResult.type} amount=${aiResult.amount} category=${aiResult.category} reply=${(aiResult.replyMessage || '').substring(0, 40)}`);
        if (aiResult.type === 'expense' || aiResult.type === 'income') {
          await addTransaction(phone, {
            type: aiResult.type,
            amount: aiResult.amount,
            category: aiResult.category || 'أخرى',
            description: aiResult.description || textMessage
          });

          const summary = await getFinancialSummary(phone);
          const emoji = aiResult.type === 'expense' ? '💸' : '📥';
          const confirmText = `${emoji} *${aiResult.replyMessage || 'تم التسجيل بنجاح!'}*\n\n` +
            `🔹 المبلغ: *${aiResult.amount} جنيه*\n` +
            `🏷 التصنيف: *${aiResult.category}*\n` +
            `💰 المتبقي من ميزانيتك: *${summary.remainingBudget} جنيه*`;

          await sendText(sock, replyJid, confirmText);
        } else {
          await sendText(sock, replyJid, aiResult.replyMessage || 'أهلاً بك! يمكنك إرسال مصاريفك أو صور الفواتير أو الفويسات لتسجيلها.');
        }
      } else {
        await sendText(sock, replyJid, 'عذراً، لم أستطع فهم رسالتك. جرب كتابة "مساعدة" لمعرفة طريقة الاستخدام.');
      }
    } catch (err) {
      logLine('[MSG ERROR] ' + err.message);
      try {
        await sendText(sock, '😅 حدث خطأ أثناء معالجة رسالتك. حاول مرة أخرى.');
      } catch {}
    }
  }
}
