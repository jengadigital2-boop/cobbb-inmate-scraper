const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

app.get('/', (req, res) => res.json({ status: 'ok', service: 'cobb-inmate-scraper' }));

app.post('/scrape', async (req, res) => {
  if (AUTH_TOKEN) {
    const provided = req.headers['x-auth-token'] || req.query.token;
    if (provided !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  }

  const { name, mode = 'In+Custody' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    const page = await context.newPage();

    console.log(`[scrape] Starting: ${name}`);
    await page.goto('http://inmate-search.cobbsheriff.org/enter_name.shtm', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.goto(
      `http://inmate-search.cobbsheriff.org/inquiry.asp?soid=&inmate_name=${encodeURIComponent(name)}&serial=&qry=${mode}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // Parse results list
    const listData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const inmates = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (cells.length >= 6 && /^\d{9}$/.test(cells[6] || '')) {
          inmates.push({ name: cells[1]||'', dob: cells[2]||'', race: cells[3]||'',
            sex: cells[4]||'', location: cells[5]||'', soid: cells[6]||'', daysInCustody: cells[7]||'' });
        }
      }
      return inmates;
    });

    if (!listData || listData.length === 0) {
      await browser.close();
      return res.json({ found: false, name, message: 'No matching records found.', scrapedAt: new Date().toISOString() });
    }

    const firstInmate = listData[0];
    console.log(`[scrape] Found: ${firstInmate.name} (SOID: ${firstInmate.soid})`);

    // Navigate to detail page
    let clickError = null;
    try {
      const allButtons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input, button, a')).map(el => ({
          onclick: el.getAttribute('onclick') || '', href: el.href || ''
        }))
      );
      let bookingId = '';
      for (const el of allButtons) {
        const m = (el.onclick + el.href).match(/BOOKING_ID[=,\s'"]+(\d{10,})/i);
        if (m) { bookingId = m[1]; break; }
      }
      const paddedSoid = firstInmate.soid + '    ';
      const dest = bookingId
        ? `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}&BOOKING_ID=${bookingId}`
        : `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}`;
      console.log(`[scrape] Going to: ${dest}`);
      await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      clickError = e.message;
      console.error(`[scrape] Nav error: ${e.message}`);
    }

    const detailUrl = page.url();
    const isDetailPage = detailUrl.includes('InmDetails');

    let pageData = null;

    if (isDetailPage) {
      // ── Collect EVERYTHING from the page ──
      // Return raw rows + full page text so n8n can route as needed
      pageData = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();

        // 1. Full page text (for simple regex extraction in n8n if needed)
        const fullText = clean(document.body.innerText);

        // 2. All table rows as arrays of cell text
        const allRows = Array.from(document.querySelectorAll('table tr')).map(row => {
          return Array.from(row.querySelectorAll('td, th')).map(c => clean(c.innerText)).filter(c => c);
        }).filter(r => r.length > 0);

        // 3. Flat list of every non-empty cell in order
        const allCells = Array.from(document.querySelectorAll('td, th'))
          .map(c => clean(c.innerText))
          .filter(c => c);

        return { fullText, allRows, allCells };
      });

      console.log(`[scrape] Rows collected: ${pageData.allRows.length}, Cells: ${pageData.allCells.length}`);
      console.log(`[scrape] Full text preview: ${pageData.fullText.substring(0, 500)}`);
    }

    await browser.close();

    return res.json({
      found: true,
      name,
      totalFound: listData.length,
      scrapedAt: new Date().toISOString(),
      gotDetailPage: isDetailPage,
      detailUrl,
      inmate: firstInmate,           // basic list data: name, dob, race, sex, soid, location
      pageData: pageData || null,    // ALL raw page data: fullText, allRows, allCells
      debugInfo: { isDetailPage, clickError }
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[scrape] Fatal error:', err.message);
    return res.status(500).json({ error: err.message, found: false, name, scrapedAt: new Date().toISOString() });
  }
});

app.listen(PORT, () => console.log(`Cobb scraper listening on port ${PORT}`));
