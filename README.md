# توضیح آزمایش خون — Blood Test Explainer

🇮🇷 **فارسی** | [🇬🇧 **English**](#english)

برگه آزمایش خون (PDF یا عکس) را ارسال کنید تا هر نتیجه به زبان ساده فارسی توضیح داده شود — فقط با اعداد روی همان برگه، بدون تشخیص و بدون توصیه درمانی.

> این توضیحات صرفاً برای آگاهی عمومی هستند و جایگزین نظر پزشک نیستند.

## چطور کار می‌کند

1. فایل PDF یا عکس (JPG, PNG, WEBP، حداکثر ۱۰ مگابایت) را ارسال می‌کنید.
2. **PDF متنی بدون هوش مصنوعی خوانده می‌شود:** متن PDF با `unpdf` در خود ورکر استخراج و جدول آن با کد پارس می‌شود؛ اگر جدول کامل باشد، صفر فراخوانی AI انجام می‌شود. PDF اسکن‌شده (بدون لایه متن) با `AI.toMarkdown` خوانده می‌شود.
3. **عکس با چند روش پشت سر هم پردازش می‌شود** تا بازه مرجع حتماً خوانده شود (هر مرحله فقط وقتی اجرا می‌شود که مرحله قبل بازه‌ها را کامل نکرده باشد؛ سقف ۸ فراخوانی AI):
   استخراج کامل → تکرار فقط‌بازه → هر بخش جدا (هماتولوژی، بیوشیمی) → فقط ستون بازه → رونویسی متنی جدول و ساختاردهی آن → بازخوانی قطعی (temperature 0) → مدل بینایی جایگزین → عکس بهبودیافته با Jimp (کنتراست، خاکستری، شارپ). هر مرحله فقط بازه‌ها و واحدهای خالی را پر می‌کند؛ مقدارها هرگز بازنویسی نمی‌شوند.
4. مدل `@cf/meta/llama-4-scout-17b-16e-instruct` با `guided_json` فقط استخراج می‌کند: نام، مخفف، مقدار، واحد، بازه مرجع و (فقط برای آزمایش‌های ناشناخته) یک جمله تعریف. خروجی مدل با Zod اعتبارسنجی می‌شود.
5. بقیه کار دست کد است، نه مدل:
   - اعداد فارسی و عربی به انگلیسی تبدیل می‌شوند.
   - هر مقدار و بازه باید عیناً در متن برگه پیدا شود، وگرنه «خوانا نیست» می‌شود.
   - وضعیت (داخل بازه / بالاتر / پایین‌تر / نامشخص) را کد، با مقایسه عدد و بازه، حساب می‌کند.
   - جمله توضیح از یک قالب ثابت و با همان وضعیت تاییدشده ساخته می‌شود؛ جمله آزاد مدل هرگز استفاده نمی‌شود.
   - توضیح هر آزمایش اول از دیکشنری داخلی (کبد، کلیه، چربی خون، دیابت، تیروئید، هورمون، آهن، التهاب و غیره) می‌آید، بعد از تعریف مدل، و فقط در آخر جمله کلی.
6. فایل ذخیره نمی‌شود و بعد از پردازش نگه داشته نمی‌شود.

### نکته‌ها

- در بسیاری از برگه‌ها، شمارش افتراقی (نوتروفیل، لنفوسیت، مونوسیت، ائوزینوفیل) بازه مرجع ندارد؛ این موارد با وضعیت «نامشخص» و جمله «بازه روی برگه نیست» نشان داده می‌شوند، نه با مقایسه حدسی.
- برگه PDF اسکن‌شده یا عکس‌گرفته‌شده متن ندارد؛ اگر متن PDF خوانا نباشد، خطای واضح می‌گیرید و باید عکس واضح برگه را بفرستید.
- عکس در مرورگر هم پیش‌پردازش می‌شود: تا ۲۴۰۰ پیکسل با جزئیات کامل و کنتراست ملایم ارسال می‌شود تا چاپ کوچک برگه خوانا بماند.

### چرا جمله و برچسب نمی‌توانند با هم تناقض داشته باشند؟

در نسخه قبلی، مدل جمله توضیح را می‌نوشت و کد فقط برچسب را عوض می‌کرد؛ برای همین کلسترول ۲۱۰ با بازه ۰ تا ۲۰۰ برچسب «بالاتر از محدوده» داشت ولی جمله‌اش می‌گفت «در محدوده است». در این نسخه برچسب و جمله هر دو از یک متغیر وضعیت ساخته می‌شوند:

> کلسترول نوعی چربی خون است. مقدار 210 بالاتر از بازه 0 تا 200 روی برگه است.

## ساختار

```
src/
  index.ts       # فقط روت /api/analyze — فایل‌های استاتیک از public سرو می‌شوند
  analyze.ts     # اعتبارسنجی فایل، مسیر PDF قطعی، خط لوله چندمرحله‌ای Workers AI
  pdfparse.ts    # استخراج متن PDF با unpdf + پارس قطعی جدول آزمایش
  validation.ts  # نرمال‌سازی اعداد، پارس بازه، وضعیت قطعی، grounding، جمله قالب، اعتبارسنجی Zod
  names.ts       # اسم‌های فارسی استاندارد + جمله عمومی هر آزمایش (~۹۰ آزمایش)
  prompt.ts      # پرامپت سیستم و اسکیمای JSON + پرامپت‌های مرحله‌های مختلف
  types.ts       # تایپ‌ها و ثابت‌ها (مدل‌ها، بخش‌ها)
public/
  index.html  style.css  app.js  sample.json
tests/
  validation.test.ts  names.test.ts  pdfparse.test.ts  analyze.test.ts
```

## اجرا

```bash
npm install
npm run dev        # wrangler dev — http://localhost:8787
npm run typecheck
npm test
```

## دیپلوی

```bash
npx wrangler login
npm run deploy
```

اتصال AI با نام `AI` در `wrangler.toml` تعریف شده و موقع دیپلوی خودکار ساخته می‌شود. فایل‌های استاتیک از `public/` سرو می‌شوند.

> توجه: فایل `.github/workflows/ci.yml` را باید خودتان در گیت‌هاب بگذارید؛ اپ گیت‌هاب نمی‌تواند فایل ورک‌فلو پوش کند.

## حریم خصوصی

- فایل فقط برای پردازش استفاده می‌شود و به‌صورت دائمی ذخیره نمی‌شود.
- نام بیمار، کد ملی، شماره پرونده و تاریخ تولد از خلاصه حذف می‌شوند.

---

# English

Upload a blood test sheet (PDF or photo) and get each result explained in simple Persian — using only the numbers printed on that sheet. No diagnosis, no treatment advice.

> These explanations are for general information only and do not replace a doctor's opinion.

## How it works

1. Upload a PDF or image (JPG, PNG, WEBP, max 10 MB).
2. **Text PDFs need no AI at all:** the text layer is extracted in the Worker with `unpdf` and the table is parsed by code; a complete table costs zero AI calls. Scanned PDFs (no text layer) are read with `AI.toMarkdown`.
3. **Photos go through several strategies in sequence** until the reference ranges are read (each step runs only if the previous one left ranges missing; max 8 AI calls): full extraction → ranges-only retry → one section at a time → range-column-only → verbatim transcription + structuring → deterministic re-read (temperature 0) → alternate vision model → Jimp-enhanced image. Each step only fills missing ranges/units; values are never overwritten.
4. The model (`@cf/meta/llama-4-scout-17b-16e-instruct`, `guided_json`) only extracts: name, abbreviation, value, unit, reference range and (only for unknown tests) a one-sentence definition. Its JSON is validated with Zod.
5. Everything else is deterministic code, not the model:
   - Persian/Arabic digits are normalized to Latin.
   - Every value and range must appear verbatim in the source text, otherwise it becomes "unreadable".
   - The status (in range / above / below / unknown) is computed in code by comparing the number with the range.
   - The explanation sentence is built from a fixed template using that same validated status — the model's free sentence is never used.
5. The file is never stored permanently.

### Notes

- On many sheets the differential count (Neutrophil, Lymphocyte, Monocyte, Eosinophil) has no reference range; those show as "unknown" with "no range on the sheet", never a guessed comparison.
- A scanned or photographed PDF has no text; if the PDF text is unreadable you get a clear error and should send a clear photo of the sheet instead.

## Run

```bash
npm install
npm run dev        # wrangler dev — http://localhost:8787
npm run typecheck
npm test
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

The Workers AI binding (`AI`) is declared in `wrangler.toml`. Static files are served from `public/`.

---

## Me
[![Telegram](https://img.shields.io/badge/Telegram-erffan__hub-blue?style=for-the-badge&logo=telegram)](https://t.me/erffan_hub)
[![Twitter](https://img.shields.io/badge/Twitter-@Erffanhub__00-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Erffanhub_00)
[![Gist](https://img.shields.io/badge/Gist-Profile-000000?style=for-the-badge&logo=github)](https://gist.github.com/erffanhub-00)
[![Github](https://img.shields.io/badge/Github-Profile-000000?style=for-the-badge&logo=github)](https://github.com/erffanhub-00)
