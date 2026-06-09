// Interactive calibration helper for real bet placement.
//
// Run locally (you must be able to reach the bookmaker and log in):
//   node betting/calibrate.js 1xBet
//   node betting/calibrate.js Olimp
//
// It opens the book in the SAME persistent profile the placer uses, so after you
// log in once the session is reused. Then:
//   1. log in,
//   2. open any live event and click an odd so the BET SLIP (coupon) is visible,
//   3. switch back to this terminal and press Enter.
// It inspects the page, picks the stake input and place button, and writes
// betting/calibration.json. Review the printed result and adjust if needed.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const BOOKS = {
  "1xBet": { base: process.env.ONEXBET_BASE_URL || "https://1xbet.kz", live: "/ru/live",
    profile: process.env.ONEXBET_PROFILE || "./.profile-1xbet" },
  Olimp: { base: process.env.OLIMP_BASE_URL || "https://olimpbet.kz", live: "/live",
    profile: process.env.OLIMP_PROFILE || "./.profile-olimp" },
};

const book = process.argv[2];
if (!BOOKS[book]) {
  console.error("Использование: node betting/calibrate.js <1xBet|Olimp>");
  process.exit(1);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

(async () => {
  const cfg = BOOKS[book];
  console.log(`\nОткрываю ${book}. Залогинься, открой live-событие и КЛИКНИ кэф,`);
  console.log("чтобы появился купон (бет-слип). Потом вернись сюда.\n");

  const browser = await puppeteer.launch({
    headless: false, userDataDir: cfg.profile,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ru-RU,ru"],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try { await page.goto(cfg.base + cfg.live, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {}

  await ask("Купон открыт? Нажми Enter для анализа страницы… ");

  const found = await page.evaluate(() => {
    function cssPath(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      while (el && el.nodeType === 1 && parts.length < 5) {
        let sel = el.nodeName.toLowerCase();
        if (el.className && typeof el.className === "string") {
          const c = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((x) => "." + CSS.escape(x)).join("");
          sel += c;
        }
        const parent = el.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((n) => n.nodeName === el.nodeName);
          if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(el) + 1})`;
        }
        parts.unshift(sel);
        el = el.parentElement;
      }
      return parts.join(" > ");
    }
    const vis = (el) => {
      const s = getComputedStyle(el);
      return el.offsetParent && s.display !== "none" && s.visibility !== "hidden";
    };
    const inputs = Array.from(document.querySelectorAll("input")).filter(vis).map((i) => ({
      selector: cssPath(i), type: i.type, inputMode: i.inputMode,
      placeholder: i.placeholder, name: i.name, ariaLabel: i.getAttribute("aria-label"),
    }));
    const buttons = Array.from(document.querySelectorAll("button,[role=button],a")).filter(vis)
      .map((b) => (b.innerText || "").trim()).filter((t) => t && t.length < 40);
    return { inputs, buttons: [...new Set(buttons)] };
  });

  console.log("\n--- Поля ввода (кандидаты на сумму ставки) ---");
  found.inputs.forEach((i, n) => console.log(`  [${n}] ${i.selector}  (type=${i.type}, ph="${i.placeholder || ""}")`));
  console.log("\n--- Кнопки (кандидаты на 'Поставить') ---");
  found.buttons.forEach((b, n) => console.log(`  [${n}] ${b}`));

  const stakeIdx = await ask("\nНомер поля СУММЫ (Enter — авто): ");
  const btnIdx = await ask("Номер кнопки ПОСТАВИТЬ (Enter — авто по тексту): ");

  const out = {};
  const stakeInput = found.inputs[Number(stakeIdx)] ? found.inputs[Number(stakeIdx)].selector : null;
  const placeButtonText = found.buttons[Number(btnIdx)]
    ? [found.buttons[Number(btnIdx)]]
    : ["Заключить пари", "Сделать ставку", "Поставить"];
  out[book] = { stakeInput, placeButtonText };

  const file = path.join(__dirname, "calibration.json");
  let merged = {};
  try { if (fs.existsSync(file)) merged = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  merged[book] = out[book];
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Записал betting/calibration.json:\n${JSON.stringify(out, null, 2)}`);
  console.log("\nТеперь проверь в paper/ARMED режиме: BETTING_MODE=real (без BETTING_CONFIRM)");
  console.log("сначала посмотри, что выбирается верно; затем BETTING_CONFIRM=1 для реальной ставки.\n");
  await ask("Enter — закрыть браузер… ");
  await browser.close();
})();
