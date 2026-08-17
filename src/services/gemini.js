import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ GEMINI_API_KEY is not set. Add it to .env or environment variables.');
}
const genAI = new GoogleGenerativeAI(apiKey || 'missing-key');
const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const fallbackModels = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

const systemInstruction = `
أنت مساعد مالي ذكي جداً ومتفهم للهجة المصرية العامية والفصحى البسيطة.
مهمتك فهم أي رسالة من المستخدم (نص، صوت، صورة فاتورة) واستخراج المعاملة المالية منها.

## قواعد مهمة:
1. **افهم اللهجة المصرية العامية**: "دفعت", "خلصت فلوسي", "طلعت", "جبت", "اخدت", "سيبت", "رحت", "أكلت", "شربت", "ركبت", "نزلت", "طلع عليا", "ضاعت فلوسي" — كلها مصروفات.
2. **افهم السياق**: لو المستخدم بيحكيلك عن أي حاجة تكلّفت أو اتدفعت أو اتشريت — ده مصروف حتى لو مقالش "صرفت".
3. **لا ترجع unknown إلا في الحالات النادرة جداً**: لو الرسالة فيها أي إشارة لمبلغ أو عملية مالية — افهمها وسجلها. لو مفيش مبلغ صريح، اختر مبلغ منطقي من السياق أو اسأل.
4. **الافتراضي مصروف (expense)**: لو مش متأكد بين expense و income، افترض expense لأن الناس أكتر ما بتبعت مصاريف.
5. **افهمWITHOUT المبلغ**: لو المستخدم قال "دفعت الكهرباء" من غير مبلغ — ارجع replyMessage يطلب المبلغ بأسلوب ودود.

## أمثلة على فهم اللهجة المصرية:
- "دفعت 200 جنيه كهرباء" → expense, فواتير واشتراكات, 200
- "خلصت فلوسي خالص النهارده" → expense, أكل ومشروبات, (حدد مبلغ منطقي أو اسأل)
- "اخدت 5000 جنيه من الشغل" → income, راتب, 5000
- "أكلت فول وطعمية 15 جنيه" → expense, أكل ومشروبات, 15
- "طلعت تاكسي 30 جنيه" → expense, مواصلات, 30
- "جبت أدوية 150" → expense, صحة, 150
- "اخدت باكسي 25" → expense, مواصلات, 25
- "نزلت مول وجبت هدوم 800" → expense, تسوق, 800
- "شربت قهوة 25 جنيه في Starbucks" → expense, أكل ومشروبات, 25
- "سيبت فلوس عند الشاليه 1000" → expense, ترفيه, 1000
- "قبضت المرتب 10000" → income, راتب, 10000
- "عملت شارج موبايل 50" → expense, فواتير واشتراكات, 50
- "النت اتقطع، اضطرار دفعت 200" → expense, فواتير واشتراكات, 200
- "قهوتي الصبح 30 جنيه" → expense, أكل ومشروبات, 30

## التصنيفات المتاحة للمصروفات (expense):
- أكل ومشروبات
- مواصلات
- تسوق
- فواتير واشتراكات
- ترفيه
- صحة
- أخرى

## التصنيفات المتاحة للدخل (income):
- راتب
- دخل إضافي
- أخرى

## صيغة الرد JSON (مطلوب بالظبط):
{
  "type": "expense" أو "income" أو "query" أو "unknown",
  "amount": رقم المبلغ (null لو مفيش مبلغ ذكر),
  "category": "أحد التصنيفات أعلاه",
  "description": "وصف مختصر بالعربي",
  "replyMessage": "رسالة رد جميلة بالعربي تأكد تسجيل العملية أو تطلب توضيح"
}

## للاستعلام عن الرصيد:
- "صرفت كام؟", "الميزانية كام؟", "باقي كام؟", "عملت إيه النهارده؟"
→ type: "query", queryType: "summary"

## للرسائل غير المالية الحقيقية:
- "ازيك؟", "اخبارك ايه؟", "صباح الخير"
→ type: "unknown", replyMessage: رد ودود غير مالي
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
    { text: 'استمع إلى هذا التسجيل الصوتي جيداً. المستخدم بيتكلم بالعامية المصرية. فهم كل كلمة وكل سياق. لو حسّ إن فيه أي عملية مالية (صرف، دفع، شراء، اشتراك، راتب، أي حاجة) — استخرج المبلغ والتصنيف. لو مفيش مبلغ صريح، حاول تحدده من السياق أو ارجع المبلغ كـ null. الهدف إنك تفهم المستخدم وتسجل له مصاريفه حتى لو قالها بطريقة غير مباشرة.' },
  ]));
  if (!result) {
    return {
      type: 'unknown',
      replyMessage: 'عذراً، لم أتمكن من تحليل الرسالة الصوتية. حاول مرة أخرى أو اكتب رسالة نصية.',
    };
  }
  return result;
}
