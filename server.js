process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const Imap = require("imap-simple");

const app = express();
app.use(express.json());
app.use(cors());

// ✅ Rate limiting to prevent spam (100 requests per 15 min)
const emailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, please try again later." },
});

// ✅ Authorized users (store securely in .env)
const AUTHORIZED_USERS = {
    "kritikaansari8@gmail.com": process.env.APP_PASSWORD_KRITIKA,
    "yogibaba1207@gmail.com": process.env.APP_PASSWORD_YOGIBABA,
};

// ✅ Multer configuration for file upload (restrict file types)
const upload = multer({
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ["image/png", "image/jpeg", "application/pdf", "text/plain"];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Invalid file type. Only PNG, JPEG, PDF, and TXT are allowed."));
        }
    },
});

// ✅ Send email
app.post("/send-email", emailLimiter, upload.single("attachment"), async (req, res) => {
    const { fromEmail, toEmail, subject, message } = req.body;
    const attachment = req.file;

    if (!fromEmail || !toEmail || !subject || !message) {
        return res.status(400).json({ error: "All fields are required." });
    }

    if (!(fromEmail in AUTHORIZED_USERS)) {
        return res.status(403).json({ error: "Unauthorized sender." });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: fromEmail,
                pass: AUTHORIZED_USERS[fromEmail],
            },
        });

        const mailOptions = {
            from: fromEmail,
            to: toEmail,
            subject,
            text: message,
            attachments: attachment
                ? [{ filename: attachment.originalname, content: attachment.buffer }]
                : [],
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "Email sent successfully!" });
    } catch (error) {
        console.error("❌ Email send error:", error.message);
        res.status(500).json({ error: "Failed to send email. Please try again later." });
    }
});

// ✅ Save email as draft
app.post("/save-draft", emailLimiter, upload.single("attachment"), async (req, res) => {
    const { fromEmail, toEmail, subject, message } = req.body;
    const attachment = req.file;

    if (!fromEmail) {
        return res.status(400).json({ error: "From email is required." });
    }

    if (!(fromEmail in AUTHORIZED_USERS)) {
        return res.status(403).json({ error: "Unauthorized sender." });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: fromEmail,
                pass: AUTHORIZED_USERS[fromEmail],
            },
        });

        const mailOptions = {
            from: fromEmail,
            to: toEmail || "",
            subject: subject || "",
            text: message || "",
            attachments: attachment
                ? [{ filename: attachment.originalname, content: attachment.buffer }]
                : [],
        };

        // Save to drafts folder by setting the 'draft' flag
        const info = await transporter.sendMail({
            ...mailOptions,
            headers: {
                'X-GM-DRAFT': 'yes'
            },
            flags: ['Draft']
        });

        res.json({
            success: true,
            message: "Draft saved successfully!",
            draftId: info.messageId
        });
    } catch (error) {
        console.error("❌ Draft save error:", error.message);
        res.status(500).json({ error: "Failed to save draft. Please try again later." });
    }
});

// ✅ Update existing draft
app.put("/update-draft/:draftId", emailLimiter, upload.single("attachment"), async (req, res) => {
    const { draftId } = req.params;
    const { fromEmail, toEmail, subject, message } = req.body;
    const attachment = req.file;

    if (!fromEmail || !draftId) {
        return res.status(400).json({ error: "From email and draft ID are required." });
    }

    if (!(fromEmail in AUTHORIZED_USERS)) {
        return res.status(403).json({ error: "Unauthorized sender." });
    }

    try {
        // First, find and delete the existing draft
        const config = {
            imap: {
                user: fromEmail,
                password: AUTHORIZED_USERS[fromEmail],
                host: "imap.gmail.com",
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
            },
        };

        const connection = await Imap.connect(config);
        await connection.openBox("[Gmail]/Drafts");

        // Search for the specific draft using Message-ID
        const searchCriteria = ['HEADER', 'Message-ID', draftId];
        const fetchOptions = { bodies: [''], struct: true };

        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length > 0) {
            // Delete the existing draft
            await connection.addFlags(messages[0].attributes.uid, '\\Deleted');
            await connection.closeBox(true); // Expunge on close
        } else {
            await connection.end();
            return res.status(404).json({ error: "Draft not found." });
        }

        await connection.end();

        // Create a new draft with updated content
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: fromEmail,
                pass: AUTHORIZED_USERS[fromEmail],
            },
        });

        const mailOptions = {
            from: fromEmail,
            to: toEmail || "",
            subject: subject || "",
            text: message || "",
            attachments: attachment
                ? [{ filename: attachment.originalname, content: attachment.buffer }]
                : [],
        };

        // Save the updated draft
        const info = await transporter.sendMail({
            ...mailOptions,
            headers: {
                'X-GM-DRAFT': 'yes'
            },
            flags: ['Draft']
        });

        res.json({
            success: true,
            message: "Draft updated successfully!",
            draftId: info.messageId
        });
    } catch (error) {
        console.error("❌ Draft update error:", error.message);
        res.status(500).json({ error: "Failed to update draft. Please try again later." });
    }
});

// ✅ Fetch emails from a folder
async function fetchEmailsFromFolder(email, folderName, limit = 20) {
    if (!email || !(email in AUTHORIZED_USERS)) {
        throw new Error("Unauthorized email account.");
    }

    const config = {
        imap: {
            user: email,
            password: AUTHORIZED_USERS[email],
            host: "imap.gmail.com",
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
        },
    };

    const connection = await Imap.connect(config);
    await connection.openBox(folderName);

    const searchCriteria = ["ALL"];
    const fetchOptions = {
        bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
        struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    const emails = messages.slice(0, limit).map((message) => {
        const headerPart = message.parts.find((part) =>
            part.which === "HEADER.FIELDS (FROM TO SUBJECT DATE)"
        );
        const bodyPart = message.parts.find((part) => part.which === "TEXT");

        return {
            id: message.attributes.uid,
            from: headerPart?.body.from?.[0] || "Unknown",
            to: headerPart?.body.to?.[0] || "Unknown",
            subject: headerPart?.body.subject?.[0] || "No Subject",
            date: headerPart?.body.date?.[0] || "Unknown Date",
            body: bodyPart?.body.toString() || "No Content",
            isRead: !message.attributes.flags.includes("\\Seen"),
        };
    });

    await connection.end();
    return emails;
}

// ✅ Fetch Inbox
app.get("/fetch-inbox-emails", async (req, res) => {
    const { email } = req.query;
    try {
        const emails = await fetchEmailsFromFolder(email, "INBOX");
        res.json({ success: true, emails });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ Fetch Sent Mail
app.get("/fetch-sent-emails", async (req, res) => {
    const { email } = req.query;
    try {
        const emails = await fetchEmailsFromFolder(email, "[Gmail]/Sent Mail");
        res.json({ success: true, emails });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ Fetch Drafts
app.get("/fetch-drafts", async (req, res) => {
    const { email } = req.query;
    try {
        const emails = await fetchEmailsFromFolder(email, "[Gmail]/Drafts");
        res.json({ success: true, emails });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ List all mailboxes
app.get("/list-mailboxes", async (req, res) => {
    const { email } = req.query;
    try {
        const config = {
            imap: {
                user: email,
                password: AUTHORIZED_USERS[email],
                host: "imap.gmail.com",
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
            },
        };

        const connection = await Imap.connect(config);
        const boxes = await connection.getBoxes();
        await connection.end();

        const mailboxes = Object.keys(boxes);
        res.json({ success: true, mailboxes });
    } catch (error) {
        res.status(500).json({ error: "Failed to list mailboxes." });
    }
});

// ✅ Mark email as read
app.post("/mark-as-read", async (req, res) => {
    const { email, messageId, folder = "INBOX" } = req.body;

    try {
        const config = {
            imap: {
                user: email,
                password: AUTHORIZED_USERS[email],
                host: "imap.gmail.com",
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
            },
        };

        const connection = await Imap.connect(config);
        await connection.openBox(folder);
        await connection.addFlags(messageId, "\\Seen");
        await connection.end();

        res.json({ success: true, message: "Email marked as read." });
    } catch (error) {
        res.status(500).json({ error: "Failed to mark email as read." });
    }
});

// ✅ Search emails
app.get("/search-emails", async (req, res) => {
    const { email, query, folder = "INBOX" } = req.query;

    try {
        const emails = await fetchEmailsFromFolder(email, folder);
        const filteredEmails = emails.filter(
            (email) =>
                email.subject.includes(query) || email.from.includes(query)
        );
        res.json({ success: true, emails: filteredEmails });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));