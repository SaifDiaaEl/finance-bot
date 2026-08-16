import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ GEMINI_API_KEY is not set. Add it to .env or environment variables.');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);
const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const fallbackModels = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

const systemInstruction = `
أنت مساعد مالي ذكي ومحترف باللهجة العربية المصرية والعربية الفصحى البسيطة.
مهمتك تحليل رسائل المستخدم (سواء كانت نصية، أو وصف لصوت، أو صورة فاتورة) واستخراج معلومات المعاملة المالية بدقة شديدة بصيغة JSON فقط دون أي نصوص إضافية قبلها أو بعدها.

التصنيفات المتاحة للمصروفات (expense):
- أكل ومشروبات
- مواصلات
- تسوق
- فواتير واشتراكات
- ترفيه
- صحة
- أخرى

التصنيفات المتاحة للدخل (income):
- راتب
- دخل إضافي
- أخرى

يجب أن يكون الرد بصيغة JSON بالشكل التالي تماماً:
{
  "type": "expense" أو "income",
  "amount": رقم بالمبلغ الرقمي (مثل 150.5),
  "category": "أحد التصنيفات أعلاه",
  "description": "وصف مختصر للمعاملة باللغة العربية",
  "replyMessage": "رسالة رد قصيرة وجميلة للمستخدم تؤكد تسجيل العملية وتذكر الموقف المالي."
}

إذا كانت الرسالة استعلاماً عن الرصيد أو تقريراً (مثل "أنا صرفت كام؟" أو "الميزانية كام")، أرجع JSON بالشكل التالي:
{
  "type": "query",
  "queryType": "summary",
  "replyMessage": "استعلام عن الملخص"
}

إذا كانت الرسالة غير واضحة مالياً، أرجع:
{
  "type": "unknown",
  "replyMessage": "عذراً، لم أفهم العملية المالية بوضوح. برجاء كتابة المبلغ والتفاصيل بوضوح مثل: 'صرفت 50 جنيه قهوة'."
}
`;

let lastRequestTime = 0;
let requestQueue = Promise.resolve();

function throttle(fn) {
  const result = requestQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastRequestTime + 1200 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestTime = Date.now();
    return fn();
  });
  requestQueue = result.catch(() => {});
  return result;
}

async function generateWithFallback(parts) {
  const models = [primaryModel, ...fallbackModels];
  let lastError = null;
  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction,
      });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' },
      });
      const responseText = result.response.text();
      return JSON.parse(responseText);
    } catch (error) {
      lastError = error;
      const isQuota = error?.status === 429 || /quota|Too Many|exceeded/i.test(error?.message || '');
      if (!isQuota && error?.status === 400) {
        // Invalid input (e.g. unsupported media) — don't retry other models
        break;
      }
    }
  }
  console.error('Gemini All Models Failed:', lastError?.message);
  return null;
}

export async function parseFinancialInput(textPrompt) {
  const result = await throttle(() => generateWithFallback([{ text: textPrompt }]));
  if (!result) {
    return {
      type: 'unknown',
      replyMessage: 'حدث خطأ مؤقت في معالجة رسالتك. حاول مرة أخرى بعد قليل.',
    };
  }
  return result;
}

export async function parseReceiptImage(imageBuffer, mimeType = 'image/jpeg') {
  const imagePart = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType: mimeType,
    },
  };
  const result = await throttle(() => generateWithFallback([
    imagePart,
    { text: 'قم بقراءة هذه الفاتورة المالية، استخرج إجمالي المبلغ، وتصنيف المصروف المناسب، وأعطني البيانات بصيغة JSON المطلوبة.' },
  ]));
  if (!result) {
    return {
      type: 'unknown',
      replyMessage: 'عذراً، لم أستطع قراءة صورة الفاتورة بوضوح أو أن الخدمة مشغولة. حاول مرة أخرى.',
    };
  }
  return result;
}

export async function parseAudioVoice(audioBuffer, mimeType = 'audio/ogg') {
  const audioPart = {
    inlineData: {
      data: audioBuffer.toString('base64'),
      mimeType: mimeType,
    },
  };
  const result = await throttle(() => generateWithFallback([
    audioPart,
    { text: 'استمع إلى هذا التسجيل الصوتي المالي، واقرا ما يقوله المستخدم، واستخرج منه تفاصيل العملية المالية بصيغة JSON.' },
  ]));
  if (!result) {
    return {
      type: 'unknown',
      replyMessage: 'عذراً، لم أتمكن من تحليل الرسالة الصوتية. حاول مرة أخرى أو اكتب رسالة نصية.',
    };
  }
  return result;
}
