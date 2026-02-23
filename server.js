const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

app.post("/scrape", async (req, res) => {
  let browser;

  try {
    let { name, mode = "Inquiry" } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const cleanedName = name.replace(/^=/, "").trim();

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
    page.setDefaultTimeout(60000);

    // Step 1: Load search page
    await page.goto(
      "http://inmate-search.cobbsheriff.org/enter_name.shtm",
      { waitUntil: "domcontentloaded" }
    );

    // Step 2: Fill form
    await page.fill('input[name="inmate_name"]', cleanedName);
    await page.selectOption('select[name="qry"]', mode);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.evaluate(() => document.querySelector("form")?.submit())
    ]);

    await page.waitForSelector("table tr");

    // Step 3: Extract inmates
    const inmates = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      const results = [];

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 7) {
          const name = cells[1]?.innerText?.trim();
          const dob = cells[2]?.innerText?.trim();
          const race = cells[3]?.innerText?.trim();
          const sex = cells[4]?.innerText?.trim();
          const location = cells[5]?.innerText?.trim();
          const soid = cells[6]?.innerText?.trim();

          if (name && soid) {
            results.push({ name, dob, race, sex, location, soid });
          }
        }
      }

      return results;
    });

    if (!inmates.length) {
      await browser.close();
      return res.json({ found: false });
    }

    const first = inmates[0];

    // 🔥 IMPORTANT: Pad SOID to 13 characters with spaces
    const paddedSoid = first.soid.padEnd(13, " ");

    const encodedSoid = encodeURIComponent(paddedSoid);

    const detailUrl = `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodedSoid}`;

    console.log("Detail URL:", detailUrl);

    // Step 4: Navigate directly to detail page
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });

    await page.waitForTimeout(3000);

    const detailText = await page.evaluate(() => {
      return document.body.innerText;
    });

    await browser.close();

    return res.json({
      found: true,
      inmates,
      detailUrl,
      bookingDetails: detailText.substring(0, 5000)
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.json({
      found: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Cobb scraper running");
});
