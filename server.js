const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobb-inmate-scraper' });
});

app.post('/scrape', async (req, res) => {
  try {
    // 🔐 AUTH CHECK
    if (AUTH_TOKEN) {
      const provided = req.headers['x-auth-token'] || req.query.token;
      if (provided !== AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { name, mode = 'Inquiry' } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    console.log(`[scrape] Searching ${mode} for: ${name}`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
    });

    const page = await context.newPage();

    // 🔹 Load search page
    await page.goto(
      'http://inmate-search.cobbsheriff.org/enter_name.shtm',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );

    // 🔹 Fill name
    await page.fill('input[name="inmate_name"]', name);

    // 🔹 Select dropdown (In Custody / Inquiry)
    await page.selectOption('select[name="qry"]', mode);

    // 🔹 Click search
    await page.click('input[value="Search"]');

    // 🔹 Wait for results to load (NOT navigation)
    await page.waitForFunction(() => {
      return document.querySelectorAll('table tr').length > 1
        || document.body.innerText.includes('No matching records');
    }, { timeout: 60000 });

    // 🔹 Check if no records
    const noRecords = await page.evaluate(() =>
      document.body.innerText.includes('No matching records')
    );

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

    // 🔹 Collect inmate rows
    const inmates = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const results = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(c =>
          c.innerText.trim()
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

    // 🔹 Visit each detail page
    for (const inmate of inmates) {
      try {
        const paddedSoid = inmate.soid + '    ';

        const detailUrl =
          `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}`;

        await page.goto(detailUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        const detailData = await page.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();

          const fullText = clean(document.body.innerText);

          const rows = Array.from(document.querySelectorAll('table tr'))
            .map(row =>
              Array.from(row.querySelectorAll('td, th'))
                .map(c => clean(c.innerText))
                .filter(c => c)
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
      scrapedAt: new Date().toISOString(),
      inmates: detailedResults
    });

  } catch (err) {
    console.error('[scrape] Fatal error:', err.message);
    return res.status(500).json({
      error: err.message,
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`Inquiry scraper running on port ${PORT}`);
});
