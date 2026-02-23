const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobb-inmate-scraper' });
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

    console.log(`[scrape] Searching ${mode} for: ${name}`);

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
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
    });

    const page = await context.newPage();

    // Increase default timeout
    page.setDefaultTimeout(90000);

    // 🔹 Load search page
    await page.goto(
      'http://inmate-search.cobbsheriff.org/enter_name.shtm',
      { waitUntil: 'domcontentloaded' }
    );

    // 🔹 Fill name
    await page.fill('input[name="inmate_name"]', name);

    // 🔹 Select dropdown
    await page.selectOption('select[name="qry"]', mode);

    // 🔹 Submit form safely
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });

    // 🔹 Wait for page to stabilize (legacy ASP needs breathing room)
    await page.waitForTimeout(5000);

    // 🔹 Wait for either results or no-record message safely
    await page.waitForFunction(() => {
      const body = document.body;
      if (!body) return false;

      const rows = document.querySelectorAll('table tr');
      const text = body.innerText || '';

      return rows.length > 1 || text.includes('No matching records');
    });

    // 🔹 Check for no records
    const noRecords = await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      return body.innerText.includes('No matching records');
    });

    if (noRecords) {
      await browser.close();
      return res.json({
        found: false,
        name,
        mode,
        message: 'No matching records found',
        scrapedAt: new Date().toISOString()
      });
    }

    // 🔹 Extract list results
    const inmates = await page.evaluate(() => {
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

    console.log(`[scrape] Found ${inmates.length} inmates`);

    const detailedResults = [];

    // 🔹 Visit each detail page (limit to prevent overload)
    const MAX_DETAILS = 25;

    for (const inmate of inmates.slice(0, MAX_DETAILS)) {
      try {
        const paddedSoid = inmate.soid + '    ';
        const detailUrl =
          `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}`;

        await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });

        await page.waitForTimeout(2000);

        const detailData = await page.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();

          const fullText = clean(document.body ? document.body.innerText : '');

          const rows = Array.from(document.querySelectorAll('table tr'))
            .map(row =>
              Array.from(row.querySelectorAll('td, th'))
                .map(c => clean(c.innerText))
                .filter(Boolean)
            )
            .filter(r => r.length > 0);

          return { fullText, rows };
        });

        detailedResults.push({
          basic: inmate,
          detail: detailData
        });

      } catch (err) {
        console.log(`[scrape] Detail error for ${inmate.name}: ${err.message}`);
      }
    }

    await browser.close();

    return res.json({
      found: true,
      name,
      mode,
      totalFound: inmates.length,
      returnedDetails: detailedResults.length,
      scrapedAt: new Date().toISOString(),
      inmates: detailedResults
    });

  } catch (err) {
    console.error('[scrape] Fatal error:', err.message);

    if (browser) {
      try { await browser.close(); } catch (_) {}
    }

    return res.status(500).json({
      error: err.message,
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`Cobb inquiry scraper running on port ${PORT}`);
});
