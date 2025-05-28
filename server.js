// server.js
const express = require('express');
require('dotenv').config()
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const axios = require('axios');
const puppeteer = require('puppeteer');
const logger = require('./logger');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Logger initialize
app.use((req, res, next) => {
  const requestId = uuidv4();
  req.requestId = requestId;
  
  logger.info('Request started', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    requestId
  });
  
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request completed', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      requestId
    });
  });
  
  next();
});


const JOBS_DIR = path.join(__dirname, 'jobs');
const PORT = process.env.PORT || 3000;

// Queue system
const jobs = {};

// Count the amount of pages
async function countTotalPages(page) {
  try {
    // Wait for the page counter element to load
    await page.waitForSelector('.ndfHFb-c4YZDc-DARUcf-NnAfwf-j4LONd', { timeout: 10000 });
    
    const totalPages = await page.evaluate(() => {
      const pageCounter = document.querySelector('.ndfHFb-c4YZDc-DARUcf-NnAfwf-j4LONd');
      if (pageCounter) {
        // The text is typically in format "1 of 25" where 25 is total pages
        const text = pageCounter.textContent.trim();
        const match = text.match(/(\d+)\s*of\s*(\d+)/i);
        
        if (match && match[2]) {
          return parseInt(match[2], 10);
        }
        
        // Alternative check if the format is different
        const numberMatch = text.match(/\d+/);
        if (numberMatch) {
          return parseInt(numberMatch[0], 10);
        }
      }
      return 0;
    });
    
    return totalPages;
  } catch (error) {
    console.error('Error counting pages:', error);
    return 0;
  }
}


async function autoScroll(page, scrollTimes, delay) {
  for (let i = 0; i < scrollTimes; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout ? await page.waitForTimeout(delay) : await new Promise(res => setTimeout(res, delay));
  }
}


async function processPdfJob(jobId, driveUrl) {
  let browser = null;
  try {
    jobs[jobId].status = 'processing';
    logger.info('PDF processing started', { jobId, driveUrl });
    
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      executablePath: process.env.NODE_ENV === 'production' 
        ? await chrome.executablePath
        : '/usr/bin/google-chrome',
      headless: 'new',
      ignoreHTTPSErrors: true
    });
    
    const page = await browser.newPage();
    const imageRequests = [];

    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("viewerng/img") && url.includes("page=") && url.includes("webp=")) {
        const finalURL = url.replace("webp=true", "webp=false").replace(/w=\d+/, "w=2400");
        if (!imageRequests.includes(finalURL)) {
          imageRequests.push(finalURL);
        }
      }
    });

    await page.goto(driveUrl, { waitUntil: "networkidle2" });
    
    const totalPages = await countTotalPages(page);
    logger.debug('Total pages detected', { jobId, totalPages });
  
    await autoScroll(page, totalPages*2, 500);
    await new Promise(res => setTimeout(res, 2000));
    
    // Download images
    const outputDir = path.join(JOBS_DIR, jobId);
    await fs.ensureDir(outputDir);
    
    const downloadedImages = [];
    logger.info(`Downloading ${imageRequests.length} pages`, { jobId });

    for (let i = 0; i < imageRequests.length; i++) {
      try {
      const url = imageRequests[i];
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const filename = path.join(outputDir, `page_${i + 1}.png`);
      await fs.writeFile(filename, res.data);
      downloadedImages.push(filename);
      logger.debug(`Downloaded page ${i + 1}`, { jobId, pageNumber: i + 1 });
      } catch (err) {
        logger.error('Failed to download page', { jobId, pageNumber: i + 1, error: err.message });
      }
    }

    // Combine into PDF
    logger.info('Combining images into PDF', { jobId, pageCount: downloadedImages.length });
    const pdfDoc = await PDFDocument.create();

    for (const imgPath of downloadedImages) {
      try {
      const imgBytes = await fs.readFile(imgPath);
      const pngImage = await pdfDoc.embedPng(imgBytes);
      const pdfPage = pdfDoc.addPage([pngImage.width, pngImage.height]);
      pdfPage.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pngImage.width,
        height: pngImage.height,
      });
      } catch (err) {
        logger.error('Failed to add page to PDF', { jobId, imgPath, error: err.message });
      }
    }

    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(outputDir, 'output.pdf');
    await fs.writeFile(outputPath, pdfBytes);
    
    jobs[jobId].status = 'completed';
    jobs[jobId].result = `/download/${jobId}`;

    logger.info('PDF processing completed', { 
      jobId,
      pageCount: downloadedImages.length,
      outputSize: `${(pdfBytes.length / (1024 * 1024)).toFixed(2)}MB`
    });

    await browser.close();
    
  } catch (error) {
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;

    logger.error('PDF processing failed', { 
      jobId,
      error: error.message,
      stack: error.stack 
    });
    console.error('Processing error:', error);
  } finally {
    if (browser) await browser.close();
  }
}

// API Endpoints
app.post('/api/convert', async (req, res) => {
  const { driveUrl } = req.body;
  if (!driveUrl) {
    return res.status(400).json({ error: 'Drive URL is required' });
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'queued',
    createdAt: new Date()
  };

  // Process in background
  processPdfJob(jobId, driveUrl);

  res.json({ jobId });
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

app.get('/download/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'completed') {
    return res.status(404).send('File not ready or not found');
  }
  
  const filePath = path.join(JOBS_DIR, req.params.id, 'output.pdf');
  res.download(filePath, 'converted.pdf', (err) => {
    if (err) {
      console.error('Download error:', err);
    }
    // Cleanup after download
    fs.remove(path.join(JOBS_DIR, req.params.id)).catch(console.error);
    delete jobs[req.params.id];
  });
});

// Log viewer endpoint
app.get('/api/logs', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const logFile = path.join(LOGS_DIR, `app-${date}.log`);
    
    if (await fs.pathExists(logFile)) {
      const logContent = await fs.readFile(logFile, 'utf8');
      const logs = logContent.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
      
      res.json(logs);
    } else {
      res.status(404).json({ error: 'No logs for this date' });
    }
  } catch (err) {
    logger.error('Failed to fetch logs', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Add basic auth to logs endpoint
app.use('/api/logs', (req, res, next) => {
  const auth = { login: process.env.LOG_USER, password: process.env.LOG_PASS};
  
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  
  if (login === auth.login && password === auth.password) {
    return next();
  }
  
  res.set('WWW-Authenticate', 'Basic realm="Logs"');
  return res.status(401).send('Authentication required');
});

// Modify your error handling
app.use((err, req, res, next) => {
  logger.error('Server error', {
    error: err.message,
    stack: err.stack,
    requestId: req.requestId
  });
  
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await fs.ensureDir(JOBS_DIR);
  await logger.cleanupOldLogs();
  setInterval(logger.cleanupOldLogs, 24 * 60 * 60 * 1000); // Daily cleanup
});