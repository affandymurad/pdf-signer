const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const forge = require('node-forge');
const signer = require('node-signpdf').default;
const { plainAddPlaceholder } = require('node-signpdf');
const { PDFDocument } = require('pdf-lib');

// ✅ Import LTV helper
const { extractCertChain, requestOCSP, embedDSS } = require('./ltv-helper');

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

// === Helper: Check Signature ===
function checkPdfSignature(pdfBuffer) {
    const pdfText = pdfBuffer.toString('binary');
    const hasSig = /\/Type\s*\/Sig|\/FT\s*\/Sig|\/SubFilter\s*\/adbe\.pkcs7/i.test(pdfText);
    if (!hasSig) return { hasSig: false };

    let hasLTV = false;

    try {
        if (/\/DSS\s+\d+\s+0\s+R/i.test(pdfText)) {
            hasLTV = true;
        }

        if (!hasLTV && /\/Type\s*\/DSS/i.test(pdfText)) {
            hasLTV = true;
        }

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

    let signer = extract(/\/Name\s*\(([^)]*(?:\\\)[^)]*)*)\)/);
    if (!signer || signer.trim() === '') {
        signer = extract(/\/T\s*\(([^)]*(?:\\\)[^)]*)*)\)/) || 'Signature1';
    }

    const rawDate = extract(/\/M\s*\(D:(\d{14})/);

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
        signer: signer,
        reason: extract(/\/Reason\s*\(([^)]*(?:\\\)[^)]*)*)\)/),
        location: extract(/\/Location\s*\(([^)]*(?:\\\)[^)]*)*)\)/),
        date: formattedDate,
    };

    return result;
}

// === Helper: Embed Visual Signature ===
async function embedVisualSignature(pdfDoc, overlay) {
    try {
        const page = pdfDoc.getPages()[overlay.page - 1];
        if (!page) {
            console.warn('⚠️ Page not found:', overlay.page);
            return;
        }

        let imageBytes;
        let imageType = 'png';

        if (overlay.content.startsWith('data:image/png')) {
            const base64 = overlay.content.split(',')[1];
            imageBytes = Buffer.from(base64, 'base64');
            imageType = 'png';
        } else if (overlay.content.startsWith('data:image/jpeg') || overlay.content.startsWith('data:image/jpg')) {
            const base64 = overlay.content.split(',')[1];
            imageBytes = Buffer.from(base64, 'base64');
            imageType = 'jpeg';
        } else {
            console.warn('⚠️ Unsupported image format:', overlay.content.substring(0, 50));
            return;
        }

        let image;
        try {
            if (imageType === 'png') {
                image = await pdfDoc.embedPng(imageBytes);
            } else if (imageType === 'jpeg') {
                image = await pdfDoc.embedJpg(imageBytes);
            }
        } catch (embedErr) {
            console.error('❌ Image embed error:', embedErr.message);
            if (imageType === 'jpeg') {
                console.log('🔄 Retrying with PNG conversion...');
                try {
                    const { createCanvas, loadImage } = require('canvas');
                    const img = await loadImage(imageBytes);
                    const canvas = createCanvas(img.width, img.height);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const pngBuffer = canvas.toBuffer('image/png');
                    image = await pdfDoc.embedPng(pngBuffer);
                } catch (fallbackErr) {
                    console.error('❌ Fallback conversion failed:', fallbackErr.message);
                    throw fallbackErr;
                }
            } else {
                throw embedErr;
            }
        }

        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        const scale = 1.3;

        const xPdf = overlay.x / scale;
        const yPdf = pageHeight - (overlay.y / scale) - (overlay.height / scale);

        console.log('📍 Embedding signature:', {
            type: imageType,
            page: overlay.page,
            x: xPdf.toFixed(2),
            y: yPdf.toFixed(2),
            width: (overlay.width / scale).toFixed(2),
            height: (overlay.height / scale).toFixed(2)
        });

        page.drawImage(image, {
            x: xPdf,
            y: yPdf,
            width: overlay.width / scale,
            height: overlay.height / scale,
        });

        console.log('✅ Visual signature embedded successfully');
    } catch (err) {
        console.error('❌ Failed to embed visual signature:', err.message);
        throw err;
    }
}

// === Routes ===
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'PDF Signing Service with AUTO TSA & LTV is running' });
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

// === SIGNING ENDPOINT (AUTO TSA & LTV ENABLED) ===
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

        // 🔥 AUTOMATICALLY ENABLED - No frontend options needed
        const enableTSA = true;
        const enableLTV = true;
        const tsaUrl = 'http://freetsa.org/tsr';

        console.log('📋 Auto-signing with TSA & LTV enabled');

        const p12Buffer = fs.readFileSync(p12File.path);
        let originalPdfBuffer = fs.readFileSync(pdfFile.path);

        // 1️⃣ Load PDF untuk flatten dan embed signature
        let flattenedPdfBuffer;
        try {
            const pdfDoc = await PDFDocument.load(originalPdfBuffer, {
                ignoreEncryption: true,
                allowInvalidSignatures: true,
            });

            if (req.body.signatureOverlay) {
                const overlay = JSON.parse(req.body.signatureOverlay);
                console.log('📍 Embedding visual signature:', overlay);
                await embedVisualSignature(pdfDoc, overlay);
            }

            const uint8Array = await pdfDoc.save({
                useObjectStreams: false,
                addDefaultPage: false,
            });
            flattenedPdfBuffer = Buffer.from(uint8Array);
            console.log('✅ PDF flattened successfully');
        } catch (err) {
            console.warn('⚠️ PDF processing failed:', err.message);
            flattenedPdfBuffer = originalPdfBuffer;
        }

        // 2️⃣ Validasi sertifikat
        const certInfo = parseP12Certificate(p12Buffer, password);
        if (!certInfo.success) {
            throw new Error('Invalid certificate or password: ' + certInfo.error);
        }

        // 3️⃣ Tambahkan placeholder signature dengan ukuran lebih besar untuk TSA
        const pdfWithPlaceholder = plainAddPlaceholder({
            pdfBuffer: flattenedPdfBuffer,
            reason: reason,
            location: location,
            signatureLength: 32768, // Lebih besar untuk TSA + LTV
        });

        // 4️⃣ Tanda tangan kriptografi
        let signedPdf = signer.sign(pdfWithPlaceholder, p12Buffer, {
            passphrase: password,
            asn1Strict: false
        });

        // 5️⃣ AUTO: Request TSA timestamp
        console.log('⏱️ Requesting TSA timestamp (auto-enabled)...');
        try {
            const { addTimestampToPDF } = require('./tsa-helper');
            const newSignedPdf = await addTimestampToPDF(signedPdf, tsaUrl);
            if (newSignedPdf && newSignedPdf.length > 0) {
                signedPdf = newSignedPdf;
                console.log('✅ TSA timestamp embedded successfully');
            }
        } catch (tsaErr) {
            console.warn('⚠️ TSA failed (continuing without timestamp):', tsaErr.message);
            // Continue tanpa TSA jika gagal
        }

        // 6️⃣ AUTO: Embed LTV/DSS
        console.log('🔒 Preparing LTV/DSS (auto-enabled)...');
        try {
            const certChain = extractCertChain(certInfo.p12);
            console.log(`📋 Certificate chain length: ${certChain.length}`);

            if (certChain.length >= 1) {
                const cert = certChain[0];

                // Check if self-signed
                const isSelfSigned = cert.subject.getField('CN')?.value === cert.issuer.getField('CN')?.value;

                if (isSelfSigned) {
                    console.log('ℹ️ Self-signed certificate detected');
                    // For self-signed certs, just embed the certificate (no OCSP needed)
                    signedPdf = embedDSS(signedPdf, [], certChain);
                    console.log('✅ LTV/DSS embedded with certificate (self-signed, no OCSP)');
                } else if (certChain.length > 1) {
                    // We have issuer cert, try OCSP
                    const issuerCert = certChain[1];

                    console.log('📡 Requesting OCSP response...');
                    const ocspResponse = await requestOCSP(cert, issuerCert);
                    const ocspResponses = ocspResponse ? [ocspResponse] : [];

                    if (ocspResponse) {
                        console.log('✅ OCSP response received');
                    } else {
                        console.warn('⚠️ OCSP response not available (continuing anyway)');
                    }

                    signedPdf = embedDSS(signedPdf, ocspResponses, certChain);
                    console.log('✅ LTV/DSS embedded with certificate chain and OCSP');
                } else {
                    // Single cert, not self-signed (missing issuer)
                    console.warn('⚠️ No issuer certificate found - embedding cert only');
                    signedPdf = embedDSS(signedPdf, [], certChain);
                    console.log('✅ LTV/DSS embedded with certificate only');
                }
            } else {
                console.warn('⚠️ LTV skipped: No certificates found in chain');
            }
        } catch (ltvErr) {
            console.warn('⚠️ LTV failed (continuing without LTV):', ltvErr.message);
            // Continue tanpa LTV jika gagal
        }

        // 7️⃣ Simpan & kirim
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
    console.log('✅ TSA (Time Stamping Authority) AUTO-ENABLED');
    console.log('✅ LTV (Long-Term Validation) AUTO-ENABLED');
    console.log('ℹ️  PDFs are flattened before signing to avoid error (14)');
    console.log('🔥 TSA & LTV are now automatically applied to all signatures');
});