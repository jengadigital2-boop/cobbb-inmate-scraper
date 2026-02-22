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

    console.log(`[scrape] Starting search for: ${name}`);
    await page.goto('http://inmate-search.cobbsheriff.org/enter_name.shtm', { waitUntil: 'domcontentloaded', timeout: 30000 });
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
          inmates.push({ name: cells[1]||'', dob: cells[2]||'', race: cells[3]||'', sex: cells[4]||'', location: cells[5]||'', soid: cells[6]||'', daysInCustody: cells[7]||'' });
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
          onclick: el.getAttribute('onclick') || '', href: el.href || '',
          value: el.value || '', text: el.innerText || ''
        }))
      );
      let bookingId = '';
      for (const el of allButtons) {
        const m = (el.onclick + el.href).match(/BOOKING_ID[=,\s'"]+(\d{10,})/i);
        if (m) { bookingId = m[1]; break; }
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
    console.log(`[scrape] isDetail: ${isDetailPage}`);

    let bookingData = null;

    if (isDetailPage) {
      // Pull raw rows out of browser context
      const rawRows = await page.evaluate(() => {
        const clean = s => (s||'').replace(/\s+/g,' ').trim();
        return Array.from(document.querySelectorAll('table tr')).map(row => ({
          isHeader: row.querySelectorAll('th').length > 0,
          cells: Array.from(row.querySelectorAll('td,th')).map(c => clean(c.innerText))
        })).filter(r => r.cells.some(c => c));
      });

      // ── Key insight from KV dump:
      // The site layout is: HEADER ROW (th cells) followed immediately by VALUE ROW (td cells)
      // Headers and values are in SEPARATE rows, not the same row
      // So we need to pair consecutive header+value rows
      
      const kv = {};
      let pendingHeaders = [];

      for (const row of rawRows) {
        const cells = row.cells.filter(c => c); // remove empty cells

        if (row.isHeader) {
          // Store these as pending headers waiting for next value row
          pendingHeaders = cells.map(h => h.toLowerCase().replace(/:$/,'').trim());
          continue;
        }

        if (pendingHeaders.length > 0 && cells.length > 0) {
          // Map value cells to pending headers
          pendingHeaders.forEach((h, i) => {
            if (h && cells[i] !== undefined) kv[h] = cells[i];
          });
          pendingHeaders = [];
          continue;
        }

        // Also handle 2-col and 4-col non-header rows as direct kv pairs
        if (cells.length === 2 && cells[0] && cells[1]) {
          kv[cells[0].toLowerCase().replace(/:$/,'').trim()] = cells[1];
        } else if (cells.length >= 4) {
          if (cells[0] && cells[1]) kv[cells[0].toLowerCase().replace(/:$/,'').trim()] = cells[1];
          if (cells[2] && cells[3]) kv[cells[2].toLowerCase().replace(/:$/,'').trim()] = cells[3];
        }
      }

      // Log every KV pair
      console.log('[scrape] === KV DUMP ===');
      Object.entries(kv).forEach(([k,v]) => console.log(`  "${k}" => "${v}"`));
      console.log('[scrape] === END KV ===');

      const get = (...keys) => {
        for (const k of keys) {
          if (kv[k]) return kv[k];
          const fk = Object.keys(kv).find(x => x.includes(k.toLowerCase()));
          if (fk) return kv[fk];
        }
        return '';
      };

      // ── Parse charges
      // From KV dump we know charges appear as rows with these keys:
      // "case", "offense date", "description"(=charge name), "n/a"(=statute),
      // "theft by taking (felony)"(=actual charge text) => "Felony Indicted"(=type)
      // "disposition", "bond amount"
      // Strategy: group rows between "case" markers
      const charges = [];
      const kvEntries = Object.entries(kv);
      
      // Find all "case" entry indices as charge group boundaries
      const caseIndices = kvEntries.reduce((acc, [k], i) => {
        if (k === 'case') acc.push(i);
        return acc;
      }, []);

      console.log(`[scrape] Found ${caseIndices.length} charge groups`);

      if (caseIndices.length > 0) {
        for (let ci = 0; ci < caseIndices.length; ci++) {
          const start = caseIndices[ci];
          const end = caseIndices[ci + 1] || kvEntries.length;
          const group = Object.fromEntries(kvEntries.slice(start, end));
          
          // The charge description is the key that isn't a known field name
          const knownKeys = ['case','offense date','description','n/a','disposition','bond amount','warrant','warrant date','type','code section'];
          const chargeKey = Object.keys(group).find(k =>
            !knownKeys.some(kn => k.includes(kn)) &&
            k !== 'case' && group[k] && group[k].length > 2
          );
          
          const charge = {
            description: chargeKey ? `${chargeKey} — ${group[chargeKey]}` : get('description'),
            caseNumber:  group['case'] || '',
            offenseDate: group['offense date'] || '',
            statute:     group['n/a'] || group['code section'] || '',
            disposition: group['disposition'] || '',
            bond:        group['bond amount'] || '',
            warrant:     group['warrant'] || '',
            warrantDate: group['warrant date'] || '',
            type:        chargeKey ? group[chargeKey] : ''
          };

          // If chargeKey found, use it as the main description
          if (chargeKey) {
            charge.description = chargeKey;
            charge.type = group[chargeKey];
          }

          charges.push(charge);
          console.log(`[scrape] Charge ${ci+1}: ${JSON.stringify(charge)}`);
        }
      } else {
        // Fallback: look for any key that matches charge-like patterns
        kvEntries.forEach(([k, v]) => {
          if (k.includes('theft') || k.includes('assault') || k.includes('battery') ||
              k.includes('drug') || k.includes('murder') || k.includes('robbery') ||
              k.includes('burglary') || k.includes('fraud') || k.includes('dui') ||
              (v && (v.toLowerCase().includes('felony') || v.toLowerCase().includes('misdemeanor')))) {
            charges.push({ description: k, type: v, bond: get('bond amount') });
            console.log(`[scrape] Fallback charge: ${k} => ${v}`);
          }
        });
      }

      bookingData = {
        agencyId:         get('ga0330000', 'arrest agency', 'agency id', 'agency'),
        arrestDate:       get('arrest date/time', 'arrest date'),
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
        rawKvKeys: Object.keys(kv)
      };

      console.log(`[scrape] Final — arrestDate:${bookingData.arrestDate} height:${bookingData.height} weight:${bookingData.weight} attorney:${bookingData.attorney} charges:${charges.length}`);
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
