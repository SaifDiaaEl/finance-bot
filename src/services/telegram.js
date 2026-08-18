import { Bot, InlineKeyboard } from 'grammy';
import XLSX from 'xlsx';
import {
  getUser, addTransaction, getFinancialSummary, getTransactions, updateUserBudget,
  deleteTransaction, setUserPassword, checkUserPassword, hasPassword,
  getMonthlyComparison, getCategoryBreakdown,
  addDebt, getDebts, getDebtById, settleDebt, deleteDebt, getDebtSummary,
  getDailyStats, getPeriodStats, getTransactionsForExport
} from '../lib/db.js';
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

function uid(ctx) { return String(ctx.from.id); }

const SEP = '──────────────────────';

const mainKeyboard = new InlineKeyboard()
  .text('📊 ملخص', 'cmd:summary')
  .text('📋 العمليات', 'cmd:transactions')
  .row()
  .text('💰 الميزانية', 'cmd:budget')
  .text('🏷 التصنيفات', 'cmd:categories')
  .row()
  .text('📈 المقارنة', 'cmd:compare')
  .text('🗑 حذف', 'cmd:delete')
  .row()
  .text('🤝 الديون', 'cmd:debts')
  .text('🌙 تقفيل يوم', 'cmd:digest')
  .row()
  .text('📄 تصدير', 'cmd:export')
  .text('🔒 باسورد', 'cmd:password')
  .row()
  .text('ℹ️ مساعدة', 'cmd:help');

const startKeyboard = () => new InlineKeyboard()
  .text('📊 ملخص', 'cmd:summary')
  .text('📋 العمليات', 'cmd:transactions')
  .row()
  .text('💰 الميزانية', 'cmd:budget')
  .text('🏷 التصنيفات', 'cmd:categories')
  .row()
  .text('🤝 الديون', 'cmd:debts')
  .text('🌙 تقفيل يوم', 'cmd:digest')
  .row()
  .text('📄 تصدير', 'cmd:export')
  .text('ℹ️ مساعدة', 'cmd:help');

const debtsKeyboard = new InlineKeyboard()
  .text('💰 سلفت حد', 'debt:lend')
  .text('📥 استلفت من حد', 'debt:borrow')
  .row()
  .text('🎪 جمعية', 'debt:gameya')
  .text('✅ دُفع/تسوى', 'debt:settle')
  .row()
  .text('📋 قائمة الديون', 'debt:list')
  .text('📊 ملخص الديون', 'debt:summary')
  .row()
  .text('🏠 الرئيسية', 'cmd:home');

async function sendSummary(ctx) {
  const id = uid(ctx);
  try {
    const s = await getFinancialSummary(id);
    const periodMap = { 'اليوم': 'اليومية', 'الأسبوع': 'الأسبوعية', 'السنة': 'السنوية', 'الشهر': 'الشهرية' };
    const pName = periodMap[s.periodLabel] || 'الشهرية';
    const used = s.monthlyBudget - s.remainingBudget;
    const pct = s.monthlyBudget > 0 ? Math.round(used / s.monthlyBudget * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

    let msg = `📊 *tahweshabot*\n${SEP}\n`;
    msg += `🗓 *الميزانية ${pName}*\n\n`;
    msg += `💰 الميزانية: \`${s.monthlyBudget.toLocaleString('ar-EG')} ج\`\n`;
    msg += `📤 المصروفات: \`${s.totalExpenses.toLocaleString('ar-EG')} ج\`\n`;
    msg += `📥 الدخل: \`${s.totalIncome.toLocaleString('ar-EG')} ج\`\n`;
    msg += `🟢 المتبقي: \`${s.remainingBudget.toLocaleString('ar-EG')} ج\`\n\n`;
    msg += `📈 الاستخدام: *${pct}%*\n\`${bar}\`\n`;

    if (s.byCategory.length > 0) {
      msg += `\n${SEP}\n🏷 *التصنيفات*\n\n`;
      s.byCategory.forEach(c => {
        const catPct = Math.round(c.total / s.totalExpenses * 100);
        msg += `• ${c.category}: \`${c.total.toLocaleString('ar-EG')} ج\` (${catPct}%)\n`;
      });
    }
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  } catch (e) {
    console.error('Summary error:', e.message);
    await ctx.reply('❌ حصلت مشكلة في جلب الملخص.', { reply_markup: mainKeyboard });
  }
}

async function sendTransactions(ctx) {
  const id = uid(ctx);
  try {
    const txs = await getTransactions(id, 5);
    if (txs.length === 0) {
      await ctx.reply(`📊 *tahweshabot*\n\nلا توجد عمليات مسجلة بعد.\nابعت أي رسالة عشان تبدأ تسجل مصاريفك.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
      return;
    }
    let msg = `📊 *tahweshabot*\n${SEP}\n📋 *آخر ${txs.length} عمليات*\n\n`;
    txs.forEach((t, i) => {
      const emoji = t.type === 'income' ? '📥' : '📤';
      msg += `${i + 1}. ${emoji} \`${t.amount.toLocaleString('ar-EG')} ج\`\n   └ ${t.description || t.category} · ${t.category}\n   └ ${t.date.substring(0, 10)}\n\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  } catch (e) {
    await ctx.reply('❌ حصلت مشكلة.', { reply_markup: mainKeyboard });
  }
}

async function sendHelp(ctx) {
  const msg = `📊 *tahweshabot*\n\n${SEP}\n\n` +
    `👋 أهلاً! أنا مساعدك المالي الذكي\n\n` +
    `📝 *طريقة التسجيل:*\n\n` +
    `💬 *نص:* "صرفت 50 جنيه اكل"\n` +
    `💬 *نص:* "قبضت راتبي 9000"\n` +
    `📸 *صورة:* ابعت صورة فاتورة\n` +
    `🎤 *صوت:* تكلّم بالعامية\n\n` +
    `${SEP}\n\n` +
    `🤝 *الديون والجمعيات:*\n` +
    `• "سلفت أحمد 500"\n` +
    `• "استلفت من سارة 1000"\n` +
    `• "أنا في جمعية 500 شهري"\n\n` +
    `${SEP}\n\n` +
    `💡 *استشارة شراء:*\n` +
    `• "أشتري جاكيت 1500 ولا لأ؟"\n\n` +
    `${SEP}\n\n` +
    `💡 جرّب: "صرفت 50 جنيه اكل"`;
  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
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
  let period = null, num = null;
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
    const pName = period === 'daily' ? 'اليومية' : period === 'weekly' ? 'الأسبوعية' : period === 'yearly' ? 'السنوية' : 'الشهرية';
    await ctx.reply(
      `📊 *tahweshabot*\n${SEP}\n\n✅ *تم تحديث الميزانية*\n\n💰 الميزانية ${pName}: \`${num.toLocaleString('ar-EG')} ج\``,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
  } else {
    await ctx.reply(
      `📊 *tahweshabot*\n${SEP}\n\n⚠️ *طريقة الاستخدام:*\n\n• ميزانيتي 7000\n• ميزانيتي 3000 أسبوعي\n• budget 5000 شهري`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
  }
}

async function handleAiResult(ctx, aiResult, originalText) {
  if (!aiResult) {
    await ctx.reply(`📊 *tahweshabot*\n\n❌ حصلت مشكلة مؤقتة. حاول تاني.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
    return;
  }
  const id = uid(ctx);
  const type = aiResult.type;

  if (type === 'expense' || type === 'income') {
    if (aiResult.amount === null || aiResult.amount === undefined) {
      const emoji = type === 'expense' ? '📤' : '📥';
      await ctx.reply(
        `📊 *tahweshabot*\n${SEP}\n\n${emoji} فهمت إنك ${type === 'expense' ? 'صرفت' : 'اخدت'} على *${aiResult.description || 'حاجة'}*\n\n💰 قولي المبلغ كام بالظبط؟`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await addTransaction(id, { type, amount: aiResult.amount, category: aiResult.category || 'أخرى', description: aiResult.description || originalText });
    const summary = await getFinancialSummary(id);
    const emoji = type === 'expense' ? '📤' : '📥';
    const typeLabel = type === 'expense' ? 'مصروف' : 'دخل';
    await ctx.reply(
      `📊 *tahweshabot*\n${SEP}\n\n✅ *تم تسجيل ${typeLabel}*\n\n${emoji} المبلغ: \`${aiResult.amount.toLocaleString('ar-EG')} ج\`\n🏷 التصنيف: *${aiResult.category}*\n📝 الوصف: ${aiResult.description || originalText}\n💰 المتبقي: \`${summary.remainingBudget.toLocaleString('ar-EG')} ج\``,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
    return;
  }

  if (type === 'debt_lend' || type === 'debt_borrow') {
    const personName = aiResult.personName || 'مجهول';
    const amount = aiResult.amount;
    if (!amount) {
      await ctx.reply(
        `📊 *tahweshabot*\n${SEP}\n\n${type === 'debt_lend' ? '💰' : '📥'} فهمت إنك ${type === 'debt_lend' ? 'سلفت' : 'استلفت'} من *${personName}*\n\n قولي المبلغ كام؟`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await addDebt(id, { type: type === 'debt_lend' ? 'lend' : 'borrow', personName, amount });
    const label = type === 'debt_lend' ? 'سلفة' : 'دين';
    const emoji = type === 'debt_lend' ? '💰' : '📥';
    await ctx.reply(
      `📊 *tahweshabot*\n${SEP}\n\n✅ *تم تسجيل ${label}*\n\n${emoji} الشخص: *${personName}*\n💵 المبلغ: \`${amount.toLocaleString('ar-EG')} ج\``,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
    return;
  }

  if (type === 'gameya') {
    const personName = aiResult.personName || 'الجمعية';
    const amount = aiResult.amount;
    if (!amount) {
      await ctx.reply(
        `📊 *tahweshabot*\n${SEP}\n\n🎪 فهمت إنك في جمعية مع *${personName}*\n\n قولي القسط كام شهرياً؟`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await addDebt(id, { type: 'gameya', personName, amount });
    await ctx.reply(
      `📊 *tahweshabot*\n${SEP}\n\n✅ *تم تسجيل الجمعية*\n\n🎪 الجمعية مع: *${personName}*\n💵 القسط: \`${amount.toLocaleString('ar-EG')} ج\` شهرياً`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
    return;
  }

  if (type === 'settle_debt') {
    const personName = aiResult.personName;
    const debts = await getDebts(id, 'pending');
    const match = debts.find(d => d.person_name.toLowerCase().includes(personName?.toLowerCase() || ''));
    if (match) {
      await settleDebt(match.id, id);
      const label = match.type === 'lend' ? 'سلفة' : match.type === 'borrow' ? 'دين' : 'جمعية';
      await ctx.reply(
        `📊 *tahweshabot*\n${SEP}\n\n✅ *تم التسويه*\n\n🤝 ${label} مع *${match.person_name}*: \`${match.amount.toLocaleString('ar-EG')} ج\``,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard }
      );
    } else {
      await ctx.reply(
        `📊 *tahweshabot*\n${SEP}\n\n🔍 ملقيتش دين معلق مع *${personName || 'حد'}*\n\nجرّب تكتب الاسم بالظبط أو ادخل على زر 🤝 الديون`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard }
      );
    }
    return;
  }

  if (type === 'purchase_advice') {
    const amount = aiResult.amount;
    if (!amount) {
      await ctx.reply(
        `📊 *tahweshabot*\n${SEP}\n\n💡 قولي المبلغ بالظبط عشان أقدر أساعدك!`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard }
      );
      return;
    }
    const ps = await getPeriodStats(id);
    const remaining = ps.budget - ps.totalExpenses;
    const daysLeft = ps.daysRemaining;
    const dailyAllowance = daysLeft > 0 ? remaining / daysLeft : 0;
    const impact = Math.round(amount / ps.budget * 100);
    const afterPurchase = remaining - amount;

    let verdict, verdictEmoji;
    if (afterPurchase < 0) {
      verdict = 'الشراء هيخلّيك في سالب! الوضع المالي مش مناسب دلوقتي.';
      verdictEmoji = '🚫';
    } else if (impact > 30) {
      verdict = `ده ${impact}% من ميزانيتك الشهرية — شكل كبير! فكّر كويس.`;
      verdictEmoji = '⚠️';
    } else if (dailyAllowance > 0 && amount > dailyAllowance * 5) {
      verdict = `ده أكتر من مصاريف 5 أيام. الوضع يسمح بس لو مستعجل.`;
      verdictEmoji = '🤔';
    } else {
      verdict = `تمام! الوضع يسمح. هيفضل معاك \`${afterPurchase.toLocaleString('ar-EG')} ج\` وفاضل ${daysLeft} يوم.`;
      verdictEmoji = '✅';
    }

    await ctx.reply(
      `📊 *tahweshabot*\n${SEP}\n\n🛒 *استشارة شراء*\n\n` +
      `💵 المبلغ: \`${amount.toLocaleString('ar-EG')} ج\`\n` +
      `💰 المتبقي: \`${remaining.toLocaleString('ar-EG')} ج\`\n` +
      `📅 فاضل: *${daysLeft} يوم*\n` +
      `📊 نسبة الميزانية: *${impact}%*\n\n` +
      `${SEP}\n${verdictEmoji} *النتيجة:* ${verdict}`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
    return;
  }

  await ctx.reply(
    `📊 *tahweshabot*\n\n👋 أهلاً! ابعت مصاريفك أو صور فواتير.\n💬 جرّب: "صرفت 50 جنيه اكل"`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard }
  );
}

async function handleDebtsList(ctx) {
  const id = uid(ctx);
  const debts = await getDebts(id, 'pending');
  if (debts.length === 0) {
    await ctx.reply(`📊 *tahweshabot*\n${SEP}\n\n🤝 *مفيش ديون معلقة*\n\nجرّب تبعت:\n• "سلفت أحمد 500"\n• "استلفت من سارة 1000"\n• "أنا في جمعية 500 شهري"`, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
    return;
  }
  let msg = `📊 *tahweshabot*\n${SEP}\n🤝 *الديون المعلقة*\n\n`;
  debts.forEach((d, i) => {
    const emoji = d.type === 'lend' ? '💰' : d.type === 'borrow' ? '📥' : '🎪';
    const label = d.type === 'lend' ? 'سلفت' : d.type === 'borrow' ? 'عليا' : 'جمعية';
    const due = d.due_date ? `\n   └ الميعاد: ${d.due_date.substring(0, 10)}` : '';
    msg += `${i + 1}. ${emoji} *${d.person_name}* — ${label}\n   └ \`${d.amount.toLocaleString('ar-EG')} ج\`${due}\n\n`;
  });
  msg += `${SEP}\n💡 اكتب رقم العملية عشان تسويها`;
  const kb = new InlineKeyboard();
  debts.forEach((d, i) => { kb.text(`✅ ${d.person_name}`, `debt:settle:${d.id}`).row(); });
  kb.text('🏠 الرئيسية', 'cmd:home');
  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
}

async function handleDebtsSummary(ctx) {
  const id = uid(ctx);
  const summary = await getDebtSummary(id);
  let msg = `📊 *tahweshabot*\n${SEP}\n📊 *ملخص الديون*\n\n`;
  msg += `💰 *ليا من الناس:* \`${summary.lend.total.toLocaleString('ar-EG')} ج\` (${summary.lend.count})\n`;
  msg += `📥 *عليا للناس:* \`${summary.borrow.total.toLocaleString('ar-EG')} ج\` (${summary.borrow.count})\n`;
  msg += `🎪 *الجمعيات:* \`${summary.gameya.total.toLocaleString('ar-EG')} ج\` (${summary.gameya.count})\n`;
  const net = summary.lend.total - summary.borrow.total;
  msg += `\n${SEP}\n`;
  msg += net >= 0
    ? `🟢 *الصافي ليك:* \`${net.toLocaleString('ar-EG')} ج\``
    : `🔴 *الصافي عليك:* \`${Math.abs(net).toLocaleString('ar-EG')} ج\``;
  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
}

async function handleDailyDigest(ctx) {
  const id = uid(ctx);
  const daily = await getDailyStats(id);
  const ps = await getPeriodStats(id);
  const pct = ps.budget > 0 ? Math.round(ps.totalExpenses / ps.budget * 100) : 0;
  const remaining = ps.budget - ps.totalExpenses;
  const burnStatus = ps.projectedTotal > ps.budget ? '⚠️ مرتفع' : '✅ طبيعي';

  let msg = `📊 *tahweshabot*\n${SEP}\n🌙 *تقفيل اليوم*\n\n`;
  msg += `📤 مصروفات النهاردة: \`${daily.totalExpenses.toLocaleString('ar-EG')} ج\`\n`;
  msg += `📥 دخل النهاردة: \`${daily.totalIncome.toLocaleString('ar-EG')} ج\`\n`;
  msg += `📋 عدد العمليات: *${daily.txCount}*\n`;

  if (daily.topCategories.length > 0) {
    msg += `\n🏷 *أكثر التصنيفات:*\n`;
    daily.topCategories.forEach(c => { msg += `• ${c.category}: \`${c.total.toLocaleString('ar-EG')} ج\`\n`; });
  }

  msg += `\n${SEP}\n📈 *تحليل الفترة*\n\n`;
  msg += `💰 الميزانية: \`${ps.budget.toLocaleString('ar-EG')} ج\`\n`;
  msg += `📤 المصروفات: \`${ps.totalExpenses.toLocaleString('ar-EG')} ج\` (${pct}%)\n`;
  msg += `📅 فاضل: *${ps.daysRemaining} يوم*\n`;
  msg += `📊 متوسط الصرف اليومي: \`${Math.round(ps.dailyBurnRate).toLocaleString('ar-EG')} ج\`\n`;
  msg += `🔮 المتوقع到最后 الشهر: \`${Math.round(ps.projectedTotal).toLocaleString('ar-EG')} ج\`\n`;
  msg += `🟢 المتبقي: \`${remaining.toLocaleString('ar-EG')} ج\`\n\n`;
  msg += `${SEP}\n${burnStatus} *معدل الصرف*`;

  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
}

async function handleExport(ctx) {
  const id = uid(ctx);
  try {
    const txs = await getTransactionsForExport(id, 1);
    if (txs.length === 0) {
      await ctx.reply(`📊 *tahweshabot*\n\n📄 مفيش بيانات تتصدر الشهر ده.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
      return;
    }
    const wsData = [['التاريخ', 'النوع', 'المبلغ', 'التصنيف', 'الوصف']];
    txs.forEach(t => {
      wsData.push([t.date.toISOString().substring(0, 10), t.type === 'income' ? 'دخل' : 'مصروف', t.amount, t.category, t.description || '']);
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 15 }, { wch: 25 }];
    XLSX.utils.book_append_sheet(wb, ws, 'التقارير');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await ctx.replyWithDocument({
      source: buf,
      filename: `tahweshabot-report-${new Date().toISOString().substring(0, 7)}.xlsx`
    }, { reply_markup: mainKeyboard });
  } catch (e) {
    console.error('Export error:', e.message);
    await ctx.reply('❌ حصلت مشكلة في التصدير.', { reply_markup: mainKeyboard });
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
      `📊 *tahweshabot*\n\n${SEP}\n\n👋 أهلاً *${name}*!\n\nأنا مساعدك المالي الذكي.\nأساعدك تتابع مصاريفك ودخلك بسهولة.\n\n${SEP}\n\n📝 *ابدأ دلوقتي:*\n\n💬 "صرفت 50 جنيه اكل"\n💬 "قبضت راتبي 9000"\n📸 ابعت صورة فاتورة\n🎤 ابعت رسالة صوتية\n\n🤝 "سلفت أحمد 500"\n💡 "أشتري جاكيت 1500 ولا لأ؟"`,
      { parse_mode: 'Markdown', reply_markup: startKeyboard() }
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
        ? `📊 *tahweshabot*\n\n🔒 *عندك باسورد بالفعل*\n\nللتغيير: /password باسورد_جديد\nللحذف: /password حذف`
        : `📊 *tahweshabot*\n\n🔒 *مفيش باسورد*\n\nلتعين باسورد: /password ال_باسورد\nلو مش عايز باسورد اسيبك عادي.`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard });
      return;
    }
    if (args === 'حذف' || args === 'delete' || args === 'remove') {
      await setUserPassword(id, null);
      await ctx.reply(`📊 *tahweshabot*\n\n🔓 *تم مسح الباسورد*\nحسابك مفتوح بدون حماية.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
      return;
    }
    await setUserPassword(id, args);
    await ctx.reply(`📊 *tahweshabot*\n\n🔒 *تم تعين الباسورد*\n\nالباسورد: \`${args}\`\n\nمحدش يقدر يحذف أو يعدّل عملياتك من غيره.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  });

  b.command('delete', async (ctx) => {
    const id = uid(ctx);
    if (await hasPassword(id)) {
      pendingActions.set(id, { action: 'delete_tx', time: Date.now() });
      await ctx.reply(`📊 *tahweshabot*\n\n🔒 *محتاج باسورد*\nاكتب باسورد عشان تقدر تحذف.`, { parse_mode: 'Markdown' });
      return;
    }
    const txs = await getTransactions(id, 5);
    if (txs.length === 0) { await ctx.reply(`📊 *tahweshabot*\n\n📋 لا توجد عمليات تحذف.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
    let msg = `📊 *tahweshabot*\n${SEP}\n\n🗑 *اختر العملية اللي عايز تحذفها:*\n\n`;
    txs.forEach((t, i) => { msg += `${i + 1}. ${t.type === 'income' ? '📥' : '📤'} \`${t.amount.toLocaleString('ar-EG')} ج\` — ${t.description || t.category}\n`; });
    pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  b.command('categories', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    try {
      const cats = await getCategoryBreakdown(id, 1);
      if (cats.length === 0) { await ctx.reply(`📊 *tahweshabot*\n\n🏷 لا توجد مصروفات الشهر ده.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
      const total = cats.reduce((s, c) => s + c.total, 0);
      let msg = `📊 *tahweshabot*\n${SEP}\n\n🏷 *تصنيفات المصروفات*\n\n`;
      cats.forEach(c => {
        const pct = Math.round(c.total / total * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        msg += `*${c.category}*\n\`${bar}\` *${pct}%*\n└ \`${c.total.toLocaleString('ar-EG')} ج\`\n\n`;
      });
      msg += `${SEP}\n💰 الإجمالي: \`${total.toLocaleString('ar-EG')} ج\``;
      await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
    } catch (e) { await ctx.reply('❌ حصلت مشكلة.', { reply_markup: mainKeyboard }); }
  });

  b.command('compare', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    try {
      const data = await getMonthlyComparison(id);
      if (data.length === 0) { await ctx.reply(`📊 *tahweshabot*\n\n📈 مفيش بيانات كافية للمقارنة.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
      const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      let msg = `📊 *tahweshabot*\n${SEP}\n\n📈 *مقارنة الشهور*\n\n`;
      data.forEach(d => { msg += `*${months[d.month - 1]}*\n└ 📤 المصروفات: \`${d.totalExpenses.toLocaleString('ar-EG')} ج\`\n└ 📥 الدخل: \`${d.totalIncome.toLocaleString('ar-EG')} ج\`\n\n`; });
      if (data.length >= 2) {
        const diff = data[0].totalExpenses - data[1].totalExpenses;
        const pct = Math.round(diff / data[1].totalExpenses * 100);
        msg += `${SEP}\n`;
        msg += diff > 0 ? `⚠️ صرفت \`${diff.toLocaleString('ar-EG')} ج\` (${pct}%) *أكتر* من الشهر اللي فات` : `✅ وفّرت \`${Math.abs(diff).toLocaleString('ar-EG')} ج\` (${Math.abs(pct)}%) *عن* الشهر اللي فات`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
    } catch (e) { await ctx.reply('❌ حصلت مشكلة.', { reply_markup: mainKeyboard }); }
  });

  b.command('debts', async (ctx) => handleDebtsList(ctx));

  b.command('digest', async (ctx) => handleDailyDigest(ctx));

  b.command('export', async (ctx) => handleExport(ctx));

  // Callback queries
  b.callbackQuery('cmd:summary', async (ctx) => { await ctx.answerCallbackQuery(); await sendSummary({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });
  b.callbackQuery('cmd:transactions', async (ctx) => { await ctx.answerCallbackQuery(); await sendTransactions({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });
  b.callbackQuery('cmd:home', async (ctx) => { await ctx.answerCallbackQuery(); await sendSummary({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });

  b.callbackQuery('cmd:budget', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`📊 *tahweshabot*\n${SEP}\n\n💰 *تعين الميزانية*\n\nاكتب المبلغ مع الفترة:\n\n• ميزانيتي 7000\n• ميزانيتي 3000 أسبوعي\n• budget 5000 شهري`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  });

  b.callbackQuery('cmd:categories', async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = String(ctx.from.id);
    await getUser(id);
    try {
      const cats = await getCategoryBreakdown(id, 1);
      if (cats.length === 0) { await ctx.editMessageText(`📊 *tahweshabot*\n\n🏷 لا توجد مصروفات الشهر ده.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
      const total = cats.reduce((s, c) => s + c.total, 0);
      let msg = `📊 *tahweshabot*\n${SEP}\n\n🏷 *تصنيفات المصروفات*\n\n`;
      cats.forEach(c => {
        const pct = Math.round(c.total / total * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        msg += `*${c.category}*\n\`${bar}\` *${pct}%*\n└ \`${c.total.toLocaleString('ar-EG')} ج\`\n\n`;
      });
      msg += `${SEP}\n💰 الإجمالي: \`${total.toLocaleString('ar-EG')} ج\``;
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
    } catch (e) { await ctx.editMessageText('❌ حصلت مشكلة.', { reply_markup: mainKeyboard }); }
  });

  b.callbackQuery('cmd:compare', async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = String(ctx.from.id);
    await getUser(id);
    try {
      const data = await getMonthlyComparison(id);
      if (data.length === 0) { await ctx.editMessageText(`📊 *tahweshabot*\n\n📈 مفيش بيانات كافية.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
      const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      let msg = `📊 *tahweshabot*\n${SEP}\n\n📈 *مقارنة الشهور*\n\n`;
      data.forEach(d => { msg += `*${months[d.month - 1]}*\n└ 📤: \`${d.totalExpenses.toLocaleString('ar-EG')} ج\`\n└ 📥: \`${d.totalIncome.toLocaleString('ar-EG')} ج\`\n\n`; });
      if (data.length >= 2) {
        const diff = data[0].totalExpenses - data[1].totalExpenses;
        const pct = Math.round(diff / data[1].totalExpenses * 100);
        msg += `${SEP}\n${diff > 0 ? `⚠️ صرفت أكتر ${pct}%` : `✅ وفّرت ${Math.abs(pct)}%`}`;
      }
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
    } catch (e) { await ctx.editMessageText('❌ حصلت مشكلة.', { reply_markup: mainKeyboard }); }
  });

  b.callbackQuery('cmd:delete', async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = String(ctx.from.id);
    if (await hasPassword(id)) { pendingActions.set(id, { action: 'delete_tx', time: Date.now() }); await ctx.editMessageText(`📊 *tahweshabot*\n\n🔒 *محتاج باسورد*`, { parse_mode: 'Markdown' }); return; }
    const txs = await getTransactions(id, 5);
    if (txs.length === 0) { await ctx.editMessageText(`📊 *tahweshabot*\n\n📋 لا توجد عمليات.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
    let msg = `📊 *tahweshabot*\n${SEP}\n\n🗑 *اختر العملية:*\n\n`;
    txs.forEach((t, i) => { msg += `${i + 1}. ${t.type === 'income' ? '📥' : '📤'} \`${t.amount.toLocaleString('ar-EG')} ج\` — ${t.description || t.category}\n`; });
    pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
    await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  });

  b.callbackQuery('cmd:password', async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = String(ctx.from.id);
    const hasPw = await hasPassword(id);
    await ctx.editMessageText(hasPw
      ? `📊 *tahweshabot*\n\n🔒 *عندك باسورد بالفعل*\n\nللتغيير: /password باسورد_جديد\nللحذف: /password حذف`
      : `📊 *tahweshabot*\n\n🔒 *مفيش باسورد*\n\nلتعين باسورد: /password ال_باسورد\nلو مش عايز باسورد اسيبك عادي.`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  });

  b.callbackQuery('cmd:help', async (ctx) => { await ctx.answerCallbackQuery(); await sendHelp({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });

  b.callbackQuery('cmd:debts', async (ctx) => { await ctx.answerCallbackQuery(); await handleDebtsList({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });
  b.callbackQuery('cmd:digest', async (ctx) => { await ctx.answerCallbackQuery(); await handleDailyDigest({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });
  b.callbackQuery('cmd:export', async (ctx) => { await ctx.answerCallbackQuery(); await handleExport({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o), replyWithDocument: (doc, opts) => ctx.replyWithDocument(doc, opts) }); });

  b.callbackQuery('debt:lend', async (ctx) => {
    await ctx.answerCallbackQuery();
    pendingActions.set(String(ctx.from.id), { action: 'debt_lend', time: Date.now() });
    await ctx.editMessageText(`📊 *tahweshabot*\n${SEP}\n\n💰 *سلفة — مين سلفته؟*\n\nاكتب: _الاسم المبلغ_\nمثال: _أحمد 500_`, { parse_mode: 'Markdown' });
  });

  b.callbackQuery('debt:borrow', async (ctx) => {
    await ctx.answerCallbackQuery();
    pendingActions.set(String(ctx.from.id), { action: 'debt_borrow', time: Date.now() });
    await ctx.editMessageText(`📊 *tahweshabot*\n${SEP}\n\n📥 *دين — استلفت من مين؟*\n\nاكتب: _الاسم المبلغ_\nمثال: _سارة 1000_`, { parse_mode: 'Markdown' });
  });

  b.callbackQuery('debt:gameya', async (ctx) => {
    await ctx.answerCallbackQuery();
    pendingActions.set(String(ctx.from.id), { action: 'debt_gameya', time: Date.now() });
    await ctx.editMessageText(`📊 *tahweshabot*\n${SEP}\n\n🎪 *جمعية*\n\nاكتب: _اسم الجماعة القسط_\nمثال: _أحمد 500_`, { parse_mode: 'Markdown' });
  });

  b.callbackQuery('debt:settle', async (ctx) => {
    await ctx.answerCallbackQuery();
    pendingActions.set(String(ctx.from.id), { action: 'debt_settle', time: Date.now() });
    await ctx.editMessageText(`📊 *tahweshabot*\n${SEP}\n\n✅ *تسوية دين*\n\nاكتب اسم الشخص اللي اتسوى معاه`, { parse_mode: 'Markdown' });
  });

  b.callbackQuery('debt:list', async (ctx) => { await ctx.answerCallbackQuery(); await handleDebtsList({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });
  b.callbackQuery('debt:summary', async (ctx) => { await ctx.answerCallbackQuery(); await handleDebtsSummary({ from: ctx.from, reply: (t, o) => ctx.editMessageText(t, o) }); });

  b.callbackQuery(/^debt:settle:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const debtId = parseInt(ctx.match[1]);
    const id = String(ctx.from.id);
    const debt = await getDebtById(debtId, id);
    if (debt) {
      await settleDebt(debtId, id);
      const label = debt.type === 'lend' ? 'سلفة' : debt.type === 'borrow' ? 'دين' : 'جمعية';
      await ctx.editMessageText(`📊 *tahweshabot*\n${SEP}\n\n✅ *تم التسويه*\n\n🤝 ${label} مع *${debt.person_name}*: \`${debt.amount.toLocaleString('ar-EG')} ج\``, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
    } else {
      await ctx.editMessageText(`❌ ملقيت العملية.`, { reply_markup: debtsKeyboard });
    }
  });

  b.on('message:photo', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    await ctx.reply(`📊 *tahweshabot*\n\n🔄 جاري تحليل الصورة...`, { parse_mode: 'Markdown' });
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const aiResult = await parseReceiptImage(buf, photo.mime_type || 'image/jpeg');
      await handleAiResult(ctx, aiResult, ctx.message.caption || 'فاتورة');
    } catch (e) { console.error('Photo error:', e.message); await ctx.reply(`📊 *tahweshabot*\n\n❌ لم أستطع تحليل الصورة.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); }
  });

  b.on('message:voice', async (ctx) => {
    const id = uid(ctx);
    await getUser(id);
    await ctx.reply(`📊 *tahweshabot*\n\n🔄 جاري الاستماع...`, { parse_mode: 'Markdown' });
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const aiResult = await parseAudioVoice(buf, ctx.message.voice.mime_type || 'audio/ogg');
      await handleAiResult(ctx, aiResult, 'رسالة صوتية');
    } catch (e) { console.error('Voice error:', e.message); await ctx.reply(`📊 *tahweshabot*\n\n❌ لم أستطع تحليل الصوت.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); }
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
        if (!await checkUserPassword(id, text)) { await ctx.reply(`📊 *tahweshabot*\n\n🔒 *باسورد غلط*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
        const txs = await getTransactions(id, 5);
        if (txs.length === 0) { await ctx.reply(`📊 *tahweshabot*\n\n📋 لا توجد عمليات.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
        let msg = `📊 *tahweshabot*\n${SEP}\n\n🗑 *اختر العملية:*\n\n`;
        txs.forEach((t, i) => { msg += `${i + 1}. ${t.type === 'income' ? '📥' : '📤'} \`${t.amount.toLocaleString('ar-EG')} ج\` — ${t.description || t.category}\n`; });
        pendingActions.set(id, { action: 'delete_tx_pick', txs, time: Date.now() });
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      }
      if (pending.action === 'delete_tx_pick') {
        pendingActions.delete(id);
        const num = parseInt(text);
        if (isNaN(num) || num < 1 || num > pending.txs.length) { await ctx.reply(`📊 *tahweshabot*\n\n❌ رقم غلط.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }); return; }
        const tx = pending.txs[num - 1];
        await deleteTransaction(tx.id, id);
        await ctx.reply(`📊 *tahweshabot*\n\n✅ *تم الحذف*\n\n${tx.type === 'income' ? '📥' : '📤'} \`${tx.amount.toLocaleString('ar-EG')} ج\` — ${tx.description || tx.category}`, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
        return;
      }
      if (pending.action === 'debt_lend') {
        pendingActions.delete(id);
        const parts = text.split(/\s+/);
        const amount = parseFloat(parts[parts.length - 1].replace(/[^\d.]/g, ''));
        const personName = parts.slice(0, -1).join(' ');
        if (!amount || !personName) { await ctx.reply(`📊 *tahweshabot*\n\n❌ اكتب: _الاسم المبلغ_\nمثال: _أحمد 500_`, { parse_mode: 'Markdown', reply_markup: debtsKeyboard }); return; }
        await addDebt(id, { type: 'lend', personName, amount });
        await ctx.reply(`📊 *tahweshabot*\n${SEP}\n\n✅ *تم تسجيل السلفة*\n💰 *${personName}*: \`${amount.toLocaleString('ar-EG')} ج\``, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
        return;
      }
      if (pending.action === 'debt_borrow') {
        pendingActions.delete(id);
        const parts = text.split(/\s+/);
        const amount = parseFloat(parts[parts.length - 1].replace(/[^\d.]/g, ''));
        const personName = parts.slice(0, -1).join(' ');
        if (!amount || !personName) { await ctx.reply(`📊 *tahweshabot*\n\n❌ اكتب: _الاسم المبلغ_\nمثال: _سارة 1000_`, { parse_mode: 'Markdown', reply_markup: debtsKeyboard }); return; }
        await addDebt(id, { type: 'borrow', personName, amount });
        await ctx.reply(`📊 *tahweshabot*\n${SEP}\n\n✅ *تم تسجيل الدين*\n📥 *${personName}*: \`${amount.toLocaleString('ar-EG')} ج\``, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
        return;
      }
      if (pending.action === 'debt_gameya') {
        pendingActions.delete(id);
        const parts = text.split(/\s+/);
        const amount = parseFloat(parts[parts.length - 1].replace(/[^\d.]/g, ''));
        const personName = parts.slice(0, -1).join(' ');
        if (!amount) { await ctx.reply(`📊 *tahweshabot*\n\n❌ اكتب: _اسم الجماعة القسط_`, { parse_mode: 'Markdown', reply_markup: debtsKeyboard }); return; }
        await addDebt(id, { type: 'gameya', personName: personName || 'الجمعية', amount });
        await ctx.reply(`📊 *tahweshabot*\n${SEP}\n\n✅ *تم تسجيل الجمعية*\n🎪 *${personName || 'الجمعية'}*: \`${amount.toLocaleString('ar-EG')} ج\` شهرياً`, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
        return;
      }
      if (pending.action === 'debt_settle') {
        pendingActions.delete(id);
        const debts = await getDebts(id, 'pending');
        const match = debts.find(d => d.person_name.toLowerCase().includes(text.toLowerCase()));
        if (match) {
          await settleDebt(match.id, id);
          const label = match.type === 'lend' ? 'سلفة' : match.type === 'borrow' ? 'دين' : 'جمعية';
          await ctx.reply(`📊 *tahweshabot*\n${SEP}\n\n✅ *تم التسويه*\n\n🤝 ${label} مع *${match.person_name}*: \`${match.amount.toLocaleString('ar-EG')} ج\``, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
        } else {
          await ctx.reply(`📊 *tahweshabot*\n\n🔍 ملقيتش دين معلق مع *${text}*`, { parse_mode: 'Markdown', reply_markup: debtsKeyboard });
        }
        return;
      }
    } else if (pending) {
      pendingActions.delete(id);
    }

    if (lower === 'ملخص' || lower === 'رصيد' || lower === 'تقرير') return sendSummary(ctx);
    if (lower === 'آخر عمليات' || lower === 'transactions') return sendTransactions(ctx);
    if (lower === 'مساعدة' || lower === 'help') return sendHelp(ctx);
    if (lower.startsWith('ميزانيتي') || lower.startsWith('budget')) return handleBudget(ctx, text);

    await ctx.reply(`📊 *tahweshabot*\n\n🔄 جاري التحليل...`, { parse_mode: 'Markdown' });
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

export function getTelegramBot() { return bot; }
