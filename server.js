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
  // 🔐 Auth
  if (AUTH_TOKEN) {
    const provided = req.headers['x-auth-token'] || req.query.token;
    if (provided !== AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { name, mode = 'In Custody' } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
      locale: 'en-US'
    });

    const page = await context.newPage();

    console.log(`[scrape] Starting search for: ${name} (${mode})`);

    // 1️⃣ Load form page
    await page.goto(
      'http://inmate-search.cobbsheriff.org/enter_name.shtm',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // 2️⃣ Fill name field
    await page.fill('input[name="inmate_name"]', name);

    // 3️⃣ Select dropdown (exact values: "In Custody" or "Inquiry")
    await page.selectOption('select[name="qry"]', mode);

    // 4️⃣ Click search and wait
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('input[value="Search"]')
    ]);

    // 5️⃣ If Inquiry mode, scroll down (large result sets)
    if (mode.toLowerCase().includes('inquiry')) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
    }

    // 6️⃣ Parse results list
    const listData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const inmates = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td =>
          td.innerText.trim()
        );

        if (cells.length >= 7 && /^\d{9}$/.test(cells[6] || '')) {
          inmates.push({
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

      return inmates;
    });

    if (!listData.length) {
      await browser.close();
      return res.json({
        found: false,
        name,
        mode,
        message: 'No matching records found.',
        scrapedAt: new Date().toISOString()
      });
    }

    const firstInmate = listData[0];

    console.log(
      `[scrape] Found ${listData.length} records. First SOID: ${firstInmate.soid}`
    );

    // 7️⃣ Navigate to detail page
    let clickError = null;
    let pageData = null;
    let detailUrl = null;

    try {
      const paddedSoid = firstInmate.soid + '    ';

      const detailLink = `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(
        paddedSoid
      )}`;

      await page.goto(detailLink, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      detailUrl = page.url();

      if (detailUrl.includes('InmDetails')) {
        pageData = await page.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();

          const fullText = clean(document.body.innerText);

          const allRows = Array.from(
            document.querySelectorAll('table tr')
          ).map(row =>
            Array.from(row.querySelectorAll('td, th'))
              .map(c => clean(c.innerText))
              .filter(Boolean)
          ).filter(r => r.length > 0);

          const allCells = Array.from(
            document.querySelectorAll('td, th')
          )
            .map(c => clean(c.innerText))
            .filter(Boolean);

          return { fullText, allRows, allCells };
        });

        console.log(
          `[scrape] Detail rows: ${pageData.allRows.length}`
        );
      }
    } catch (e) {
      clickError = e.message;
      console.error(`[scrape] Detail navigation error: ${e.message}`);
    }

    await browser.close();

    return res.json({
      found: true,
      name,
      mode,
      totalFound: listData.length,
      scrapedAt: new Date().toISOString(),
      gotDetailPage: !!pageData,
      detailUrl,
      inmates: listData,
      inmate: firstInmate,
      pageData: pageData || null,
      debugInfo: { clickError }
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[scrape] Fatal error:', err.message);

    return res.status(500).json({
      error: err.message,
      found: false,
      name,
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, () =>
  console.log(`Cobb scraper listening on port ${PORT}`)
);
