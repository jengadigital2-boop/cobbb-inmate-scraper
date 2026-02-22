const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
// Optional: set a secret token to prevent public abuse
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'cobb-inmate-scraper' }));

// ── Main scrape endpoint ──────────────────────────────────
// POST /scrape  { "name": "Rankin Shawn", "mode": "In+Custody" }
app.post('/scrape', async (req, res) => {

  // Auth check (optional but recommended)
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

    // ── Step 1: Load the search form ────────────────────────
    console.log(`[scrape] Loading search form for: ${name}`);
    await page.goto('http://inmate-search.cobbsheriff.org/enter_name.shtm', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // ── Step 2: Submit search via the actual form ───────────
    // Fill form fields and submit — this establishes a proper server session
    await page.goto(
      `http://inmate-search.cobbsheriff.org/inquiry.asp?soid=&inmate_name=${encodeURIComponent(name)}&serial=&qry=${mode}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // ── Step 3: Parse the results list ──────────────────────
    const listData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const inmates = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (cells.length >= 6 && /^\d{9}$/.test(cells[6] || '')) {
          inmates.push({
            name:          cells[1] || '',
            dob:           cells[2] || '',
            race:          cells[3] || '',
            sex:           cells[4] || '',
            location:      cells[5] || '',
            soid:          cells[6] || '',
            daysInCustody: cells[7] || '',
          });
        }
      }
      return inmates;
    });

    if (!listData || listData.length === 0) {
      await browser.close();
      return res.json({
        found: false,
        name,
        message: 'No matching records found in results table.',
        scrapedAt: new Date().toISOString()
      });
    }

    const firstInmate = listData[0];
    console.log(`[scrape] Found: ${firstInmate.name} (SOID: ${firstInmate.soid})`);

    // ── Step 4: Click "Last Known Booking" button ───────────
    let bookingData = null;
    let clickError = null;

    try {
      // Dump all buttons/inputs on the page for debugging
      const allButtons = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, button, a'));
        return inputs.map(el => ({
          tag: el.tagName,
          type: el.type || '',
          value: el.value || '',
          text: el.innerText || '',
          onclick: el.getAttribute('onclick') || '',
          href: el.href || ''
        }));
      });
      console.log('[scrape] All clickable elements:', JSON.stringify(allButtons));

      // Try to find and extract BOOKING_ID from any onclick handlers
      let bookingId = '';
      let soidFromPage = firstInmate.soid;
      for (const el of allButtons) {
        const combined = el.onclick + el.href + el.value + el.text;
        const bidMatch = combined.match(/BOOKING_ID[=,\s'"]+(\d{10,})/i);
        if (bidMatch) { bookingId = bidMatch[1]; break; }
        const longNum = combined.match(/[^\d](\d{14,})[^\d]/);
        if (longNum) { bookingId = longNum[1]; break; }
      }

      if (bookingId) {
        // We found a BOOKING_ID — navigate directly to the detail page
        const paddedSoid = soidFromPage + '    ';
        const detailUrl = `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}&BOOKING_ID=${bookingId}`;
        console.log(`[scrape] Navigating directly with BOOKING_ID: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        // No BOOKING_ID found — try clicking every button and check if we land on detail page
        const btnSelectors = [
          'input[value*="Last Known"]',
          'input[value*="Booking"]',
          'input[value*="Detail"]',
          'input[value*="View"]',
          'a:has-text("Last Known")',
          'a:has-text("Booking")',
          'button:has-text("Booking")',
          'input[type="submit"]',
          'input[type="button"]'
        ];

        let clicked = false;
        for (const sel of btnSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn) {
              const val = await btn.evaluate(el => el.value || el.innerText || '');
              console.log(`[scrape] Trying button: ${sel} = "${val}"`);
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
                btn.click()
              ]);
              // Check if we landed on the detail page
              const newUrl = page.url();
              if (newUrl.includes('InmDetails')) {
                clicked = true;
                console.log(`[scrape] Success! Landed on: ${newUrl}`);
                break;
              }
            }
          } catch (e) {
            console.log(`[scrape] Button attempt failed: ${sel} — ${e.message}`);
          }
        }

        if (!clicked) {
          // Last resort: try the SOID-only URL with a fresh page load
          // The site sometimes accepts this if a session exists
          const paddedSoid = soidFromPage + '    ';
          const fallbackUrl = `http://inmate-search.cobbsheriff.org/InmDetails.asp?soid=${encodeURIComponent(paddedSoid)}`;
          console.log(`[scrape] All buttons failed, trying SOID-only URL: ${fallbackUrl}`);
          await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      }
    } catch (e) {
      clickError = e.message;
      console.error(`[scrape] Navigation error: ${e.message}`);
    }

    // ── Step 5: Parse the booking detail page ───────────────
    const detailUrl = page.url();
    const pageTitle = await page.title();
    const isDetailPage = (
      detailUrl.includes('InmDetails') ||
      pageTitle.toLowerCase().includes('booking') ||
      await page.$('text=Agency ID') !== null ||
      await page.$('text=Arrest') !== null
    );

    console.log(`[scrape] Detail page URL: ${detailUrl}, isDetail: ${isDetailPage}`);

    if (isDetailPage) {
      bookingData = await page.evaluate(() => {
        function clean(str) {
          return (str || '').replace(/\s+/g, ' ').trim();
        }

        // Build a key→value map from the table
        const kv = {};
        const rows = Array.from(document.querySelectorAll('table tr'));
        let lastHeaders = [];

        for (const row of rows) {
          const ths = Array.from(row.querySelectorAll('th')).map(c => clean(c.innerText));
          const tds = Array.from(row.querySelectorAll('td')).map(c => clean(c.innerText));

          if (ths.length > 0) {
            lastHeaders = ths;
            continue;
          }
          if (lastHeaders.length >= 2 && tds.length >= 2) {
            lastHeaders.forEach((h, i) => {
              if (h && tds[i]) kv[h.toLowerCase().replace(/:$/, '').trim()] = tds[i];
            });
            lastHeaders = [];
            continue;
          }
          if (tds.length === 2 && tds[0] && tds[1]) {
            kv[tds[0].toLowerCase().replace(/:$/, '').trim()] = tds[1];
          }
          if (tds.length >= 4) {
            if (tds[0] && tds[1]) kv[tds[0].toLowerCase().replace(/:$/, '').trim()] = tds[1];
            if (tds[2] && tds[3]) kv[tds[2].toLowerCase().replace(/:$/, '').trim()] = tds[3];
          }
        }

        // Parse charges table
        const charges = [];
        let inCharges = false;
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td,th')).map(c => clean(c.innerText));
          const joined = cells.join(' ').toLowerCase();
          if (joined.includes('charge') && (joined.includes('bond') || joined.includes('statute'))) {
            inCharges = true;
            continue;
          }
          if (inCharges && cells[0] && cells[0].length > 3 && !/^(charge|bond|statute|type|description)/i.test(cells[0])) {
            charges.push({
              description: cells[0],
              statute:     cells[1] || '',
              bond:        cells.find(c => /\$[\d,]/.test(c) || /^\d{1,8}\.\d{2}$/.test(c)) || '',
              type:        cells[3] || ''
            });
          }
        }

        const get = (...keys) => {
          for (const k of keys) {
            // Exact match first
            if (kv[k]) return kv[k];
            // Partial match
            const fk = Object.keys(kv).find(x => x.includes(k.toLowerCase()));
            if (fk) return kv[fk];
          }
          return '';
        };

        // Fix offset issue: the site layout has headers and values in adjacent rows
        // Re-parse specifically looking for the physical description block
        // by scanning for known header patterns
        const allText = Object.entries(kv).map(([k,v]) => `${k}::${v}`).join(' | ');
        console.log('[scrape] KV pairs:', allText);

        // ── Charges: this site uses a flat list of fields per charge ──
        // Keys seen: 'offense date', 'description', 'bond amount', 'case',
        // 'warrant', 'warrant date', 'disposition', 'location of arrest'
        // Charges are NOT in a traditional table — they're flat kv rows.
        // We'll collect them by scanning for 'description' keys and pairing with nearby fields.
        const chargesFinal = [];
        const kvEntries = Object.entries(kv);
        for (let i = 0; i < kvEntries.length; i++) {
          const [k, v] = kvEntries[i];
          if (k === 'description' || k.includes('description')) {
            // Found a charge description — grab surrounding fields
            const charge = { description: v };
            // Look back and ahead for related fields
            for (let j = Math.max(0, i-3); j < Math.min(kvEntries.length, i+5); j++) {
              const [kj, vj] = kvEntries[j];
              if (kj.includes('bond')) charge.bond = vj;
              if (kj.includes('offense date') || kj.includes('offense')) charge.offenseDate = vj;
              if (kj.includes('warrant') && !kj.includes('date')) charge.warrant = vj;
              if (kj.includes('case')) charge.case = vj;
              if (kj.includes('disposition')) charge.disposition = vj;
              if (kj.includes('statute')) charge.statute = vj;
            }
            chargesFinal.push(charge);
          }
        }

        // Also keep old charge table parsing as fallback
        const finalCharges = chargesFinal.length > 0 ? chargesFinal : charges;

        return {
          agencyId:        get('arrest agency', 'agency id', 'agency'),
          arrestDate:      get('offense date', 'arrest date/time', 'arrest date'),
          bookingStarted:  get('booking started', 'booking start'),
          bookingComplete: get('booking complete', 'booking end'),
          height:          get('height'),
          weight:          get('weight'),
          hair:            get('hair'),
          eyes:            get('eyes'),
          address:         get('address'),
          city:            get('city'),
          state:           get('state'),
          zip:             get('zip'),
          placeOfBirth:    get('place of birth'),
          courtroom:       get('superior courtroom', 'courtroom', 'court'),
          locationOfArrest: get('location of arrest'),
          charges:         finalCharges,
          rawKvKeys:       Object.keys(kv)  // debug — remove once stable
        };
      });
    }

    await browser.close();

    return res.json({
      found: true,
      name,
      totalFound: listData.length,
      scrapedAt: new Date().toISOString(),
      gotDetailPage: isDetailPage,
      detailUrl,
      inmate: {
        ...firstInmate,
        ...(bookingData || {}),
      },
      debugInfo: {
        pageTitle,
        isDetailPage,
        clickError,
        rawKvKeys: bookingData?.rawKvKeys || []
      }
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

app.listen(PORT, () => console.log(`Cobb scraper listening on port ${PORT}`));
