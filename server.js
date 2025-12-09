// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");
const crypto = require("crypto");

// -------- ENV --------
const {
  PORT = 3000,
  ADMIN_KEY,
  FIREBASE_DB_URL,
  FIREBASE_SERVICE_ACCOUNT
} = process.env;

// -------- Firebase init --------
if (!FIREBASE_DB_URL || !FIREBASE_SERVICE_ACCOUNT) {
  console.error("Missing FIREBASE_DB_URL or FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT:", e);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL
});

const db = admin.database();

// -------- Express init --------
const app = express();
app.use(cors());
app.use(express.json());

// Static files (public/index.html => /, public/admin.html => /admin.html)
app.use(express.static(path.join(__dirname, "public")));

// -------- Helpers --------
function nowIso() {
  return new Date().toISOString();
}

function istNow() {
  return new Date(); // if you want strict IST, switch to tz lib
}

function formatDateTime(now) {
  const pad = n => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function parseEndTime(endStr) {
  if (!endStr) return null;
  const d = new Date(endStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

function requireAdmin(req, res, next) {
  const key = req.header("X-ADMIN-KEY");
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// like Python _resolve_mode for approve_flow_label_mode
function resolveLabelMode(uiFlags, scope) {
  const key = `${scope}_label_mode`; // approve_flow_label_mode
  const modeRaw = (uiFlags && uiFlags[key]) || "";
  const mode = modeRaw.toString().trim().toLowerCase();
  if (mode === "platform" || mode === "name") return mode;
  const legacy = !!(uiFlags && uiFlags[`use_platform_in_${scope}`]);
  return legacy ? "platform" : "name";
}

async function getSlot(slotId) {
  const snap = await db.ref(`settings/slots/${slotId}`).get();
  if (!snap.exists()) return null;
  return snap.val();
}

// Scan DB for credentials like cred2, cred3...
async function selectCredentialForSlot(slotId, slotInfo) {
  const rootSnap = await db.ref("/").get();
  const root = rootSnap.val() || {};

  const slotPlatform = (slotInfo.platform || "").toLowerCase();
  const today = new Date();

  const normalizeOwns = val => {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return String(val)
      .split(",")
      .map(v => v.trim())
      .filter(Boolean);
  };

  const candidates = [];
  for (const [key, node] of Object.entries(root)) {
    if (!key.startsWith("cred")) continue;
    if (typeof node !== "object" || node === null) continue;

    const ownsSlots = new Set(
      normalizeOwns(node.belongs_to_slot).map(v => v.toLowerCase())
    );
    const ownsPlats = new Set(
      normalizeOwns(node.belongs_to_platform).map(v => v.toLowerCase())
    );

    const appliesSlot = ownsSlots.has(slotId.toLowerCase());
    const appliesPlat = slotPlatform && ownsPlats.has(slotPlatform);
    const appliesAll = ownsSlots.has("all") || ownsPlats.has("all");

    if (!appliesSlot && !appliesPlat && !appliesAll) continue;

    let locked = 0;
    let usageCount = 0;
    let maxUsage = 0;
    try {
      locked = parseInt(node.locked ?? 0, 10);
      usageCount = parseInt(node.usage_count ?? 0, 10);
      maxUsage = parseInt(node.max_usage ?? 0, 10);
    } catch {
      continue;
    }

    if (locked === 1) continue;
    if (maxUsage !== 0 && usageCount >= maxUsage) continue;

    if (node.expiry_date) {
      try {
        const [y, m, d] = node.expiry_date.split("-").map(x => parseInt(x, 10));
        const exp = new Date(y, m - 1, d + 1); // end-of-day
        if (exp < today) continue;
      } catch {
        // ignore
      }
    }

    candidates.push({
      key,
      node,
      appliesSlot,
      appliesPlat,
      appliesAll
    });
  }

  if (!candidates.length) return { key: null, node: null };

  let best = candidates.find(c => c.appliesSlot);
  if (!best) best = candidates.find(c => c.appliesPlat);
  if (!best) best = candidates.find(c => c.appliesAll);
  if (!best) return { key: null, node: null };

  return { key: best.key, node: best.node };
}

// claim_promo_code_atomic equivalent
async function claimPromoCodeAtomic(code, userId, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const snap = await db.ref(`promo_codes/${code}`).get();
    if (!snap.exists()) return [false, "CODE_NOT_FOUND"];
    const promo = snap.val();

    if (promo.revoked) return [false, "CODE_REVOKED"];

    if (promo.expires_at) {
      try {
        const exp = new Date(promo.expires_at);
        if (!isNaN(exp.getTime()) && exp < new Date()) {
          return [false, "CODE_EXPIRED"];
        }
      } catch {
        // ignore
      }
    }

    let usedCount = 0;
    let maxUses = 1;
    try {
      usedCount = parseInt(promo.used_count ?? 0, 10);
      maxUses = parseInt(promo.max_uses ?? 1, 10);
    } catch {
      // ignore
    }
    if (usedCount >= maxUses) return [false, "CODE_ALREADY_USED_UP"];

    const newUsedCount = usedCount + 1;
    const now = nowIso();

    let usedByList = promo.used_by;
    if (!Array.isArray(usedByList)) usedByList = [];
    usedByList = [...usedByList, { user_id: userId, used_at: now }];

    const patchPayload = {
      used_count: newUsedCount,
      last_used_by: userId,
      last_used_at: now,
      used_by: usedByList
    };

    try {
      await db.ref(`promo_codes/${code}`).update(patchPayload);
    } catch (e) {
      await new Promise(r => setTimeout(r, 100));
      continue;
    }

    const afterSnap = await db.ref(`promo_codes/${code}`).get();
    const after = afterSnap.val() || {};
    try {
      if (parseInt(after.used_count ?? 0, 10) === newUsedCount) {
        return [true, after];
      }
    } catch {
      // ignore
    }

    await new Promise(r => setTimeout(r, 80));
  }
  return [false, "RACE_FAILED"];
}

// ----- TOTP helpers (for Get OTP) -----
function base32ToBuffer(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, step = 30, digits = 6) {
  const key = base32ToBuffer(secret);
  const time = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(time));

  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  let codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  codeInt = codeInt % 10 ** digits;
  const codeStr = codeInt.toString().padStart(digits, "0");

  const nowSec = Math.floor(Date.now() / 1000);
  const rem = step - (nowSec % step);
  return { code: codeStr, ttl: rem };
}

// -------- Routes --------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: nowIso() });
});

// Admin: list slots for UI
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

// Admin: generate promo code (slot-based, like /gen_code)
app.post("/admin/gen-code", requireAdmin, async (req, res) => {
  try {
    const { slotId, maxUses = 1, expiresAt = null, customCode = null, createdBy = "admin" } =
      req.body || {};
    if (!slotId) {
      return res.status(400).json({ success: false, message: "slotId is required" });
    }

    const slot = await getSlot(slotId);
    if (!slot || slot.enabled === false) {
      return res.status(400).json({ success: false, message: "Slot not found or disabled" });
    }

    const slotName = slot.name || slotId;
    const amount = Number(slot.required_amount ?? 0);

    // generate or validate code
    let code;
    if (customCode) {
      const custom = customCode.trim().toUpperCase();
      if (!/^OOR[A-Z0-9]{6,20}$/.test(custom)) {
        return res
          .status(400)
          .json({ success: false, message: "customCode must match OOR[A-Z0-9]{6,20}" });
      }
      const existing = await db.ref(`promo_codes/${custom}`).get();
      if (existing.exists()) {
        return res.status(400).json({ success: false, message: "Code already exists" });
      }
      code = custom;
    } else {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let attempts = 0;
      while (attempts < 10) {
        let rand = "";
        for (let i = 0; i < 13; i++) {
          rand += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        const cand = "OOR" + rand;
        const existing = await db.ref(`promo_codes/${cand}`).get();
        if (!existing.exists()) {
          code = cand;
          break;
        }
        attempts++;
      }
      if (!code) {
        return res.status(500).json({ success: false, message: "Failed to generate unique code" });
      }
    }

    const payload = {
      slot_id: slotId,
      slot_name: slotName,
      amount,
      created_by: createdBy,
      created_at: nowIso(),
      custom: !!customCode,
      expires_at: expiresAt,
      used_count: 0,
      max_uses: maxUses,
      revoked: false
    };

    await db.ref(`promo_codes/${code}`).set(payload);

    return res.json({ success: true, code, promo: payload });
  } catch (err) {
    console.error("Error /admin/gen-code:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// User: redeem promo code (like /use_code) -> create transaction + assign cred
app.post("/promo/claim", async (req, res) => {
  try {
    const { code, user_id } = req.body || {};
    if (!code || !user_id) {
      return res.status(400).json({ success: false, message: "code and user_id are required" });
    }
    const codeText = code.trim().toUpperCase();

    const [ok, result] = await claimPromoCodeAtomic(codeText, user_id);
    if (!ok) {
      const msgMap = {
        CODE_NOT_FOUND: "This code does not exist.",
        CODE_REVOKED: "This code has been revoked.",
        CODE_EXPIRED: "This code has expired.",
        CODE_ALREADY_USED_UP: "This code has already been used.",
        RACE_FAILED: "Could not claim the code. Try again."
      };
      return res
        .status(400)
        .json({ success: false, reason: result, message: msgMap[result] || "Failed to claim." });
    }

    const promo = result;
    const slotId = promo.slot_id;
    if (!slotId) {
      return res.status(500).json({ success: false, message: "Promo has no slot_id" });
    }

    const slot = await getSlot(slotId);
    if (!slot) {
      return res.status(500).json({ success: false, message: "Slot not found for promo" });
    }

    const uiSnap = await db.ref("settings/ui_flags").get();
    const uiFlags = uiSnap.val() || {};
    const labelMode = resolveLabelMode(uiFlags, "approve_flow");

    const now = istNow();
    let durationHours = 6;
    const rawDuration = slot.duration_hours;
    if (typeof rawDuration === "number") {
      durationHours = rawDuration;
    } else if (typeof rawDuration === "string") {
      if (/day/i.test(rawDuration)) durationHours = 24;
      else {
        const n = parseInt(rawDuration, 10);
        if (!isNaN(n)) durationHours = n;
      }
    }

    const startTime = now;
    const endTime = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

    const platform = slot.platform || null;
    const slotName = slot.name || slotId;
    let headline = slotName + " Account";
    if (labelMode === "platform" && platform) {
      headline = `${platform} Account`;
    }

    const txnRecord = {
      platform,
      slot_id: slotId,
      slot_name: slotName,
      label_mode: labelMode,
      headline,
      start_time: formatDateTime(startTime),
      end_time: formatDateTime(endTime),
      approved_at: nowIso(),
      assign_to: null,
      user_id,
      last_email: null,
      last_password: null,
      hidden: false
    };

    await db.ref(`transactions/${codeText}`).set(txnRecord);

    const { key: credKey, node: cred } = await selectCredentialForSlot(slotId, slot);
    if (!cred) {
      return res.json({
        success: true,
        code: codeText,
        message: "Promo claimed, but no credentials available for this slot.",
        transaction: txnRecord
      });
    }

    const email = cred.email || null;
    const password = cred.password || null;
    await db.ref(`transactions/${codeText}`).update({
      assign_to: credKey,
      last_email: email,
      last_password: password
    });

    let usageCount = parseInt(cred.usage_count ?? 0, 10);
    const maxUsage = parseInt(cred.max_usage ?? 0, 10);
    if (isNaN(usageCount)) usageCount = 0;
    if (maxUsage === 0 || usageCount < maxUsage) {
      await db.ref(credKey).update({ usage_count: usageCount + 1 });
    }

    const finalTxnSnap = await db.ref(`transactions/${codeText}`).get();
    const finalTxn = finalTxnSnap.val() || {};

    return res.json({
      success: true,
      code: codeText,
      platform,
      slot_id: slotId,
      slot_name: slotName,
      headline,
      last_email: finalTxn.last_email,
      last_password: finalTxn.last_password,
      start_time: finalTxn.start_time,
      end_time: finalTxn.end_time,
      user_id: finalTxn.user_id,
      label_mode: finalTxn.label_mode
    });
  } catch (err) {
    console.error("Error /promo/claim:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// User login: view transaction details + platform_actions + invite_link
app.post("/user/login", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, message: "code is required" });
    }

    const normCode = code.trim().toUpperCase();
    const snap = await db.ref(`transactions/${normCode}`).get();
    if (!snap.exists()) {
      return res.status(404).json({ success: false, message: "Invalid code" });
    }

    const trx = snap.val();

    if (trx.hidden === true) {
      return res.status(403).json({ success: false, message: "This code is no longer active" });
    }
    const endTime = parseEndTime(trx.end_time);
    if (endTime && endTime.getTime() < Date.now()) {
      return res.status(403).json({
        success: false,
        message: "This subscription has expired",
        expired: true
      });
    }

    let platform = trx.platform || null;
    const slotId = trx.slot_id || null;
    let slot = null;

    if (slotId) {
      slot = await getSlot(slotId);
      if (!platform && slot && slot.platform) {
        platform = slot.platform;
      }
    }

    let actionsConf = {};
    try {
      const actsSnap = await db.ref("settings/platform_actions").get();
      const root = actsSnap.val() || {};
      if (platform && root[platform]) {
        actionsConf = root[platform];
      } else if (root.default) {
        actionsConf = root.default;
      }
    } catch {
      actionsConf = {};
    }

    const actions = {
      refresh_enabled: !!actionsConf.refresh_enabled,
      otp_enabled: !!actionsConf.otp_enabled,
      code_enabled: !!actionsConf.code_enabled,
      invite_enabled: !!actionsConf.invite_enabled
    };

    let inviteLink = null;
    if (actions.invite_enabled) {
      inviteLink =
        trx.invite_link_short ||
        trx.invite_link_long ||
        null;
      if (!inviteLink && trx.assign_to) {
        const credSnap = await db.ref(trx.assign_to).get();
        const cred = credSnap.val() || {};
        if (cred.invite_link) {
          inviteLink = cred.invite_link;
        }
      }
    }

    return res.json({
      success: true,
      code: normCode,
      platform: platform || null,
      slot_id: trx.slot_id || null,
      slot_name: trx.slot_name || null,
      headline: trx.headline || null,
      last_email: trx.last_email || null,
      last_password: trx.last_password || null,
      start_time: trx.start_time || null,
      end_time: trx.end_time || null,
      user_id: trx.user_id || null,
      label_mode: trx.label_mode || null,
      actions,
      invite_link: inviteLink
    });
  } catch (err) {
    console.error("Error in /user/login:", err);
    return res.status(500).json({ success: false, message: "Internal error" });
  }
});

// Account: refresh credentials (like Refresh button)
app.post("/account/refresh", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, message: "code is required" });
    }

    const normCode = code.trim().toUpperCase();
    const snap = await db.ref(`transactions/${normCode}`).get();
    if (!snap.exists()) {
      return res.status(404).json({ success: false, message: "Invalid code" });
    }
    const trx = snap.val();

    const endTime = parseEndTime(trx.end_time);
    if (endTime && endTime.getTime() < Date.now()) {
      return res.status(403).json({ success: false, message: "Your access has expired" });
    }

    const credKey = trx.assign_to;
    if (!credKey) {
      return res.status(400).json({ success: false, message: "No credential assigned yet" });
    }

    const credSnap = await db.ref(credKey).get();
    if (!credSnap.exists()) {
      return res.status(404).json({ success: false, message: "Credential not found" });
    }

    const cred = credSnap.val();
    const newEmail = cred.email || "";
    const newPassword = cred.password || "";

    const lastEmail = trx.last_email || "";
    const lastPassword = trx.last_password || "";

    if (newEmail === lastEmail && newPassword === lastPassword) {
      return res.json({
        success: false,
        unchanged: true,
        message: "No change in credentials",
        email: newEmail,
        password: newPassword
      });
    }

    await db.ref(`transactions/${normCode}`).update({
      last_email: newEmail,
      last_password: newPassword
    });

    return res.json({
      success: true,
      message: "Credentials refreshed",
      email: newEmail,
      password: newPassword
    });
  } catch (err) {
    console.error("Error in /account/refresh:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// Account: get OTP (TOTP) for this credential
app.post("/account/get-otp", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, message: "code is required" });
    }

    const normCode = code.trim().toUpperCase();
    const snap = await db.ref(`transactions/${normCode}`).get();
    if (!snap.exists()) {
      return res.status(404).json({ success: false, message: "Invalid code" });
    }
    const trx = snap.val();

    const endTime = parseEndTime(trx.end_time);
    if (endTime && endTime.getTime() < Date.now()) {
      return res.status(403).json({ success: false, message: "Your access has expired" });
    }

    const credKey = trx.assign_to;
    if (!credKey) {
      return res.status(400).json({ success: false, message: "No credential assigned" });
    }

    const credSnap = await db.ref(credKey).get();
    if (!credSnap.exists()) {
      return res.status(404).json({ success: false, message: "Credential not found" });
    }
    const cred = credSnap.val();
    const secret = (cred.secret || "").trim();
    if (!secret) {
      return res.status(400).json({ success: false, message: "No OTP secret configured" });
    }

    const { code: otp, ttl } = generateTotp(secret, 30, 6);

    await db.ref(`transactions/${normCode}`).update({
      otp_delivered: true
    });

    return res.json({
      success: true,
      otp,
      ttl,
      message: "OTP generated"
    });
  } catch (err) {
    console.error("Error in /account/get-otp:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// Account: get code via OOR mail service (like Get Code)
app.post("/account/get-code", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, message: "code is required" });
    }

    const normCode = code.trim().toUpperCase();
    const snap = await db.ref(`transactions/${normCode}`).get();
    if (!snap.exists()) {
      return res.status(404).json({ success: false, message: "Invalid code" });
    }
    const trx = snap.val();

    const endTime = parseEndTime(trx.end_time);
    if (endTime && endTime.getTime() < Date.now()) {
      return res.status(403).json({ success: false, message: "Your access has expired" });
    }

    const credKey = trx.assign_to;
    if (!credKey) {
      return res.status(400).json({ success: false, message: "No credential assigned" });
    }

    const credSnap = await db.ref(credKey).get();
    if (!credSnap.exists()) {
      return res.status(404).json({ success: false, message: "Credential not found" });
    }
    const cred = credSnap.val();
    const email = (cred.email || "").trim();
    if (!email) {
      return res.status(400).json({ success: false, message: "No email configured for this credential" });
    }

    let platform = (trx.platform || "").trim();
    if (!platform && cred.belongs_to_platform) {
      platform = cred.belongs_to_platform;
    }
    if (!platform) {
      return res.status(400).json({ success: false, message: "No platform configured" });
    }
    const platformKey = platform.toLowerCase();

    const pathRuntime = `runtime/code_windows/${platformKey}`;
    const nodeSnap = await db.ref(pathRuntime).get();
    const node = nodeSnap.val() || {};
    const nowTs = Math.floor(Date.now() / 1000);
    const windowUntil = parseInt(node.window_until || 0, 10);

    if (windowUntil > nowTs) {
      return res.status(429).json({
        success: false,
        message: "Code line busy, please try again in a few seconds"
      });
    }

    await db.ref(pathRuntime).update({
      window_until: nowTs + 90
    });

    let codeVal = null;
    let attempts = 0;

    const baseUrl = "https://oormail-services.by-oor.workers.dev/otp";

    while (attempts < 3 && !codeVal) {
      attempts += 1;
      const url = new URL(baseUrl);
      url.searchParams.set("mail", email);
      url.searchParams.set("platform", platformKey);

      let resp;
      try {
        resp = await fetch(url.toString());
      } catch (e) {
        console.error("[GetCode] HTTP error:", e);
        break;
      }

      const text = await resp.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }

      const status = String(payload.status || "").toLowerCase();
      if (status === "success") {
        const c = String(payload.code || "").trim();
        if (c) {
          codeVal = c;
          break;
        } else {
          break;
        }
      } else if (status === "not_found") {
        if (attempts < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempts));
          continue;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    await db.ref(pathRuntime).update({ window_until: 0 });

    if (!codeVal) {
      return res.status(200).json({
        success: false,
        message: "No sign-in code found yet. Wait a bit and try again."
      });
    }

    await db.ref(`transactions/${normCode}`).update({
      code_delivered: true
    });

    return res.json({
      success: true,
      message: "Code fetched successfully",
      code: codeVal
    });
  } catch (err) {
    console.error("Error in /account/get-code:", err);
    res.status(500).json({ success: false, message: "Internal error" });
  }
});

// -------- Start server --------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
