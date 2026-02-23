const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobb-inquiry-scraper' });
});

app.post('/scrape', async (req, res) => {
  if (AUTH_TOKEN) {
    const provided = req.headers['x-auth-token'] || req.query.token;
    if (provided !== AUTH_TOKEN)
      return res.status(401).json({ error: 'Unauthorized' });
  }

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36'
    });

    const page = await context.newPage();

    console.log(`[scrape] Searching Inquiry for: ${name}`);

    // Load form page
    await page.goto(
      'http://inmate-search.cobbsheriff.org/enter_name.shtm',
      { waitUntil: 'domcontentloaded' }
    );

    // Fill name
    await page.fill('input[name="inmate_name"]', name);

    // Force Inquiry mode
    await page.selectOption('select[name="qry"]', 'Inquiry');

    // Click search
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('input[value="Search"]')
    ]);

    // Scroll down
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    // Extract inmate list
    const inmates = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const results = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td =>
          td.innerText.trim()
        );

        if (cells.length >= 7 && /^\d{9}$/.test(cells[6] || '')) {
          results.push({
            name: cells[1],
            dob: cells[2],
            race: cells[3],
            sex: cells[4],
            location: cells[5],
            soid: cells[6],
            daysInCustody: cells[7]
          });
        }
      }

      return results;
    });

    if (!inmates.length) {
      await browser.close();
      return res.json({
        found: false,
        message: 'No results found',
        name
      });
    }

    console.log(`[scrape] Found ${inmates.length} inmates`);

    const detailedResults = [];

    for (const inmate of inmates) {
      try {
        const paddedSoid = inmate.soid + '    ';

        const detailUrl =
          `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}`;

        const detailPage = await context.newPage();
        await detailPage.goto(detailUrl, {
          waitUntil: 'domcontentloaded'
        });

        const pageData = await detailPage.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();

          const fullText = clean(document.body.innerText);

          const allRows = Array.from(
            document.querySelectorAll('table tr')
          ).map(row =>
            Array.from(row.querySelectorAll('td, th'))
              .map(c => clean(c.innerText))
              .filter(Boolean)
          ).filter(r => r.length > 0);

          return { fullText, allRows };
        });

        detailedResults.push({
          ...inmate,
          detail: pageData
        });

        await detailPage.close();
      } catch (err) {
        console.error(`[detail error] ${inmate.soid}:`, err.message);
      }
    }

    await browser.close();

    return res.json({
      found: true,
      total: detailedResults.length,
      name,
      scrapedAt: new Date().toISOString(),
      results: detailedResults
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Fatal error:', err.message);

    return res.status(500).json({
      error: err.message,
      found: false
    });
  }
});

app.listen(PORT, () =>
  console.log(`Inquiry scraper running on port ${PORT}`)
);
