const { google } = require('googleapis');
const { Readable } = require('stream');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, msg: "Method Not Allowed" });

  try {
    const { action } = req.body;

    let credentials;
    try {
      let rawEnv = process.env.GOOGLE_SERVICE_ACCOUNT.trim();
      if (rawEnv.startsWith("'") && rawEnv.endsWith("'")) rawEnv = rawEnv.slice(1, -1);
      credentials = JSON.parse(rawEnv);
    } catch (parseError) {
      return res.status(500).json({ success: false, msg: "Config Error: Could not parse credentials." });
    }

    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    const FOLDER_ID = "1RHi6VHmvkmHkFD74xoPQl2TTV6oIYWJc"; 
    const PHOTO_FOLDER_ID = "1dgmfiePaaUpd_3YnQ3bmkLLKa04-ttWGhMfvsCnXye0w6ZqmjaAW_JDWwnhvHeYDSp2tAweS"; 
    const ADMIN_ITS = ["30366830", "30490731"]; 

    const formattedPrivateKey = credentials.private_key.replace(/\\n/g, '\n');
    const auth = new google.auth.JWT(
      credentials.client_email, null, formattedPrivateKey,
      ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    );

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Helper: Safe Date Parser
    const safeParseDate = (dateVal) => {
      if (!dateVal) return new Date(0);
      const strVal = String(dateVal).trim().split('T')[0].split(' ')[0]; 
      let d = new Date(strVal);
      const parts = strVal.split(/[\/\-\.]/);
      if (parts.length === 3) {
        let day, month, year;
        if (parts[2].length >= 4) { 
          day = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; year = parseInt(parts[2], 10);
          d = new Date(year, month, day);
        } else if (parts[0].length === 4) { 
          year = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; day = parseInt(parts[2], 10);
          d = new Date(year, month, day);
        }
      }
      return isNaN(d.getTime()) ? new Date(0) : d;
    };

    // --- DYNAMIC CONFIG FETCH ---
    let CURRENT_CYCLE_START = "2026-05-17"; // Fallback
    let NEXT_DATE = "15-06-2026"; // Fallback
    try {
      const configRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Config!A:B' });
      const configData = configRes.data.values || [];
      for (const row of configData) {
        if (row[0] === 'CURRENT_CYCLE_START' && row[1]) CURRENT_CYCLE_START = row[1];
        if (row[0] === 'NEXT_DATE' && row[1]) NEXT_DATE = row[1];
      }
    } catch(e) { console.error("Config tab not found, using fallbacks."); }

    // --- ROUTE: LOGIN USER ---
    if (action === 'login') {
      const its = req.body.its.toString().trim();
      const membersRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Members!A:B' });
      const members = membersRes.data.values || [];
      
      let user = null;
      for (let i = 1; i < members.length; i++) {
        if (members[i][0] && members[i][0].toString().trim() === its) {
          user = { its: members[i][0], name: members[i][1] }; break;
        }
      }
      if (!user) return res.status(200).json({ success: false, msg: "ITS number not recognized." });

      const contribsRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Contributions!A:F' });
      const contributions = contribsRes.data.values || [];
      const cycleStart = safeParseDate(CURRENT_CYCLE_START);
      cycleStart.setHours(0,0,0,0);

      let hasPaidThisCycle = false, totalCollected = 0, userHistory = [];

      for (let i = 1; i < contributions.length; i++) {
        const row = contributions[i];
        if (!row[0] || !row[1]) continue;
        const amt = Number(row[4]);
        if (!isNaN(amt)) totalCollected += amt;

        if (row[1].toString().trim() === its) {
          const paymentDate = safeParseDate(row[0]);
          if (paymentDate >= cycleStart) hasPaidThisCycle = true;
          const formattedDate = `${String(paymentDate.getDate()).padStart(2, '0')}-${String(paymentDate.getMonth() + 1).padStart(2, '0')}-${paymentDate.getFullYear()}`;
          userHistory.push({ date: formattedDate, amount: row[4], link: row[5] });
        }
      }

      let expensesData = [], totalSpent = 0;
      try {
        const expRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Expenses!A:C' });
        const expRows = expRes.data.values || [];
        for (let i = 1; i < expRows.length; i++) {
          const amt = Number(expRows[i][2]); if (!isNaN(amt)) totalSpent += amt;
        }
        expensesData = expRows.slice(1).map(row => {
          const d = safeParseDate(row[0]);
          return {
            date: d.getTime() > 0 ? `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}` : row[0],
            desc: row[1], amount: row[2]
          };
        }).reverse().slice(0, 3);
      } catch (e) {}

      let hasUploadedPhoto = false, photoUrl = "";
      try {
        const photoRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Form Responses 1!A:F' });
        for (let i = 1; i < (photoRes.data.values || []).length; i++) {
          const rowStr = photoRes.data.values[i].map(c => c ? c.toString().trim() : "").join("||");
          if (rowStr.includes(its)) {
            hasUploadedPhoto = true;
            const linkCell = photoRes.data.values[i].find(cell => cell && cell.toString().includes("http"));
            if (linkCell) photoUrl = linkCell.toString().split(',')[0].trim();
            break;
          }
        }
      } catch (e) {}

      let adminReport = null;
      if (ADMIN_ITS.includes(its)) {
        let paid = [], unpaid = [];
        for (let i = 1; i < members.length; i++) {
          const mIts = members[i][0].toString().trim(), mName = members[i][1];
          let foundPaid = false;
          for (let j = 1; j < contributions.length; j++) {
            if (contributions[j][1] && contributions[j][1].toString().trim() === mIts) {
              if (safeParseDate(contributions[j][0]) >= cycleStart) { foundPaid = true; break; }
            }
          }
          if (foundPaid) paid.push(mName); else unpaid.push(mName);
        }
        adminReport = { paid, unpaid };
      }

      return res.status(200).json({
        success: true, user, history: userHistory, isAdmin: ADMIN_ITS.includes(its),
        adminReport, hasPaid: hasPaidThisCycle, nextDate: NEXT_DATE,
        totalCollected, totalSpent, balance: totalCollected - totalSpent,
        recentExpenses: expensesData, hasUploadedPhoto, photoUrl,
        // Send current config dates down to the frontend for the Admin UI
        currentCycleStart: CURRENT_CYCLE_START 
      });
    }

    // --- NEW ROUTE: UPDATE CONFIG DATES (ADMIN ONLY) ---
    if (action === 'updateConfig') {
      const payload = req.body.payload;
      if (!ADMIN_ITS.includes(payload.its.toString())) return res.status(403).json({ success: false, msg: "Unauthorized." });
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: 'Config!A1:B2', valueInputOption: 'USER_ENTERED',
        resource: { values: [
          ['CURRENT_CYCLE_START', payload.newStart],
          ['NEXT_DATE', payload.newNext]
        ]}
      });
      return res.status(200).json({ success: true, msg: "Cycle dates updated! Portal is now unlocked for the new month." });
    }

    // --- ROUTE: UPLOAD CONTRIBUTION RECEIPT ---
    if (action === 'uploadReceipt') {
      const payload = req.body.payload;
      const buffer = Buffer.from(payload.receipt.split(',')[1], 'base64');
      const file = await drive.files.create({ 
        resource: { name: `Receipt_${payload.its}`, parents: [FOLDER_ID] }, 
        media: { mimeType: payload.receipt.split(';')[0].split(':')[1], body: Readable.from(buffer) }, 
        fields: 'id, webViewLink' 
      });
      await drive.permissions.create({ fileId: file.data.id, resource: { role: 'reader', type: 'anyone' } });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Contributions!A:F', valueInputOption: 'USER_ENTERED',
        resource: { values: [[new Date().toISOString(), payload.its, payload.name, payload.date, Number(payload.amount) || 1000, file.data.webViewLink]] }
      });
      return res.status(200).json({ success: true, msg: "Receipt uploaded successfully!" });
    }

    // --- ROUTE: UPLOAD COLLAGE PHOTO ---
    if (action === 'uploadPhoto') {
      const payload = req.body.payload;
      const buffer = Buffer.from(payload.photo.split(',')[1], 'base64');
      const file = await drive.files.create({ 
        resource: { name: `CollagePhoto_${payload.its}_${payload.name}`, parents: [PHOTO_FOLDER_ID] }, 
        media: { mimeType: payload.photo.split(';')[0].split(':')[1], body: Readable.from(buffer) }, 
        fields: 'id, webViewLink' 
      });
      await drive.permissions.create({ fileId: file.data.id, resource: { role: 'reader', type: 'anyone' } });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Form Responses 1!A:D', valueInputOption: 'USER_ENTERED',
        resource: { values: [[new Date().toISOString(), payload.its, payload.name, file.data.webViewLink]] }
      });
      return res.status(200).json({ success: true, msg: "Photo submitted successfully!" });
    }

  } catch (err) {
    return res.status(500).json({ success: false, msg: "Server Error: " + err.message });
  }
};