import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ GEMINI_API_KEY is not set. Add it to .env or environment variables.');
}
const genAI = new GoogleGenerativeAI(apiKey || 'missing-key');
const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const fallbackModels = ['gemini-3.5-flash-lite', 'gemini-2.5-flash'];

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
- "نزلت مول وجبت هدوم 800" → expense, ملابس, 800
- "شربت قهوة 25 جنيه في Starbucks" → expense, أكل ومشروبات, 25
- "سيبت فلوس عند الشاليه 1000" → expense, ترفيه, 1000
- "قبضت المرتب 10000" → income, راتب, 10000
- "عملت شارج موبايل 50" → expense, فواتير واشتراكات, 50
- "النت اتقطع، اضطرار دفعت 200" → expense, فواتير واشتراكات, 200
- "قهوتي الصبح 30 جنيه" → expense, أكل ومشروبات, 30
- "ادفع الأيجار 3000" → expense, سكن وأيجار, 3000
- "جبت كورس أونلاين 500" → expense, تعليم, 500
- "اخدت أوبر 45 جنيه" → expense, مواصلات, 45
- "بنزين 300" → expense, مواصلات, 300
- "لقيت حد بعتلي 200 جنيه" → income, هدية, 200
- "رجعت فلوس الميزة 50" → income, استرداد, 50
- "جبت هدية عيد ميلاد 350" → expense, هدايا, 350
- "حضانة الولاد 2000" → expense, أولاد, 2000
- "جبت أكل قطط 180" → expense, حيوانات أليفة, 180
- "دفعت المية 120" → expense, فواتير واشتراكات, 120
- "شغل فريلانس 3000" → income, دخل إضافي, 3000

## التصنيفات المتاحة للمصروفات (expense):
- أكل ومشروبات: أكل، شرب، قهوة، مطاعم، سوبر ماركت، خضار، فواكه، لحوم
- مواصلات: تاكسي، أوبر، كريم، ميكروباص، مترو، اوتوبوس، بنزين، بنزينة، جاز
- تسوق: ملابس، إلكترونيات، أي حاجة اتشريت من محل
- فواتير واشتراكات: كهرباء، مية، غاز، نت، موبايل، شارج، نتفلكس، ViU
- ترفيه: سينما، شاليه، سفري، خروجات، ألعاب، 스포츠
- صحة: دكتور، أدوية، صيدلية، تحاليل، أسنان
- تعليم: كورسات، كتب، مدرسة، جامعه، سنتر
- سكن وأيجار: إيجار، صيانة، ديكور، عفش
- ملابس: هدوم، جزمة، شنطة
- هدايا: هدية، عيد ميلاد، جواز
- أولاد: حضانة، ألعاب أولاد، ملابس أولاد، بيبى
- حيوانات أليفة: علاج حيوانات، أكل حيوانات
- أخرى: أي حاجة مش من التصنيفات دي

## التصنيفات المتاحة للدخل (income):
- راتب
- دخل إضافي: فريلانس، شغل جانبي، بيزنس
- هدية: حد بعتلك فلوس
- استرداد: فلوس اترجعتلك

## صيغة الرد JSON (مطلوب بالظبط):
{
  "type": "expense" أو "income" أو "query" أو "unknown" أو "debt_lend" أو "debt_borrow" أو "gameya" أو "purchase_advice" أو "settle_debt",
  "amount": رقم المبلغ (null لو مفيش مبلغ ذكر),
  "category": "أحد التصنيفات أعلاه",
  "description": "وصف مختصر بالعربي",
  "personName": "اسم الشخص (مهم جداً للديون والجمعيات)",
  "replyMessage": "رسالة رد جميلة بالعربي تأكد تسجيل العملية أو تطلب توضيح"
}

## للديون (سلف وعليك):
- "سلفت أحمد 500 جنيه" → type: "debt_lend", amount: 500, personName: "أحمد"
- "سلفت لـ محمد 300" → type: "debt_lend", amount: 300, personName: "محمد"
- "استلفت من سارة 1000" → type: "debt_borrow", amount: 1000, personName: "سارة"
- "عليا لـ أحمد 200" → type: "debt_borrow", amount: 200, personName: "أحمد"
- "حد سلفني 500 جنيه" → type: "debt_borrow", amount: 500
- "أحمد رجعلي فلوسه" → type: "settle_debt", personName: "أحمد"
- "دفعت لأحمد اللي عليا" → type: "settle_debt", personName: "أحمد"

## للجمعيات:
- "أنا في جمعية مع أحمد 500 شهري" → type: "gameya", amount: 500, personName: "أحمد"
- "جمعيتي 1000 جنيه في الشهر" → type: "gameya", amount: 1000
- ".collecting with ahmed 500/month" → type: "gameya", amount: 500, personName: "Ahmed"

## للاستشارة الشراء:
- "أشتري جاكيت بـ 1500 جنيه ولا لأ؟" → type: "purchase_advice", amount: 1500
- "هل أشتري الموبايل ده؟" → type: "purchase_advice", amount: null
- "عايز أشتري سماعة بـ 800" → type: "purchase_advice", amount: 800

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
      console.error(`Gemini model ${modelName} failed:`, error?.status || error?.message?.substring(0, 100));
      const isQuota = error?.status === 429 || /quota|Too Many|exceeded/i.test(error?.message || '');
      if (!isQuota && error?.status === 400) {
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
