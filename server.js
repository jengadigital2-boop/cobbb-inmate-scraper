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
      bookingData = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const allRows = Array.from(document.querySelectorAll('table tr'));

        // ── Dump ALL cells for Node-side debugging ──
        const allCellDump = allRows.map(row => ({
          isHeader: row.querySelectorAll('th').length > 0,
          cells: Array.from(row.querySelectorAll('td,th')).map(c => clean(c.innerText))
        })).filter(r => r.cells.some(c => c));

        // ── Pass 1: Build flat KV from header+value row pairs ──
        const kv = {};
        let pendingHeaders = [];
        for (const row of allCellDump) {
          const { isHeader, cells } = row;
          if (isHeader && cells.every(c => !c.match(/^\d/) && c.length < 60)) {
            pendingHeaders = cells.map(h => h.toLowerCase().replace(/:$/, '').trim());
            continue;
          }
          if (pendingHeaders.length > 0 && cells.length > 0) {
            pendingHeaders.forEach((h, i) => { if (h && cells[i]) kv[h] = cells[i]; });
            pendingHeaders = [];
            continue;
          }
          if (cells.length === 2 && cells[0] && cells[1])
            kv[cells[0].toLowerCase().replace(/:$/, '').trim()] = cells[1];
          else if (cells.length >= 4) {
            if (cells[0] && cells[1]) kv[cells[0].toLowerCase().replace(/:$/, '').trim()] = cells[1];
            if (cells[2] && cells[3]) kv[cells[2].toLowerCase().replace(/:$/, '').trim()] = cells[3];
          }
        }

        const get = (...keys) => {
          for (const k of keys) {
            if (kv[k]) return kv[k];
            const fk = Object.keys(kv).find(x => x.includes(k.toLowerCase()));
            if (fk) return kv[fk];
          }
          return '';
        };

        // ── Pass 2: Structural charge parsing ──
        const charges = [];
        let currentCharge = null;
        let inChargesSection = false;
        let inReleaseSection = false;
        let chargeColHeaders = [];
        let attorney = '';
        let releaseDate = '';
        let releasedTo = '';
        let bondStatus = '';

        for (const { isHeader, cells } of allCellDump) {
          if (!cells.some(c => c)) continue;
          const joined = cells.join(' ').toLowerCase();

          // Section markers
          if (joined.trim() === 'charges') { inChargesSection = true; inReleaseSection = false; continue; }
          if (joined.includes('release information')) { 
            if (currentCharge) { charges.push(currentCharge); currentCharge = null; }
            inChargesSection = false; inReleaseSection = true; continue; 
          }

          // ── Release section ──
          if (inReleaseSection) {
            if (joined.trim() === 'attorney' || joined.includes('attorney')) {
              // Next non-empty row is attorney value
              continue;
            }
            if (cells.length === 1 && cells[0] && !cells[0].toLowerCase().includes('attorney') && !attorney) {
              attorney = cells[0];
              continue;
            }
            if (joined.includes('release date') || joined.includes('officer') || joined.includes('released to')) continue;
            if (joined.includes('not released')) { releaseDate = 'Not Released'; releasedTo = 'Not Released'; continue; }
            if (cells[0] && cells[0].match(/\d{1,2}\/\d{1,2}\/\d{4}/)) releaseDate = cells[0];
            if (cells.length >= 3 && cells[2]) releasedTo = cells[2];
            continue;
          }

          // ── Charges section ──
          if (inChargesSection) {
            // Warrant row
            if (cells[0].toLowerCase() === 'warrant' && cells[1] && !cells[1].toLowerCase().includes('date')) {
              if (currentCharge) charges.push(currentCharge);
              currentCharge = { warrant: cells[1], warrantDate: cells[3] || '', counts: cells[4] || '' };
              continue;
            }
            // Case row
            if (cells[0].toLowerCase() === 'case' && currentCharge) {
              currentCharge.caseNumber = cells[1] || '';
              continue;
            }
            // Charge column headers
            if (joined.includes('offense date') && joined.includes('description')) {
              chargeColHeaders = cells.map(c => c.toLowerCase());
              continue;
            }
            // Charge data row
            if (chargeColHeaders.length > 0 && currentCharge && cells.length >= 3) {
              const idx = h => chargeColHeaders.findIndex(c => c.includes(h));
              const g = h => { const i = idx(h); return i >= 0 ? cells[i] || '' : ''; };
              currentCharge.offenseDate  = g('offense date') || currentCharge.offenseDate || '';
              currentCharge.statute      = g('code section');
              currentCharge.description  = g('description');
              currentCharge.type         = g('type');
              currentCharge.counts       = g('count') || currentCharge.counts || '';
              currentCharge.bond         = g('bond');
              chargeColHeaders = [];
              continue;
            }
            // Disposition
            if (cells[0].toLowerCase() === 'disposition' && currentCharge) {
              currentCharge.disposition = cells.slice(1).filter(Boolean).join(' ') || cells[1] || '';
              continue;
            }
            // Bond amount
            if (joined.includes('bond amount')) {
              if (currentCharge) currentCharge.bondAmount = cells[cells.length - 1] || '';
              continue;
            }
            // Bond status
            if (joined.includes('bond status')) {
              bondStatus = cells.find(c => c && !c.toLowerCase().includes('bond') && !c.match(/^\$/) ) || '';
              if (currentCharge) currentCharge.bondStatus = bondStatus;
              if (currentCharge) currentCharge.bondAmount = currentCharge.bondAmount || cells[cells.length-1] || '';
              continue;
            }
          }
        }

        // Capture attorney from full cell scan if missed above
        if (!attorney) {
          const allFlatCells = allCellDump.flatMap(r => r.cells);
          const ai = allFlatCells.findIndex(c => c.toLowerCase() === 'attorney');
          if (ai >= 0) attorney = allFlatCells[ai + 1] || '';
        }

        return {
          agencyId:         get('arrest agency', 'agency id'),
          arrestDate:       get('arrest date/time', 'arrest date'),
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
          attorney,
          bondStatus,
          releaseDate,
          releasedTo,
          charges,
          rawKvKeys:        Object.keys(kv)
        };
      });

      console.log(`[scrape] arrestDate:${bookingData.arrestDate} height:${bookingData.height} attorney:${bookingData.attorney} charges:${bookingData.charges.length} release:${bookingData.releaseDate}`);
      bookingData.charges.forEach((c,i) => console.log(`[scrape] Charge ${i+1}: ${JSON.stringify(c)}`));
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
