import dotenv from 'dotenv';
import app from './app.js';
import { startAllSessions } from './services/whatsapp.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Financial Assistant Server running on http://localhost:${PORT}`);
  console.log(`📱 Starting WhatsApp engine...`);

  try {
    const count = await startAllSessions();
    console.log(`✅ ${count} bot session(s) started.`);
  } catch (err) {
    console.error('WhatsApp Bot Error:', err);
  }
});
