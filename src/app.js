import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllUsers, getFinancialSummary, getTransactions, updateUserBudget, deleteTransaction, addTransaction, deleteUser } from './lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.get('/api/status', async (req, res) => {
  try {
    const { getWhatsAppStatus } = await import('./services/whatsapp.js');
    res.json(getWhatsAppStatus());
  } catch (e) {
    res.json({ status: 'disconnected', qr: null, client: null, note: 'bot not running on this host' });
  }
});

app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const { requestPairingCode } = await import('./services/whatsapp.js');
    const code = await requestPairingCode(phone);
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const summary = await getFinancialSummary(phone);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const txs = await getTransactions(phone, 50);
    res.json(txs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/budget', async (req, res) => {
  const { phone, budget, period } = req.body;
  if (!phone || budget === undefined) {
    return res.status(400).json({ error: 'Phone and budget are required' });
  }
  const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
  const p = period && validPeriods.includes(period) ? period : null;
  try {
    await updateUserBudget(phone, parseFloat(budget), p);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ error: 'Phone is required' });
  }
  try {
    const success = await deleteTransaction(parseInt(id), phone);
    res.json({ success });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transactions', async (req, res) => {
  const { phone, type, amount, category, description } = req.body;
  if (!phone || !amount) {
    return res.status(400).json({ error: 'Phone and amount are required' });
  }
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
  if (!phone) {
    return res.status(400).json({ error: 'Phone is required' });
  }
  try {
    const result = await deleteUser(phone);
    res.json({ success: result.userDeleted > 0, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default app;
