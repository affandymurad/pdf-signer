const multipart = require('parse-multipart-data');
const forge = require('node-forge');
const signer = require('node-signpdf').default;
const { plainAddPlaceholder } = require('node-signpdf');
const { PDFDocument } = require('pdf-lib');
const axios = require('axios');

// ========================
// TSA Helper (inline)
// ========================
async function requestTimestamp(dataToTimestamp, tsaUrl = 'http://freetsa.org/tsr') {
    try {
        const hash = require('crypto').createHash('sha256').update(dataToTimestamp).digest();
        const asn1 = forge.asn1;
        const timestampReq = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('2.16.840.1.101.3.4.2.1').getBytes()),
                ]),
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hash.toString('binary')),
            ]),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xFF)),
        ]);
        const der = asn1.toDer(timestampReq).getBytes();
        const requestBuffer = Buffer.from(der, 'binary');

        const response = await axios.post(tsaUrl, requestBuffer, {
            headers: { 'Content-Type': 'application/timestamp-query' },
            responseType: 'arraybuffer',
            timeout: 12000,
        });

        if (response.status !== 200) throw new Error(`TSA error: ${response.status}`);
        return Buffer.from(response.data);
    } catch (error) {
        if (tsaUrl === 'http://freetsa.org/tsr') {
            console.log('🔄 Retrying with DigiCert TSA...');
            return requestTimestamp(dataToTimestamp, 'http://timestamp.digicert.com');
        }
        throw error;
    }
}

function extractSignatureFromPDF(pdfBuffer) {
    const pdfText = pdfBuffer.toString('binary');
    const byteRangeMatch = pdfText.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    const contentsMatch = pdfText.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
    if (!byteRangeMatch || !contentsMatch) return null;
    return {
        signature: Buffer.from(contentsMatch[1], 'hex'),
        signatureHex: contentsMatch[1],
    };
}

function replaceSignatureInPDF(pdfBuffer, oldSignatureHex, newSignature) {
    let pdfText = pdfBuffer.toString('binary');
    const newHex = newSignature.toString('hex').padEnd(oldSignatureHex.length, '0');
    pdfText = pdfText.replace(`/Contents <${oldSignatureHex}>`, `/Contents <${newHex}>`);
    return Buffer.from(pdfText, 'binary');
}

async function addTimestampToPDF(signedPdf, tsaUrl = 'http://freetsa.org/tsr') {
    const extracted = extractSignatureFromPDF(signedPdf);
    if (!extracted) throw new Error('No signature found');
    const token = await requestTimestamp(extracted.signature, tsaUrl);
    const cmsAsn1 = forge.asn1.fromDer(extracted.signature.toString('binary'));
    const tsAsn1 = forge.asn1.fromDer(token.toString('binary'));

    const contentInfo = cmsAsn1.value[1];
    const signedData = contentInfo.value[0];
    const signerInfo = signedData.value[4].value[0];

    let unsignedAttrs = signerInfo.value.find(v => v.tagClass === 0 && v.type === 1);
    if (!unsignedAttrs) {
        unsignedAttrs = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 1, true, []);
        signerInfo.value.push(unsignedAttrs);
    }

    const timestampAttr = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
            forge.asn1.oidToDer('1.2.840.113549.1.9.16.2.14').getBytes()
        ),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [tsAsn1]),
    ]);
    unsignedAttrs.value.push(timestampAttr);

    const newSignature = Buffer.from(forge.asn1.toDer(cmsAsn1).getBytes(), 'binary');
    return replaceSignatureInPDF(signedPdf, extracted.signatureHex, newSignature);
}

// ========================
// LTV/OCSP Helper (inline)
// ========================
function extractCertChain(p12Buffer, password = '') {
    const p12Der = forge.util.decode64(p12Buffer.toString('base64'));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    return certBags ? certBags.map(bag => bag.cert) : [];
}

function getOCSPUrl(cert) {
    const aia = cert.extensions?.find(ext => ext.id === '1.3.6.1.5.5.7.1.1');
    if (!aia) return null;
    try {
        const aiaAsn1 = forge.asn1.fromDer(aia.value);
        for (const item of aiaAsn1.value) {
            if (item.type === forge.asn1.Type.SEQUENCE && item.value?.[0]?.type === forge.asn1.Type.OID) {
                const oid = forge.asn1.derToOid(item.value[0].value);
                if (oid === '1.3.6.1.5.5.7.48.1' && item.value[1]?.type === forge.asn1.Type.IA5STRING) {
                    return item.value[1].value;
                }
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

async function requestOCSP(cert, issuerCert) {
    const ocspUrl = getOCSPUrl(cert);
    if (!ocspUrl) return null;

    const issuerNameHash = require('crypto').createHash('sha1')
        .update(forge.asn1.toDer(cert.issuer).getBytes(), 'binary').digest();
    const issuerKeyHash = require('crypto').createHash('sha1')
        .update(forge.asn1.toDer(issuerCert.publicKey).getBytes(), 'binary').digest();

    const asn1 = forge.asn1;
    const ocspReq = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('1.3.14.3.2.26').getBytes()),
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, issuerNameHash.toString('binary')),
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, issuerKeyHash.toString('binary')),
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, forge.util.hexToBytes(cert.serialNumber)),
            ])
        ])
    ]);

    const reqBuffer = Buffer.from(asn1.toDer(ocspReq).getBytes(), 'binary');
    const res = await axios.post(ocspUrl, reqBuffer, {
        headers: { 'Content-Type': 'application/ocsp-request' },
        responseType: 'arraybuffer',
        timeout: 10000,
    });
    return res.status === 200 ? Buffer.from(res.data) : null;
}

function embedDSS(pdfBuffer, ocspResponses, certs) {
    let pdfText = pdfBuffer.toString('binary');
    const matches = pdfText.match(/(\d+)\s+0\s+obj/g);
    let nextObj = matches ? Math.max(...matches.map(m => parseInt(m))) + 1 : 1;

    const dssObjects = [];

    // Embed OCSPs
    let ocspArrayRef = '';
    if (ocspResponses?.length) {
        const refs = ocspResponses.filter(r => r).map(resp => {
            const obj = nextObj++;
            dssObjects.push(`${obj} 0 obj\n<< /Length ${resp.length} >>\nstream\n${resp.toString('base64')}\nendstream\nendobj\n`);
            return `${obj} 0 R`;
        });
        if (refs.length) {
            const arrObj = nextObj++;
            dssObjects.push(`${arrObj} 0 obj\n[ ${refs.join(' ')} ]\nendobj\n`);
            ocspArrayRef = ` /OCSPs ${arrObj} 0 R`;
        }
    }

    // Embed Certs
    let certArrayRef = '';
    if (certs?.length) {
        const refs = certs.map(cert => {
            const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
            const buf = Buffer.from(der, 'binary');
            const obj = nextObj++;
            dssObjects.push(`${obj} 0 obj\n<< /Length ${buf.length} >>\nstream\n${buf.toString('base64')}\nendstream\nendobj\n`);
            return `${obj} 0 R`;
        });
        const arrObj = nextObj++;
        dssObjects.push(`${arrObj} 0 obj\n[ ${refs.join(' ')} ]\nendobj\n`);
        certArrayRef = ` /Certs ${arrObj} 0 R`;
    }

    // DSS Dictionary
    const dssObj = nextObj++;
    dssObjects.push(`${dssObj} 0 obj\n<< /Type /DSS${ocspArrayRef}${certArrayRef} >>\nendobj\n`);

    // Insert DSS before xref
    const xrefIndex = pdfText.lastIndexOf('xref');
    if (xrefIndex === -1) return pdfBuffer;

    const before = pdfText.slice(0, xrefIndex);
    const after = pdfText.slice(xrefIndex);
    const newPdf = before + dssObjects.join('\n') + '\n' + after;

    return Buffer.from(newPdf, 'binary');
}

// ========================
// Existing helpers (unchanged)
// ========================
function parseP12Certificate(p12Buffer, password = '') {
    try {
        const p12B64 = p12Buffer.toString('base64');
        const p12Der = forge.util.decode64(p12B64);
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
        const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        if (!certBag || certBag.length === 0) throw new Error('No certificate found in P12 file');
        return { success: true, p12 };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function embedVisualSignature(pdfDoc, overlay) {
    try {
        const page = pdfDoc.getPages()[overlay.page - 1];
        if (!page) return;

        let imageBytes, imageType = 'png';
        if (overlay.content.startsWith('data:image/png')) {
            imageBytes = Buffer.from(overlay.content.split(',')[1], 'base64');
            imageType = 'png';
        } else if (overlay.content.startsWith('data:image/jpeg') || overlay.content.startsWith('data:image/jpg')) {
            imageBytes = Buffer.from(overlay.content.split(',')[1], 'base64');
            imageType = 'jpeg';
        } else return;

        const image = imageType === 'png'
            ? await pdfDoc.embedPng(imageBytes)
            : await pdfDoc.embedJpg(imageBytes);

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
    } catch (err) {
        console.warn('⚠️ Visual signature skipped:', err.message);
        // Do NOT throw — continue signing
    }
}

// ========================
// Main Handler
// ========================
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
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing boundary in Content-Type' }) };
        }

        const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
        const parts = multipart.parse(bodyBuffer, boundary);

        const pdfPart = parts.find(part => part.name === 'pdf');
        const certPart = parts.find(part => part.name === 'certificate');
        if (!pdfPart || !certPart) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'PDF and certificate required' }) };
        }

        const password = parts.find(p => p.name === 'password')?.data.toString() || '';
        const reason = parts.find(p => p.name === 'reason')?.data.toString() || 'Document approval';
        const location = parts.find(p => p.name === 'location')?.data.toString() || 'Digital Signature';

        // Parse overlay safely
        let overlay = null;
        const overlayPart = parts.find(p => p.name === 'signatureOverlay');
        if (overlayPart) {
            try {
                const str = overlayPart.data.toString().trim();
                if (str) overlay = JSON.parse(str);
            } catch (e) {
                console.warn('⚠️ Invalid signatureOverlay, skipping');
            }
        }

        const p12Buffer = certPart.data;
        let originalPdfBuffer = pdfPart.data;

        // Validate cert
        const certInfo = parseP12Certificate(p12Buffer, password);
        if (!certInfo.success) {
            throw new Error('Invalid certificate or password: ' + certInfo.error);
        }

        // Process PDF (visual signature)
        let flattenedPdfBuffer = originalPdfBuffer;
        try {
            const pdfDoc = await PDFDocument.load(originalPdfBuffer, {
                ignoreEncryption: true,
                allowInvalidSignatures: true,
            });
            if (overlay) {
                await embedVisualSignature(pdfDoc, overlay);
            }
            const uint8Array = await pdfDoc.save({ useObjectStreams: false });
            flattenedPdfBuffer = Buffer.from(uint8Array);
        } catch (err) {
            console.warn('⚠️ PDF processing failed, using original:', err.message);
        }

        // Add large placeholder for TSA + LTV
        const pdfWithPlaceholder = plainAddPlaceholder({
            pdfBuffer: flattenedPdfBuffer,
            reason,
            location,
            signatureLength: 32768, // Increased for TSA+LTV
        });

        // Sign
        let signedPdf = signer.sign(pdfWithPlaceholder, p12Buffer, {
            passphrase: password,
            asn1Strict: false
        });

        // ✅ AUTO: TSA
        try {
            signedPdf = await addTimestampToPDF(signedPdf, 'http://freetsa.org/tsr');
            console.log('✅ TSA embedded');
        } catch (tsaErr) {
            console.warn('⚠️ TSA failed, continuing:', tsaErr.message);
        }

        // ✅ AUTO: LTV (OCSP + DSS)
        try {
            const certs = extractCertChain(p12Buffer, password);
            if (certs.length >= 1) {
                const cert = certs[0];
                const isSelfSigned = cert.subject.attributes.some(a => a.name === 'commonName') &&
                    cert.issuer.attributes.some(a => a.name === 'commonName') &&
                    cert.subject.getField('CN')?.value === cert.issuer.getField('CN')?.value;

                if (isSelfSigned) {
                    signedPdf = embedDSS(signedPdf, [], certs);
                    console.log('✅ LTV: self-signed cert embedded');
                } else if (certs.length > 1) {
                    const ocspResp = await requestOCSP(cert, certs[1]);
                    signedPdf = embedDSS(signedPdf, ocspResp ? [ocspResp] : [], certs);
                    console.log('✅ LTV: OCSP + certs embedded');
                } else {
                    signedPdf = embedDSS(signedPdf, [], certs);
                    console.log('✅ LTV: cert only (no issuer)');
                }
            }
        } catch (ltvErr) {
            console.warn('⚠️ LTV failed, continuing:', ltvErr.message);
        }

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
            body: JSON.stringify({ error: error.message || 'Internal error' })
        };
    }
};