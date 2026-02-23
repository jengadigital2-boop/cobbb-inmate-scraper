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

    const { name, mode = "Inquiry" } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    console.log(`[SCRAPE] Searching ${mode} for: ${name}`);

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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    // Load search page
    await page.goto(
      "http://inmate-search.cobbsheriff.org/enter_name.shtm",
      { waitUntil: "domcontentloaded" }
    );

    // Fill form
    await page.fill('input[name="inmate_name"]', name);
    await page.selectOption('select[name="qry"]', mode);

    // Submit form
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) form.submit();
    });

    // Wait for results page to render
    await page.waitForTimeout(8000);

    const currentUrl = page.url();
    const html = await page.content();
    const htmlLength = html.length;

    console.log("Page URL:", currentUrl);
    console.log("HTML Length:", htmlLength);

    // Extract table rows
    const inmateRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      const results = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));

        if (cells.length >= 7) {
          const name = cells[1]?.innerText?.trim();
          const dob = cells[2]?.innerText?.trim();
          const race = cells[3]?.innerText?.trim();
          const sex = cells[4]?.innerText?.trim();
          const location = cells[5]?.innerText?.trim();
          const soid = cells[6]?.innerText?.trim();

          if (name && soid && soid.length >= 6) {
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

    await browser.close();

    if (!inmateRows || inmateRows.length === 0) {
      return res.json({
        found: false,
        name,
        mode,
        message: "No matching records found",
        scrapedAt: new Date().toISOString()
      });
    }

    return res.json({
      found: true,
      name,
      mode,
      totalFound: inmateRows.length,
      inmates: inmateRows,
      scrapedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error("Fatal scraper error:", err.message);

    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }

    // Return safe response so n8n continues
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
