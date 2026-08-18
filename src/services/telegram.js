import { Bot } from 'grammy';
import { getUser, addTransaction, getFinancialSummary, getTransactions, updateUserBudget, deleteTransaction, setUserPassword, checkUserPassword, hasPassword, getMonthlyComparison, getCategoryBreakdown } from '../lib/db.js';
import { parseFinancialInput, parseReceiptImage, parseAudioVoice } from './gemini.js';

let bot = null;
let handlersSetup = false;
const pendingActions = new Map();

function getBot() {
  if (bot) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  bot = new Bot(token);
  return bot;
}

function uid(ctx) {
  return String(ctx.from.id);
}

async function sendSummary(ctx) {
  const id = uid(ctx);
  try {
    const summary = await getFinancialSummary(id);
    const periodLabel = summary.periodLabel;
    const periodName = periodLabel === 'اليوم' ? 'اليومية' : periodLabel === 'الأسبوع' ? 'الأسبوعية' : periodLabel === 'السنة' ? 'السنوية' : 'الشهرية';
    const firstName = ctx.from.first_name || 'صديقي';
    await ctx.reply(
      `📊 *ملخصك المالي للفترة ${periodName}:*\n\n` +
      `👤 أهلًا ${firstName}\n` +
      `💰 الميزانية ${periodName}: *${summary.monthlyBudget} جنيه*\n` +
      `💸 إجمالي المصروفات: *${summary.totalExpenses} جنيه*\n` +
      `📥 إجمالي الدخل: *${summary.totalIncome} جنيه*\n` +
      `🟢 المتبقي: *${summary.remainingBudget} جنيه*\n\n` +
      `🏷 *المصروفات حسب التصنيف:*\n` +
      (summary.byCategory.length
        ? summary.byCategory.map(c => `• ${c.category}: ${c.total} ج`).join('\n')
        : 'لا توجد مصروفات مسجلة.'),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Summary error:', e.message);
    await ctx.reply('حدث خطأ في جلب الملخص.');
  }
}

async function sendTransactions(ctx) {
  const id = uid(ctx);
  try {
    const txs = await getTransactions(id, 5);
    let text = `📜 *آخر 5 عمليات مسجلة:*\n\n`;
    if (txs.length === 0) {
      text += 'لا توجد عمليات مسجلة.';
    } else {
      txs.forEach((t, i) => {
        const sign = t.type === 'income' ? '📥 (+)' : '📤 (-)';
        text += `${i + 1}. ${sign} *${t.amount} ج* (${t.category})\n   📝 ${t.description || 'بدون وصف'} - 🕒 ${t.date.substring(0, 10)}\n`;
      });
    }
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('حدث خطأ.');
  }
}

async function sendHelp(ctx) {
  await ctx.reply(
    `🤖 *tahweshabot*\n\n` +
    `💬 *تسجيل مصروف:* "صرفت 150 جنيه عشاء"\n` +
    `📥 *تسجيل دخل:* "قبضت 9000 جنيه"\n` +
    `📸 *فاتورة:* ابعت صورة\n` +
    `🎤 *فويس:* تكلّم بالعامية\n\n` +
    `📊 /summary - ملخص مالي\n📜 /transactions - العمليات\n💰 /budget - الميزانية\n🏷 /categories - التصنيفات\n📈 /compare - مقارنة الشهور\n\n` +
    `🔒 /password - تعين باسورد (اختياري)\n🗑 /delete - حذف عملية`,
    { parse_mode: 'Markdown' }
  );
}

async function handleBudget(ctx, text) {
  const id = uid(ctx);
  const parts = text.replace(/^(ميزانيتي|budget)\s*/i, '').split(/\s+/);
  const periodMap = {
    'شهري': 'monthly', 'شهريه': 'monthly', 'الشهر': 'monthly', 'شهر': 'monthly',
    'اسبوعي': 'weekly', 'اسبوعيه': 'weekly', 'الاسبوع': 'weekly', 'أسبوعي': 'weekly', 'اسبوع': 'weekly',
    'يومي': 'daily', 'يوميه': 'daily', 'اليوم': 'daily', 'يوم': 'daily',
    'سنوي': 'yearly', 'سنويه': 'yearly', 'السنة': 'yearly', 'السنه': 'yearly'
  };
  let period = null;
  let num = null;
  for (const p of parts) {
    const key = p.replace(/[0-9.,\u0660-\u0669]/g, '');
    if (periodMap[key]) period = periodMap[key];
  }
  for (const p of parts) {
    const converted = p.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    const n = parseFloat(converted.replace(/[^\d.]/g, ''));
    if (!isNaN(n)) { num = n; break; }
  }
  if (num !== null) {
    await updateUserBudget(id, num, period);
    const periodName = period ? (period === 'daily' ? 'اليومية' : period === 'weekly' ? 'الأسبوعية' : period === 'yearly' ? 'السنوية' : 'الشهرية') : 'الشهرية';
    await ctx.reply(`✅ تم تحديث ميزانيتك *${periodName}* لتصبح *${num} جنيه*.`, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply('⚠️ برجاء كتابة المبلغ، مثل:\nميزانيتي 7000\nميزانيتي 3000 اسبوعي');
  }
}

async function handleAiResult(ctx, aiResult, originalText) {
  if (!aiResult) {
    await ctx.reply('حدث خطأ مؤقت. حاول مرة أخرى.');
    return;
  }
  const id = uid(ctx);

  if ((aiResult.type === 'expense' || aiResult.type === 'income') && (aiResult.amount === null || aiResult.amount === undefined)) {
    const emoji = aiResult.type === 'expense' ? '💸' : '📥';
    await ctx.reply(
      `${emoji} فهمت إنك ${aiResult.type === 'expense' ? 'صرفت' : 'اخدت'} على ${aiResult.description || 'حاجة'}\n\nبس قولي المبلغ كام بالظبط؟`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (aiResult.type === 'expense' || aiResult.type === 'income') {
    await addTransaction(id, {
      type: aiResult.type,
      amount: aiResult.amount,
      category: aiResult.category || 'أخرى',
      description: aiResult.description || originalText
    });
    const summary = await getFinancialSummary(id);
    const emoji = aiResult.type === 'expense' ? '💸' : '📥';
    await ctx.reply(
      `${emoji} *${aiResult.replyMessage || 'تم التسجيل!'}*\n\n` +
      `🔹 المبلغ: *${aiResult.amount} جنيه*\n` +
      `🏷 التصنيف: *${aiResult.category}*\n` +
      `💰 المتبقي: *${summary.remainingBudget} جنيه*`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(aiResult.replyMessage || 'أهلاً! ابعت مصاريفك أو صور فواتير.');
  }
}

export function setupBotHandlers() {
  if (handlersSetup) return;
  handlersSetup = true;
  const b = getBot();

  b.command('start', async (ctx) => {
    await getUser(uid(ctx));
    const name = ctx.from.first_name || 'صديقي';
    await ctx.reply(
      `مرحباً ${name}! 👋\n\nأنا *tahweshabot* — مساعدك المالي الذكي.\n\n` +
      `💸 "صرفت 50 جنيه اكل"\n` +
      `📥 "قبضت راتبي 9000 جنيه"\n` +
      `📸 ابعت صورة فاتورة\n` +
      `🎤 ابعت رسالة صوتية\n\n` +
      `📊 /summary - ملخص مالي\n📜 /transactions - العمليات\n💰 /budget - الميزانية\n🏷 /categories - التصنيفات\n📈 /compare - مقارنة الشهور\n🔒 /password - باسورد (اختياري)\n🗑 /delete - حذف عملية\n/help - مساعدة`,
      { parse_mode: 'Markdown' }
    );
  });

  b.command('help', sendHelp);
  b.command('summary', sendSummary);
  b.command('transactions', sendTransactions);
  b.command('budget', async (ctx) => handleBudget(ctx, ctx.message.text));

  b.command('password', async (ctx) => {
    const id = uid(ctx);
    const args = (ctx.message.text || '').replace('/password', '').trim();
    if (!args) {
      const has = await hasPassword(id);
      await ctx.reply(has
        ? '🔒 عندك باسورد بالفعل. اكتب:\n/password باسورد_جديد لتغييره\n/password حذف لمسح الباسورد'
        : '🔒 مفيش باسورد مظبوط. اكتب:\n/password اسم_باسورد_اللي_تعجبك\n\nلو مش عايز باسورد اسيبك عادي.');
      return;
    }
    if (args === 'حذف' || args === 'delete' || args === 'remove') {
      await setUserPassword(id, null);
      await ctx.reply('🔓 تم مسح الباسورد. حسابك دلوقتي مفتوح بدون باسورد.');
      return;
    }
    await setUserPassword(id, args);
    await ctx.reply(`🔒 تم تعين الباسورد: *${args}*\n\nمحدش يقدر يحذف أو يعدّل عملياتك من غيره.`, { parse_mode: 'Markdown' });
  });

  b.command('delete', async (ctx) => {
    const id = uid(ctx);
    const has = await hasPassword(id);
    if (has) {
      pendingActions.set(id, { action: 'delete_tx', time: Date.now() });
      await ctx.reply('🔒 اكتب الباسورد عشان تقدر تحذف عملياتك.');
      return;
    }
    const txs = await getTransactions(id, 5);
    if (txs.length === 0) { await ctx.reply('مفيش عمليات تحذف.'); return; }
    let text = '📜 ابعت رقم العملية اللي عايز تحذفها:\n\n';
    txs.forEach((t, i) => {
      const sign = t.type === 'income' ? '📥' : '📤';
      text += `${i + 1}. ${sign} ${t.amount} ج (${t.description || t.category})\n`;
    });
    pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
    await ctx.reply(text);
  });

  b.command('categories', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    try {
      const cats = await getCategoryBreakdown(id, 1);
      if (cats.length === 0) { await ctx.reply('📊 مفيش مصروفات الشهر ده.'); return; }
      let msg = '📊 *تصنيفات المصروفات الشهر ده:*\n\n';
      const total = cats.reduce((s, c) => s + c.total, 0);
      cats.forEach(c => {
        const pct = Math.round(c.total / total * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        msg += `*${c.category}*: ${c.total} ج (${pct}%)\n\`${bar}\`\n`;
      });
      msg += `\n💰 الإجمالي: *${total} جنيه*`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply('❌ حصلت مشكلة.');
    }
  });

  b.command('compare', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    try {
      const data = await getMonthlyComparison(id);
      if (data.length === 0) { await ctx.reply('📊 مفيش بيانات كافية للمقارنة.'); return; }
      const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      let msg = '📈 *مقارنة شهور:*\n\n';
      data.forEach(d => {
        msg += `*${months[d.month - 1]}*: 📤 ${d.totalExpenses} ج | 📥 ${d.totalIncome} ج\n`;
      });
      if (data.length >= 2) {
        const diff = data[0].totalExpenses - data[1].totalExpenses;
        const pct = Math.round(diff / data[1].totalExpenses * 100);
        msg += diff > 0
          ? `\n⚠️ صرفت ${diff} جنيه (${pct}%) أكتر من الشهر اللي فات`
          : `\n✅ وفّرت ${Math.abs(diff)} جنيه (${Math.abs(pct)}%) عن الشهر اللي فات`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply('❌ حصلت مشكلة.');
    }
  });

  b.on('message:photo', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    await ctx.reply('🔄 جاري تحليل الصورة...');
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const aiResult = await parseReceiptImage(buf, photo.mime_type || 'image/jpeg');
      await handleAiResult(ctx, aiResult, ctx.message.caption || 'فاتورة');
    } catch (e) {
      console.error('Photo error:', e.message);
      await ctx.reply('😅 لم أستطع تحليل الصورة.');
    }
  });

  b.on('message:voice', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    await ctx.reply('🔄 جاري الاستماع...');
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const aiResult = await parseAudioVoice(buf, ctx.message.voice.mime_type || 'audio/ogg');
      await handleAiResult(ctx, aiResult, 'رسالة صوتية');
    } catch (e) {
      console.error('Voice error:', e.message);
      await ctx.reply('😅 لم أستطع تحليل الصوت.');
    }
  });

  b.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const lower = text.toLowerCase();
    const id = uid(ctx);
    await getUser(id);

    const pending = pendingActions.get(id);
    if (pending && Date.now() - pending.time < 300000) {
      if (pending.action === 'delete_tx') {
        pendingActions.delete(id);
        const ok = await checkUserPassword(id, text);
        if (!ok) {
          await ctx.reply('❌巴斯ورد غلط. حاول تاني من الأزرار.');
          return;
        }
        const txs = await getTransactions(id, 5);
        if (txs.length === 0) { await ctx.reply('مفيش عمليات تحذف.'); return; }
        let msg = '📜 ابعت رقم العملية اللي عايز تحذفها:\n\n';
        txs.forEach((t, i) => {
          const sign = t.type === 'income' ? '📥' : '📤';
          msg += `${i + 1}. ${sign} ${t.amount} ج (${t.description || t.category})\n`;
        });
        pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
        await ctx.reply(msg);
        return;
      }
      if (pending.action === 'delete_tx_pick') {
        pendingActions.delete(id);
        const num = parseInt(text);
        if (isNaN(num) || num < 1 || num > pending.txs.length) {
          await ctx.reply('❌ رقم غلط.');
          return;
        }
        const tx = pending.txs[num - 1];
        await deleteTransaction(tx.id, id);
        await ctx.reply(`✅ تم حذف العملية: ${tx.type === 'income' ? '📥' : '📤'} ${tx.amount} ج (${tx.description || tx.category})`);
        return;
      }
    } else if (pending) {
      pendingActions.delete(id);
    }

    if (lower === 'ملخص' || lower === 'رصيد' || lower === 'تقرير') return sendSummary(ctx);
    if (lower === 'آخر عمليات' || lower === 'transactions') return sendTransactions(ctx);
    if (lower === 'مساعدة' || lower === 'help') return sendHelp(ctx);
    if (lower.startsWith('ميزانيتي') || lower.startsWith('budget')) return handleBudget(ctx, text);

    await ctx.reply('🔄 جاري التحليل...');
    const aiResult = await parseFinancialInput(text);
    await handleAiResult(ctx, aiResult, text);
  });

  console.log('✅ Telegram handlers registered');
}

export async function startTelegramBot() {
  const b = getBot();
  setupBotHandlers();
  return b;
}

export function getTelegramBot() {
  return bot;
}
