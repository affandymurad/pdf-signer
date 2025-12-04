const multipart = require('parse-multipart-data');
const forge = require('node-forge');
const signer = require('node-signpdf').default;
const { plainAddPlaceholder } = require('node-signpdf');
const { PDFDocument } = require('pdf-lib');

function parseP12Certificate(p12Buffer, password = '') {
    try {
        const p12B64 = p12Buffer.toString('base64');
        const p12Der = forge.util.decode64(p12B64);
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

        const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        if (!certBag || certBag.length === 0) throw new Error('No certificate found in P12 file');

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

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
            console.warn('⚠️ Unsupported image format');
            return;
        }

        let image;
        if (imageType === 'png') {
            image = await pdfDoc.embedPng(imageBytes);
        } else if (imageType === 'jpeg') {
            image = await pdfDoc.embedJpg(imageBytes);
        }

        // const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        const scale = 1.3;

        const xPdf = overlay.x / scale;
        const yPdf = pageHeight - (overlay.y / scale) - (overlay.height / scale);

        page.drawImage(image, {
            x: xPdf,
            y: yPdf,
            width: overlay.width / scale,
            height: overlay.height / scale,
        });

        console.log('✅ Visual signature embedded');
    } catch (err) {
        console.error('❌ Failed to embed visual signature:', err.message);
        throw err;
    }
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const contentType = event.headers['content-type'] || event.headers['Content-Type'];
        const boundary = contentType.split('boundary=')[1];
        const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
        const parts = multipart.parse(bodyBuffer, boundary);

        const pdfPart = parts.find(part => part.name === 'pdf');
        const certPart = parts.find(part => part.name === 'certificate');
        const passwordPart = parts.find(part => part.name === 'password');
        const reasonPart = parts.find(part => part.name === 'reason');
        const locationPart = parts.find(part => part.name === 'location');
        const overlayPart = parts.find(part => part.name === 'signatureOverlay');

        if (!pdfPart || !certPart) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'PDF and certificate files are required' })
            };
        }

        const password = passwordPart ? passwordPart.data.toString() : '';
        const reason = reasonPart ? reasonPart.data.toString() : 'Document approval';
        const location = locationPart ? locationPart.data.toString() : 'Digital Signature';

        const p12Buffer = certPart.data;
        let originalPdfBuffer = pdfPart.data;

        // Validate certificate
        const certInfo = parseP12Certificate(p12Buffer, password);
        if (!certInfo.success) {
            throw new Error('Invalid certificate or password: ' + certInfo.error);
        }

        // Load & process PDF
        let flattenedPdfBuffer;
        try {
            const pdfDoc = await PDFDocument.load(originalPdfBuffer, {
                ignoreEncryption: true,
                allowInvalidSignatures: true,
            });

            // Embed visual signature if provided
            if (overlayPart) {
                const overlay = JSON.parse(overlayPart.data.toString());
                console.log('📝 Embedding visual signature');
                await embedVisualSignature(pdfDoc, overlay);
            }

            const uint8Array = await pdfDoc.save({
                useObjectStreams: false,
                addDefaultPage: false,
            });
            flattenedPdfBuffer = Buffer.from(uint8Array);
            console.log('✅ PDF processed');
        } catch (err) {
            console.warn('⚠️ PDF processing failed:', err.message);
            flattenedPdfBuffer = originalPdfBuffer;
        }

        // Add placeholder
        const pdfWithPlaceholder = plainAddPlaceholder({
            pdfBuffer: flattenedPdfBuffer,
            reason: reason,
            location: location,
            signatureLength: 16384,
        });

        // Sign PDF
        const signedPdf = signer.sign(pdfWithPlaceholder, p12Buffer, {
            passphrase: password,
            asn1Strict: false
        });

        // Return signed PDF
        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'attachment; filename="signed.pdf"'
            },
            body: signedPdf.toString('base64'),
            isBase64Encoded: true
        };

    } catch (error) {
        console.error('❌ Signing error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};