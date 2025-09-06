// server.js — SIMPLE: no API key, just Nodemailer + PDFKit
// Endpoints:
//   GET  /api/health
//   POST /api/send-email
//   POST /api/send-pdf-email   (optional)
//   POST /api/send-absent-emails  (NEW: batch absent alerts)
//
// Uses Gmail SMTP (App Password). No API key required.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
require("dotenv").config();

const app = express();

// Trust proxy for Render deployment
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, "public")));


/* ========== Config (.env) ========== */
const PORT        = process.env.PORT || 3000;
const SMTP_USER   = process.env.SMTP_USER; // Remove default fallback for security
const SMTP_PASS   = process.env.SMTP_PASS; // Remove default fallback for security
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DRY_RUN     = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const NODE_ENV    = process.env.NODE_ENV || "development";

const REPORT_DIR = path.join(__dirname, "reports");
fs.mkdirSync(REPORT_DIR, { recursive: true });

/* ========== Middleware ========== */
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN }));

// Security headers
app.use((req, res, next) => {
  // Prevent XSS attacks
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Content Security Policy
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "media-src 'self' blob:;"
  );
  
  next();
});

// Rate limiting middleware
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20;

function rateLimit(req, res, next) {
  const clientId = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(clientId)) {
    rateLimitMap.set(clientId, []);
  }
  
  const requests = rateLimitMap.get(clientId);
  const validRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (validRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({ 
      ok: false, 
      message: "Too many requests. Please try again later." 
    });
  }
  
  validRequests.push(now);
  rateLimitMap.set(clientId, validRequests);
  next();
}

// Apply rate limiting to API routes
app.use('/api', rateLimit);

app.use(express.json({ limit: "1mb" }));

/* ========== Utilities ========== */
const isEmail = (s="") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
function formatIST(isoOrDate = new Date()){
  const d = new Date(isoOrDate);
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(d);
}

/* ========== Enhanced Mailer Configuration ========== */
let transporter = null;
if (!DRY_RUN) {
  if (!SMTP_USER || !SMTP_PASS) {
    logger.warn("SMTP credentials not configured. Set SMTP_USER and SMTP_PASS in .env (or use DRY_RUN=true).");
  } else {
    transporter = nodemailer.createTransporter({
      host: "smtp.gmail.com",
      port: 587, // Use STARTTLS instead of SSL for better compatibility
      secure: false, // Use STARTTLS
      requireTLS: true,
      auth: { 
        user: SMTP_USER, 
        pass: SMTP_PASS 
      },
      // Enhanced configuration for better deliverability
      pool: true, // Use connection pooling
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000, // 1 second between messages
      rateLimit: 5, // Max 5 messages per rateDelta
      // Timeout configurations
      connectionTimeout: 30000, // 30 seconds
      greetingTimeout: 30000,
      socketTimeout: 30000,
      // TLS options
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      },
      // Debug for development
      debug: NODE_ENV === 'development',
      logger: NODE_ENV === 'development'
    });
    
    // Enhanced SMTP verification with retry logic
    const verifyTransporter = async (retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          await transporter.verify();
          logger.success("SMTP connection verified and ready");
          return;
        } catch (err) {
          logger.warn(`SMTP verification attempt ${i + 1} failed:`, err.message);
          if (i === retries - 1) {
            logger.error("SMTP verification failed after all retries. Email sending may not work.");
          } else {
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
          }
        }
      }
    };
    
    verifyTransporter();
  }
}

/* ========== Email content builders ========== */
function buildAttendanceEmail({ studentId, studentName, whenISO }) {
  const whenStr = formatIST(whenISO);
  const text = `Dear Parent,

Your child ${studentName} (ID: ${studentId}) is marked PRESENT at Saamarthya Academy.

Date & Time: ${whenStr}

Best regards,
Saamarthya Academy`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;line-height:1.6">
    <p>Dear Parent,</p>
    <p>
      Your child <strong>${studentName}</strong> (ID: <strong>${studentId}</strong>) is marked
      <span style="display:inline-block;padding:4px 10px;border-radius:9999px;background:#d1fae5;color:#065f46;border:1px solid #a7f3d0;font-weight:700;">
        PRESENT
      </span>
      at Saamarthya Academy.
    </p>
    <p style="margin:12px 0 0 0;"><strong>Date &amp; Time:</strong> ${whenStr}</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />
    <p style="margin:0">Best regards,</p>
    <p style="margin:0"><strong>Saamarthya Academy</strong></p>
  </div>`;

  return { subject: "Attendance: Present ✔️", text, html };
}

/* NEW: Absent email content */
function buildAbsentEmail({ studentId, studentName, dateISO }) {
  const dayStr = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeZone: "Asia/Kolkata"
  }).format(new Date(dateISO || new Date()));

  const text = `Dear Parent,

This is to inform you that ${studentName} (ID: ${studentId}) was marked ABSENT at Saamarthya Academy.

Date: ${dayStr}

If this is unexpected, please contact the Institute administration.

Best regards,
Saamarthya Academy`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;line-height:1.6">
    <p>Dear Parent,</p>
    <p>
      This is to inform you that <strong>${studentName}</strong> (ID: <strong>${studentId}</strong>) was marked
      <span style="display:inline-block;padding:4px 10px;border-radius:9999px;background:#fee2e2;color:#991b1b;border:1px solid #fecaca;font-weight:700;">
        ABSENT
      </span>
      at Saamarthya Academy.
    </p>
    <p style="margin:12px 0 0 0;"><strong>Date:</strong> ${dayStr}</p>
    <p style="margin:12px 0 0 0;">If this is unexpected, please contact the school administration.</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />
    <p style="margin:0">Best regards,</p>
    <p style="margin:0"><strong>Saamarthya Academy</strong></p>
  </div>`;

  return { subject: "Attendance: Absent ❗", text, html };
}

/* ========== Routes ========== */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dryRun: DRY_RUN, time: new Date().toISOString() });
});

// No API key check — just send
app.post("/api/send-email", async (req, res) => {
  try {
    const { studentId, studentName, parentEmail, timestamp } = req.body || {};
    if (!studentId || !studentName || !parentEmail) {
      return res.status(400).json({ ok: false, message: "Missing fields" });
    }
    if (!isEmail(parentEmail)) {
      return res.status(400).json({ ok: false, message: "Invalid parentEmail" });
    }

    const when = timestamp ? new Date(timestamp) : new Date();
    const { subject, text, html } = buildAttendanceEmail({
      studentId, studentName, whenISO: when.toISOString()
    });

    let emailSent = false;
    if (DRY_RUN || !transporter) {
      console.log("📧 [DRY_RUN] Would send to:", parentEmail, "|", subject);
      emailSent = true;
    } else {
      try {
        emailInfo = await transporter.sendMail({
          from: `"Saamarthya Academy" <${SMTP_USER}>`,
          to: sanitizedParentEmail,
          subject,
          text,
          html,
          // Add headers for better deliverability
          headers: {
            'X-Mailer': 'Saamarthya Academy Attendance System',
            'X-Priority': '3'
          }
        });
        
        logger.success("Email sent successfully", { 
          messageId: emailInfo.messageId, 
          to: sanitizedParentEmail,
          studentId: sanitizedStudentId 
        });
        emailSent = true;
      } catch (emailError) {
        logger.error("Failed to send email", emailError);
        return res.status(500).json({ 
          ok: false, 
          message: "Failed to send email",
          error: emailError.message 
        });
      }
    }

    res.json({ ok: true, emailSent });
  } catch (err) {
    console.error("❌ /api/send-email:", err?.message || err);
    res.status(500).json({ ok: false, message: "Internal error" });
  }
});

// Optional monthly report with PDF attachment (also no API key)
app.post("/api/send-pdf-email", async (req, res) => {
  try {
    const { studentName, parentEmail, reportData } = req.body || {};
    if (!studentName || !parentEmail || !reportData) {
      return res.status(400).json({ ok: false, message: "Missing fields" });
    }
    if (!isEmail(parentEmail)) {
      return res.status(400).json({ ok: false, message: "Invalid parentEmail" });
    }

    // Build PDF
    const safe = String(studentName || "student").replace(/[^\w\-]+/g, "_");
    const pdfPath = path.join(REPORT_DIR, `${safe}_monthly_${Date.now()}.pdf`);
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const out = fs.createWriteStream(pdfPath);
      doc.pipe(out);

      doc.fontSize(20).text("📘 Monthly Attendance Report", { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(`Student: ${studentName}`);
      doc.text(`Generated On: ${formatIST(new Date())}`);
      doc.moveDown();
      doc.fontSize(14).text("Attendance Records:", { underline: true });
      doc.moveDown(0.5);
      const lines = Array.isArray(reportData) ? reportData : String(reportData).split("\n");
      if (!lines.length) doc.fontSize(12).text("No records provided.");
      else lines.forEach((line, i) => doc.fontSize(12).text(`${i + 1}. ${line}`));

      doc.moveDown();
      doc.fontSize(12).text("Best regards,\nSaamarthya Academy");

      doc.end();
      out.on("finish", resolve);
      out.on("error", reject);
    });

    let emailSent = false;
    if (DRY_RUN || !transporter) {
      console.log("📎 [DRY_RUN] Would email PDF to:", parentEmail, "file:", pdfPath);
      emailSent = true;
    } else {
      try {
        const info = await transporter.sendMail({
          from: `"Saamarthya Academy" <${SMTP_USER}>`,
          to: parentEmail,
          replyTo: SMTP_USER,
          subject: "Monthly Attendance Report",
          text: "Attached is your child's monthly attendance report.\n\nBest regards,\nSaamarthya Academy",
          html: `<p>Attached is your child's monthly attendance report.</p><p>Best regards,<br><strong>Saamarthya Academy</strong></p>`,
          attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
          headers: {
            'X-Mailer': 'Saamarthya Academy Attendance System v1.0',
            'X-Priority': '3',
            'List-Unsubscribe': `<mailto:${SMTP_USER}?subject=Unsubscribe>`
          }
        });
        console.log("✅ Report email sent:", info.messageId || info.response);
        emailSent = true;
      } finally {
        try { fs.unlinkSync(pdfPath); } catch {}
      }
    }

    res.json({ ok: true, emailSent });
  } catch (err) {
    console.error("❌ /api/send-pdf-email:", err?.message || err);
    res.status(500).json({ ok: false, message: "Internal error" });
  }
});

/* ========== NEW: Batch Absent Alerts after Finalize ========== */
// Payload example:
// {
//   "records":[
//     {"studentId":"SAH25009","studentName":"Aditya Raj","parentEmail":"parent@example.com","dateISO":"2025-08-25"},
//     ...
//   ]
// }
app.post("/api/send-absent-emails", async (req, res) => {
  try {
    const { records } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ ok: false, message: "records[] required" });
    }

    const results = [];
    for (const rec of records) {
      const { studentId, studentName, parentEmail, dateISO } = rec || {};
      if (!studentId || !studentName || !parentEmail || !isEmail(parentEmail)) {
        results.push({ studentId, ok: false, message: "Invalid or missing fields" });
        continue;
      }

      const { subject, text, html } = buildAbsentEmail({ studentId, studentName, dateISO });

      if (DRY_RUN || !transporter) {
        console.log("📧 [DRY_RUN] Would send ABSENT to:", parentEmail, "|", subject);
        results.push({ studentId, ok: true, dryRun: true });
      } else {
        try {
          const info = await transporter.sendMail({
            from: `"Saamarthya Academy" <${SMTP_USER}>`,
            to: parentEmail,
            replyTo: SMTP_USER,
            subject,
            text,
            html,
            headers: {
              'X-Mailer': 'Saamarthya Academy Attendance System v1.0',
              'X-Priority': '3',
              'List-Unsubscribe': `<mailto:${SMTP_USER}?subject=Unsubscribe>`
            }
          });
          console.log("✅ Absent email sent:", info.messageId || info.response);
          results.push({ studentId, ok: true });
        } catch (e) {
          console.error("❌ Absent email failed:", studentId, e?.message || e);
          results.push({ studentId, ok: false, message: e?.message || "send failed" });
        }
      }
      // (Optional) modest delay to avoid SMTP throttling:
      await new Promise(r => setTimeout(r, 150));
    }

    const sent = results.filter(r => r.ok).length;
    res.json({ ok: true, sent, total: results.length, results });
  } catch (err) {
    console.error("❌ /api/send-absent-emails:", err?.message || err);
    res.status(500).json({ ok: false, message: "Internal error" });
  }
});

// Health check endpoint for Render and other platforms
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

/* ========== Start Server ========== */
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.success(`Server running on port ${PORT}`);
  logger.info(`Environment: ${NODE_ENV}`);
  logger.info(`DRY_RUN: ${DRY_RUN ? "enabled" : "disabled"}`);
  logger.info(`SMTP configured: ${SMTP_USER ? "yes" : "no"}`);
  
  // Log server configuration for debugging
  if (NODE_ENV === 'development') {
    logger.info('Server configuration:', {
      port: PORT,
      corsOrigin: CORS_ORIGIN,
      trustProxy: app.get('trust proxy'),
      rateLimitWindow: RATE_LIMIT_WINDOW,
      maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW
    });
  }
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use`);
  } else {
    logger.error('Server error:', error);
  }
  process.exit(1);
});
