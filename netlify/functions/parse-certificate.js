// netlify/functions/parse-certificate.js
const multipart = require('parse-multipart-data');
const forge = require('node-forge');

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
            validTo: cert.validity.notAfter
        };
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

        const certPart = parts.find(part => part.name === 'certificate');
        const passwordPart = parts.find(part => part.name === 'password');

        if (!certPart) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'No certificate file uploaded' })
            };
        }

        const password = passwordPart ? passwordPart.data.toString() : '';
        const result = parseP12Certificate(certPart.data, password);

        if (result.success) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(result)
            };
        } else {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: result.error })
            };
        }
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};