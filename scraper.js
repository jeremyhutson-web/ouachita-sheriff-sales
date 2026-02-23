const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://sheriffsaleonline.azurewebsites.net/sheriffsaledates/ouachita';
const GOOGLE_API_KEY = 'AIzaSyDEygkgPdiRYpNJmL4fnHwpFHI5EWv-TwM';

async function geocode(address) {
  const fullAddress = address.includes('LA') ? address : `${address}, Louisiana`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&key=${GOOGLE_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results[0]) {
      return {
        lat: data.results[0].geometry.location.lat,
        lng: data.results[0].geometry.location.lng,
        formatted: data.results[0].formatted_address
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function parseListingsFromText(text, saleDate) {
  const listings = [];
  const lines = text.split('\n');

  for (const line of lines) {
    // Look for suit number pattern like 37-C-20233941
    const suitMatch = line.match(/(\d{2}-[A-Z]-\d+)\s+(.+)/);
    if (suitMatch) {
      const suitNumber = suitMatch[1];
      const restOfLine = suitMatch[2];

      // Extract address - look for pattern like "123 STREET NAME CITY, LA 71XXX"
      const addressMatch = restOfLine.match(/(\d+\s+[A-Z][A-Z0-9\s\.]+(?:DRIVE|DR|ROAD|RD|STREET|ST|AVENUE|AVE|LANE|LN|COURT|CT|CIRCLE|CIR|BLVD|HWY|WAY|LOOP)[A-Z0-9\s,\.]*LA[.\s]*\d{5})/i);

      if (addressMatch) {
        const address = addressMatch[1].trim().replace(/\s+/g, ' ').replace(/,\s*,/g, ',');

        // Extract bids
        const bidMatch = restOfLine.match(/\$[\d,]+\.\d{2}/g);
        const startingBid = bidMatch ? bidMatch[0] : '';
        const writAmount = bidMatch && bidMatch[1] ? bidMatch[1] : '';

        // Extract plaintiff vs defendant
        const vsMatch = restOfLine.match(/(.+?)\s+(?:vs|VS|v\.)\s+(.+?)(?:\s+PENDING|\s+ACTIVE|\s+\d+\s+[A-Z])/i);

        listings.push({
          suitNumber,
          plaintiff: vsMatch ? vsMatch[1].trim() : '',
          defendant: vsMatch ? vsMatch[2].trim() : '',
          address,
          status: 'PENDING',
          startingBid,
          writAmount,
          saleDate
        });
      }
    }
  }

  return listings;
}

async function scrape() {
  console.log('Starting scraper...');
  console.log(`Source: ${URL}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  const allListings = new Map(); // Use map to dedupe by suit number
  const allSaleDates = [];

  try {
    console.log('Loading main page...');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Get all sale dates from the dropdown
    const saleDates = await page.evaluate(() => {
      const select = document.querySelector('#selDate');
      if (!select) return [];
      return Array.from(select.options).map(opt => ({
        value: opt.value,
        label: opt.label || opt.text
      }));
    });

    console.log(`Found ${saleDates.length} sale dates: ${saleDates.map(d => d.label).join(', ')}\n`);

    // Function to parse listings from the table DOM
    async function parseListingsFromPage(saleDate) {
      return await page.evaluate((date) => {
        const listings = [];
        const rows = document.querySelectorAll('table.table tbody tr');

        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 7) continue; // Skip header row

          const suitNumber = cells[1]?.textContent?.trim() || '';
          const titleLink = cells[2]?.querySelector('a');
          const title = titleLink?.textContent?.trim() || '';
          const detailUrl = titleLink?.href || '';
          const status = cells[3]?.textContent?.trim() || '';
          const address = cells[4]?.textContent?.trim().replace(/\s+/g, ' ') || '';
          const startingBid = cells[5]?.textContent?.trim() || '';
          const writAmount = cells[6]?.textContent?.trim() || '';

          // Parse plaintiff vs defendant from title
          const vsMatch = title.match(/(.+?)\s+(?:vs|VS|v\.)\s+(.+)/i);

          if (suitNumber && address) {
            listings.push({
              suitNumber,
              plaintiff: vsMatch ? vsMatch[1].trim() : '',
              defendant: vsMatch ? vsMatch[2].trim() : '',
              address,
              status,
              startingBid,
              writAmount,
              saleDate: date,
              detailUrl
            });
          }
        }

        return listings;
      }, saleDate);
    }

    // Scrape each sale date by selecting from dropdown
    for (let i = 0; i < saleDates.length; i++) {
      const { value, label } = saleDates[i];
      allSaleDates.push(label);

      console.log(`[${i + 1}/${saleDates.length}] Scraping ${label}...`);

      try {
        // Select the date in the dropdown
        await page.select('#selDate', value);

        // Wait for AngularJS to update the table
        await new Promise(r => setTimeout(r, 2000));

        const listings = await parseListingsFromPage(label);

        let newCount = 0;
        for (const l of listings) {
          if (!allListings.has(l.suitNumber)) {
            allListings.set(l.suitNumber, l);
            newCount++;
          }
        }

        console.log(`  Found ${listings.length} listings (${newCount} new)`);

      } catch (err) {
        console.log(`  Error: ${err.message}`);
      }

      // Small delay between requests
      await new Promise(r => setTimeout(r, 500));
    }

    // If no dates found, just scrape current page
    if (saleDates.length === 0) {
      console.log('No date dropdown found, scraping current page...');
      const listings = await parseListingsFromPage('Unknown');
      for (const l of listings) {
        allListings.set(l.suitNumber, l);
      }
    }

    const listings = Array.from(allListings.values());

    console.log(`\n========================================`);
    console.log(`Total unique listings: ${listings.length}`);
    console.log(`Sale dates: ${allSaleDates.join(', ')}`);
    console.log(`========================================\n`);

    // Geocode addresses
    if (listings.length > 0) {
      console.log('Geocoding addresses...\n');

      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        console.log(`[${i + 1}/${listings.length}] ${listing.address}`);

        const coords = await geocode(listing.address);
        if (coords) {
          listing.lat = coords.lat;
          listing.lng = coords.lng;
          listing.formattedAddress = coords.formatted;
          console.log(`  ✓ ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
        } else {
          console.log(`  ✗ Could not geocode`);
        }

        await new Promise(r => setTimeout(r, 250));
      }
    }

    // Save output with Street View image URLs
    const output = {
      scrapedAt: new Date().toISOString(),
      source: URL,
      saleDates: allSaleDates,
      count: listings.length,
      listings: listings.map(l => ({
        suitNumber: l.suitNumber,
        plaintiff: l.plaintiff,
        defendant: l.defendant,
        address: l.address,
        formattedAddress: l.formattedAddress || l.address,
        status: l.status,
        startingBid: l.startingBid,
        writAmount: l.writAmount,
        saleDate: l.saleDate,
        url: URL,
        lat: l.lat || null,
        lng: l.lng || null,
        streetViewUrl: l.lat && l.lng
          ? `https://maps.googleapis.com/maps/api/streetview?size=400x250&location=${l.lat},${l.lng}&key=${GOOGLE_API_KEY}`
          : null
      }))
    };

    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'data', 'listings.json'), JSON.stringify(output, null, 2));
    console.log(`\nSaved ${listings.length} listings`);

    return output;

  } finally {
    await browser.close();
  }
}

// Run
scrape()
  .then(data => {
    console.log(`\n✓ Done! ${data.count} properties from ${data.saleDates.length} sale dates.`);
    const mapped = data.listings.filter(l => l.lat && l.lng).length;
    console.log(`✓ ${mapped} geocoded and ready for map.`);
  })
  .catch(err => {
    console.error('Failed:', err);
    process.exit(1);
  });

module.exports = { scrape };
