const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const axios = require("axios");
const { PDFDocument } = require("pdf-lib");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "pages");

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
  console.log(`Auto-scroll complete.`);
}

async function run() {
  await fs.ensureDir(OUTPUT_DIR);

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const imageRequests = [];

  page.on("request", (req) => {
    const url = req.url();
    if (
      url.includes("viewerng/img") &&
      url.includes("page=") &&
      url.includes("webp=")
    ) {
      const finalURL = url.replace("webp=true", "webp=false").replace(/w=\d+/, "w=2400");
      if (!imageRequests.includes(finalURL)) {
        imageRequests.push(finalURL);
      }
    }
  });

  // Go to your specific view-only Google Drive PDF
  // Replace your URL here
  await page.goto("https://drive.google.com/file/d/1hNc_XKVN60IJWp4askQ1WbnxudVFl8zF/view", {
    waitUntil: "networkidle2",
  });

  // Scroll slowly to trigger all pages
  console.log("Scrolling to load all pages...");
  const totalPages = await countTotalPages(page);
  console.log(`Total PDF pages: ${totalPages}`);
  await autoScroll(page, totalPages*2, 500);
  await page.waitForTimeout ? await page.waitForTimeout(2000) : await new Promise(res => setTimeout(res, 2000));
  console.log(`Found ${imageRequests.length} image URLs.`);

  // Download images
  const downloadedImages = [];
  for (let i = 0; i < imageRequests.length; i++) {
    const url = imageRequests[i];
    const res = await axios.get(url, { responseType: "arraybuffer" });
    const filename = path.join(OUTPUT_DIR, `page_${i + 1}.png`);
    await fs.writeFile(filename, res.data);
    downloadedImages.push(filename);
    console.log(`Downloaded page ${i + 1}`);
  }

  // Combine into PDF
  console.log('Combining into PDF ...')
  const pdfDoc = await PDFDocument.create();
  for (const imgPath of downloadedImages) {
    const imgBytes = await fs.readFile(imgPath);
    const pngImage = await pdfDoc.embedPng(imgBytes);
    const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: pngImage.width,
      height: pngImage.height,
    });
  }

  const pdfBytes = await pdfDoc.save();
  await fs.writeFile("output.pdf", pdfBytes);
  console.log("✅ Saved as output.pdf");

  await browser.close();
}

run();
