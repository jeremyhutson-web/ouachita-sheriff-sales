require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

let scrapeProcess = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Get Maps API key
app.get('/api/config', (req, res) => {
  res.json({ mapsApiKey: GOOGLE_API_KEY });
});

// Get listings
app.get('/api/listings', (req, res) => {
  const file = path.join(__dirname, 'data', 'listings.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else {
    res.json({ listings: [], count: 0, saleDates: [] });
  }
});

// Get scrape status
app.get('/api/scrape/status', (req, res) => {
  const file = path.join(__dirname, 'data', 'scrape-status.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else {
    res.json({ phase: 'idle', message: 'No scrape in progress.' });
  }
});

// Trigger scrape
app.post('/api/scrape', (req, res) => {
  if (scrapeProcess) {
    return res.json({ status: 'already_running', message: 'A scrape is already in progress.' });
  }

  // Clear old status
  const statusFile = path.join(__dirname, 'data', 'scrape-status.json');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({ phase: 'starting', message: 'Starting scraper...', updatedAt: new Date().toISOString() }));

  scrapeProcess = spawn('node', ['scraper.js'], { cwd: __dirname, env: { ...process.env } });

  scrapeProcess.stdout.on('data', d => process.stdout.write(d));
  scrapeProcess.stderr.on('data', d => process.stderr.write(d));

  scrapeProcess.on('close', (code) => {
    scrapeProcess = null;
    if (code !== 0) {
      fs.writeFileSync(statusFile, JSON.stringify({
        phase: 'error',
        message: `Scraper exited with code ${code}`,
        updatedAt: new Date().toISOString()
      }));
    }
  });

  res.json({ status: 'started', message: 'Scrape started.' });
});

// Serve app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
  Ouachita Parish Sheriff Sales Map
  http://localhost:${PORT}
  `);
});
