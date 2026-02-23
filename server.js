const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cobb-inmate-scraper" });
});

app.post("/scrape", async (req, res) => {
  let browser;

  try {
    // Optional auth
    if (AUTH_TOKEN) {
      const provided =
        req.headers["x-auth-token"] || req.query.token || "";
      if (provided !== AUTH_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    let { name, mode = "Inquiry" } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    // Clean input
    const cleanedName = name.replace(/^=/, "").trim();

    console.log(`[SCRAPE] Searching ${mode} for: ${cleanedName}`);

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36",
      extraHTTPHeaders: {
        referer: "http://inmate-search.cobbsheriff.org/"
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    // Step 1: Load search page
    await page.goto(
      "http://inmate-search.cobbsheriff.org/enter_name.shtm",
      { waitUntil: "domcontentloaded" }
    );

    // Step 2: Fill search form
    await page.fill('input[name="inmate_name"]', cleanedName);
    await page.selectOption('select[name="qry"]', mode);

    // Step 3: Submit form properly
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.evaluate(() => document.querySelector("form")?.submit())
    ]);

    // Step 4: Wait for results table
    await page.waitForSelector("table tr", { timeout: 20000 });

    // Step 5: Extract inmate rows
    const inmates = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      const results = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length >= 9) {
          const name = cells[1]?.innerText?.trim();
          const dob = cells[2]?.innerText?.trim();
          const race = cells[3]?.innerText?.trim();
          const sex = cells[4]?.innerText?.trim();
          const location = cells[5]?.innerText?.trim();
          const soid = cells[6]?.innerText?.trim();

          if (name && soid) {
            results.push({
              name,
              dob,
              race,
              sex,
              location,
              soid
            });
          }
        }
      }

      return results;
    });

    if (!inmates || inmates.length === 0) {
      await browser.close();
      return res.json({
        found: false,
        name: cleanedName,
        mode,
        message: "No matching records found",
        scrapedAt: new Date().toISOString()
      });
    }

    // Step 6: Click correct Last Known Booking (first row match)
    const bookingButton = page.locator('input[value="Last Known Booking"]').first();

    if (await bookingButton.count() === 0) {
      await browser.close();
      return res.json({
        found: true,
        inmates,
        bookingError: "Booking button not found",
        scrapedAt: new Date().toISOString()
      });
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      bookingButton.click()
    ]);

    // Extra wait for legacy ASP page
    await page.waitForTimeout(4000);

    console.log("After click URL:", page.url());

    // Step 7: Scrape booking details
    const bookingDetails = await page.evaluate(() => {
      const text = document.body.innerText;
      return text;
    });

    await browser.close();

    return res.json({
      found: true,
      name: cleanedName,
      mode,
      totalFound: inmates.length,
      inmates,
      bookingDetails: bookingDetails.substring(0, 5000),
      scrapedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error("SCRAPER ERROR:", err.message);

    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }

    return res.json({
      found: false,
      error: err.message,
      message: "Scraper error but workflow continues",
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`Cobb scraper running on port ${PORT}`);
});
