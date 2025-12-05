const axios = require('axios');
const forge = require('node-forge');
const crypto = require('crypto');

/**
 * Extract certificate chain dari P12
 * @param {Object} p12 - Parsed PKCS#12 object
 * @returns {Array} - Array of X509 certificates
 */
function extractCertChain(p12) {
    try {
        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        const certs = certBags ? certBags.map(bag => bag.cert) : [];

        console.log(`📋 Extracted ${certs.length} certificate(s) from P12`);

        // Log certificate details
        certs.forEach((cert, idx) => {
            const cn = cert.subject.getField('CN')?.value || 'Unknown';
            const issuerCn = cert.issuer.getField('CN')?.value || 'Unknown';
            console.log(`  [${idx}] CN: ${cn}, Issuer: ${issuerCn}`);
        });

        return certs;
    } catch (error) {
        console.error('❌ Failed to extract cert chain:', error.message);
        return [];
    }
}

/**
 * Request OCSP response untuk certificate
 * @param {Object} cert - Certificate yang akan di-validasi
 * @param {Object} issuerCert - Issuer certificate
 * @returns {Promise<Buffer|null>} - OCSP response (DER-encoded)
 */
async function requestOCSP(cert, issuerCert) {
    try {
        // 1️⃣ Ambil OCSP URL dari certificate extensions
        const ocspUrl = getOCSPUrl(cert);
        if (!ocspUrl) {
            console.warn('⚠️ No OCSP URL found in certificate');
            return null;
        }

        // 2️⃣ Buat OCSP Request
        const ocspRequest = createOCSPRequest(cert, issuerCert);

        // 3️⃣ Kirim ke OCSP responder
        console.log(`📡 Requesting OCSP from ${ocspUrl}...`);
        const response = await axios.post(ocspUrl, ocspRequest, {
            headers: {
                'Content-Type': 'application/ocsp-request',
            },
            responseType: 'arraybuffer',
            timeout: 10000
        });

        if (response.status !== 200) {
            throw new Error(`OCSP server error: ${response.status}`);
        }

        const ocspResponse = Buffer.from(response.data);
        console.log('✅ OCSP response received:', ocspResponse.length, 'bytes');
        return ocspResponse;

    } catch (error) {
        console.warn('⚠️ OCSP request failed:', error.message);
        return null;
    }
}

/**
 * Extract OCSP URL dari certificate
 */
function getOCSPUrl(cert) {
    try {
        const extensions = cert.extensions || [];
        const aiaExt = extensions.find(ext => ext.id === '1.3.6.1.5.5.7.1.1'); // AIA extension

        if (!aiaExt) return null;

        // Parse AIA extension untuk OCSP URL
        const aiaAsn1 = forge.asn1.fromDer(aiaExt.value);

        for (const item of aiaAsn1.value) {
            if (item.value && item.value[0]) {
                const oid = forge.asn1.derToOid(item.value[0].value);
                // OCSP OID: 1.3.6.1.5.5.7.48.1
                if (oid === '1.3.6.1.5.5.7.48.1' && item.value[1]) {
                    const url = item.value[1].value;
                    if (typeof url === 'string' && url.startsWith('http')) {
                        return url;
                    }
                }
            }
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to extract OCSP URL:', error.message);
        return null;
    }
}

/**
 * Buat OCSP Request (simplified - RFC 6960)
 */
function createOCSPRequest(cert, issuerCert) {
    const asn1 = forge.asn1;

    // Hash issuer name dan public key
    const issuerNameHash = crypto.createHash('sha1')
        .update(forge.asn1.toDer(cert.issuer).getBytes(), 'binary')
        .digest();

    const issuerKeyHash = crypto.createHash('sha1')
        .update(forge.asn1.toDer(issuerCert.publicKey).getBytes(), 'binary')
        .digest();

    // Serial number
    const serialNumber = cert.serialNumber;

    // Build OCSPRequest structure
    const ocspReq = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                    // CertID
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                            asn1.oidToDer('1.3.14.3.2.26').getBytes() // SHA-1
                        )
                    ]),
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                        issuerNameHash.toString('binary')
                    ),
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                        issuerKeyHash.toString('binary')
                    ),
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false,
                        forge.util.hexToBytes(serialNumber)
                    )
                ])
            ])
        ])
    ]);

    const der = asn1.toDer(ocspReq).getBytes();
    return Buffer.from(der, 'binary');
}

/**
 * Embed DSS (Document Security Store) ke PDF untuk LTV
 * @param {Buffer} pdfBuffer - PDF yang sudah di-sign
 * @param {Array} ocspResponses - Array of OCSP responses
 * @param {Array} certs - Certificate chain
 * @returns {Buffer} - PDF with embedded DSS
 */
function embedDSS(pdfBuffer, ocspResponses, certs) {
    try {
        let pdfText = pdfBuffer.toString('binary');

        // 1️⃣ Buat DSS object
        const dssObjects = [];
        let objectNumber = getNextObjectNumber(pdfText);

        console.log('📝 Building DSS structure...');

        // Embed OCSP responses (if available)
        let ocspObjNum = null;
        if (ocspResponses && ocspResponses.length > 0) {
            const ocspArray = ocspResponses
                .filter(r => r !== null)
                .map((resp, idx) => {
                    const objNum = objectNumber++;
                    const base64 = resp.toString('base64');
                    dssObjects.push(
                        `${objNum} 0 obj\n<< /Length ${base64.length} >>\nstream\n${base64}\nendstream\nendobj\n`
                    );
                    return `${objNum} 0 R`;
                });

            if (ocspArray.length > 0) {
                ocspObjNum = objectNumber++;
                dssObjects.push(
                    `${ocspObjNum} 0 obj\n[ ${ocspArray.join(' ')} ]\nendobj\n`
                );
                console.log(`  ✓ ${ocspArray.length} OCSP response(s) added`);
            }
        }

        // Embed certificates (always include for LTV)
        let certObjNum = null;
        if (certs && certs.length > 0) {
            const certArray = certs.map((cert, idx) => {
                const objNum = objectNumber++;
                const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
                const base64 = Buffer.from(der, 'binary').toString('base64');
                dssObjects.push(
                    `${objNum} 0 obj\n<< /Length ${base64.length} >>\nstream\n${base64}\nendstream\nendobj\n`
                );
                return `${objNum} 0 R`;
            });

            certObjNum = objectNumber++;
            dssObjects.push(
                `${certObjNum} 0 obj\n[ ${certArray.join(' ')} ]\nendobj\n`
            );
            console.log(`  ✓ ${certArray.length} certificate(s) added`);
        }

        // 2️⃣ Buat DSS dictionary
        const dssNum = objectNumber++;
        let dssDictContent = '/Type /DSS';

        if (ocspObjNum) {
            dssDictContent += ` /OCSPs ${ocspObjNum} 0 R`;
        }
        if (certObjNum) {
            dssDictContent += ` /Certs ${certObjNum} 0 R`;
        }

        const dssDict = `${dssNum} 0 obj\n<< ${dssDictContent} >>\nendobj\n`;
        dssObjects.push(dssDict);

        // 3️⃣ Update Catalog dengan /DSS reference
        const catalogUpdated = pdfText.replace(
            /\/Type\s*\/Catalog/,
            `/Type /Catalog /DSS ${dssNum} 0 R`
        );

        if (catalogUpdated === pdfText) {
            console.warn('⚠️ Failed to update Catalog with DSS reference');
            return pdfBuffer;
        }

        pdfText = catalogUpdated;

        // 4️⃣ Insert DSS objects sebelum xref
        const xrefIndex = pdfText.lastIndexOf('xref');
        if (xrefIndex === -1) {
            throw new Error('Invalid PDF: xref not found');
        }

        const beforeXref = pdfText.substring(0, xrefIndex);
        const afterXref = pdfText.substring(xrefIndex);

        const newPdf = beforeXref + dssObjects.join('\n') + '\n' + afterXref;

        console.log('✅ DSS embedded successfully');
        return Buffer.from(newPdf, 'binary');

    } catch (error) {
        console.error('❌ Failed to embed DSS:', error.message);
        return pdfBuffer; // Fallback
    }
}

/**
 * Get next available object number dari PDF
 */
function getNextObjectNumber(pdfText) {
    const matches = pdfText.match(/(\d+)\s+0\s+obj/g);
    if (!matches || matches.length === 0) return 1;

    const numbers = matches.map(m => parseInt(m.match(/\d+/)[0]));
    return Math.max(...numbers) + 1;
}

module.exports = {
    extractCertChain,
    requestOCSP,
    embedDSS
};