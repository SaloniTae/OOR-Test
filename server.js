// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");              // <-- NEW

const {
  PORT = 3000,
  ADMIN_KEY,
  FIREBASE_DB_URL,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY
} = process.env;

// ---------- Firebase init ----------
if (!FIREBASE_DB_URL || !FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error("Missing Firebase env vars. Check .env");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  }),
  databaseURL: FIREBASE_DB_URL
});

const db = admin.database();

// ---------- Express init ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- Serve static frontend ----------
// public/index.html  -> '/'
// public/admin.html  -> '/admin.html'
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers ----------

function generateOorCode(length = 12) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let randomPart = "";
  for (let i = 0; i < length; i++) {
    const idx = Math.floor(Math.random() * chars.length);
    randomPart += chars[idx];
  }
  return "OOR" + randomPart;
}

function isValidCustomCode(code) {
  return /^OOR[A-Z0-9]{6,20}$/.test(code);
}

async function codeExistsAnywhere(code) {
  const promoSnap = await db.ref(`promo_codes/${code}`).get();
  if (promoSnap.exists()) return true;
  const txnSnap = await db.ref(`transactions/${code}`).get();
  if (txnSnap.exists()) return true;
  return false;
}

function requireAdmin(req, res, next) {
  const key = req.header("X-ADMIN-KEY");
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

function nowIso() {
  return new Date().toISOString();
}

function parseEndTime(endStr) {
  if (!endStr) return null;
  const d = new Date(endStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

// ---------- Health check ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: nowIso() });
});

// ---------- ADMIN: list slots (for admin UI) ----------
app.get("/admin/slots", requireAdmin, async (req, res) => {
  try {
    const snap = await db.ref("settings/slots").get();
    if (!snap.exists()) {
      return res.json({ success: true, slots: [] });
    }
    const raw = snap.val();
    const slots = Object.entries(raw).map(([id, data]) => ({
      id,
      name: data.name || id,
      platform: data.platform || null,
      amount: data.required_amount || null,
      enabled: data.enabled !== false
    }));
    res.json({ success: true, slots });
  } catch (err) {
    console.error("Error in /admin/slots:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// ---------- ADMIN: generate promo code ----------
app.post("/admin/gen-code", requireAdmin, async (req, res) => {
  try {
    const {
      mode,
      slotId,
      platform,
      maxUses = 1,
      expiresAt = null,
      customCode = null,
      createdBy = "admin"
    } = req.body || {};

    if (mode !== "slot" && mode !== "platform") {
      return res.status(400).json({ success: false, message: "mode must be 'slot' or 'platform'" });
    }

    let resolvedPlatform = platform || null;
    let slotData = null;

    if (mode === "slot") {
      if (!slotId) {
        return res.status(400).json({ success: false, message: "slotId is required for mode=slot" });
      }
      const slotSnap = await db.ref(`settings/slots/${slotId}`).get();
      if (!slotSnap.exists()) {
        return res.status(404).json({ success: false, message: "Slot not found" });
      }
      slotData = slotSnap.val();
      if (slotData.enabled === false) {
        return res.status(400).json({ success: false, message: "Slot is disabled" });
      }
      resolvedPlatform = slotData.platform || resolvedPlatform;
    } else {
      // mode === "platform"
      if (!platform) {
        return res.status(400).json({ success: false, message: "platform is required for mode=platform" });
      }
    }

    // Determine code
    let code = null;
    if (customCode) {
      const custom = customCode.trim().toUpperCase();
      if (!isValidCustomCode(custom)) {
        return res.status(400).json({
          success: false,
          message: "customCode must match pattern: OOR[A-Z0-9]{6,20}"
        });
      }
      if (await codeExistsAnywhere(custom)) {
        return res.status(400).json({
          success: false,
          message: "customCode already exists"
        });
      }
      code = custom;
    } else {
      // generate random code, ensure unique
      let attempts = 0;
      while (attempts < 10) {
        const cand = generateOorCode(12);
        if (!(await codeExistsAnywhere(cand))) {
          code = cand;
          break;
        }
        attempts++;
      }
      if (!code) {
        return res.status(500).json({
          success: false,
          message: "Failed to generate unique code, try again"
        });
      }
    }

    const createdAt = nowIso();

    const promoRef = db.ref(`promo_codes/${code}`);
    const promoPayload = {
      code,
      mode,
      slot_id: mode === "slot" ? slotId : null,
      slot_name: mode === "slot" ? slotData?.name || null : null,
      platform: resolvedPlatform,
      amount: mode === "slot" ? slotData?.required_amount || null : null,
      created_by: createdBy,
      created_at: createdAt,
      custom: !!customCode,
      max_uses: maxUses,
      used_count: 0,
      expires_at: expiresAt,
      revoked: false,
      used_by: []
    };

    await promoRef.set(promoPayload);

    return res.json({
      success: true,
      promo: promoPayload
    });
  } catch (err) {
    console.error("Error in /admin/gen-code:", err);
    return res.status(500).json({ success: false, message: "Internal error" });
  }
});

// ---------- USER: login with transaction code ----------
app.post("/user/login", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, message: "code is required" });
    }

    const normCode = code.trim().toUpperCase();
    const trxSnap = await db.ref(`transactions/${normCode}`).get();
    if (!trxSnap.exists()) {
      return res.status(404).json({ success: false, message: "Invalid code" });
    }

    const trx = trxSnap.val();

    if (trx.hidden === true) {
      return res.status(403).json({
        success: false,
        message: "This code is no longer active"
      });
    }

    const endTimeDate = parseEndTime(trx.end_time);
    if (endTimeDate && endTimeDate.getTime() < Date.now()) {
      return res.status(403).json({
        success: false,
        message: "This subscription has expired",
        expired: true
      });
    }

    return res.json({
      success: true,
      code: normCode,
      platform: trx.platform || null,
      slot_id: trx.slot_id || null,
      slot_name: trx.slot_name || null,
      headline: trx.headline || null,
      last_email: trx.last_email || null,
      last_password: trx.last_password || null,
      start_time: trx.start_time || null,
      end_time: trx.end_time || null,
      user_id: trx.user_id || null,
      label_mode: trx.label_mode || null
    });
  } catch (err) {
    console.error("Error in /user/login:", err);
    return res.status(500).json({ success: false, message: "Internal error" });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
