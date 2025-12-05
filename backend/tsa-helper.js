const axios = require('axios');
const crypto = require('crypto');
const forge = require('node-forge');

/**
 * Extract CMS signature from signed PDF
 * @param {Buffer} pdfBuffer - Signed PDF buffer
 * @returns {Object|null} - { signature: Buffer, byteRange: Array, signatureHex: string }
 */
function extractSignatureFromPDF(pdfBuffer) {
    try {
        const pdfText = pdfBuffer.toString('binary');

        // Find ByteRange
        const byteRangeMatch = pdfText.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
        if (!byteRangeMatch) {
            console.warn('⚠️ ByteRange not found in PDF');
            return null;
        }

        const byteRange = [
            parseInt(byteRangeMatch[1]),
            parseInt(byteRangeMatch[2]),
            parseInt(byteRangeMatch[3]),
            parseInt(byteRangeMatch[4])
        ];

        // Find Contents (signature hex)
        const contentsMatch = pdfText.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
        if (!contentsMatch) {
            console.warn('⚠️ Contents not found in PDF');
            return null;
        }

        const signatureHex = contentsMatch[1];
        const signatureBuffer = Buffer.from(signatureHex, 'hex');

        console.log(`📋 Extracted signature: ${signatureBuffer.length} bytes`);

        return {
            signature: signatureBuffer,
            byteRange: byteRange,
            signatureHex: signatureHex
        };

    } catch (error) {
        console.error('❌ Failed to extract signature from PDF:', error.message);
        return null;
    }
}

/**
 * Replace signature in PDF with new signature
 * @param {Buffer} pdfBuffer - Original PDF
 * @param {string} oldSignatureHex - Old signature hex string
 * @param {Buffer} newSignature - New signature buffer
 * @returns {Buffer} - Modified PDF
 */
function replaceSignatureInPDF(pdfBuffer, oldSignatureHex, newSignature) {
    try {
        let pdfText = pdfBuffer.toString('binary');
        const newSignatureHex = newSignature.toString('hex');

        // Ensure new signature fits in placeholder
        if (newSignatureHex.length > oldSignatureHex.length) {
            console.warn(`⚠️ New signature too large: ${newSignatureHex.length} > ${oldSignatureHex.length}`);
            // Pad with zeros if needed (should not happen with proper placeholder size)
            return pdfBuffer;
        }

        // Pad with zeros to match original length
        const paddedHex = newSignatureHex.padEnd(oldSignatureHex.length, '0');

        // Replace signature
        pdfText = pdfText.replace(
            `/Contents <${oldSignatureHex}>`,
            `/Contents <${paddedHex}>`
        );

        console.log(`✅ Signature replaced in PDF (${newSignatureHex.length} chars)`);
        return Buffer.from(pdfText, 'binary');

    } catch (error) {
        console.error('❌ Failed to replace signature in PDF:', error.message);
        return pdfBuffer;
    }
}

/**
 * Request Timestamp Token dari TSA Server
 * @param {Buffer} dataToTimestamp - Data to timestamp (CMS signature)
 * @param {string} tsaUrl - URL TSA server (default: FreeTSA)
 * @returns {Promise<Buffer>} - Timestamp token (DER-encoded)
 */
async function requestTimestamp(dataToTimestamp, tsaUrl = 'http://freetsa.org/tsr') {
    try {
        // 1️⃣ Hash data menggunakan SHA-256
        const hash = crypto.createHash('sha256').update(dataToTimestamp).digest();

        // 2️⃣ Buat TimeStampReq sesuai RFC 3161
        const asn1 = forge.asn1;
        const timestampReq = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            // Version (INTEGER 1)
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false,
                asn1.integerToDer(1).getBytes()
            ),
            // MessageImprint
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                // AlgorithmIdentifier (SHA-256)
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                        asn1.oidToDer('2.16.840.1.101.3.4.2.1').getBytes() // SHA-256 OID
                    )
                ]),
                // HashedMessage
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hash.toString('binary'))
            ]),
            // CertReq (BOOLEAN TRUE) - request cert chain
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false,
                String.fromCharCode(0xFF)
            )
        ]);

        const der = asn1.toDer(timestampReq).getBytes();
        const requestBuffer = Buffer.from(der, 'binary');

        // 3️⃣ Kirim HTTP POST ke TSA server
        console.log(`📡 Requesting timestamp from ${tsaUrl}...`);
        const response = await axios.post(tsaUrl, requestBuffer, {
            headers: {
                'Content-Type': 'application/timestamp-query',
                'Content-Length': requestBuffer.length
            },
            responseType: 'arraybuffer',
            timeout: 15000 // 15 detik
        });

        if (response.status !== 200) {
            throw new Error(`TSA server error: ${response.status}`);
        }

        const responseBuffer = Buffer.from(response.data);
        console.log('✅ Timestamp response received:', responseBuffer.length, 'bytes');

        // 4️⃣ Parse dan validasi response
        try {
            const responseAsn1 = forge.asn1.fromDer(responseBuffer.toString('binary'));

            if (!responseAsn1 || !responseAsn1.value || responseAsn1.value.length < 1) {
                throw new Error('Invalid TSA response structure');
            }

            // Check status
            const status = responseAsn1.value[0];
            if (status && status.value && status.value[0]) {
                const statusValue = forge.asn1.derToInteger(status.value[0].value);
                if (statusValue !== 0) {
                    throw new Error(`TSA returned error status: ${statusValue}`);
                }
            }

            // Extract timeStampToken
            if (responseAsn1.value.length > 1 && responseAsn1.value[1]) {
                const tokenAsn1 = responseAsn1.value[1];
                const tokenDer = forge.asn1.toDer(tokenAsn1).getBytes();
                const tokenBuffer = Buffer.from(tokenDer, 'binary');
                console.log('✅ Timestamp token extracted:', tokenBuffer.length, 'bytes');
                return tokenBuffer;
            } else {
                throw new Error('No timestamp token in TSA response');
            }

        } catch (parseErr) {
            console.warn('⚠️ TSA response parsing issue, returning raw response:', parseErr.message);
            return responseBuffer;
        }

    } catch (error) {
        console.error('❌ TSA request failed:', error.message);

        // Fallback: coba server alternatif
        if (tsaUrl === 'http://freetsa.org/tsr') {
            console.log('🔄 Retrying with DigiCert TSA...');
            try {
                return await requestTimestamp(dataToTimestamp, 'http://timestamp.digicert.com');
            } catch (retryErr) {
                console.error('❌ Fallback TSA also failed:', retryErr.message);
                throw new Error(`All TSA servers unavailable: ${error.message}`);
            }
        }

        throw error;
    }
}

/**
 * Embed timestamp token ke dalam CMS signature
 * @param {Buffer} cmsSignature - Original CMS signature
 * @param {Buffer} timestampToken - TSA token
 * @returns {Buffer} - CMS signature with embedded timestamp
 */
function embedTimestampInSignature(cmsSignature, timestampToken) {
    try {
        console.log('🔧 Embedding timestamp into CMS signature...');

        if (!timestampToken || timestampToken.length === 0) {
            console.warn('⚠️ Empty timestamp token');
            return cmsSignature;
        }

        const asn1 = forge.asn1;

        // Parse CMS signature
        const cmsAsn1 = asn1.fromDer(cmsSignature.toString('binary'));

        // Parse timestamp token
        const tsAsn1 = asn1.fromDer(timestampToken.toString('binary'));

        // Navigate: ContentInfo > SignedData > SignerInfos > [0]
        const contentInfo = cmsAsn1.value[1]; // SignedData (EXPLICIT [0])
        const signedData = contentInfo.value[0]; // SEQUENCE
        const signerInfos = signedData.value[4]; // SET of SignerInfo

        const signerInfo = signerInfos.value[0]; // First SignerInfo

        // Find or create UnsignedAttrs [1]
        let unsignedAttrs = signerInfo.value.find(v =>
            v.tagClass === asn1.Class.CONTEXT_SPECIFIC && v.type === 1
        );

        if (!unsignedAttrs) {
            console.log('📝 Creating new UnsignedAttrs');
            unsignedAttrs = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, []);
            signerInfo.value.push(unsignedAttrs);
        }

        // Create timestamp attribute
        // OID: 1.2.840.113549.1.9.16.2.14 (id-aa-signatureTimeStampToken)
        const timestampAttr = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer('1.2.840.113549.1.9.16.2.14').getBytes()
            ),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [tsAsn1])
        ]);

        unsignedAttrs.value.push(timestampAttr);

        // Encode back to DER
        const newDer = asn1.toDer(cmsAsn1).getBytes();
        const newSignature = Buffer.from(newDer, 'binary');

        console.log(`✅ Timestamp embedded (${cmsSignature.length} -> ${newSignature.length} bytes)`);
        return newSignature;

    } catch (error) {
        console.error('❌ Timestamp embedding failed:', error.message);
        return cmsSignature;
    }
}

/**
 * Add timestamp to signed PDF
 * @param {Buffer} signedPdf - Signed PDF buffer
 * @param {string} tsaUrl - TSA server URL
 * @returns {Promise<Buffer>} - PDF with timestamp
 */
async function addTimestampToPDF(signedPdf, tsaUrl = 'http://freetsa.org/tsr') {
    try {
        // 1️⃣ Extract signature from PDF
        const extracted = extractSignatureFromPDF(signedPdf);
        if (!extracted) {
            throw new Error('Failed to extract signature from PDF');
        }

        // 2️⃣ Request timestamp for the signature
        const timestampToken = await requestTimestamp(extracted.signature, tsaUrl);

        // 3️⃣ Embed timestamp into CMS signature
        const newSignature = embedTimestampInSignature(extracted.signature, timestampToken);

        // 4️⃣ Replace signature in PDF
        const newPdf = replaceSignatureInPDF(signedPdf, extracted.signatureHex, newSignature);

        return newPdf;

    } catch (error) {
        console.error('❌ Failed to add timestamp to PDF:', error.message);
        return signedPdf; // Return original on failure
    }
}

module.exports = {
    requestTimestamp,
    embedTimestampInSignature,
    addTimestampToPDF,
    extractSignatureFromPDF,
    replaceSignatureInPDF
};