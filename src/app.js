import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllUsers, getFinancialSummary, getTransactions, updateUserBudget, deleteTransaction, addTransaction, deleteUser, hasPassword, checkUserPassword } from './lib/db.js';
import { getTelegramBot, setupBotHandlers } from './services/telegram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// Telegram webhook
app.post('/api/webhook', async (req, res) => {
  try {
    setupBotHandlers();
    const bot = getTelegramBot();
    if (!bot.api.__inited) {
      await bot.init();
      bot.api.__inited = true;
    }
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.sendStatus(200);
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const { getTelegramBot } = await import('./services/telegram.js');
    const b = getTelegramBot();
    res.json({ bot: b ? 'active' : 'inactive', platform: 'telegram' });
  } catch (e) {
    res.json({ bot: 'inactive', platform: 'telegram', error: e.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/summary', async (req, res) => {
  const phone = req.query.phone;
  const password = req.query.password;
  if (!phone) return res.status(400).json({ error: 'User ID is required' });
  try {
    if (password) {
      const ok = await checkUserPassword(phone, password);
      if (!ok) return res.status(403).json({ error: 'Invalid password' });
    }
    const summary = await getFinancialSummary(phone);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'User ID is required' });
  try {
    const txs = await getTransactions(phone, 50);
    res.json(txs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/budget', async (req, res) => {
  const { phone, budget, period, password } = req.body;
  if (!phone || budget === undefined) return res.status(400).json({ error: 'User ID and budget are required' });
  try {
    if (password) {
      const ok = await checkUserPassword(phone, password);
      if (!ok) return res.status(403).json({ error: 'Invalid password' });
    }
    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
    const p = period && validPeriods.includes(period) ? period : null;
    await updateUserBudget(phone, parseFloat(budget), p);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { phone, password } = req.query;
  if (!phone) return res.status(400).json({ error: 'User ID is required' });
  try {
    if (password) {
      const ok = await checkUserPassword(phone, password);
      if (!ok) return res.status(403).json({ error: 'Invalid password' });
    }
    const success = await deleteTransaction(parseInt(id), phone);
    res.json({ success });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transactions', async (req, res) => {
  const { phone, type, amount, category, description } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'User ID and amount are required' });
  try {
    const id = await addTransaction(phone, {
      type: type || 'expense',
      amount: parseFloat(amount),
      category: category || 'أخرى',
      description: description || 'إدخال يدوي'
    });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:phone', async (req, res) => {
  const { phone } = req.params;
  if (!phone) return res.status(400).json({ error: 'User ID is required' });
  try {
    const result = await deleteUser(phone);
    res.json({ success: result.userDeleted > 0, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default app;
