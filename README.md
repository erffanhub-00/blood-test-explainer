# توضیح آزمایش خون — Blood Test Explainer

🇮🇷 **فارسی** | [🇬🇧 **English**](#english)

برگه آزمایش (PDF یا عکس) را ارسال کنید تا هر نتیجه به زبان ساده فارسی توضیح داده شود — فقط با اعداد روی همان برگه، بدون تشخیص و بدون توصیه درمانی.

> این توضیحات صرفاً برای آگاهی عمومی هستند و جایگزین نظر پزشک نیستند.

## امکانات

- **همه پنل‌های آزمایشگاهی:** خون‌شناسی، کبد، کلیه، چربی خون، دیابت، تیروئید، آهن، هورمون، التهاب و انعقاد — حدود ۸۰ آزمایش با توضیح فارسی اختصاصی؛ اگر آزمایشی در بانک نباشد، مدل فقط یک جمله تعریف می‌دهد.
- **توضیح باز و بسته‌شونده برای هر مورد:** اول می‌گوید آن آزمایش چیست، بعد عدد شما با بازه روی برگه، و اگر خارج از بازه باشد مقدار انحرافش هم گفته می‌شود. توضیح موردهای عادی بسته و موردهای خارج از بازه یا نامشخص باز است.
- **گروه‌بندی بر اساس پنل برگه** (هماتولوژی، بیوشیمی، کبد، کلیه و...) و خلاصه با چهار شمارش جدا: کل / داخل بازه / خارج از بازه / بدون بازه.
- **کاملا ریسپانسیو:** روی موبایل تک‌ستونه، بدون بیرون‌زدگی، دکمه‌ها حداقل ۴۴ پیکسل؛ نسخه چاپ هم خوانا است.
- **دکمه برگه نمونه** برای دیدن خروجی بدون آپلود فایل.

## چطور کار می‌کند

### ۱. PDF متنی: صفر تماس با هوش مصنوعی

متن PDF با `unpdf` در خود ورکر استخراج و جدول آن با کد پارس می‌شود. اگر جدول کامل باشد، **هیچ فراخوانی AI انجام نمی‌شود**. PDF اسکن‌شده (بدون لایه متن) با `AI.toMarkdown` خوانده می‌شود و اگر متن آن هم خوانا نباشد، خطای واضح می‌گیرید: «متن PDF خوانا نیست؛ عکس واضح برگه را بفرست.»

### ۲. عکس: خط لوله چندمرحله‌ای با مدیر مرحله

عکس با چند روش پردازش می‌شود تا بازه مرجع حتماً خوانده شود. مدیریت مرحله‌ها در `src/pipeline.ts` است — مرحله‌ها داده‌اند، نه چند `if` پراکنده:

| دور | مرحله | هزینه |
|---|---|---|
| ۱ | خواندن کامل + فقط ستون بازه (موازی) | ۲ تماس |
| ۲ | هر بخش جدا + بازخوانی قطعی دمای صفر (موازی) | تا ۳ تماس |
| ۳ | مدل بینایی جایگزین + رونویسی جدول (موازی) | تا ۳ تماس |
| ۴ | عکس بهبودیافته با Jimp (فقط JPEG/PNG) | ۱ تماس |

- **امتیاز کیفیت بعد از هر دور:** اگر مقدارها ۹۵٪ و بازه‌ها ۹۰٪ خوانده شده باشند، همان‌جا متوقف می‌شود و جواب برمی‌گردد. فقط وقتی ادامه می‌دهد که هنوز جا برای بهتر شدن باشد.
- **سقف زمانی ۱۲۰ ثانیه و سقف ۸ تماس** برای کل درخواست؛ اگر وقت رو به پایان باشد، بهترین نتیجه تا آن لحظه برگردانده می‌شود.
- **هر تماس سقف ۵۰ ثانیه دارد** و اگر گیر کرد، خط لوله با بقیه ادامه می‌دهد.
- **پیشرفت واقعی:** سرور مرحله جاری را با استریم (NDJSON) می‌فرستد و صفحه مرحله و ثانیه‌های گذشته را نشان می‌دهد؛ بدون درصد تقلبی.
- هر مرحله فقط بازه‌ها و واحدهای خالی را پر می‌کند؛ **مقدارها هرگز بازنویسی نمی‌شوند**.
- عکس قبل از ارسال در مرورگر پیش‌پردازش می‌شود (تا ۲۴۰۰ پیکسل با جزئیات کامل و کنتراست ملایم) و در سرور هم با Jimp واضح‌تر می‌شود (کنتراست، خاکستری، شارپ).

### ۳. مدل فقط استخراج می‌کند

مدل `@cf/meta/llama-4-scout-17b-16e-instruct` با `guided_json` فقط این‌ها را برمی‌گرداند: نام، مخفف، مقدار، واحد، بازه مرجع و (فقط برای آزمایش‌های ناشناخته) یک جمله تعریف. خروجی مدل با Zod اعتبارسنجی می‌شود. مدل‌های جایگزینِ تاییدشده در کاتالوگ Workers AI: `@cf/meta/llama-3.2-11b-vision-instruct` و `@cf/mistralai/mistral-small-3.1-24b-instruct`.

### ۴. بقیه کار دست کد است، نه مدل

- اعداد فارسی و عربی به انگلیسی تبدیل می‌شوند.
- هر مقدار و بازه باید عیناً در متن برگه پیدا شود، وگرنه «خوانا نیست» می‌شود.
- وضعیت (داخل بازه / بالاتر / پایین‌تر / نامشخص) را کد، با مقایسه عدد و بازه، حساب می‌کند.
- جمله توضیح از یک قالب ثابت و با همان وضعیت تاییدشده ساخته می‌شود؛ جمله آزاد مدل هرگز استفاده نمی‌شود.
- توضیح هر آزمایش اول از دیکشنری داخلی می‌آید، بعد از تعریف مدل، و فقط در آخر جمله کلی.

### چرا جمله و برچسب نمی‌توانند با هم تناقض داشته باشند؟

در نسخه قبلی، مدل جمله توضیح را می‌نوشت و کد فقط برچسب را عوض می‌کرد؛ برای همین کلسترول ۲۱۰ با بازه ۰ تا ۲۰۰ برچسب «بالاتر از محدوده» داشت ولی جمله‌اش می‌گفت «در محدوده است». در این نسخه برچسب و جمله هر دو از یک متغیر وضعیت ساخته می‌شوند:

> کلسترول نوعی چربی خون است. مقدار 210 بالاتر از بازه 0 تا 200 روی برگه است.

### نکته‌ها

- در بسیاری از برگه‌ها، شمارش افتراقی (نوتروفیل، لنفوسیت، مونوسیت، ائوزینوفیل) بازه مرجع ندارد؛ این موارد با وضعیت «نامشخص» و جمله «بازه روی برگه نیست» نشان داده می‌شوند، نه با مقایسه حدسی.
- بازه فقط همان است که روی برگه چاپ شده؛ اگر بازه‌ای روی برگه نیست، چیزی حدس زده نمی‌شود.

## ساختار

```
src/
  index.ts       # فقط روت /api/analyze — فایل‌های استاتیک از public سرو می‌شوند
  analyze.ts     # اعتبارسنجی فایل، مسیر PDF قطعی، اجرای دورهای خط لوله، استریم پیشرفت
  pipeline.ts    # مدیر مرحله‌ها: امتیاز کیفیت، تصمیم توقف/ادامه، بودجه زمانی و تماس
  pdfparse.ts    # استخراج متن PDF با unpdf + پارس قطعی جدول آزمایش
  validation.ts  # نرمال‌سازی اعداد، پارس بازه، وضعیت قطعی، grounding، جمله قالب، اعتبارسنجی Zod
  names.ts       # اسم‌های فارسی استاندارد + جمله عمومی هر آزمایش (~۸۰ آزمایش) + ست تفکیکی
  prompt.ts      # پرامپت سیستم و اسکیمای JSON + پرامپت‌های مرحله‌های مختلف
  types.ts       # تایپ‌ها و ثابت‌ها (مدل‌ها، بخش‌ها، سقف‌ها)
public/
  index.html  style.css  app.js  sample.json
tests/
  validation.test.ts  names.test.ts  pdfparse.test.ts
  analyze.test.ts  pipeline.test.ts  make-pdf.ts
```

## اجرا

```bash
npm install
npm run dev        # wrangler dev — http://localhost:8787
npm run typecheck
npm test           # 60 تست
```

## دیپلوی

```bash
npx wrangler login
npm ci             # بعد از هر پول که وابستگی جدید دارد
npm run deploy
```

اتصال AI با نام `AI` در `wrangler.toml` تعریف شده و موقع دیپلوی خودکار ساخته می‌شود. فایل‌های استاتیک از `public/` سرو می‌شوند.

> توجه: فایل `.github/workflows/ci.yml` را باید خودتان در گیت‌هاب بگذارید؛ اپ گیت‌هاب نمی‌تواند فایل ورک‌فلو پوش کند.

## حریم خصوصی

- فایل فقط برای پردازش استفاده می‌شود و به‌صورت دائمی ذخیره نمی‌شود.
- نام بیمار، کد ملی، شماره پرونده و تاریخ تولد از خلاصه حذف می‌شوند.
- هیچ فایلی در گیت‌هاب یا جای دیگر منتشر نمی‌شود؛ نمونه داخلی (`sample.json`) داده ساختگی است.

---

# English

Upload a lab sheet (PDF or photo) and get each result explained in simple Persian — using only the numbers printed on that sheet. No diagnosis, no treatment advice.

> These explanations are for general information only and do not replace a doctor's opinion.

## Features

- **Every lab panel:** hematology, liver, kidney, lipids, diabetes, thyroid, iron, hormones, inflammation and coagulation — about 80 tests with their own Persian explanation; for a test not in the dictionary, the model only supplies a one-sentence definition.
- **Expandable explanation per test:** first what the test is, then your value against the sheet's range, plus the deviation amount when out of range. Normal tests start collapsed, out-of-range and unknown ones start open.
- **Grouped by the sheet's own panels**, with a summary of four separate counts: total / in range / out of range / no range.
- **Fully responsive:** single column on mobile, no overflow, tap targets at least 44px; print stylesheet included.
- **Sample sheet button** to see the output without uploading a file.

## How it works

### 1. Text PDF: zero AI calls

The PDF text layer is extracted in the Worker with `unpdf` and the table is parsed by code. A complete table costs **zero AI calls**. Scanned PDFs (no text layer) are read with `AI.toMarkdown`; if the text is still unreadable you get a clear error asking for a clear photo instead.

### 2. Photo: multi-strategy pipeline with a stage manager

Photos go through several strategies until the reference ranges are read. Stage management lives in `src/pipeline.ts` — stages are data, not scattered `if`s:

| Round | Stage | Cost |
|---|---|---|
| 1 | Full extraction + range-column-only (parallel) | 2 calls |
| 2 | One section at a time + deterministic re-read at temperature 0 (parallel) | up to 3 calls |
| 3 | Alternate vision model + table transcription (parallel) | up to 3 calls |
| 4 | Jimp-enhanced image (JPEG/PNG only) | 1 call |

- **Quality score after each round:** if 95% of values and 90% of ranges are read, it stops and returns the answer. It only continues when there is still room to improve.
- **120-second time budget and 8-call cap** per request; when time runs low, the best result so far is returned.
- **50-second cap per call** — a stuck call is skipped and the pipeline continues with the rest.
- **Real progress:** the server streams the current stage (NDJSON) and the page shows the stage and elapsed seconds; no fake percentages.
- Each stage only fills missing ranges/units; **values are never overwritten**.
- Photos are pre-processed in the browser before upload (up to 2400px, mild contrast) and enhanced again on the server with Jimp (contrast, greyscale, sharpen).

### 3. The model only extracts

The model (`@cf/meta/llama-4-scout-17b-16e-instruct`, `guided_json`) returns only: name, abbreviation, value, unit, reference range and (only for unknown tests) a one-sentence definition. Its JSON is validated with Zod. Verified fallback models in the Workers AI catalog: `@cf/meta/llama-3.2-11b-vision-instruct` and `@cf/mistralai/mistral-small-3.1-24b-instruct`.

### 4. Everything else is deterministic code, not the model

- Persian/Arabic digits are normalized to Latin.
- Every value and range must appear verbatim in the source text, otherwise it becomes "unreadable".
- The status (in range / above / below / unknown) is computed in code by comparing the number with the range.
- The explanation sentence is built from a fixed template using that same validated status — the model's free sentence is never used.
- Each test's explanation comes from the built-in dictionary first, then the model's definition, and only last the generic sentence.

### Notes

- On many sheets the differential count (Neutrophil, Lymphocyte, Monocyte, Eosinophil) has no reference range; those show as "unknown" with "no range on the sheet", never a guessed comparison.
- The range is only the one printed on the sheet; when a sheet has no range, nothing is invented.

## Run

```bash
npm install
npm run dev        # wrangler dev — http://localhost:8787
npm run typecheck
npm test           # 60 tests
```

## Deploy

```bash
npx wrangler login
npm ci             # after any pull that adds a dependency
npm run deploy
```

The Workers AI binding (`AI`) is declared in `wrangler.toml`. Static files are served from `public/`.

## Privacy

- Files are used only for processing and are never stored permanently.
- Patient name, national ID, file number and date of birth are stripped from the summary.
- No file is published anywhere; the built-in sample (`sample.json`) is synthetic data.

---

## Me
[![Telegram](https://img.shields.io/badge/Telegram-erffan__hub-blue?style=for-the-badge&logo=telegram)](https://t.me/erffan_hub)
[![Twitter](https://img.shields.io/badge/Twitter-@Erffanhub__00-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Erffanhub_00)
[![Gist](https://img.shields.io/badge/Gist-Profile-000000?style=for-the-badge&logo=github)](https://gist.github.com/erffanhub-00)
[![Github](https://img.shields.io/badge/Github-Profile-000000?style=for-the-badge&logo=github)](https://github.com/erffanhub-00)
