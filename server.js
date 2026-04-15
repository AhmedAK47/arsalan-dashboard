const express = require('express');

const app = express();
const PORT = 3000;
const DEFAULT_SHEET_ID = '18ATEk4-2YihvjwxHRAaQNpVsOEaNP3a_S1QoPvT3fVQ';
const DEFAULT_GID = '0';
const DEFAULT_SHEET_NAME = 'Overview Page';

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
  let currentSection = "Overview";
  let isWaitingForSection = false;
  let sectionNameFromPageName = null;
  
  // Initialize Overview section
  result[currentSection] = {};
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const columns = Object.keys(row);
    const firstCol = columns[0];
    const key = row[firstCol];
    
    if (!key) continue;
    
    const cleanKey = String(key).trim();
    const otherCols = columns.filter(c => c !== firstCol);
    
    // Check if this is a "Page_Name" row (separator)
    if (cleanKey === "Page_Name") {
      // The section name is in the second column (Overview or column_C, etc.)
      if (otherCols.length > 0) {
        const secondColValue = row[otherCols[0]];
        if (secondColValue) {
          sectionNameFromPageName = String(secondColValue).trim();
          isWaitingForSection = true;
        } else {
          // If second column is empty, check third column
          if (otherCols.length > 1 && row[otherCols[1]]) {
            sectionNameFromPageName = String(row[otherCols[1]]).trim();
            isWaitingForSection = true;
          }
        }
      }
      continue;
    }
    
    // If we're waiting for a section, create it
    if (isWaitingForSection && sectionNameFromPageName) {
      currentSection = sectionNameFromPageName;
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      isWaitingForSection = false;
      sectionNameFromPageName = null;
      
      // Process the current row as data for the new section
      if (otherCols.length > 0) {
        const firstValue = row[otherCols[0]];
        if (firstValue !== undefined && firstValue !== null) {
          if (otherCols.length === 1) {
            result[currentSection][cleanKey] = firstValue;
          } else {
            const columnData = {};
            otherCols.forEach(col => {
              if (row[col] !== undefined && row[col] !== null) {
                columnData[col] = row[col];
              }
            });
            result[currentSection][cleanKey] = columnData;
          }
        } else {
          // Handle case where the value is empty (like Cost Analysis items)
          result[currentSection][cleanKey] = null;
        }
      }
      continue;
    }
    
    // Skip rows that are just section headers without values
    const hasValues = otherCols.some(c => row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '');
    
    if (!hasValues && cleanKey && cleanKey !== "Page_Name") {
      // This might be a section header with no data yet
      if (!result[cleanKey]) {
        currentSection = cleanKey;
        result[currentSection] = {};
      }
      continue;
    }
    
    // Regular data row with values
    if (cleanKey) {
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      
      // Handle multiple columns
      if (otherCols.length > 1) {
        const columnData = {};
        let hasAnyValue = false;
        otherCols.forEach(col => {
          if (row[col] !== undefined && row[col] !== null && String(row[col]).trim() !== '') {
            columnData[col] = row[col];
            hasAnyValue = true;
          }
        });
        
        if (hasAnyValue) {
          // Check if this is a single value that should be flattened
          if (Object.keys(columnData).length === 1 && columnData[otherCols[0]] !== undefined) {
            result[currentSection][cleanKey] = columnData[otherCols[0]];
          } else {
            result[currentSection][cleanKey] = columnData;
          }
        } else {
          result[currentSection][cleanKey] = null;
        }
      } 
      // Handle single column
      else if (otherCols.length === 1) {
        const value = row[otherCols[0]];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          result[currentSection][cleanKey] = value;
        } else {
          result[currentSection][cleanKey] = null;
        }
      } else if (otherCols.length === 0) {
        // No data columns, set as null
        result[currentSection][cleanKey] = null;
      }
    }
  }
  
  // Special handling to separate Pipeline Snapshot data
  if (result["Pipeline Snapshot"]) {
    const snapshotData = result["Pipeline Snapshot"];
    const forecastData = {};
    const activeData = {};
    
    Object.keys(snapshotData).forEach(key => {
      if (key.startsWith("Forecast-")) {
        const date = key.replace("Forecast-", "");
        forecastData[date] = snapshotData[key];
      } else if (key.startsWith("Active-")) {
        const date = key.replace("Active-", "");
        activeData[date] = snapshotData[key];
      }
    });
    
    if (Object.keys(forecastData).length > 0) {
      result["Pipeline Snapshot"]["Forecast"] = forecastData;
    }
    if (Object.keys(activeData).length > 0) {
      result["Pipeline Snapshot"]["Active"] = activeData;
    }
    
    // Remove the old flat data
    Object.keys(snapshotData).forEach(key => {
      if (key.startsWith("Forecast-") || key.startsWith("Active-")) {
        delete result["Pipeline Snapshot"][key];
      }
    });
  }
  
  // Move Candidate Pipeline data to its own section if it's in Overview
  if (result["Overview"] && result["Overview"]["Riders Total Pipeline"]) {
    if (!result["Candidate Pipeline"]) {
      result["Candidate Pipeline"] = {};
    }
    result["Candidate Pipeline"]["Riders Total Pipeline"] = result["Overview"]["Riders Total Pipeline"];
    result["Candidate Pipeline"]["Drivers Total Pipeline"] = result["Overview"]["Drivers Total Pipeline"];
    delete result["Overview"]["Riders Total Pipeline"];
    delete result["Overview"]["Drivers Total Pipeline"];
  }
  
  // Move License School data to its own section
  if (result["Overview"]) {
    const licenseData = {};
    const licenseKeys = ["license School", "Riders in School", "Drivers In School", "Awaiting for registration", "Avg days for license"];
    let hasLicenseData = false;
    
    licenseKeys.forEach(key => {
      if (result["Overview"][key] !== undefined) {
        licenseData[key] = result["Overview"][key];
        delete result["Overview"][key];
        hasLicenseData = true;
      }
    });
    
    if (hasLicenseData && !result["In Licence School"]) {
      result["In Licence School"] = licenseData;
    }
  }
  
  // Move Leave & Off Boarded data to its own section
  if (result["Overview"]) {
    const leaveData = {};
    const leaveKeys = ["Current on leave", "Riders Currently on leave", "Drivers Currently on leave", "Off Boarded", "Resigned", "Terminated", "Contract End", "Other"];
    let hasLeaveData = false;
    
    leaveKeys.forEach(key => {
      if (result["Overview"][key] !== undefined) {
        leaveData[key] = result["Overview"][key];
        delete result["Overview"][key];
        hasLeaveData = true;
      }
    });
    
    if (hasLeaveData && !result["Off boarding & Leave"]) {
      result["Off boarding & Leave"] = leaveData;
    }
  }
  
  // Ensure Cost Analysis section exists
  if (!result["Cost Analysis"]) {
    result["Cost Analysis"] = {};
  }
  
  // Add Cost Analysis items if they exist in Overview
  if (result["Overview"]) {
    const costKeys = ["Total Cost", "Direct cost break up", "Indirect cost break up", "Cost per head"];
    costKeys.forEach(key => {
      if (result["Overview"][key] !== undefined) {
        result["Cost Analysis"][key] = result["Overview"][key];
        delete result["Overview"][key];
      } else if (!result["Cost Analysis"][key]) {
        result["Cost Analysis"][key] = null;
      }
    });
  }
  
  // Clean up empty sections
  Object.keys(result).forEach(section => {
    if (Object.keys(result[section]).length === 0) {
      delete result[section];
    }
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