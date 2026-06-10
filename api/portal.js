const { google } = require('googleapis');
const { Readable } = require('stream');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, msg: "Method Not Allowed" });
  }

  try {
    const { action } = req.body;

    // --- BULLETPROOF GOOGLE VARIABLE PARSING ---
    let credentials;
    try {
      // If Vercel loads it with accidental enclosing single quotes, strip them out
      let rawEnv = process.env.GOOGLE_SERVICE_ACCOUNT.trim();
      if (rawEnv.startsWith("'") && rawEnv.endsWith("'")) {
        rawEnv = rawEnv.slice(1, -1);
      }
      credentials = JSON.parse(rawEnv);
    } catch (parseError) {
      return res.status(500).json({ 
        success: false, 
        msg: "Vercel Environment Variable Config Error: Could not parse JSON credentials.",
        error: parseError.message 
      });
    }

    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    
    const FOLDER_ID = "1RHi6VHmvkmHkFD74xoPQl2TTV6oIYWJc"; 
    const PHOTO_FOLDER_ID = "1dgmfiePaaUpd_3YnQ3bmkLLKa04-ttWGhMfvsCnXye0w6ZqmjaAW_JDWwnhvHeYDSp2tAweS"; 
    const ADMIN_ITS = ["30366830", "30490731"]; 
    const CURRENT_CYCLE_START = "2026-05-17"; 
    const NEXT_DATE = "15-06-2026"; 

    // Repair private key line breaks explicitly
    const formattedPrivateKey = credentials.private_key.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      formattedPrivateKey,
      ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    );

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // --- ROUTE: LOGIN USER ---
    if (action === 'login') {
      const its = req.body.its.toString().trim();

      const membersRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Members!A:B' });
      const members = membersRes.data.values || [];
      
      let user = null;
      for (let i = 1; i < members.length; i++) {
        if (members[i][0] && members[i][0].toString().trim() === its) {
          user = { its: members[i][0], name: members[i][1] };
          break;
        }
      }
      if (!user) return res.status(200).json({ success: false, msg: "ITS number not recognized." });

      const contribsRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Contributions!A:F' });
      const contributions = contribsRes.data.values || [];
      
      const cycleStart = new Date(CURRENT_CYCLE_START);
      cycleStart.setHours(0,0,0,0);

      let hasPaidThisCycle = false;
      let totalCollected = 0;
      let userHistory = [];

      for (let i = 1; i < contributions.length; i++) {
        const row = contributions[i];
        const amt = Number(row[4]);
        if (!isNaN(amt)) totalCollected += amt;

        if (row[1] && row[1].toString().trim() === its) {
          const paymentDate = new Date(row[0]);
          if (paymentDate >= cycleStart) hasPaidThisCycle = true;

          const d = new Date(row[0]);
          const formattedDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
          userHistory.push({ date: formattedDate, amount: row[4], link: row[5] });
        }
      }

      let expensesData = [];
      let totalSpent = 0;
      try {
        const expRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Expenses!A:C' });
        const expRows = expRes.data.values || [];
        for (let i = 1; i < expRows.length; i++) {
          const amt = Number(expRows[i][2]);
          if (!isNaN(amt)) totalSpent += amt;
        }
        expensesData = expRows.slice(1).map(row => {
          const d = new Date(row[0]);
          return {
            date: !isNaN(d) ? `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}` : row[0],
            desc: row[1],
            amount: row[2]
          };
        }).reverse().slice(0, 3);
      } catch (e) { console.error(e); }

      let hasUploadedPhoto = false;
      let photoUrl = "";
      try {
        const photoRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Form Responses 1!A:F' });
        const photoRows = photoRes.data.values || [];
        for (let i = 1; i < photoRows.length; i++) {
          const rowStr = photoRows[i].map(c => c ? c.toString().trim() : "").join("||");
          if (rowStr.includes(its)) {
            hasUploadedPhoto = true;
            const linkCell = photoRows[i].find(cell => cell && cell.toString().includes("http"));
            if (linkCell) photoUrl = linkCell.toString().split(',')[0].trim();
            break;
          }
        }
      } catch (e) { console.error(e); }

      let adminReport = null;
      if (ADMIN_ITS.includes(its)) {
        let paid = []; let unpaid = [];
        for (let i = 1; i < members.length; i++) {
          const mIts = members[i][0].toString().trim();
          const mName = members[i][1];
          let foundPaid = false;
          for (let j = 1; j < contributions.length; j++) {
            if (contributions[j][1] && contributions[j][1].toString().trim() === mIts) {
              if (new Date(contributions[j][0]) >= cycleStart) { foundPaid = true; break; }
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
        recentExpenses: expensesData, hasUploadedPhoto, photoUrl
      });
    }

    // --- ROUTE: UPLOAD CONTRIBUTION RECEIPT ---
    if (action === 'uploadReceipt') {
      const payload = req.body.payload;
      const contentType = payload.receipt.split(';')[0].split(':')[1];
      const buffer = Buffer.from(payload.receipt.split(',')[1], 'base64');

      const fileMetadata = { name: `Receipt_${payload.its}`, parents: [FOLDER_ID] };
      const media = { mimeType: contentType, body: Readable.from(buffer) };
      const file = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
      
      await drive.permissions.create({ fileId: file.data.id, resource: { role: 'reader', type: 'anyone' } });

      let finalAmount = Number(payload.amount);
      if (isNaN(finalAmount) || finalAmount <= 0) finalAmount = 1000;

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Contributions!A:F', valueInputOption: 'USER_ENTERED',
        resource: { values: [[new Date().toISOString(), payload.its, payload.name, payload.date, finalAmount, file.data.webViewLink]] }
      });

      return res.status(200).json({ success: true, msg: "Receipt uploaded successfully! Jazakallah." });
    }

    // --- ROUTE: UPLOAD COLLAGE PHOTO ---
    if (action === 'uploadPhoto') {
      const payload = req.body.payload;
      const contentType = payload.photo.split(';')[0].split(':')[1];
      const buffer = Buffer.from(payload.photo.split(',')[1], 'base64');

      const fileMetadata = { name: `CollagePhoto_${payload.its}_${payload.name}`, parents: [PHOTO_FOLDER_ID] };
      const media = { mimeType: contentType, body: Readable.from(buffer) };
      const file = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });

      await drive.permissions.create({ fileId: file.data.id, resource: { role: 'reader', type: 'anyone' } });

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Form Responses 1!A:D', valueInputOption: 'USER_ENTERED',
        resource: { values: [[new Date().toISOString(), payload.its, payload.name, file.data.webViewLink]] }
      });

      return res.status(200).json({ success: true, msg: "Photo submitted successfully for the Collage!" });
    }

  } catch (err) {
    return res.status(500).json({ success: false, msg: "Server Internal Runtime Error: " + err.message });
  }
};