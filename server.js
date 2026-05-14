const express = require('express');

const app = express();
const PORT = 3000;
const DEFAULT_SHEET_ID = '18ATEk4-2YihvjwxHRAaQNpVsOEaNP3a_S1QoPvT3fVQ';
const DEFAULT_GID = '1654060697';
const DEFAULT_SHEET_NAME = 'Data_1';

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Extract Sheet ID
function extractSheetId(sheetUrlOrId) {
  if (!sheetUrlOrId) return DEFAULT_SHEET_ID;
  const match = String(sheetUrlOrId).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(sheetUrlOrId).trim();
}

// Parse Google response
function parseGvizResponse(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Invalid Google Sheets response');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeHeader(value, index) {
  const label = String(value || '').trim();
  return label || `column_${String.fromCharCode(65 + index)}`;
}

function isDefaultHeader(header) {
  return /^column_[A-Z]$/i.test(header);
}

function hasCellValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function getCellValue(cell) {
  if (!cell) return null;
  if (hasCellValue(cell.v)) return cell.v;
  if (hasCellValue(cell.f)) return cell.f;
  return null;
}

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickRowValue(row) {
  if (!row || typeof row !== 'object') return null;

  const preferred = [row.Value, row.value, row.column_C, row.column_D, row.column_E];
  for (const candidate of preferred) {
    if (hasCellValue(candidate)) return candidate;
  }

  const excluded = new Set(['dbpage', 'matrixname', 'columna', 'columnb']);
  for (const [key, value] of Object.entries(row)) {
    if (excluded.has(normalizeKey(key))) continue;
    if (hasCellValue(value)) return value;
  }

  return null;
}

function parseMonthLabel(label) {
  const match = String(label || '').trim().match(/^([A-Za-z]+)-?(\d{2}|\d{4})$/);
  if (!match) return null;

  const monthToken = match[1].slice(0, 3).toLowerCase();
  const monthIndex = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  }[monthToken];
  if (monthIndex === undefined) return null;

  const yearToken = Number(match[2]);
  const year = match[2].length === 2 ? 2000 + yearToken : yearToken;
  return new Date(year, monthIndex, 1);
}

function formatMonthLabel(date) {
  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${month}-${date.getFullYear()}`;
}

function inferLatestOverviewMonth(pageData) {
  const overview = pageData?.Overview;
  if (!overview || typeof overview !== 'object') return null;

  const months = Object.keys(overview)
    .map((key) => key.match(/^Forecast-(.+)$/)?.[1] || key.match(/^Active-(.+)$/)?.[1] || null)
    .filter(Boolean)
    .map(parseMonthLabel)
    .filter(Boolean)
    .sort((a, b) => a - b);

  return months.length ? months[months.length - 1] : null;
}

function ensureLicenseSchoolMonthLabels(pageData) {
  const license = pageData?.['In Licence School'];
  if (!license || typeof license !== 'object') return;

  const hasCurrent = hasCellValue(license.Current_Month) || hasCellValue(license.Cuurent_Month);
  const hasLast = hasCellValue(license.Last_Month);
  if (hasCurrent && hasLast) return;

  const latest = inferLatestOverviewMonth(pageData) || new Date();
  const currentDate = new Date(latest.getFullYear(), latest.getMonth(), 1);
  const previousDate = new Date(latest.getFullYear(), latest.getMonth() - 1, 1);

  if (!hasCurrent) {
    const current = formatMonthLabel(currentDate);
    license.Current_Month = current;
    license.Cuurent_Month = current;
  }

  if (!hasLast) {
    license.Last_Month = formatMonthLabel(previousDate);
  }
}

function tableToRows(table) {
  const rawHeaders = (table.cols || []).map((col, index) => normalizeHeader(col.label, index));
  
  const visibleColumns = rawHeaders
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => header && header.trim() !== '');

  const headers = visibleColumns.map(({ header }) => header);

  const rows = (table.rows || [])
    .map((row) => {
      const out = {};
      
      visibleColumns.forEach(({ header, index }) => {
        const cell = row.c && row.c[index];
        const value = getCellValue(cell);
        
        if (hasCellValue(value)) {
          out[header] = value;
        }
      });
      
      return Object.keys(out).length > 0 ? out : null;
    })
    .filter(Boolean);

  return { headers, rows };
}


function buildPageNameMap(rows) {
  const result = {};

  rows.forEach((row) => {
    const dbPage = row.DB_Page ?? row.db_page ?? row['DB Page'] ?? row.column_A;
    const matrixName = row['Matrix Name'] ?? row.Matrix_Name ?? row.matrix_name ?? row.column_B;
    const value = pickRowValue(row);

    if (!hasCellValue(dbPage) || !hasCellValue(matrixName)) {
      return;
    }

    const parentKey = String(dbPage).trim();
    const childKey = String(matrixName).trim();

    if (!result[parentKey]) {
      result[parentKey] = {};
    }

    result[parentKey][childKey] = hasCellValue(value) ? value : null;
  });

  return result;
}

async function fetchSheetAsJson(sheetId, gid, sheetName) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set('tqx', 'out:json');
  url.searchParams.set('sheet', sheetName);
  if (gid) url.searchParams.set('gid', gid);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Google Sheets error: ${response.status}`);
  }

  const text = await response.text();
  const parsed = parseGvizResponse(text);
  const table = parsed.table || { cols: [], rows: [] };
  const { headers, rows } = tableToRows(table);
  const pageData = buildPageNameMap(rows);
  ensureLicenseSchoolMonthLabels(pageData);

  return {
    ok: true,
    sheetId,
    gid,
    sheetName,
    headers,
    rows,
    page_name: pageData,
    rowCount: rows.length,
    fetchedAt: new Date().toISOString()
  };
}

// Routes
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/sheet', async (req, res) => {
  try {
    const sheetId = extractSheetId(req.query.sheet || DEFAULT_SHEET_ID);
    const gid = String(req.query.gid || DEFAULT_GID).trim();
    const sheetName = String(req.query.sheetName || DEFAULT_SHEET_NAME).trim() || DEFAULT_SHEET_NAME;

    const data = await fetchSheetAsJson(sheetId, gid, sheetName);
    
    // Return only the page_name object
    res.json({
      ok: true,
      data: data.page_name
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      hint: 'Ensure the sheet is public and the sheet name matches exactly.'
    });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not Found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});