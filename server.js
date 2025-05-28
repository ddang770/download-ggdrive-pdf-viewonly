// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const axios = require('axios');
const puppeteer = require('puppeteer');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

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
  try {
    jobs[jobId].status = 'processing';
    
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
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
    await autoScroll(page, totalPages*2, 500);
    await new Promise(res => setTimeout(res, 2000));
    
    // Download images
    const outputDir = path.join(JOBS_DIR, jobId);
    await fs.ensureDir(outputDir);
    
    const downloadedImages = [];
    for (let i = 0; i < imageRequests.length; i++) {
      const url = imageRequests[i];
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const filename = path.join(outputDir, `page_${i + 1}.png`);
      await fs.writeFile(filename, res.data);
      downloadedImages.push(filename);
    }

    // Combine into PDF
    const pdfDoc = await PDFDocument.create();
    for (const imgPath of downloadedImages) {
      const imgBytes = await fs.readFile(imgPath);
      const pngImage = await pdfDoc.embedPng(imgBytes);
      const pdfPage = pdfDoc.addPage([pngImage.width, pngImage.height]);
      pdfPage.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pngImage.width,
        height: pngImage.height,
      });
    }

    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(outputDir, 'output.pdf');
    await fs.writeFile(outputPath, pdfBytes);
    
    jobs[jobId].status = 'completed';
    jobs[jobId].result = `/download/${jobId}`;
    await browser.close();
    
  } catch (error) {
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;
    console.error('Processing error:', error);
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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  fs.ensureDir(JOBS_DIR).catch(console.error);
});