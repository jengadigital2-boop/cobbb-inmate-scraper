const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobb-inmate-debug' });
});

app.post('/scrape', async (req, res) => {
  let browser;

  try {
    // 🔐 AUTH CHECK
    if (AUTH_TOKEN) {
      const provided = req.headers['x-auth-token'] || req.query.token;
      if (provided !== AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { name, mode = 'Inquiry' } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    console.log(`[DEBUG] Searching ${mode} for: ${name}`);

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // 🔹 Go to search page
    await page.goto(
      'http://inmate-search.cobbsheriff.org/enter_name.shtm',
      { waitUntil: 'domcontentloaded' }
    );

    // 🔹 Fill form
    await page.fill('input[name="inmate_name"]', name);
    await page.selectOption('select[name="qry"]', mode);

    // 🔹 Submit form safely
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });

    // 🔹 Wait a fixed amount of time (no DOM dependency)
    await page.waitForTimeout(15000);

    // 🔍 DEBUG DATA
    const currentUrl = page.url();
    const html = await page.content();
    const htmlLength = html.length;

    console.log("PAGE URL:", currentUrl);
    console.log("PAGE LENGTH:", htmlLength);
    console.log("PAGE PREVIEW:", html.substring(0, 800));

    // 🔎 Try to detect results safely
    const inmateRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const results = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(c =>
          (c.innerText || '').trim()
        );

        if (cells.length >= 6 && /^\d{9}$/.test(cells[6] || '')) {
          results.push({
            name: cells[1] || '',
            dob: cells[2] || '',
            race: cells[3] || '',
            sex: cells[4] || '',
            location: cells[5] || '',
            soid: cells[6] || '',
            daysInCustody: cells[7] || ''
          });
        }
      }

      return results;
    });

    await browser.close();

    // ✅ If no rows found
    if (!inmateRows || inmateRows.length === 0) {
      return res.json({
        found: false,
        name,
        mode,
        pageUrl: currentUrl,
        htmlLength,
        debugPreview: html.substring(0, 1000),
        message: 'No matching records OR blocked page',
        scrapedAt: new Date().toISOString()
      });
    }

    // ✅ If rows found
    return res.json({
      found: true,
      name,
      mode,
      totalFound: inmateRows.length,
      inmates: inmateRows,
      pageUrl: currentUrl,
      htmlLength,
      scrapedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[DEBUG] Fatal error:', err.message);

    if (browser) {
      try { await browser.close(); } catch (_) {}
    }

    // 🚫 DO NOT crash n8n
    return res.json({
      found: false,
      error: err.message,
      message: 'Scraper error but workflow continues',
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`Cobb DEBUG scraper running on port ${PORT}`);
});
