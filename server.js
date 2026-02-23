const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post("/scrape", async (req, res) => {
  let browser;

  try {
    let { name, mode = "Inquiry" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const cleanedName = name.replace(/^=/, "").trim();

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // 1️⃣ Go to search page
    await page.goto(
      "http://inmate-search.cobbsheriff.org/enter_name.shtm",
      { waitUntil: "domcontentloaded" }
    );

    // 2️⃣ Fill form
    await page.fill('input[name="inmate_name"]', cleanedName);
    await page.selectOption('select[name="qry"]', mode);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.evaluate(() => document.querySelector("form").submit())
    ]);

    await page.waitForSelector("table");

    // 3️⃣ Click "Last Known Booking" button directly
    const bookingButton = await page.locator("input[value='Last Known Booking']").first();

    if (!(await bookingButton.count())) {
      await browser.close();
      return res.json({ found: false });
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      bookingButton.click()
    ]);

    // 4️⃣ Now we are inside InmDetails.asp (valid session)
    await page.waitForSelector("body");

    const detailText = await page.evaluate(() => {
      return document.body.innerText;
    });

    await browser.close();

    return res.json({
      found: true,
      details: detailText.substring(0, 8000)
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
