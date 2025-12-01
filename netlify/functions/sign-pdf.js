// netlify/functions/sign-pdf.js
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

exports.handler = async (event, context) => {
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

        // Flatten PDF
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
            flattenedPdfBuffer = Buffer.from(uint8Array);
        } catch (err) {
            console.warn('⚠️ PDF flattening failed. Using original PDF as fallback.');
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

        // Return signed PDF as base64
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
        console.error('Signing error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};