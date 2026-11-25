const form = document.getElementById("form");
const fileInput = document.getElementById("file");
const submitButton = document.getElementById("submit");
const sampleButton = document.getElementById("sampleBtn");
const message = document.getElementById("message");
const results = document.getElementById("results");
const uploadBox = document.getElementById("uploadBox");
const filenameBox = document.getElementById("filenameBox");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressPercent = document.getElementById("progressPercent");
const progressStepName = document.getElementById("progressStepName");

const ALLOWED_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_DIM = 1200;
const JPEG_QUALITY = 0.78;

const STATUS_LABELS = {
  normal: "✓ در محدوده برگه",
  low: "↓ پایین‌تر از بازه برگه",
  high: "↑ بالاتر از بازه برگه",
  unknown: "؟ نامشخص",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setProgress(percent, label) {
  progressWrap.classList.add("show");
  progressFill.style.width = Math.round(percent) + "%";
  progressPercent.textContent = Math.round(percent) + "%";
  progressStepName.textContent = label;
}

function hideProgress() {
  progressWrap.classList.remove("show");
  progressFill.style.width = "0%";
  progressPercent.textContent = "0%";
}

function setMessage(text, type) {
  message.className = "show " + (type || "info");
  message.textContent = text;
}

function clearMessage() {
  message.className = "";
  message.textContent = "";
}

function showError(text, requestId) {
  setMessage(text + (requestId ? " (شناسه پیگیری: " + requestId + ")" : ""), "error");
}

async function compressImage(file) {
  if (!file.type.startsWith("image/") || file.size < 400 * 1024) return file;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) return resolve(file);
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }));
      }, "image/jpeg", JPEG_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

function validateFile(file) {
  if (!file) return "لطفاً فایل را انتخاب کنید.";
  if (file.size > MAX_SIZE) return "حجم فایل نباید بیشتر از ۱۰ مگابایت باشد.";
  const name = file.name.toLowerCase();
  if (name.endsWith(".heic") || name.endsWith(".heif")) {
    return "فرمت HEIC پشتیبانی نمی‌شود. لطفاً عکس را به JPG تبدیل کنید.";
  }
  if (!ALLOWED_EXT.some((ext) => name.endsWith(ext))) {
    return "فقط PDF یا عکس (JPG, PNG, WEBP) مجاز است.";
  }
  return null;
}

/** Real upload progress from XMLHttpRequest — no fake timer. */
function upload(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/analyze");
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) setProgress((e.loaded / e.total) * 90, "ارسال فایل…");
    });
    xhr.addEventListener("load", () => {
      setProgress(95, "تحلیل با هوش مصنوعی…");
      resolve({ status: xhr.status, data: xhr.response });
    });
    xhr.addEventListener("error", () => reject(new Error("ارسال فایل ناموفق بود.")));
    xhr.send(formData);
  });
}

function testCard(test) {
  const status = STATUS_LABELS[test.status] ? test.status : "unknown";
  const card = el("article", "test " + status);
  const header = el("div", "test-header");
  const title = el("h3", "test-title");
  title.appendChild(document.createTextNode(test.name));
  if (test.abbr) title.appendChild(el("span", "abbr", "(" + test.abbr + ")"));
  header.appendChild(title);
  header.appendChild(el("span", "badge " + status, STATUS_LABELS[status]));
  card.appendChild(header);

  const grid = el("div", "values-grid");
  const addField = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    const cell = el("div", "cell");
    cell.appendChild(el("span", "lbl", label));
    cell.appendChild(el("span", "val", value));
    grid.appendChild(cell);
  };
  addField("مقدار", test.value);
  addField("واحد", test.unit);
  addField("بازه مرجع", test.reference_range);
  if (grid.children.length) card.appendChild(grid);
  if (test.explanation) {
    const d = el("details", "test-explanation");
    d.open = status !== "normal";
    const s = el("summary", "", status === "normal" ? "توضیح بیشتر" : "توضیح");
    s.setAttribute("aria-expanded", String(d.open));
    d.addEventListener("toggle", () => s.setAttribute("aria-expanded", String(d.open)));
    d.append(s, el("p", "", test.explanation));
    card.appendChild(d);
  }
  return card;
}

function renderResult(data) {
  const tests = data.tests || [];
  const normal = tests.filter((t) => t.status === "normal").length;
  const abnormal = tests.filter((t) => t.status === "low" || t.status === "high").length;
  const unknown = tests.filter((t) => t.status === "unknown").length;

  document.getElementById("countPill").textContent = tests.length + " مورد";
  const statsBar = document.getElementById("statsBar");
  statsBar.replaceChildren();
  const addStat = (num, label, cls) => {
    const s = el("div", "stat " + (cls || ""));
    s.appendChild(el("div", "num", String(num)));
    s.appendChild(el("div", "lbl", label));
    statsBar.appendChild(s);
  };
  addStat(tests.length, "کل موارد", "");
  addStat(normal, "داخل بازه", "ok");
  addStat(abnormal, "خارج از بازه", abnormal > 0 ? "danger" : "");
  addStat(unknown, "بدون بازه", unknown > 0 ? "warn" : "");

  document.getElementById("summary").textContent = data.summary || "خلاصه‌ای ارائه نشد.";

  const container = document.getElementById("tests");
  container.replaceChildren();
  const sections = [
    ["hematology", "هماتولوژی"],
    ["biochemistry", "بیوشیمی"],
    ["other", "سایر"],
  ];
  for (const [key, title] of sections) {
    const group = tests.filter((t) => (t.section || "other") === key);
    if (!group.length) continue;
    container.appendChild(el("h3", "section-title", title));
    for (const test of group) container.appendChild(testCard(test));
  }

  const limBox = document.getElementById("limitations");
  limBox.replaceChildren();
  if (Array.isArray(data.limitations) && data.limitations.length) {
    const box = el("div", "limitations-box");
    box.appendChild(el("h3", "", "⚠️ موارد نامشخص یا محدودیت‌ها"));
    const list = el("ul", "");
    for (const item of data.limitations) list.appendChild(el("li", "", item));
    box.appendChild(list);
    limBox.appendChild(box);
  }

  document.getElementById("disclaimer").textContent = data.disclaimer || "";
  setProgress(100, "آماده شد");
  setTimeout(hideProgress, 400);
  results.classList.remove("hidden");
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function copySummary(data) {
  const lines = (data.tests || []).map((t) => {
    const range = t.reference_range ? " (بازه " + t.reference_range + ")" : " (بازه روی برگه نیست)";
    return `${t.name}: ${t.value ?? "خوانا نیست"} ${t.unit ?? ""}${range} — ${STATUS_LABELS[t.status] || "نامشخص"}`;
  });
  return (data.summary || "") + "\n" + lines.join("\n");
}

let lastResult = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  results.classList.add("hidden");
  clearMessage();
  hideProgress();

  let file = fileInput.files[0];
  const validationError = validateFile(file);
  if (validationError) return showError(validationError);
  submitButton.disabled = true;
  setProgress(0, "آماده‌سازی…");
  setMessage("فایل در حال پردازش است؛ لطفاً صبر کنید.", "info");

  try {
    file = await compressImage(file);
    const formData = new FormData();
    formData.append("file", file, file.name);
    const { status, data } = await upload(formData);
    if (status !== 200) throw { message: (data && data.error) || "پردازش ناموفق بود.", requestId: data && data.requestId };
    lastResult = data;
    renderResult(data);
    setMessage("بررسی فایل با موفقیت انجام شد.", "success");
  } catch (err) {
    hideProgress();
    showError(err?.message || "خطایی رخ داد. دوباره تلاش کنید.", err?.requestId);
  } finally {
    submitButton.disabled = false;
  }
});

sampleButton.addEventListener("click", async () => {
  results.classList.add("hidden");
  clearMessage();
  try {
    // sample.json is the processed output of src/validation processTests
    // (verified by tests/validation.test.ts) — rendered by the same
    // renderResult() as a real /api/analyze response.
    const res = await fetch("sample.json");
    const data = await res.json();
    lastResult = data;
    setProgress(100, "آماده شد");
    renderResult(data);
    setMessage("این برگه نمونه است — بدون ارسال به سرور.", "success");
  } catch {
    showError("بارگذاری برگه نمونه ناموفق بود.");
  }
});

document.getElementById("copyBtn").addEventListener("click", async (e) => {
  if (!lastResult) return;
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(copySummary(lastResult));
    btn.textContent = "✓ کپی شد";
    setTimeout(() => { btn.textContent = "کپی خلاصه"; }, 1800);
  } catch {
    btn.textContent = "کپی نشد";
  }
});

document.getElementById("printBtn").addEventListener("click", () => window.print());

fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  if (f) {
    filenameBox.textContent = f.name + "  (" + (f.size / 1024).toFixed(0) + " KB)";
    filenameBox.classList.add("show");
  } else {
    filenameBox.classList.remove("show");
  }
});

for (const ev of ["dragenter", "dragover", "dragleave", "drop"]) {
  uploadBox.addEventListener(ev, (e) => {
    e.preventDefault();
    uploadBox.classList.toggle("drag-over", ev === "dragenter" || ev === "dragover");
  });
}
uploadBox.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) {
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change"));
  }
});
