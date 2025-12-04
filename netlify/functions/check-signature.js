const multipart = require('parse-multipart-data');
const zlib = require('zlib');

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
                    } catch (zlibErr) { }
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

    return {
        hasSig: true,
        hasLTV: hasLTV,
        signer: signer,
        reason: extract(/\/Reason\s*\(([^)]*(?:\\\)[^)]*)*)\)/),
        location: extract(/\/Location\s*\(([^)]*(?:\\\)[^)]*)*)\)/),
        date: formattedDate,
    };
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
        if (!pdfPart) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'No PDF file uploaded' })
            };
        }

        const result = checkPdfSignature(pdfPart.data);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};