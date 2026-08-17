import dotenv from 'dotenv';
import app from './app.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

async function main() {
  console.log(`🚀 Financial Assistant Server running on http://localhost:${PORT}`);

  if (process.env.VERCEL) {
    console.log('☁️ Running on Vercel — use webhook mode');
    return;
  }

  try {
    const { startTelegramBot } = await import('./services/telegram.js');
    const bot = await startTelegramBot();
    bot.start({
      onStart: () => console.log('✅ Telegram bot started (polling mode)'),
    });
  } catch (err) {
    console.error('Telegram Bot Error:', err.message);
  }
}

app.listen(PORT, () => main());
