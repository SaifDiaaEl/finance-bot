import dotenv from 'dotenv';
import app from './app.js';
import { startWhatsApp } from './services/whatsapp.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Financial Assistant Server running on http://localhost:${PORT}`);
  console.log(`📱 Starting WhatsApp engine...`);

  try {
    await startWhatsApp();
  } catch (err) {
    console.error('WhatsApp Bot Error:', err);
  }
});
