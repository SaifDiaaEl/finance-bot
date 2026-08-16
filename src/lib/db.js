import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_cDpbzTUZ1tA6@ep-holy-mountain-zatkucvv.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require';

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

  const userCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
  if (!userCols.rows.some(r => r.column_name === 'budget_period')) {
    await pool.query("ALTER TABLE users ADD COLUMN budget_period TEXT DEFAULT 'monthly'");
  }

  const defaultCategories = [
    { name: 'أكل ومشروبات', type: 'expense' },
    { name: 'مواصلات', type: 'expense' },
    { name: 'تسوق', type: 'expense' },
    { name: 'فواتير واشتراكات', type: 'expense' },
    { name: 'ترفيه', type: 'expense' },
    { name: 'صحة', type: 'expense' },
    { name: 'أخرى', type: 'expense' },
    { name: 'راتب', type: 'income' },
    { name: 'دخل إضافي', type: 'income' }
  ];

  for (const cat of defaultCategories) {
    await pool.query(
      'INSERT INTO categories (name, type) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [cat.name, cat.type]
    );
  }
}

await initDb();

export async function getUser(phone) {
  let res = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  if (res.rows.length === 0) {
    await pool.query('INSERT INTO users (phone) VALUES ($1)', [phone]);
    res = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  }
  return res.rows[0];
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

export default pool;
