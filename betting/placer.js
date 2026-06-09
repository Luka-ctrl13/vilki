// Bet placer — places one leg of a fork by driving YOUR logged-in browser.
//
//  * PAPER (default): simulates a fill at the detected odd. No browser, no money.
//  * REAL: opens a persistent profile per bookmaker (you log in once, the session
//    is reused), navigates to the event, clicks the outcome, types the stake,
//    re-checks the odd, and confirms.
//
// Calibration: the click flow uses text/label heuristics that work on the
// Russian-language Olimp / 1xBet bet slips out of the box, but selectors can be
// overridden without touching code via betting/calibration.json (generate it
// with `npm run calibrate` — see README). Two safety gates:
//   * REAL never confirms unless BETTING_CONFIRM=1 — otherwise it ARMS the bet
//     (selects outcome + fills stake) and stops, so you can watch it pick the
//     right thing before trusting it with money.
//   * Before confirming it re-reads the slip odd and aborts if it dropped more
//     than BETTING_MAX_SLIPPAGE (default 3%).

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const CONFIRM = process.env.BETTING_CONFIRM === "1";
const MAX_SLIPPAGE = Number(process.env.BETTING_MAX_SLIPPAGE || 0.03);

// Default per-book recipe. Overridable via betting/calibration.json.
const DEFAULTS = {
  "1xBet": {
    profile: process.env.ONEXBET_PROFILE || "./.profile-1xbet",
    // Visible text on the place-bet button (first match wins).
    placeButtonText: ["Заключить пари", "Сделать ставку", "Поставить"],
    // CSS for the stake input in the coupon (optional — falls back to heuristic).
    stakeInput: null,
    // Text that appears after a successful bet.
    successText: ["Ставка принята", "Пари заключено", "успешно"],
  },
  Olimp: {
    profile: process.env.OLIMP_PROFILE || "./.profile-olimp",
    placeButtonText: ["Поставить", "Заключить пари", "Сделать ставку"],
    stakeInput: null,
    successText: ["Ставка принята", "успешно", "Пари заключено"],
  },
};

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const file = path.join(__dirname, "calibration.json");
  try {
    if (fs.existsSync(file)) {
      const over = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const book of Object.keys(over)) cfg[book] = { ...cfg[book], ...over[book] };
    }
  } catch (e) {
    console.warn("calibration.json invalid:", e.message);
  }
  return cfg;
}

// ---- pure helpers (unit-tested) ---- //

// Accepted odd must not have dropped below expected by more than maxSlip.
function slippageOk(expected, actual, maxSlip = MAX_SLIPPAGE) {
  if (!(actual > 1)) return false;
  return actual >= expected * (1 - maxSlip);
}

// Pick the first wanted label present among the buttons found on the page.
function pickButtonLabel(found, wanted) {
  const norm = (s) => (s || "").toLowerCase().trim();
  for (const w of wanted) {
    const hit = found.find((f) => norm(f).includes(norm(w)));
    if (hit) return hit;
  }
  return null;
}

class Placer {
  constructor() {
    this.config = loadConfig();
    this._sessions = {}; // book -> { browser, page }
  }

  status() {
    return {
      confirm: CONFIRM,
      maxSlippage: MAX_SLIPPAGE,
      books: Object.fromEntries(
        Object.entries(this.config).map(([b, c]) => [b, { profile: c.profile }])
      ),
    };
  }

  async place(leg, mode) {
    if (mode !== "real") return { ok: true, acceptedOdd: leg.odd, message: "paper fill" };
    return this._placeReal(leg);
  }

  async _placeReal(leg) {
    const cfg = this.config[leg.book];
    if (!cfg) return fail(`нет конфига для ${leg.book}`);
    try {
      const { page } = await this._session(leg.book, cfg);
      return await this._run(page, leg, cfg);
    } catch (e) {
      return fail(`ошибка проставления: ${e.message}`);
    }
  }

  async _session(book, cfg) {
    let s = this._sessions[book];
    if (s && s.browser.isConnected() && !s.page.isClosed()) return s;
    const browser = await puppeteer.launch({
      headless: process.env.HEADLESS === "new" ? "new" : false,
      userDataDir: cfg.profile,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ru-RU,ru"],
    });
    const page = (await browser.pages())[0] || (await browser.newPage());
    s = { browser, page };
    this._sessions[book] = s;
    return s;
  }

  async _run(page, leg, cfg) {
    await page.goto(leg.link, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    // 1) Click the outcome (the odd cell). Match by exact odd value, narrowed to
    //    the right line when present in the same row.
    const picked = await page.evaluate(clickOutcomeInPage, { odd: leg.odd, line: leg.line });
    if (!picked.ok) return fail(`не нашёл исход (${leg.outcome} @${leg.odd}): ${picked.reason}`);
    await sleep(1200);

    // 2) Enter the stake into the coupon.
    const staked = await page.evaluate(enterStakeInPage, { stake: leg.stake, selector: cfg.stakeInput });
    if (!staked.ok) return fail(`не смог ввести сумму: ${staked.reason}`);
    await sleep(500);

    // 3) Re-read the slip odd and check slippage before committing.
    const slipOdd = await page.evaluate(readSlipOddInPage);
    if (slipOdd && !slippageOk(leg.odd, slipOdd)) {
      return fail(`кэф упал ${leg.odd} → ${slipOdd} (>${MAX_SLIPPAGE * 100}%), ставку отменил`);
    }

    // 4) Confirm — only if explicitly enabled.
    if (!CONFIRM) {
      return {
        ok: false,
        acceptedOdd: slipOdd || leg.odd,
        message: "ARMED: исход выбран, сумма введена, подтверждение выключено (BETTING_CONFIRM=1)",
      };
    }
    const labels = await page.evaluate(listButtonsInPage);
    const label = pickButtonLabel(labels, cfg.placeButtonText);
    if (!label) return fail(`не нашёл кнопку ставки (искал: ${cfg.placeButtonText.join(", ")})`);
    const confirmed = await page.evaluate(clickButtonByTextInPage, label);
    if (!confirmed) return fail("клик по кнопке ставки не сработал");
    await sleep(2000);

    const success = await page.evaluate(checkSuccessInPage, cfg.successText);
    return success
      ? { ok: true, acceptedOdd: slipOdd || leg.odd, message: "ставка принята" }
      : fail("подтверждение не обнаружено — проверьте вручную");
  }
}

function fail(message) {
  return { ok: false, acceptedOdd: null, message };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- functions executed inside the page (browser context) ---- //
// Kept as plain functions so they serialize cleanly to page.evaluate.

function clickOutcomeInPage({ odd, line }) {
  const target = String(odd);
  const leaves = Array.from(document.querySelectorAll("*")).filter(
    (el) => el.children.length === 0 && (el.innerText || "").trim() === target
  );
  if (!leaves.length) return { ok: false, reason: "ячейка с кэфом не найдена" };
  // Prefer a cell whose surrounding row also mentions the line.
  let pick = leaves[0];
  if (line !== undefined && line !== null) {
    const ls = String(line);
    const better = leaves.find((el) => {
      let r = el;
      for (let i = 0; i < 4 && r; i++) r = r.parentElement;
      return r && (r.innerText || "").includes(ls);
    });
    if (better) pick = better;
  }
  const clickable = pick.closest("button,a,[role=button],div") || pick;
  clickable.click();
  return { ok: true };
}

function enterStakeInPage({ stake, selector }) {
  let input = selector ? document.querySelector(selector) : null;
  if (!input) {
    const inputs = Array.from(document.querySelectorAll("input")).filter((i) => {
      const st = getComputedStyle(i);
      return st.display !== "none" && st.visibility !== "hidden" && !i.disabled && i.offsetParent;
    });
    // Prefer inputs hinting at a stake/amount; else the last visible one (coupon).
    input =
      inputs.find((i) =>
        /сумм|ставк|amount|stake/i.test((i.placeholder || "") + (i.name || "") + (i.getAttribute("aria-label") || ""))
      ) ||
      inputs.find((i) => i.type === "number" || i.inputMode === "decimal" || i.inputMode === "numeric") ||
      inputs[inputs.length - 1];
  }
  if (!input) return { ok: false, reason: "поле суммы не найдено" };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, String(stake));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

function readSlipOddInPage() {
  // Look for a number that looks like an odd (x.xx) inside the coupon area.
  const txt = document.body.innerText || "";
  const m = txt.match(/\b\d{1,2}\.\d{2}\b/g);
  return m ? parseFloat(m[0]) : null;
}

function listButtonsInPage() {
  return Array.from(document.querySelectorAll("button,[role=button],a"))
    .filter((b) => b.offsetParent)
    .map((b) => (b.innerText || "").trim())
    .filter(Boolean);
}

function clickButtonByTextInPage(label) {
  const norm = (s) => (s || "").toLowerCase().trim();
  const btn = Array.from(document.querySelectorAll("button,[role=button],a")).find(
    (b) => b.offsetParent && norm(b.innerText).includes(norm(label))
  );
  if (!btn) return false;
  btn.click();
  return true;
}

function checkSuccessInPage(successText) {
  const txt = (document.body.innerText || "").toLowerCase();
  return successText.some((s) => txt.includes(String(s).toLowerCase()));
}

module.exports = { Placer, slippageOk, pickButtonLabel, loadConfig, DEFAULTS };
