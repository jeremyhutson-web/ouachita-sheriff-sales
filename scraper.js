require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://sheriffsaleonline.azurewebsites.net';
const CLIENT = 'ouachita';
const PROPERTY_TYPE_REAL_ESTATE = 6;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Status tracking for the server to read
const STATUS_FILE = path.join(__dirname, 'data', 'scrape-status.json');

function updateStatus(status) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getSaleDates() {
  const url = `${BASE_URL}/api/SheriffSaleDates/GetDates?client=${CLIENT}&propertyType=${PROPERTY_TYPE_REAL_ESTATE}`;
  return fetchJSON(url);
}

async function getSaleList(dateStr) {
  const url = `${BASE_URL}/api/SheriffSaleDates/GetList?client=${CLIENT}&propertyType=${PROPERTY_TYPE_REAL_ESTATE}&strSalesDate=${encodeURIComponent(dateStr)}`;
  return fetchJSON(url);
}

async function getSaleDetails(suitSheriffSaleId) {
  const url = `${BASE_URL}/api/SheriffSaleDetails/GetSaleDetails?client=${CLIENT}&suitSheriffSaleId=${suitSheriffSaleId}`;
  return fetchJSON(url);
}

function cleanAddress(raw) {
  let addr = raw
    .replace(/\r\n/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  // Skip vacant lots and mobile homes
  if (/^0\s/.test(addr)) return null;
  if (/SERIAL|MOBILE HOME|BEARING/i.test(addr)) return null;

  // If multiple addresses concatenated (some listings have several), take the first
  const parts = addr.split(/\s+(?=\d+\s+[A-Z])/);
  if (parts.length > 1) {
    // Find first part that looks like a full address with zip
    const full = parts.find(p => /\d{5}/.test(p));
    if (full) addr = full.trim();
  }

  return addr;
}

async function geocode(address) {
  const cleanAddr = cleanAddress(address);
  if (!cleanAddr) return null;

  // US Census Geocoder - free, no API key, excellent for US addresses
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(cleanAddr)}&benchmark=Public_AR_Current&format=json`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const match = data?.result?.addressMatches?.[0];
    if (match) {
      return {
        lat: match.coordinates.y,
        lng: match.coordinates.x,
        formatted: match.matchedAddress
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function formatDate(isoDate) {
  // API returns "2026-04-22T00:00:00" — parse directly to avoid timezone shifts
  const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return isoDate;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parseCurrency(val) {
  if (!val && val !== 0) return null;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function formatCurrency(val) {
  if (val === null || val === undefined) return '';
  return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function scrape() {
  console.log('Starting scraper (direct API)...');
  console.log(`Source: ${BASE_URL}\n`);
  updateStatus({ phase: 'starting', message: 'Connecting to sheriff sale API...' });

  // Load existing geocode cache to avoid re-geocoding known addresses
  const cacheFile = path.join(__dirname, 'data', 'geocode-cache.json');
  let geocodeCache = {};
  try {
    if (fs.existsSync(cacheFile)) {
      geocodeCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch (e) { /* ignore */ }

  const allListings = new Map();
  const allSaleDates = [];

  try {
    // Step 1: Get sale dates
    updateStatus({ phase: 'dates', message: 'Fetching sale dates...' });
    const dates = await getSaleDates();
    console.log(`Found ${dates.length} sale dates\n`);

    if (dates.length === 0) {
      updateStatus({ phase: 'done', message: 'No upcoming sale dates found.', count: 0 });
      return { listings: [], saleDates: [], count: 0 };
    }

    // Step 2: Fetch listings for each date
    for (let i = 0; i < dates.length; i++) {
      // API returns objects like {saleDate: "2026-04-22T00:00:00"}
      const rawDate = typeof dates[i] === 'object' ? dates[i].saleDate : dates[i];
      const dateStr = formatDate(rawDate);
      allSaleDates.push(dateStr);

      updateStatus({
        phase: 'listings',
        message: `Fetching listings for ${dateStr}...`,
        progress: { current: i + 1, total: dates.length }
      });
      console.log(`[${i + 1}/${dates.length}] Fetching ${dateStr}...`);

      try {
        const items = await getSaleList(dateStr);
        let newCount = 0;

        for (const item of items) {
          const key = item.suitNumberDisplay || item.suitNumber;
          if (!allListings.has(key)) {
            // Parse plaintiff vs defendant from title
            const vsMatch = (item.suitTitle || '').match(/(.+?)\s+(?:vs|VS|v\.)\s+(.+)/i);

            allListings.set(key, {
              suitNumber: item.suitNumberDisplay || item.suitNumber,
              suitSheriffSaleId: item.suitSheriffSaleID,
              plaintiff: vsMatch ? vsMatch[1].trim() : '',
              defendant: vsMatch ? vsMatch[2].trim() : '',
              address: (item.physicalAddress || '').replace(/\r\n/g, ' ').replace(/\s+/g, ' ').trim(),
              status: item.description || 'PENDING',
              startingBid: parseCurrency(item.startingBid),
              writAmount: parseCurrency(item.writAmount),
              saleDate: dateStr,
              detailUrl: `${BASE_URL}/sheriffsaledetails/${CLIENT}?suitSheriffSaleId=${item.suitSheriffSaleID}`
            });
            newCount++;
          }
        }

        console.log(`  Found ${items.length} listings (${newCount} new)`);
      } catch (err) {
        console.log(`  Error fetching ${dateStr}: ${err.message}`);
      }

      // Small delay between requests
      await new Promise(r => setTimeout(r, 200));
    }

    const listings = Array.from(allListings.values());

    console.log(`\n========================================`);
    console.log(`Total unique listings: ${listings.length}`);
    console.log(`Sale dates: ${allSaleDates.join(', ')}`);
    console.log(`========================================\n`);

    // Step 3: Geocode addresses
    if (listings.length > 0 && GOOGLE_API_KEY) {
      console.log('Geocoding addresses...\n');

      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        updateStatus({
          phase: 'geocoding',
          message: `Geocoding ${i + 1} of ${listings.length}...`,
          progress: { current: i + 1, total: listings.length }
        });

        // Check cache first
        const cacheKey = listing.address.toUpperCase().trim();
        if (geocodeCache[cacheKey]) {
          listing.lat = geocodeCache[cacheKey].lat;
          listing.lng = geocodeCache[cacheKey].lng;
          listing.formattedAddress = geocodeCache[cacheKey].formatted;
          console.log(`[${i + 1}/${listings.length}] ${listing.address} (cached)`);
        } else {
          console.log(`[${i + 1}/${listings.length}] ${listing.address}`);
          const coords = await geocode(listing.address);
          if (coords) {
            listing.lat = coords.lat;
            listing.lng = coords.lng;
            listing.formattedAddress = coords.formatted;
            geocodeCache[cacheKey] = coords;
            console.log(`  -> ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
          } else {
            console.log(`  -> Could not geocode`);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Save geocode cache
      fs.writeFileSync(cacheFile, JSON.stringify(geocodeCache, null, 2));
    }

    // Step 4: Save output
    updateStatus({ phase: 'saving', message: 'Saving data...' });

    const output = {
      scrapedAt: new Date().toISOString(),
      source: `${BASE_URL}/sheriffsaledates/${CLIENT}`,
      saleDates: allSaleDates,
      count: listings.length,
      listings: listings.map(l => ({
        suitNumber: l.suitNumber,
        suitSheriffSaleId: l.suitSheriffSaleId,
        plaintiff: l.plaintiff,
        defendant: l.defendant,
        address: l.address,
        formattedAddress: l.formattedAddress || l.address,
        status: l.status,
        startingBid: formatCurrency(l.startingBid),
        startingBidRaw: l.startingBid,
        writAmount: formatCurrency(l.writAmount),
        writAmountRaw: l.writAmount,
        saleDate: l.saleDate,
        detailUrl: l.detailUrl,
        lat: l.lat || null,
        lng: l.lng || null,
        streetViewUrl: l.lat && l.lng
          ? `https://maps.googleapis.com/maps/api/streetview?size=600x300&location=${l.lat},${l.lng}&key=${GOOGLE_API_KEY}`
          : null
      }))
    };

    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'data', 'listings.json'), JSON.stringify(output, null, 2));

    updateStatus({ phase: 'done', message: `Scraped ${listings.length} listings from ${allSaleDates.length} sale dates.`, count: listings.length });
    console.log(`\nSaved ${listings.length} listings`);

    return output;

  } catch (err) {
    updateStatus({ phase: 'error', message: err.message });
    throw err;
  }
}

// Run if called directly
if (require.main === module) {
  scrape()
    .then(data => {
      console.log(`\nDone! ${data.count} properties from ${data.saleDates.length} sale dates.`);
      const mapped = data.listings.filter(l => l.lat && l.lng).length;
      console.log(`${mapped} geocoded and ready for map.`);
    })
    .catch(err => {
      console.error('Failed:', err);
      process.exit(1);
    });
}

module.exports = { scrape };
