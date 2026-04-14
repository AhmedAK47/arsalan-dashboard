const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DEFAULT_SHEET_ID = '18ATEk4-2YihvjwxHRAaQNpVsOEaNP3a_S1QoPvT3fVQ';

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function extractSheetId(sheetUrlOrId) {
  if (!sheetUrlOrId) return DEFAULT_SHEET_ID;
  const match = String(sheetUrlOrId).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(sheetUrlOrId).trim();
}

function parseGvizResponse(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Unexpected Google Sheets response format');
  }

  return JSON.parse(raw.slice(start, end + 1));
}

function rowsToObjects(table) {
  const headers = table.cols.map((col, index) => {
    const label = (col.label || '').trim();
    return label || `column_${index + 1}`;
  });

  return table.rows.map((row) => {
    const out = {};

    headers.forEach((header, colIndex) => {
      const cell = row.c && row.c[colIndex];
      out[header] = cell ? cell.v : null;
    });

    return out;
  });
}

async function fetchSheetAsJson(sheetId, gid) {
  const gvizUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  gvizUrl.searchParams.set('tqx', 'out:json');
  if (gid) gvizUrl.searchParams.set('gid', gid);

  const response = await fetch(gvizUrl);

  if (!response.ok) {
    throw new Error(`Google Sheets responded with ${response.status}`);
  }

  const text = await response.text();
  const parsed = parseGvizResponse(text);
  const table = parsed.table || { cols: [], rows: [] };

  return {
    sheetId,
    gid: gid || 'default',
    columns: table.cols.map((c, i) => ({
      index: i,
      label: c.label || `column_${i + 1}`,
      type: c.type || 'unknown'
    })),
    rows: rowsToObjects(table),
    rowCount: table.rows.length,
    fetchedAt: new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'sheet-json-server' });
    return;
  }

  if (reqUrl.pathname === '/api/sheet') {
    try {
      const sheetId = extractSheetId(reqUrl.searchParams.get('sheet') || DEFAULT_SHEET_ID);
      const gid = reqUrl.searchParams.get('gid');
      const payload = await fetchSheetAsJson(sheetId, gid);
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message,
        hint: 'Ensure the Google Sheet is accessible to anyone with the link.'
      });
    }
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'Not found',
    endpoints: ['/health', '/api/sheet', '/api/sheet?gid=0']
  });
});

server.listen(PORT, () => {
  console.log(`Sheet JSON server running on http://localhost:${PORT}`);
});
