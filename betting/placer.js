// Bet placer. Turns one leg of a fork into a fill.
//
//  * PAPER (default): simulates a fill at the detected odd. No browser, no money.
//  * REAL: clicks the bet in YOUR logged-in browser. It opens a persistent
//    profile per bookmaker (you log in once, the session is reused), navigates to
//    the event, selects the outcome, types the stake and confirms.
//
// Because every bookmaker's bet-slip DOM differs and live layouts change, the
// click selectors live in SELECTORS below and must be calibrated once against
// your real pages. Until a book is marked `calibrated`, REAL placement refuses
// (returns ok:false) so it can never misfire blindly with real money.

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// Per-bookmaker click recipe. Fill these in from your logged-in pages, then flip
// `calibrated: true`. Selectors are examples/placeholders — verify in DevTools.
const SELECTORS = {
  "1xBet": {
    calibrated: false,
    profile: process.env.ONEXBET_PROFILE || "./.profile-1xbet",
    base: process.env.ONEXBET_BASE_URL || "https://1xbet.kz",
    // function(page, leg) => clicks the right odd cell. Implement against real DOM.
  },
  Olimp: {
    calibrated: false,
    profile: process.env.OLIMP_PROFILE || "./.profile-olimp",
    base: process.env.OLIMP_BASE_URL || "https://olimpbet.kz",
  },
};

class Placer {
  constructor() {
    this._browsers = {}; // book -> { browser, page }
  }

  status() {
    return {
      books: Object.fromEntries(
        Object.entries(SELECTORS).map(([b, c]) => [b, { calibrated: c.calibrated }])
      ),
    };
  }

  async place(leg, mode) {
    if (mode !== "real") {
      // Paper fill at the detected odd.
      return { ok: true, acceptedOdd: leg.odd, message: "paper fill" };
    }
    return this._placeReal(leg);
  }

  async _placeReal(leg) {
    const cfg = SELECTORS[leg.book];
    if (!cfg) return { ok: false, acceptedOdd: null, message: `нет конфига для ${leg.book}` };
    if (!cfg.calibrated)
      return {
        ok: false,
        acceptedOdd: null,
        message: `${leg.book}: селекторы не откалиброваны — поставьте calibrated:true в betting/placer.js и реализуйте клики`,
      };
    try {
      const { page } = await this._session(leg.book, cfg);
      return await this._clickBet(page, leg, cfg);
    } catch (e) {
      return { ok: false, acceptedOdd: null, message: `ошибка проставления: ${e.message}` };
    }
  }

  // Persistent logged-in session per book (operator logs in on first run).
  async _session(book, cfg) {
    let s = this._browsers[book];
    if (s && s.browser.isConnected() && !s.page.isClosed()) return s;
    const browser = await puppeteer.launch({
      headless: process.env.HEADLESS === "new" ? "new" : false,
      userDataDir: cfg.profile,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ru-RU,ru"],
    });
    const page = await browser.newPage();
    s = { browser, page };
    this._browsers[book] = s;
    return s;
  }

  // The actual click flow. Generic skeleton — calibrate per book.
  async _clickBet(page, leg, cfg) {
    await page.goto(leg.link, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 1) Click the outcome cell. Strategy: locate by the exact odd text near the
    //    market/line. This is the part most sensitive to layout — verify it.
    const clicked = await page.evaluate((odd) => {
      const target = String(odd);
      const cells = Array.from(document.querySelectorAll("*")).filter(
        (el) => el.children.length === 0 && el.innerText && el.innerText.trim() === target
      );
      if (!cells.length) return false;
      cells[0].click();
      return true;
    }, leg.odd);
    if (!clicked) return { ok: false, acceptedOdd: null, message: "не нашёл ячейку с кэфом" };

    // 2) Type the stake into the bet-slip input (calibrate the selector).
    //    await page.type(cfg.stakeInput, String(leg.stake));
    // 3) Click confirm (calibrate the selector).
    //    await page.click(cfg.confirmButton);
    // 4) Read back the accepted odd / confirmation (calibrate).

    return {
      ok: false,
      acceptedOdd: null,
      message:
        "клик по кэфу выполнен, но ввод суммы/подтверждение не откалиброваны — допишите шаги 2–4 в _clickBet",
    };
  }
}

module.exports = { Placer, SELECTORS };
