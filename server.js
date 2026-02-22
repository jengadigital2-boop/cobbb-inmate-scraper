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
    if (provided !== AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
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

    console.log(`[scrape] Starting search for: ${name}`);
    await page.goto('http://inmate-search.cobbsheriff.org/enter_name.shtm', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    await page.goto(
      `http://inmate-search.cobbsheriff.org/inquiry.asp?soid=&inmate_name=${encodeURIComponent(name)}&serial=&qry=${mode}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    const listData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const inmates = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (cells.length >= 6 && /^\d{9}$/.test(cells[6] || '')) {
          inmates.push({
            name: cells[1] || '', dob: cells[2] || '', race: cells[3] || '',
            sex: cells[4] || '', location: cells[5] || '', soid: cells[6] || '',
            daysInCustody: cells[7] || '',
          });
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

    let clickError = null;
    try {
      const allButtons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input, button, a')).map(el => ({
          tag: el.tagName, type: el.type || '', value: el.value || '',
          text: el.innerText || '', onclick: el.getAttribute('onclick') || '', href: el.href || ''
        }))
      );

      let bookingId = '';
      for (const el of allButtons) {
        const combined = el.onclick + el.href + el.value + el.text;
        const bidMatch = combined.match(/BOOKING_ID[=,\s'"]+(\d{10,})/i);
        if (bidMatch) { bookingId = bidMatch[1]; break; }
      }

      console.log(`[scrape] BOOKING_ID: ${bookingId || 'none'}`);

      const paddedSoid = firstInmate.soid + '    ';
      const dest = bookingId
        ? `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}&BOOKING_ID=${bookingId}`
        : `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}`;
      await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      clickError = e.message;
      console.error(`[scrape] Nav error: ${e.message}`);
    }

    const detailUrl = page.url();
    const pageTitle = await page.title();
    const isDetailPage = detailUrl.includes('InmDetails');
    console.log(`[scrape] Detail URL: ${detailUrl}, isDetail: ${isDetailPage}`);

    let bookingData = null;

    if (isDetailPage) {
      // Extract ALL rows from the page in browser context
      const rawRows = await page.evaluate(() => {
        function clean(str) { return (str || '').replace(/\s+/g, ' ').trim(); }
        return Array.from(document.querySelectorAll('table tr')).map(row => ({
          isHeader: row.querySelectorAll('th').length > 0,
          cells: Array.from(row.querySelectorAll('td, th')).map(c => clean(c.innerText))
        })).filter(r => r.cells.some(c => c));
      });

      // Parse KV in Node context — logs actually appear in Railway
      const kv = {};
      let lastHeaders = [];

      for (const row of rawRows) {
        const cells = row.cells;
        if (row.isHeader) {
          lastHeaders = cells.map(h => h.toLowerCase().replace(/:$/, '').trim());
          continue;
        }
        if (lastHeaders.length >= 2 && cells.length >= 2) {
          lastHeaders.forEach((h, i) => { if (h && cells[i]) kv[h] = cells[i]; });
          lastHeaders = [];
          continue;
        }
        if (cells.length === 2 && cells[0] && cells[1])
          kv[cells[0].toLowerCase().replace(/:$/, '').trim()] = cells[1];
        if (cells.length >= 4) {
          if (cells[0] && cells[1]) kv[cells[0].toLowerCase().replace(/:$/, '').trim()] = cells[1];
          if (cells[2] && cells[3]) kv[cells[2].toLowerCase().replace(/:$/, '').trim()] = cells[3];
        }
      }

      // Log every KV pair — visible in Railway deploy logs
      console.log('[scrape] === KV DUMP ===');
      Object.entries(kv).forEach(([k, v]) => console.log(`  "${k}" => "${v}"`));
      console.log('[scrape] === END KV ===');

      const get = (...keys) => {
        for (const k of keys) {
          if (kv[k]) return kv[k];
          const fk = Object.keys(kv).find(x => x.includes(k.toLowerCase()));
          if (fk) return kv[fk];
        }
        return '';
      };

      // Build charges by finding 'description' keys
      const charges = [];
      const kvEntries = Object.entries(kv);
      for (let i = 0; i < kvEntries.length; i++) {
        const [k, v] = kvEntries[i];
        if (k === 'description' || k.endsWith(' description')) {
          const charge = { description: v };
          const slice = kvEntries.slice(Math.max(0, i - 4), Math.min(kvEntries.length, i + 6));
          for (const [kj, vj] of slice) {
            if (kj.includes('bond'))          charge.bond = vj;
            if (kj.includes('offense date'))  charge.offenseDate = vj;
            if (kj === 'warrant')             charge.warrant = vj;
            if (kj === 'warrant date')        charge.warrantDate = vj;
            if (kj === 'case')                charge.case = vj;
            if (kj === 'disposition')         charge.disposition = vj;
            if (kj.includes('statute'))       charge.statute = vj;
          }
          charges.push(charge);
          console.log(`[scrape] Charge: ${JSON.stringify(charge)}`);
        }
      }

      bookingData = {
        agencyId:         get('arrest agency', 'agency id', 'agency'),
        arrestDate:       get('arrest date', 'arrest date/time'),
        offenseDate:      get('offense date'),
        bookingStarted:   get('booking started'),
        bookingComplete:  get('booking complete'),
        height:           get('height'),
        weight:           get('weight'),
        hair:             get('hair'),
        eyes:             get('eyes'),
        address:          get('address'),
        city:             get('city'),
        state:            get('state'),
        zip:              get('zip'),
        placeOfBirth:     get('place of birth'),
        locationOfArrest: get('location of arrest'),
        courtroom:        get('superior courtroom', 'courtroom'),
        attorney:         get('attorney', 'public defender', 'counsel'),
        warrant:          get('warrant'),
        warrantDate:      get('warrant date'),
        charges,
        rawKvKeys:        Object.keys(kv)
      };

      console.log(`[scrape] Summary — arrestDate:${bookingData.arrestDate} height:${bookingData.height} weight:${bookingData.weight} charges:${charges.length} attorney:${bookingData.attorney}`);
    }

    await browser.close();

    return res.json({
      found: true, name, totalFound: listData.length,
      scrapedAt: new Date().toISOString(),
      gotDetailPage: isDetailPage, detailUrl,
      inmate: { ...firstInmate, ...(bookingData || {}) },
      debugInfo: { pageTitle, isDetailPage, clickError, rawKvKeys: bookingData?.rawKvKeys || [] }
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[scrape] Fatal error:', err.message);
    return res.status(500).json({ error: err.message, found: false, name, scrapedAt: new Date().toISOString() });
  }
});

app.listen(PORT, () => console.log(`Cobb scraper listening on port ${PORT}`));
