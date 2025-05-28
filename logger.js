// logger.js
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const LOGS_DIR = path.join(__dirname, 'logs');
const MAX_LOG_FILES = 30; // Keep last 30 log files

// Ensure logs directory exists
fs.ensureDirSync(LOGS_DIR);

function getCurrentLogFile() {
  const date = new Date();
  const dateString = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
  return path.join(LOGS_DIR, `app-${dateString}.log`);
}

async function cleanupOldLogs() {
  try {
    const files = await fs.readdir(LOGS_DIR);
    if (files.length > MAX_LOG_FILES) {
      const sortedFiles = files
        .map(file => ({ file, time: fs.statSync(path.join(LOGS_DIR, file)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time)
        .map(f => f.file);
      
      const filesToDelete = sortedFiles.slice(MAX_LOG_FILES);
      for (const file of filesToDelete) {
        await fs.unlink(path.join(LOGS_DIR, file));
      }
    }
  } catch (err) {
    console.error('Log cleanup error:', err);
  }
}

function log(level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logId = uuidv4();
  const logEntry = JSON.stringify({
    logId,
    timestamp,
    level,
    message,
    ...metadata
  });

  const logFile = getCurrentLogFile();
  
  fs.appendFile(logFile, logEntry + '\n', (err) => {
    if (err) console.error('Failed to write log:', err);
  });

  // Also output to console in development
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${timestamp}] [${level}] ${message}`);
  }
}

module.exports = {
  info: (message, metadata) => log('INFO', message, metadata),
  error: (message, metadata) => log('ERROR', message, metadata),
  warn: (message, metadata) => log('WARN', message, metadata),
  debug: (message, metadata) => log('DEBUG', message, metadata),
  cleanupOldLogs
};