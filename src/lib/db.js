import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Add it to .env or environment variables.');
}

const pool = new Pool({ connectionString });

export async function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT DEFAULT 'مستخدم',
      monthly_budget REAL DEFAULT 5000,
      budget_period TEXT DEFAULT 'monthly',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      phone TEXT,
      type TEXT CHECK(type IN ('expense', 'income')) DEFAULT 'expense',
      amount REAL NOT NULL,
      category TEXT DEFAULT 'أخرى',
      description TEXT,
      date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (phone) REFERENCES users(phone)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE,
      type TEXT CHECK(type IN ('expense', 'income'))
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      owner_phone TEXT NOT NULL,
      bot_phone TEXT,
      status TEXT DEFAULT 'disconnected',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      msg_key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS debts (
      id SERIAL PRIMARY KEY,
      phone TEXT,
      type TEXT CHECK(type IN ('lend', 'borrow', 'gameya')),
      person_name TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT CHECK(status IN ('pending', 'settled')) DEFAULT 'pending',
      due_date TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      settled_at TIMESTAMPTZ,
      FOREIGN KEY (phone) REFERENCES users(phone)
    )
  `);

  // Migrate legacy single-bot auth (unprefixed keys) into a named session
  const legacyAuth = await pool.query("SELECT count(*)::int AS c FROM whatsapp_auth WHERE key NOT LIKE '%/%'");
  if (legacyAuth.rows[0].c > 0) {
    await pool.query(
      "INSERT INTO bot_sessions (id, name, owner_phone, bot_phone) VALUES ('sowrd', 'Eng Sowrd', '201060005533', '201060005533') ON CONFLICT (id) DO NOTHING"
    );
    await pool.query("UPDATE whatsapp_auth SET key = 'sowrd/' || key WHERE key NOT LIKE '%/%'");
  }

  const userCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
  if (!userCols.rows.some(r => r.column_name === 'budget_period')) {
    await pool.query("ALTER TABLE users ADD COLUMN budget_period TEXT DEFAULT 'monthly'");
  }
  if (!userCols.rows.some(r => r.column_name === 'password')) {
    await pool.query("ALTER TABLE users ADD COLUMN password TEXT");
  }
  if (!userCols.rows.some(r => r.column_name === 'telegram_id')) {
    await pool.query("ALTER TABLE users ADD COLUMN telegram_id TEXT");
  }

  const defaultCategories = [
    { name: 'أكل ومشروبات', type: 'expense' },
    { name: 'مواصلات', type: 'expense' },
    { name: 'تسوق', type: 'expense' },
    { name: 'فواتير واشتراكات', type: 'expense' },
    { name: 'ترفيه', type: 'expense' },
    { name: 'صحة', type: 'expense' },
    { name: 'تعليم', type: 'expense' },
    { name: 'سكن وأيجار', type: 'expense' },
    { name: 'ملابس', type: 'expense' },
    { name: 'هدايا', type: 'expense' },
    { name: 'أولاد', type: 'expense' },
    { name: 'حيوانات أليفة', type: 'expense' },
    { name: 'أخرى', type: 'expense' },
    { name: 'راتب', type: 'income' },
    { name: 'دخل إضافي', type: 'income' },
    { name: 'هدية', type: 'income' },
    { name: 'استرداد', type: 'income' }
  ];

  for (const cat of defaultCategories) {
    await pool.query(
      'INSERT INTO categories (name, type) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [cat.name, cat.type]
    );
  }
}

try {
  await initDb();
} catch (e) {
  console.error('DB init failed (will retry on demand):', e.message);
}

export async function getUser(phone) {
  let res = await pool.query('SELECT * FROM users WHERE phone = $1 OR telegram_id = $1', [phone]);
  if (res.rows.length === 0) {
    await pool.query('INSERT INTO users (phone) VALUES ($1)', [phone]);
    res = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  }
  return res.rows[0];
}

export async function setUserPassword(userId, password) {
  await pool.query('UPDATE users SET password = $1 WHERE phone = $2 OR telegram_id = $2', [password, userId]);
}

export async function checkUserPassword(userId, password) {
  const user = await getUser(userId);
  if (!user.password) return true;
  return user.password === password;
}

export async function hasPassword(userId) {
  const user = await getUser(userId);
  return !!user.password;
}

export async function updateUserBudget(phone, budget, period = null) {
  await getUser(phone);
  if (period) {
    await pool.query('UPDATE users SET monthly_budget = $1, budget_period = $2 WHERE phone = $3', [budget, period, phone]);
  } else {
    await pool.query('UPDATE users SET monthly_budget = $1 WHERE phone = $2', [budget, phone]);
  }
}

export function getPeriodStart(period = 'monthly') {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  switch (period) {
    case 'daily':
      return `${y}-${m}-${d} 00:00:00`;
    case 'weekly': {
      // Start of current week (Monday)
      const day = now.getDay() || 7; // 1=Mon ... 7=Sun
      const diff = day - 1;
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - diff);
      return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')} 00:00:00`;
    }
    case 'yearly':
      return `${y}-01-01 00:00:00`;
    default:
      return `${y}-${m}-01 00:00:00`;
  }
}

export function getPeriodLabel(period = 'monthly') {
  switch (period) {
    case 'daily': return 'اليوم';
    case 'weekly': return 'الأسبوع';
    case 'yearly': return 'السنة';
    default: return 'الشهر';
  }
}

export async function getFinancialSummary(phone) {
  const user = await getUser(phone);
  const period = user.budget_period || 'monthly';
  const startDate = getPeriodStart(period);

  const expensesRes = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE phone = $1 AND type = 'expense' AND date >= $2
  `, [phone, startDate]);

  const incomeRes = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE phone = $1 AND type = 'income' AND date >= $2
  `, [phone, startDate]);

  const byCategoryRes = await pool.query(`
    SELECT category, SUM(amount) as total FROM transactions
    WHERE phone = $1 AND type = 'expense' AND date >= $2
    GROUP BY category ORDER BY total DESC
  `, [phone, startDate]);

  const expenses = Number(expensesRes.rows[0].total) || 0;
  const income = Number(incomeRes.rows[0].total) || 0;
  const byCategory = byCategoryRes.rows.map(r => ({
    category: r.category,
    total: Number(r.total) || 0
  }));

  const remainingBudget = (user.monthly_budget + income) - expenses;

  return {
    monthlyBudget: user.monthly_budget,
    budgetPeriod: period,
    periodLabel: getPeriodLabel(period),
    totalExpenses: expenses,
    totalIncome: income,
    remainingBudget,
    byCategory,
    userName: user.name
  };
}

export async function addTransaction(phone, { type = 'expense', amount, category = 'أخرى', description = '' }) {
  await getUser(phone);
  const res = await pool.query(`
    INSERT INTO transactions (phone, type, amount, category, description)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [phone, type, amount, category, description]);
  return res.rows[0].id;
}

export async function getTransactions(phone, limit = 10) {
  const res = await pool.query(
    'SELECT * FROM transactions WHERE phone = $1 ORDER BY date DESC LIMIT $2',
    [phone, limit]
  );
  return res.rows;
}

export async function deleteTransaction(id, phone) {
  const res = await pool.query('DELETE FROM transactions WHERE id = $1 AND phone = $2', [id, phone]);
  return res.rowCount > 0;
}

export async function getAllTransactionsForDashboard() {
  const res = await pool.query(`
    SELECT t.*, u.name as user_name FROM transactions t
    LEFT JOIN users u ON t.phone = u.phone
    ORDER BY t.date DESC
  `);
  return res.rows;
}

export async function getAllUsers() {
  const res = await pool.query('SELECT * FROM users');
  return res.rows;
}

export async function authStateGet(key) {
  const res = await pool.query('SELECT value FROM whatsapp_auth WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

export async function authStateSet(key, value) {
  await pool.query(
    'INSERT INTO whatsapp_auth (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

export async function authStateRemove(key) {
  await pool.query('DELETE FROM whatsapp_auth WHERE key = $1', [key]);
}

export async function deleteUser(phone) {
  const res = await pool.query('DELETE FROM transactions WHERE phone = $1', [phone]);
  const res2 = await pool.query('DELETE FROM users WHERE phone = $1', [phone]);
  return { transactionsDeleted: res.rowCount, userDeleted: res2.rowCount };
}

export async function getBotSessions() {
  const res = await pool.query('SELECT * FROM bot_sessions ORDER BY created_at ASC');
  return res.rows;
}

export async function getBotSession(id) {
  const res = await pool.query('SELECT * FROM bot_sessions WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function createBotSession({ id, name, ownerPhone, botPhone = '' }) {
  await pool.query(
    `INSERT INTO bot_sessions (id, name, owner_phone, bot_phone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       owner_phone = EXCLUDED.owner_phone,
       bot_phone = COALESCE(NULLIF(EXCLUDED.bot_phone, ''), bot_sessions.bot_phone)`,
    [id, name, ownerPhone, botPhone]
  );
}

export async function updateBotSessionStatus(id, status, botPhone = null) {
  if (botPhone) {
    await pool.query('UPDATE bot_sessions SET status = $1, bot_phone = $2 WHERE id = $3', [status, botPhone, id]);
  } else {
    await pool.query('UPDATE bot_sessions SET status = $1 WHERE id = $2', [status, id]);
  }
}

export async function deleteBotSession(id) {
  await pool.query('DELETE FROM bot_sessions WHERE id = $1', [id]);
  await pool.query("DELETE FROM whatsapp_auth WHERE key LIKE $1", [id + '/%']);
}

export async function isMessageProcessed(msgKey) {
  const res = await pool.query('SELECT 1 FROM processed_messages WHERE msg_key = $1', [msgKey]);
  return res.rows.length > 0;
}

export async function markMessageProcessed(msgKey) {
  await pool.query(
    'INSERT INTO processed_messages (msg_key) VALUES ($1) ON CONFLICT (msg_key) DO NOTHING',
    [msgKey]
  );
}

export async function clearSessionAuth(prefix) {
  await pool.query("DELETE FROM whatsapp_auth WHERE key LIKE $1", [prefix + '/%']);
}

export async function cleanupOldProcessedMessages(hours = 24) {
  await pool.query('DELETE FROM processed_messages WHERE created_at < NOW() - ($1 || \' hours\')::interval', [hours]);
}

export async function getMonthlyComparison(phone) {
  const res = await pool.query(`
    SELECT
      EXTRACT(MONTH FROM date) as month,
      EXTRACT(YEAR FROM date) as year,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expenses,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income
    FROM transactions WHERE phone = $1
    GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date)
    ORDER BY year DESC, month DESC
    LIMIT 6
  `, [phone]);
  return res.rows.map(r => ({
    month: Number(r.month),
    year: Number(r.year),
    totalExpenses: Number(r.total_expenses),
    totalIncome: Number(r.total_income)
  }));
}

export async function getCategoryBreakdown(phone, months = 1) {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const start = startDate.toISOString().split('T')[0];
  const res = await pool.query(`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM transactions WHERE phone = $1 AND type = 'expense' AND date >= $2
    GROUP BY category ORDER BY total DESC
  `, [phone, start]);
  return res.rows.map(r => ({
    category: r.category,
    total: Number(r.total),
    count: Number(r.count)
  }));
}

export async function addDebt(phone, { type, personName, amount, dueDate = null, notes = '' }) {
  await getUser(phone);
  const res = await pool.query(`
    INSERT INTO debts (phone, type, person_name, amount, due_date, notes)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [phone, type, personName, amount, dueDate, notes]);
  return res.rows[0].id;
}

export async function getDebts(phone, status = 'pending') {
  const res = await pool.query(`
    SELECT * FROM debts WHERE phone = $1 AND status = $2 ORDER BY created_at DESC
  `, [phone, status]);
  return res.rows;
}

export async function getDebtById(id, phone) {
  const res = await pool.query('SELECT * FROM debts WHERE id = $1 AND phone = $2', [id, phone]);
  return res.rows[0] || null;
}

export async function settleDebt(id, phone) {
  const res = await pool.query(`
    UPDATE debts SET status = 'settled', settled_at = NOW()
    WHERE id = $1 AND phone = $2 AND status = 'pending'
  `, [id, phone]);
  return res.rowCount > 0;
}

export async function deleteDebt(id, phone) {
  const res = await pool.query('DELETE FROM debts WHERE id = $1 AND phone = $2', [id, phone]);
  return res.rowCount > 0;
}

export async function getDebtSummary(phone) {
  const res = await pool.query(`
    SELECT type, SUM(amount) as total, COUNT(*) as count
    FROM debts WHERE phone = $1 AND status = 'pending'
    GROUP BY type
  `, [phone]);
  const result = { lend: { total: 0, count: 0 }, borrow: { total: 0, count: 0 }, gameya: { total: 0, count: 0 } };
  res.rows.forEach(r => {
    result[r.type] = { total: Number(r.total), count: Number(r.count) };
  });
  return result;
}

export async function getDailyStats(phone) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const expensesRes = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
    FROM transactions WHERE phone = $1 AND type = 'expense' AND date >= $2
  `, [phone, today]);

  const incomeRes = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions WHERE phone = $1 AND type = 'income' AND date >= $2
  `, [phone, today]);

  const topCatRes = await pool.query(`
    SELECT category, SUM(amount) as total
    FROM transactions WHERE phone = $1 AND type = 'expense' AND date >= $2
    GROUP BY category ORDER BY total DESC LIMIT 3
  `, [phone, today]);

  return {
    totalExpenses: Number(expensesRes.rows[0].total) || 0,
    txCount: Number(expensesRes.rows[0].count) || 0,
    totalIncome: Number(incomeRes.rows[0].total) || 0,
    topCategories: topCatRes.rows.map(r => ({ category: r.category, total: Number(r.total) }))
  };
}

export async function getPeriodStats(phone) {
  const user = await getUser(phone);
  const period = user.budget_period || 'monthly';
  const startDate = getPeriodStart(period);
  const now = new Date();
  const startOfPeriod = new Date(startDate);
  const totalDays = Math.max(1, Math.ceil((now - startOfPeriod) / (1000 * 60 * 60 * 24)));
  const daysInPeriod = period === 'monthly' ? 30 : period === 'weekly' ? 7 : period === 'yearly' ? 365 : 1;
  const daysRemaining = Math.max(0, daysInPeriod - totalDays);

  const expensesRes = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as total FROM transactions
    WHERE phone = $1 AND type = 'expense' AND date >= $2
  `, [phone, startDate]);

  return {
    budget: user.monthly_budget,
    period,
    daysElapsed: totalDays,
    daysRemaining,
    daysInPeriod,
    totalExpenses: Number(expensesRes.rows[0].total) || 0,
    dailyBurnRate: totalDays > 0 ? (Number(expensesRes.rows[0].total) || 0) / totalDays : 0,
    projectedTotal: totalDays > 0 ? ((Number(expensesRes.rows[0].total) || 0) / totalDays) * daysInPeriod : 0
  };
}

export async function getTransactionsForExport(phone, months = 1) {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const start = startDate.toISOString().split('T')[0];
  const res = await pool.query(`
    SELECT type, amount, category, description, date
    FROM transactions WHERE phone = $1 AND date >= $2
    ORDER BY date DESC
  `, [phone, start]);
  return res.rows;
}

export default pool;
