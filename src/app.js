import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllUsers, getFinancialSummary, getTransactions, updateUserBudget, deleteTransaction, addTransaction, deleteUser, getBotSessions, deleteBotSession } from './lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// On Vercel (family-facing), go straight to the dashboard.
// The pairing page is only for the admin connecting the bot locally.
app.get('/', (req, res) => {
  if (process.env.VERCEL) {
    return res.redirect('/dashboard.html');
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// API Routes
app.get('/api/status', async (req, res) => {
  try {
    const { getWhatsAppStatus } = await import('./services/whatsapp.js');
    res.json(await getWhatsAppStatus());
  } catch (e) {
    res.json({ sessions: [], note: 'bot not running on this host', error: e.message });
  }
});

app.post('/api/pair', async (req, res) => {
  const { id, name, phone, botPhone } = req.body;
  if (!id || !phone) {
    return res.status(400).json({ error: 'id and phone (owner) are required' });
  }
  try {
    const { requestPairingCode } = await import('./services/whatsapp.js');
    // If no dedicated bot number provided, link the person's own number (self-chat flow)
    const targetBot = (botPhone && String(botPhone).trim()) || String(phone).trim();
    const code = await requestPairingCode(String(id).trim(), {
      name: String(name || '').trim(),
      phone: String(phone).trim(),
      botPhone: targetBot
    });
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await getBotSessions();
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { removeSession } = await import('./services/whatsapp.js');
    await removeSession(req.params.id);
    res.json({ success: true });
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
