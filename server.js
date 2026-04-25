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
        const value = cell && cell.v !== undefined ? cell.v : null;
        
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
    const value = row.Value ?? row.value ?? row.column_C ?? null;

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