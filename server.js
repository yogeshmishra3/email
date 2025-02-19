require('dotenv').config(); // Load environment variables
const express = require('express');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const cors = require('cors');
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 5002;

// Middleware
app.use(bodyParser.json());
app.use(cors());

// Connect to MongoDB
mongoose
    .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Draft Schema
const DraftSchema = new mongoose.Schema({
    to: { type: String, required: false },
    subject: { type: String, required: false },
    body: { type: String, required: false },
    date: { type: Date, default: Date.now }
});

const Draft = mongoose.model("Draft", DraftSchema);

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// In-memory storage for sent emails
const sentEmails = [];

// Configure Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// IMAP Configuration
const imap = new Imap({
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASS,
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT,
    tls: true,
    timeout: 30000,
});

// Function to connect IMAP
function connectImap() {
    imap.connect();
}

imap.on('error', (err) => {
    console.error('IMAP error:', err);
    setTimeout(connectImap, 5000); // Attempt to reconnect after 5s
});

imap.on('end', () => {
    console.log('IMAP connection ended. Reconnecting...');
    setTimeout(connectImap, 5000);
});

// Initial connection
connectImap();

// Error handling for uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

// ✅ Send Email Route
app.post('/send-email', upload.single('attachment'), async (req, res) => {
    const { email, subject, body } = req.body;
    const file = req.file;

    if (!email || !subject || !body) {
        return res.status(400).send({ message: 'Recipient email, subject, and body are required' });
    }

    const mailOptions = {
        from: process.env.SMTP_USER,
        to: email,
        subject: subject,
        text: body,
        attachments: file ? [{ filename: file.originalname, path: file.path }] : [],
    };

    try {
        const info = await transporter.sendMail(mailOptions);

        if (file) {
            fs.unlink(file.path, (err) => {
                if (err) console.error('Error deleting uploaded file:', err);
            });
        }

        sentEmails.push({ from: process.env.SMTP_USER, to: email, subject, body, date: new Date() });

        res.status(200).send({ message: 'Email sent successfully!', info });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).send({ message: 'Error sending email', error: error.message });
    }
});

// ✅ Fetch Sent Emails API
app.get('/fetch-sent-emails', (req, res) => {
    try {
        sentEmails.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.status(200).send({ emails: sentEmails });
    } catch (err) {
        console.error('Error fetching sent emails:', err);
        res.status(500).send({ message: 'Error fetching sent emails', error: err.message });
    }
});

// ✅ Fetch Inbox Emails API
app.get('/fetch-inbox-emails', async (req, res) => {
    const emails = [];

    try {
        await new Promise((resolve, reject) => {
            imap.once('ready', () => {
                const folderToOpen = 'INBOX';

                imap.openBox(folderToOpen, true, (err, box) => {
                    if (err) return reject(new Error(`Error opening folder '${folderToOpen}': ${err.message}`));

                    imap.search(['ALL'], (err, results) => {
                        if (err) return reject(new Error(`Error searching emails: ${err.message}`));

                        if (results.length === 0) {
                            console.log(`No emails found in folder '${folderToOpen}'.`);
                            return resolve();
                        }

                        const fetcher = imap.fetch(results.reverse(), { bodies: '' });

                        fetcher.on('message', (msg) => {
                            msg.on('body', (stream) => {
                                simpleParser(stream, (err, parsed) => {
                                    if (err) return console.error('Error parsing email:', err.message);

                                    if (parsed?.from?.text && parsed.subject && parsed.date) {
                                        emails.push({
                                            from: parsed.from.text,
                                            subject: parsed.subject,
                                            date: parsed.date,
                                            body: parsed.text,
                                        });
                                    }
                                });
                            });
                        });

                        fetcher.once('end', () => {
                            console.log(`Finished fetching emails from folder '${folderToOpen}'.`);
                            resolve();
                        });
                    });
                });
            });

            imap.once('error', (err) => reject(new Error(`IMAP connection error: ${err.message}`)));
            imap.once('end', () => console.log('IMAP connection closed.'));
            imap.connect();
        });

        emails.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.status(200).send({ emails });
    } catch (err) {
        console.error('Error fetching inbox emails:', err);
        res.status(500).send({ message: 'Error fetching inbox emails', error: err.message });
    }
});

// ✅ Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
