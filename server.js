const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Get listings
app.get('/api/listings', (req, res) => {
  const file = path.join(__dirname, 'data', 'listings.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else {
    res.json({ listings: [], count: 0 });
  }
});

// Trigger scrape
app.post('/api/scrape', (req, res) => {
  res.json({ status: 'started' });

  const scraper = spawn('node', ['scraper.js'], { cwd: __dirname });
  scraper.stdout.on('data', d => console.log(d.toString()));
  scraper.stderr.on('data', d => console.error(d.toString()));
});

// Serve app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════════════╗
  ║   Ouachita Parish Sheriff Sales Map                ║
  ║   http://localhost:${PORT}                            ║
  ╚════════════════════════════════════════════════════╝
  `);
});
