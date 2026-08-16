import { makeWASocket, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import { getUser, addTransaction, deleteTransaction, getFinancialSummary, getTransactions, updateUserBudget } from '../lib/db.js';
import { usePgAuthState } from './dbAuth.js';
import { parseFinancialInput, parseReceiptImage, parseAudioVoice } from './gemini.js';

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let clientInfo = null;

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

async function sendText(jid, text) {
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

export async function startWhatsApp(onQR, onConnected) {
  const { state, saveCreds } = await usePgAuthState();

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = qr;
      connectionStatus = 'qr_ready';
      qrcodeTerminal.generate(qr, { small: true });
      if (onQR) onQR(qr);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      qrCodeData = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      logLine('Connection closed due to ' + (lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown') + ', reconnecting: ' + shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(onQR, onConnected), 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      clientInfo = sock.user;
      logLine('WhatsApp connected successfully as: ' + sock.user?.id);
      if (onConnected) onConnected(sock.user);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (update.connection) logLine('[EVT] connection.update -> ' + update.connection + (update.lastDisconnect?.error ? ' err=' + update.lastDisconnect.error.message : ''));
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logLine('[EVT] messages.upsert type=' + type + ' count=' + (messages?.length || 0));
    for (const msg of messages || []) {
      logLine('[RAW] key=' + JSON.stringify(msg?.key) + ' pushName=' + msg?.pushName + ' msgKeys=' + (msg?.message ? Object.keys(msg.message).join(',') : 'EMPTY'));
    }
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      try {
      if (!msg.message) {
        logLine('[SKIP] msg.message is empty. key=' + JSON.stringify(msg.key) + ' type=' + msg.type);
        continue;
      }

      // Only process fresh messages (avoid replaying old history after reconnect)
      const msgTs = msg.messageTimestamp;
      const tsSec = typeof msgTs === 'object' ? Number(msgTs.low || 0) : Number(msgTs || 0);
      if (tsSec && Date.now() / 1000 - tsSec > 120) {
        logLine('[SKIP] old message (replayed history): ' + tsSec);
        continue;
      }

      // Deduplicate: same message may arrive via 'append' and 'notify'
      const msgId = msg.key?.id || '';
      if (msgId) {
        // Skip the bot's own sent replies (self-chat echo)
        if (sentMsgIds.has(msgId)) continue;
        if (processedMsgIds.has(msgId)) continue;
        processedMsgIds.add(msgId);
        if (processedMsgIds.size > 500) {
          const first = processedMsgIds.values().next().value;
          processedMsgIds.delete(first);
        }
      }

      const messageType = Object.keys(msg.message)[0];

      // Skip bot's own echoed replies (recognizable by the bot's reply prefixes)
      if (msg.key.fromMe) {
        const txt = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const botPrefix = /^(🎧|🔄|💸|📥|📊|📜|✅|🤖|😅|⚠️|تم تسجيل|عذراً|حدث خطأ)/;
        if (botPrefix.test(txt) || sentMsgIds.has(msgId)) {
          logLine('[SKIP] bot self-reply: ' + txt.substring(0, 40));
          continue;
        }
      }

      const remoteJid = msg.key.remoteJid || '';
      if (remoteJid.endsWith('@g.us')) continue;

      // Resolve actual phone number from JID or LID
      const myId = sock.user?.id || '';
      const myPhone = myId.split(':')[0].split('@')[0]; // e.g. 201060005533

      let phone;
      if (msg.key.fromMe) {
        // Self-chat: user testing by messaging their own linked number
        phone = myPhone;
      } else if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) {
        phone = remoteJid.split('@')[0];
      } else {
        phone = remoteJid.split('@')[0];
      }

      // For replies, use the chat JID: if from a real number use its JID, else the bot's own number
      const replyJid = msg.key.fromMe ? (myPhone + '@s.whatsapp.net') : (remoteJid.endsWith('@lid') ? (phone + '@s.whatsapp.net') : remoteJid);

      const pushName = msg.pushName || 'صديقي';

      await getUser(phone);

      let textMessage = '';
      let mediaBuffer = null;
      let mediaMime = '';
      let isImage = false;
      let isAudio = false;

      logLine(`[MSG] type=${type} messageType=${messageType} from=${phone} fromMe=${msg.key.fromMe}`);

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
          logLine('Error downloading image: ' + e.message);
        }
      } else if (messageType === 'audioMessage') {
        isAudio = true;
        try {
          mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
          mediaMime = msg.message.audioMessage.mimetype || 'audio/ogg';
          // WhatsApp voice notes are often audio/mpeg (opus container). Keep original mime for Gemini.
          logLine('Audio mime: ' + mediaMime + ', size: ' + (mediaBuffer ? mediaBuffer.length : 0));
        } catch (e) {
          logLine('Error downloading audio: ' + e.message);
        }
      }

      if ((isAudio || isImage) && !mediaBuffer) {
        await sendText(replyJid, '😅 عذراً، لم أستطع تحميل الوسائط. أرسل الرسالة مرة أخرى أو جرب نصاً مكتوباً.');
        continue;
      }

      if (!textMessage && !mediaBuffer) continue;

      logLine(`[MSG] Processing from ${phone}: ${textMessage || (isImage ? '[Image]' : '') || (isAudio ? '[Audio]' : '')}`);

      let aiResult = null;

      if (isImage && mediaBuffer) {
        await sendText(replyJid, '🔄 جاري قراءة وتحليل الفاتورة بالذكاء الاصطناعي...');
        aiResult = await parseReceiptImage(mediaBuffer, mediaMime);
      } else if (isAudio && mediaBuffer) {
        await sendText(replyJid, '🎧 جاري الاستماع للرسالة الصوتية وتحليلها...');
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

          await sendText(replyJid, responseText);
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
          await sendText(replyJid, txText);
          continue;
        }

        if (lower.startsWith('ميزانيتي') || lower.startsWith('budget')) {
          const parts = textMessage.trim().split(/\s+/);
          // Detect period keyword
          let period = null;
          const periodMap = { 'شهري': 'monthly', 'شهريه': 'monthly', 'الشهر': 'monthly', 'شهر': 'monthly',
                             'اسبوعي': 'weekly', 'اسبوعيه': 'weekly', 'الاسبوع': 'weekly', 'أسبوعي': 'weekly', 'أسبوعيه': 'weekly', 'اسبوع': 'weekly',
                             'يومي': 'daily', 'يوميه': 'daily', 'اليوم': 'daily', 'يوم': 'daily',
                             'سنوي': 'yearly', 'سنويه': 'yearly', 'السنة': 'yearly', 'السنه': 'yearly', 'سنة': 'yearly', 'سنه': 'yearly' };
          for (const p of parts) {
            const key = p.replace(/[0-9.,\u0660-\u0669]/g, '');
            if (periodMap[key]) { period = periodMap[key]; break; }
          }
          // Find the number (Arabic or Western digits)
          let num = null;
          for (const p of parts) {
            const converted = p.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
            const n = parseFloat(converted.replace(/[^\d.]/g, ''));
            if (!isNaN(n)) { num = n; break; }
          }
          if (num !== null) {
            await updateUserBudget(phone, num, period);
            const periodName = period ? (period === 'daily' ? 'اليومية' : period === 'weekly' ? 'الأسبوعية' : period === 'yearly' ? 'السنوية' : 'الشهرية') : 'الشهرية';
            await sendText(replyJid, `✅ تم تحديث ميزانيتك *${periodName}* لتصبح *${num} جنيه*.`);
          } else {
            await sendText(replyJid, '⚠️ برجاء كتابة المبلغ صحيحاً، مثل: *ميزانيتي 6000* أو *ميزانيتي 3000 اسبوعي*');
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
          await sendText(replyJid, helpText);
          continue;
        }

        aiResult = await parseFinancialInput(textMessage);
      }

      if (aiResult) {
        logLine('[AI Result] type=' + aiResult.type + ' amount=' + aiResult.amount + ' category=' + aiResult.category);
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

          await sendText(replyJid, confirmText);
        } else {
          await sendText(replyJid, aiResult.replyMessage || 'أهلاً بك! يمكنك إرسال مصاريفك أو صور الفواتير أو الفويسات لتسجيلها.');
        }
      } else {
        await sendText(replyJid, 'عذراً، لم أستطع فهم رسالتك. جرب كتابة "مساعدة" لمعرفة طريقة الاستخدام.');
      }
      } catch (err) {
        logLine('[MSG ERROR] ' + err.message);
        try {
          await sendText(replyJid, '😅 حدث خطأ أثناء معالجة رسالتك. حاول مرة أخرى.');
        } catch {}
      }
    }
  });

  return sock;
}

export async function requestPairingCode(phoneNumber) {
  if (!sock) throw new Error('WhatsApp socket not initialized');
  const cleaned = phoneNumber.replace(/\D/g, '');
  const code = await sock.requestPairingCode(cleaned);
  return code;
}

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qr: qrCodeData,
    client: clientInfo ? { id: clientInfo.id, name: clientInfo.name } : null
  };
}
