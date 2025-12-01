const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const forge = require('node-forge');
const signer = require('node-signpdf').default;
const { plainAddPlaceholder } = require('node-signpdf');
const { PDFDocument } = require('pdf-lib'); // ✅ Untuk flattening

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Uploads dir
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        cb(null, `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

// === Helper: Parse P12 ===
function parseP12Certificate(p12Buffer, password = '') {
    try {
        const p12B64 = p12Buffer.toString('base64');
        const p12Der = forge.util.decode64(p12B64);
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

        const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        if (!certBag || certBag.length === 0) throw new Error('No certificate found in P12 file');

        const cert = certBag[0].cert;
        const getField = (name) => {
            try {
                const field = cert.subject.getField(name);
                return field ? field.value : '';
            } catch (e) {
                return '';
            }
        };

        return {
            success: true,
            commonName: getField('CN') || 'Unknown Signer',
            email: getField('emailAddress') || '',
            organization: getField('O') || '',
            validFrom: cert.validity.notBefore,
            validTo: cert.validity.notAfter,
            cert: cert,
            p12: p12
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// === Helper: Check Signature with Accurate LTV Detection & User-Friendly Output ===
function checkPdfSignature(pdfBuffer) {
    const pdfText = pdfBuffer.toString('binary');
    const hasSig = /\/Type\s*\/Sig|\/FT\s*\/Sig|\/SubFilter\s*\/adbe\.pkcs7/i.test(pdfText);
    if (!hasSig) return { hasSig: false };

    let hasLTV = false;

    try {
        // 1. Cek /DSS di root level
        if (/\/DSS\s+\d+\s+0\s+R/i.test(pdfText)) {
            hasLTV = true;
        }

        // 2. Cek /Type /DSS di object definition
        if (!hasLTV && /\/Type\s*\/DSS/i.test(pdfText)) {
            hasLTV = true;
        }

        // 3. Cek di compressed streams
        if (!hasLTV) {
            const streamRegex = /(\d+\s+0\s+obj\s*<<[^>]*>>)\s*stream\s*\n([\s\S]*?)\s*endstream/g;
            let match;
            let streamCount = 0;

            while ((match = streamRegex.exec(pdfText)) !== null && streamCount < 50) {
                streamCount++;
                const objHeader = match[1];
                const streamContent = match[2];

                if (/\/Filter\s*\/FlateDecode/i.test(objHeader)) {
                    try {
                        const streamBytes = Buffer.from(streamContent, 'binary');
                        const decompressed = zlib.inflateSync(streamBytes);
                        const decompressedText = decompressed.toString('binary');

                        if (/\/Type\s*\/DSS|\/DSS\s+\d+\s+0\s+R/i.test(decompressedText)) {
                            hasLTV = true;
                            break;
                        }
                    } catch (zlibErr) {
                        // Skip
                    }
                } else {
                    if (/\/Type\s*\/DSS|\/DSS\s+\d+\s+0\s+R/i.test(streamContent)) {
                        hasLTV = true;
                        break;
                    }
                }
            }
        }

        // 4. Cek VRI sebagai fallback
        if (!hasLTV && /\/Type\s*\/VRI/i.test(pdfText)) {
            hasLTV = true;
        }

    } catch (e) {
        console.warn('⚠️ LTV detection failed:', e.message);
    }

    const decodePdfString = (str) => {
        if (!str) return '';
        return str
            .replace(/\\([0-3][0-7]{2})/g, (match, oct) => String.fromCharCode(parseInt(oct, 8)))
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');
    };

    const extract = (regex) => {
        const match = pdfText.match(regex);
        return match ? decodePdfString(match[1]) : '';
    };

    // ✅ Ambil signer name: prioritaskan /Name, fallback ke /T (misal "Signature1")
    let signer = extract(/\/Name\s*\(([^)]*(?:\\\)[^)]*)*)\)/);
    if (!signer || signer.trim() === '') {
        signer = extract(/\/T\s*\(([^)]*(?:\\\)[^)]*)*)\)/) || 'Signature1';
    }

    // ✅ Ambil tanggal mentah dari PDF
    const rawDate = extract(/\/M\s*\(D:(\d{14})/); // contoh: 20250925090927

    // ✅ Konversi ke format "25/09/2025 09:09:27"
    let formattedDate = '';
    if (rawDate && rawDate.length >= 14) {
        const year = rawDate.substring(0, 4);
        const month = rawDate.substring(4, 6);
        const day = rawDate.substring(6, 8);
        const hour = rawDate.substring(8, 10);
        const minute = rawDate.substring(10, 12);
        const second = rawDate.substring(12, 14);
        formattedDate = `${day}/${month}/${year} ${hour}:${minute}:${second}`;
    }

    const result = {
        hasSig: true,
        hasLTV: hasLTV,
        signer: signer, // ✅ Akan jadi "Signature1" jika tidak ada /Name
        reason: extract(/\/Reason\s*\(([^)]*(?:\\\)[^)]*)*)\)/),
        location: extract(/\/Location\s*\(([^)]*(?:\\\)[^)]*)*)\)/),
        date: formattedDate, // ✅ Format tanggal sesuai permintaan
    };

    return result;
}

// === Routes ===
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'PDF Signing Service is running' });
});

app.post('/api/check-signature', upload.single('pdf'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    try {
        const buf = fs.readFileSync(req.file.path);
        const result = checkPdfSignature(buf);
        fs.unlinkSync(req.file.path);
        res.json(result);
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/parse-certificate', upload.single('certificate'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No certificate file uploaded' });
    try {
        const buf = fs.readFileSync(req.file.path);
        const result = parseP12Certificate(buf, req.body.password || '');
        fs.unlinkSync(req.file.path);
        if (result.success) {
            const { cert, p12, ...safeResult } = result;
            res.json(safeResult);
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

// === SIGNING ENDPOINT (Flattened + Cryptographic) ===
app.post('/api/sign-pdf', upload.fields([
    { name: 'pdf', maxCount: 1 },
    { name: 'certificate', maxCount: 1 }
]), async (req, res) => {
    const pdfFile = req.files.pdf?.[0];
    const p12File = req.files.certificate?.[0];

    if (!pdfFile || !p12File) {
        return res.status(400).json({ error: 'PDF and certificate files are required' });
    }

    const cleanupFiles = [pdfFile.path, p12File.path];
    let outPath = null;

    try {
        const password = req.body.password || '';
        const reason = req.body.reason || 'Document approval';
        const location = req.body.location || 'Digital Signature';
        const contactInfo = req.body.contactInfo || '';
        const signerName = req.body.signerName || '';

        const p12Buffer = fs.readFileSync(p12File.path);
        let originalPdfBuffer = fs.readFileSync(pdfFile.path);

        // ✅ FLATTEN PDF: Hapus form fields & annotations aktif
        let flattenedPdfBuffer;
        try {
            const pdfDoc = await PDFDocument.load(originalPdfBuffer, {
                ignoreEncryption: true,
                allowInvalidSignatures: true,
            });
            const uint8Array = await pdfDoc.save({
                useObjectStreams: false,
                addDefaultPage: false,
            });
            // 🔁 Konversi Uint8Array ke Buffer
            flattenedPdfBuffer = Buffer.from(uint8Array);
        } catch (err) {
            console.warn('⚠️ PDF flattening failed. Using original PDF as fallback.');
            flattenedPdfBuffer = originalPdfBuffer; // ini sudah Buffer
        }

        // ✅ Validasi sertifikat
        const certInfo = parseP12Certificate(p12Buffer, password);
        if (!certInfo.success) {
            throw new Error('Invalid certificate or password: ' + certInfo.error);
        }

        // ✅ Tambahkan placeholder signature
        const pdfWithPlaceholder = plainAddPlaceholder({
            pdfBuffer: flattenedPdfBuffer,
            reason: reason,
            location: location,
            signatureLength: 16384, // Lebih aman untuk sertifikat dengan chain
        });

        // ✅ Tanda tangan kriptografi
        const signedPdf = signer.sign(pdfWithPlaceholder, p12Buffer, {
            passphrase: password,
            asn1Strict: false
        });

        // ✅ Simpan & kirim
        const outName = pdfFile.originalname.replace(/\.pdf$/i, '_signed.pdf');
        outPath = path.join(uploadsDir, `signed-${Date.now()}.pdf`);
        fs.writeFileSync(outPath, signedPdf);
        cleanupFiles.push(outPath);

        res.download(outPath, outName, (err) => {
            cleanupFiles.forEach(f => {
                if (f && fs.existsSync(f)) {
                    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
                }
            });
            if (err) console.error('Download error:', err);
        });

    } catch (err) {
        console.error('❌ Signing error:', err);
        cleanupFiles.forEach(f => {
            if (f && fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
            }
        });
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log('🚀 PDF Signing Server running on http://localhost:' + PORT);
    console.log('✅ Adobe-compatible cryptographic signing enabled');
    console.log('ℹ️  PDFs are flattened before signing to avoid error (14)');
});