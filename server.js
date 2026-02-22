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
    console.log(`[scrape] isDetail: ${isDetailPage}, URL: ${detailUrl}`);

    let bookingData = null;

    if (isDetailPage) {
      // Parse the entire page in browser context with full structural awareness
      bookingData = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();

        const result = {
          // Booking fields
          agencyId: '', arrestDate: '', bookingStarted: '', bookingComplete: '',
          // Physical
          height: '', weight: '', hair: '', eyes: '',
          // Personal
          address: '', city: '', state: '', zip: '', placeOfBirth: '',
          // Case
          locationOfArrest: '', courtroom: '', courtCaseNumber: '',
          // Release
          attorney: '', releaseDate: '', releasedTo: '', bondStatus: '',
          // Charges array
          charges: [],
          // Debug
          rawKvKeys: []
        };

        // ── SECTION 1: Parse all simple key→value pairs from the top of the page ──
        // These are 2-col or 4-col rows with th headers followed by td values
        const allRows = Array.from(document.querySelectorAll('table tr'));
        const kv = {};
        let lastHeaders = [];

        for (const row of allRows) {
          const ths = Array.from(row.querySelectorAll('th')).map(c => clean(c.innerText));
          const tds = Array.from(row.querySelectorAll('td')).map(c => clean(c.innerText));

          if (ths.length > 0 && tds.length === 0) {
            // Pure header row — store for next value row
            lastHeaders = ths.map(h => h.toLowerCase().replace(/:$/, '').trim());
            continue;
          }

          if (lastHeaders.length > 0 && tds.length > 0) {
            lastHeaders.forEach((h, i) => {
              if (h && tds[i] !== undefined && tds[i] !== '') kv[h] = tds[i];
            });
            lastHeaders = [];
            continue;
          }

          // Mixed th+td in same row (label:value inline)
          if (ths.length > 0 && tds.length > 0) {
            // pair them: th[0]→td[0], th[1]→td[1], etc.
            ths.forEach((h, i) => {
              if (h && tds[i]) kv[h.toLowerCase().replace(/:$/, '').trim()] = tds[i];
            });
            continue;
          }

          // Pure td rows: 2-col or 4-col kv
          if (tds.length === 2 && tds[0] && tds[1]) {
            kv[tds[0].toLowerCase().replace(/:$/, '').trim()] = tds[1];
          } else if (tds.length >= 4) {
            if (tds[0] && tds[1]) kv[tds[0].toLowerCase().replace(/:$/, '').trim()] = tds[1];
            if (tds[2] && tds[3]) kv[tds[2].toLowerCase().replace(/:$/, '').trim()] = tds[3];
          }
        }

        result.rawKvKeys = Object.keys(kv);

        const get = (...keys) => {
          for (const k of keys) {
            if (kv[k]) return kv[k];
            const fk = Object.keys(kv).find(x => x.includes(k.toLowerCase()));
            if (fk) return kv[fk];
          }
          return '';
        };

        // ── SECTION 2: Map known fields ──
        result.agencyId        = get('arrest agency', 'agency id');
        result.arrestDate      = get('arrest date/time', 'arrest date');
        result.bookingStarted  = get('booking started');
        result.bookingComplete = get('booking complete');
        result.height          = get('height');
        result.weight          = get('weight');
        result.hair            = get('hair');
        result.eyes            = get('eyes');
        result.address         = get('address');
        result.city            = get('city');
        result.state           = get('state');
        result.zip             = get('zip');
        result.placeOfBirth    = get('place of birth');
        result.locationOfArrest = get('location of arrest');
        result.courtroom       = get('superior courtroom', 'courtroom');
        result.bondStatus      = get('bond status');
        result.releaseDate     = get('release date');
        result.releasedTo      = get('released to');

        // ── SECTION 3: Attorney — look for the specific cell text ──
        const allCells = Array.from(document.querySelectorAll('td, th')).map(c => clean(c.innerText));
        const attyIdx = allCells.findIndex(c => c.toLowerCase() === 'attorney');
        if (attyIdx >= 0 && allCells[attyIdx + 1]) {
          result.attorney = allCells[attyIdx + 1];
        } else {
          result.attorney = get('attorney', 'public defender', 'counsel');
        }

        // ── SECTION 4: Parse Charges table structurally ──
        // The charges section looks like:
        // Row: [Warrant] [24-WD-NA46] [Warrant Date] [2/13/2026] [1]
        // Row: [Case] [24CR02977-AGP] [OTN] []
        // Row: [Offense Date] [Code Section] [Description] [Type] [Counts] [Bond]  ← header
        // Row: [N/A] [OCGA16-8-2] [Theft by Taking (Felony)] [Felony Indicted] [1] [$0.00]  ← data
        // Row: [Disposition] [Felony Sentence]
        // Row: [Bond Amount] [$0.00]
        // Row: [Bond Status] [Sentenced/NO BOND] [$0.00]

        const charges = [];
        let currentCharge = null;
        let inChargesSection = false;
        let chargeRowHeaders = [];

        for (const row of allRows) {
          const cells = Array.from(row.querySelectorAll('td, th')).map(c => clean(c.innerText)).filter(c => c);
          const cellsLower = cells.map(c => c.toLowerCase());
          const joined = cellsLower.join(' ');

          // Detect start of charges section
          if (!inChargesSection && joined === 'charges') {
            inChargesSection = true;
            continue;
          }
          if (!inChargesSection) continue;

          // Detect end of charges section
          if (joined.includes('release information') || joined.includes('not released')) {
            if (currentCharge) charges.push(currentCharge);
            currentCharge = null;
            break;
          }

          // Warrant row starts a new charge group
          if (cellsLower[0] === 'warrant' && cells[1] && cells[1] !== 'Date') {
            if (currentCharge) charges.push(currentCharge);
            currentCharge = { warrant: cells[1], warrantDate: cells[3] || '', counts: cells[4] || '' };
            continue;
          }

          // Case row
          if (cellsLower[0] === 'case' && currentCharge) {
            currentCharge.caseNumber = cells[1] || '';
            continue;
          }

          // Charge header row: Offense Date | Code Section | Description | Type | Counts | Bond
          if (cellsLower.includes('offense date') && cellsLower.includes('description')) {
            chargeRowHeaders = cellsLower;
            continue;
          }

          // Charge data row (follows header row)
          if (chargeRowHeaders.length > 0 && currentCharge && cells.length >= 3) {
            const offIdx = chargeRowHeaders.indexOf('offense date');
            const codeIdx = chargeRowHeaders.indexOf('code section');
            const descIdx = chargeRowHeaders.indexOf('description');
            const typeIdx = chargeRowHeaders.indexOf('type');
            const cntIdx = chargeRowHeaders.indexOf('counts');
            const bondIdx = chargeRowHeaders.indexOf('bond');

            if (offIdx >= 0)  currentCharge.offenseDate  = cells[offIdx] || '';
            if (codeIdx >= 0) currentCharge.statute       = cells[codeIdx] || '';
            if (descIdx >= 0) currentCharge.description   = cells[descIdx] || '';
            if (typeIdx >= 0) currentCharge.type          = cells[typeIdx] || '';
            if (cntIdx >= 0)  currentCharge.counts        = cells[cntIdx] || '';
            if (bondIdx >= 0) currentCharge.bond          = cells[bondIdx] || '';
            chargeRowHeaders = [];
            continue;
          }

          // Disposition row
          if (cellsLower[0] === 'disposition' && currentCharge) {
            currentCharge.disposition = cells[1] || cells.slice(1).join(' ') || '';
            continue;
          }

          // Bond amount row
          if (joined.includes('bond amount') && currentCharge) {
            currentCharge.bondAmount = cells[cells.length - 1] || '';
            continue;
          }

          // Bond status row
          if (joined.includes('bond status') && currentCharge) {
            currentCharge.bondStatus = cells.find(c => c && !c.toLowerCase().includes('bond status') && c !== '$0.00') || '';
            currentCharge.bondAmount = currentCharge.bondAmount || cells[cells.length - 1] || '';
            continue;
          }
        }

        if (currentCharge) charges.push(currentCharge);
        result.charges = charges;

        return result;
      });

      // Log final result
      console.log(`[scrape] arrestDate:${bookingData.arrestDate} height:${bookingData.height} weight:${bookingData.weight} attorney:${bookingData.attorney} charges:${bookingData.charges.length} bondStatus:${bookingData.bondStatus} releaseDate:${bookingData.releaseDate}`);
      bookingData.charges.forEach((c, i) => console.log(`[scrape] Charge ${i+1}: ${JSON.stringify(c)}`));
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
