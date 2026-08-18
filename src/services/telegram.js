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

const SEP = '──────────────────────';

async function sendSummary(ctx) {
  const id = uid(ctx);
  try {
    const s = await getFinancialSummary(id);
    const periodMap = { 'اليوم': 'اليومية', 'الأسبوع': 'الأسبوعية', 'السنة': 'السنوية', 'الشهر': 'الشهرية' };
    const pName = periodMap[s.periodLabel] || 'الشهرية';
    const used = s.monthlyBudget - s.remainingBudget;
    const pct = s.monthlyBudget > 0 ? Math.round(used / s.monthlyBudget * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

    let msg = `📊 *tahweshabot*\n`;
    msg += `${SEP}\n`;
    msg += `🗓 *الميزانية ${pName}*\n\n`;
    msg += `💰 الميزانية: \`${s.monthlyBudget.toLocaleString('ar-EG')} ج\`\n`;
    msg += `📤 المصروفات: \`${s.totalExpenses.toLocaleString('ar-EG')} ج\`\n`;
    msg += `📥 الدخل: \`${s.totalIncome.toLocaleString('ar-EG')} ج\`\n`;
    msg += `🟢 المتبقي: \`${s.remainingBudget.toLocaleString('ar-EG')} ج\`\n\n`;
    msg += `📈 الاستخدام: *${pct}%*\n`;
    msg += `\`${bar}\`\n`;

    if (s.byCategory.length > 0) {
      msg += `\n${SEP}\n`;
      msg += `🏷 *التصنيفات*\n\n`;
      s.byCategory.forEach(c => {
        const catPct = Math.round(c.total / s.totalExpenses * 100);
        msg += `• ${c.category}: \`${c.total.toLocaleString('ar-EG')} ج\` (${catPct}%)\n`;
      });
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Summary error:', e.message);
    await ctx.reply('❌ حصلت مشكلة في جلب الملخص.');
  }
}

async function sendTransactions(ctx) {
  const id = uid(ctx);
  try {
    const txs = await getTransactions(id, 5);
    if (txs.length === 0) {
      await ctx.reply(`📊 *tahweshabot*\n\nلا توجد عمليات مسجلة بعد.\nابعت أي رسالة عشان تبدأ تسجل مصاريفك.`, { parse_mode: 'Markdown' });
      return;
    }
    let msg = `📊 *tahweshabot*\n`;
    msg += `${SEP}\n`;
    msg += `📋 *آخر ${txs.length} عمليات*\n\n`;

    txs.forEach((t, i) => {
      const sign = t.type === 'income' ? '🟢 +' : '🔴 -';
      const emoji = t.type === 'income' ? '📥' : '📤';
      msg += `${i + 1}. ${emoji} \`${t.amount.toLocaleString('ar-EG')} ج\`\n`;
      msg += `   └ ${t.description || t.category} · ${t.category}\n`;
      msg += `   └ ${t.date.substring(0, 10)}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ حصلت مشكلة.');
  }
}

async function sendHelp(ctx) {
  const msg = `📊 *tahweshabot*\n\n` +
    `${SEP}\n\n` +
    `👋 أهلاً! أنا مساعدك المالي الذكي\n\n` +
    `📝 *طريقة التسجيل:*\n\n` +
    `💬 *نص:* "صرفت 50 جنيه اكل"\n` +
    `💬 *نص:* "قبضت راتبي 9000"\n` +
    `📸 *صورة:* ابعت صورة فاتورة\n` +
    `🎤 *صوت:* تكلّم بالعامية\n\n` +
    `${SEP}\n\n` +
    `⚙️ *الأوامر:*\n\n` +
    `📊 /summary — ملخص مالي شامل\n` +
    `📋 /transactions — آخر العمليات\n` +
    `💰 /budget — تعين الميزانية\n` +
    `🏷 /categories — مصروفات بالتصنيفات\n` +
    `📈 /compare — مقارنة الشهور\n` +
    `🔒 /password — حماية الحساب\n` +
    `🗑 /delete — حذف عملية\n` +
    `ℹ️ /help — المساعدة\n\n` +
    `${SEP}\n\n` +
    `💡 *مثال:* ابعت "مقبوضات 35 جنيه اكل"`\n``;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
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
    const periodName = period === 'daily' ? 'اليومية' : period === 'weekly' ? 'الأسبوعية' : period === 'yearly' ? 'السنوية' : 'الشهرية';
    await ctx.reply(
      `📊 *tahweshabot*\n` +
      `${SEP}\n\n` +
      `✅ *تم تحديث الميزانية*\n\n` +
      `💰 الميزانية ${periodName}: \`${num.toLocaleString('ar-EG')} ج\``,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(
      `📊 *tahweshabot*\n` +
      `${SEP}\n\n` +
      `⚠️ *طريقة الاستخدام:*\n\n` +
      `• ميزانيتي 7000\n` +
      `• ميزانيتي 3000 أسبوعي\n` +
      `• budget 5000 شهري`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleAiResult(ctx, aiResult, originalText) {
  if (!aiResult) {
    await ctx.reply(`📊 *tahweshabot*\n\n❌ حصلت مشكلة مؤقتة. حاول تاني.`, { parse_mode: 'Markdown' });
    return;
  }
  const id = uid(ctx);

  if ((aiResult.type === 'expense' || aiResult.type === 'income') && (aiResult.amount === null || aiResult.amount === undefined)) {
    const emoji = aiResult.type === 'expense' ? '📤' : '📥';
    await ctx.reply(
      `📊 *tahweshabot*\n` +
      `${SEP}\n\n` +
      `${emoji} فهمت إنك ${aiResult.type === 'expense' ? 'صرفت' : 'اخدت'} على *${aiResult.description || 'حاجة'}*\n\n` +
      `💰 قولي المبلغ كام بالظبط؟`,
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
    const emoji = aiResult.type === 'expense' ? '📤' : '📥';
    const typeLabel = aiResult.type === 'expense' ? 'مصروف' : 'دخل';

    await ctx.reply(
      `📊 *tahweshabot*\n` +
      `${SEP}\n\n` +
      `✅ *تم تسجيل ${typeLabel}*\n\n` +
      `${emoji} المبلغ: \`${aiResult.amount.toLocaleString('ar-EG')} ج\`\n` +
      `🏷 التصنيف: *${aiResult.category}*\n` +
      `📝 الوصف: ${aiResult.description || originalText}\n` +
      `💰 المتبقي: \`${summary.remainingBudget.toLocaleString('ar-EG')} ج\``,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(
      `📊 *tahweshabot*\n\n` +
      `👋 أهلاً! ابعت مصاريفك أو صور فواتير.\n` +
      `💬 جرّب: "صرفت 50 جنيه اكل"`,
      { parse_mode: 'Markdown' }
    );
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
      `📊 *tahweshabot*\n\n` +
      `${SEP}\n\n` +
      `👋 أهلاً *${name}*!\n\n` +
      `أنا مساعدك المالي الذكي.\n` +
      `أساعدك تتابع مصاريفك ودخلك بسهولة.\n\n` +
      `${SEP}\n\n` +
      `📝 *ابدأ دلوقتي:*\n\n` +
      `💬 "صرفت 50 جنيه اكل"\n` +
      `💬 "قبضت راتبي 9000"\n` +
      `📸 ابعت صورة فاتورة\n` +
      `🎤 ابعت رسالة صوتية\n\n` +
      `${SEP}\n\n` +
      `⚙️ *الأوامر:*\n\n` +
      `📊 /summary — ملخص مالي\n` +
      `📋 /transactions — العمليات\n` +
      `💰 /budget — الميزانية\n` +
      `🏷 /categories — التصنيفات\n` +
      `📈 /compare — المقارنة\n` +
      `🔒 /password — الحماية\n` +
      `🗑 /delete — حذف\n` +
      `ℹ️ /help — المساعدة`,
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
        ? `📊 *tahweshabot*\n\n🔒 *عندك باسورد بالفعل*\n\n` +
          `للتغيير: /password باسورد_جديد\n` +
          `للحذف: /password حذف`
        : `📊 *tahweshabot*\n\n🔒 *مفيش باسورد*\n\n` +
          `لتعين باسورد: /password ال_باسورد\n` +
          `لو مش عايز باسورد اسيبك عادي.`,
        { parse_mode: 'Markdown' });
      return;
    }
    if (args === 'حذف' || args === 'delete' || args === 'remove') {
      await setUserPassword(id, null);
      await ctx.reply(
        `📊 *tahweshabot*\n\n🔓 *تم مسح الباسورد*\nحسابك مفتوح بدون حماية.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await setUserPassword(id, args);
    await ctx.reply(
      `📊 *tahweshabot*\n\n🔒 *تم تعين الباسورد*\n\n` +
      `الباسورد: \`${args}\`\n\n` +
      `محدش يقدر يحذف أو يعدّل عملياتك من غيره.`,
      { parse_mode: 'Markdown' }
    );
  });

  b.command('delete', async (ctx) => {
    const id = uid(ctx);
    const has = await hasPassword(id);
    if (has) {
      pendingActions.set(id, { action: 'delete_tx', time: Date.now() });
      await ctx.reply(
        `📊 *tahweshabot*\n\n🔒 *محتاج巴斯ورد*\nاكتب巴斯ورد عشان تقدر تحذف.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const txs = await getTransactions(id, 5);
    if (txs.length === 0) {
      await ctx.reply(`📊 *tahweshabot*\n\n📋 لا توجد عمليات تحذف.`, { parse_mode: 'Markdown' });
      return;
    }
    let msg = `📊 *tahweshabot*\n`;
    msg += `${SEP}\n\n`;
    msg += `🗑 *اختر العملية اللي عايز تحذفها:*\n\n`;
    txs.forEach((t, i) => {
      const emoji = t.type === 'income' ? '📥' : '📤';
      msg += `${i + 1}. ${emoji} \`${t.amount.toLocaleString('ar-EG')} ج\` — ${t.description || t.category}\n`;
    });
    pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  b.command('categories', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    try {
      const cats = await getCategoryBreakdown(id, 1);
      if (cats.length === 0) {
        await ctx.reply(`📊 *tahweshabot*\n\n🏷 لا توجد مصروفات الشهر ده.`, { parse_mode: 'Markdown' });
        return;
      }
      const total = cats.reduce((s, c) => s + c.total, 0);
      let msg = `📊 *tahweshabot*\n`;
      msg += `${SEP}\n\n`;
      msg += `🏷 *تصنيفات المصروفات*\n\n`;
      cats.forEach(c => {
        const pct = Math.round(c.total / total * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        msg += `*${c.category}*\n`;
        msg += `\`${bar}\` *${pct}%*\n`;
        msg += `└ \`${c.total.toLocaleString('ar-EG')} ج\`\n\n`;
      });
      msg += `${SEP}\n`;
      msg += `💰 الإجمالي: \`${total.toLocaleString('ar-EG')} ج\``;
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
      if (data.length === 0) {
        await ctx.reply(`📊 *tahweshabot*\n\n📈 مفيش بيانات كافية للمقارنة.`, { parse_mode: 'Markdown' });
        return;
      }
      const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      let msg = `📊 *tahweshabot*\n`;
      msg += `${SEP}\n\n`;
      msg += `📈 *مقارنة الشهور*\n\n`;
      data.forEach(d => {
        msg += `*${months[d.month - 1]}*\n`;
        msg += `└ 📤 المصروفات: \`${d.totalExpenses.toLocaleString('ar-EG')} ج\`\n`;
        msg += `└ 📥 الدخل: \`${d.totalIncome.toLocaleString('ar-EG')} ج\`\n\n`;
      });
      if (data.length >= 2) {
        const diff = data[0].totalExpenses - data[1].totalExpenses;
        const pct = Math.round(diff / data[1].totalExpenses * 100);
        msg += `${SEP}\n`;
        msg += diff > 0
          ? `⚠️ صرفت \`${diff.toLocaleString('ar-EG')} ج\` (${pct}%) *أكتر* من الشهر اللي فات`
          : `✅ وفّرت \`${Math.abs(diff).toLocaleString('ar-EG')} ج\` (${Math.abs(pct)}%) *عن* الشهر اللي فات`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply('❌ حصلت مشكلة.');
    }
  });

  b.on('message:photo', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    await ctx.reply(
      `📊 *tahweshabot*\n\n🔄 جاري تحليل الصورة...`,
      { parse_mode: 'Markdown' }
    );
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
      await ctx.reply(
        `📊 *tahweshabot*\n\n❌ لم أستطع تحليل الصورة.`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  b.on('message:voice', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    await ctx.reply(
      `📊 *tahweshabot*\n\n🔄 جاري الاستماع...`,
      { parse_mode: 'Markdown' }
    );
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const aiResult = await parseAudioVoice(buf, ctx.message.voice.mime_type || 'audio/ogg');
      await handleAiResult(ctx, aiResult, 'رسالة صوتية');
    } catch (e) {
      console.error('Voice error:', e.message);
      await ctx.reply(
        `📊 *tahweshabot*\n\n❌ لم أستطع تحليل الصوت.`,
        { parse_mode: 'Markdown' }
      );
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
          await ctx.reply(
            `📊 *tahweshabot*\n\n🔒 *巴斯ورد غلط*\nحاول تاني.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        const txs = await getTransactions(id, 5);
        if (txs.length === 0) {
          await ctx.reply(`📊 *tahweshabot*\n\n📋 لا توجد عمليات.`, { parse_mode: 'Markdown' });
          return;
        }
        let msg = `📊 *tahweshabot*\n`;
        msg += `${SEP}\n\n`;
        msg += `🗑 *اختر العملية:*\n\n`;
        txs.forEach((t, i) => {
          const emoji = t.type === 'income' ? '📥' : '📤';
          msg += `${i + 1}. ${emoji} \`${t.amount.toLocaleString('ar-EG')} ج\` — ${t.description || t.category}\n`;
        });
        pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      }
      if (pending.action === 'delete_tx_pick') {
        pendingActions.delete(id);
        const num = parseInt(text);
        if (isNaN(num) || num < 1 || num > pending.txs.length) {
          await ctx.reply(
            `📊 *tahweshabot*\n\n❌ رقم غلط. جرّب تاني.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        const tx = pending.txs[num - 1];
        await deleteTransaction(tx.id, id);
        await ctx.reply(
          `📊 *tahweshabot*\n\n✅ *تم الحذف*\n\n` +
          `${tx.type === 'income' ? '📥' : '📤'} \`${tx.amount.toLocaleString('ar-EG')} ج\` — ${tx.description || tx.category}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    } else if (pending) {
      pendingActions.delete(id);
    }

    if (lower === 'ملخص' || lower === 'رصيد' || lower === 'تقرير') return sendSummary(ctx);
    if (lower === 'آخر عمليات' || lower === 'transactions') return sendTransactions(ctx);
    if (lower === 'مساعدة' || lower === 'help') return sendHelp(ctx);
    if (lower.startsWith('ميزانيتي') || lower.startsWith('budget')) return handleBudget(ctx, text);

    await ctx.reply(
      `📊 *tahweshabot*\n\n🔄 جاري التحليل...`,
      { parse_mode: 'Markdown' }
    );
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
