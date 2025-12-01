import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function App() {
  const [pdfFile, setPdfFile] = useState(null);
  const [certFile, setCertFile] = useState(null);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('Document approval');
  const [location, setLocation] = useState('Digital Signature');

  const [pdfInfo, setPdfInfo] = useState(null);
  const [certInfo, setCertInfo] = useState(null);
  const [signatureStatus, setSignatureStatus] = useState(null);
  const [isSignedByUser, setIsSignedByUser] = useState(false); // ✅ Tandai jika ditandatangani oleh user

  // Full PDF preview
  const [pdfPreview, setPdfPreview] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const canvasRef = useRef(null);
  const pdfDocRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeAccordion, setActiveAccordion] = useState(null);

  // Load PDF.js
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
    script.async = true;
    script.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      }
    };
    document.body.appendChild(script);

    return () => {
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
    };
  }, []);

  // Render specific page
  const renderPage = async (pageNum) => {
    if (!pdfDocRef.current || !canvasRef.current) return;

    try {
      const page = await pdfDocRef.current.getPage(pageNum);
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      const scale = 1.3;
      const viewport = page.getViewport({ scale });
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({ canvasContext: context, viewport }).promise;
    } catch (err) {
      console.error('Render error:', err);
    }
  };

  const handlePdfUpload = async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setError('Please upload a valid PDF file');
      return;
    }

    setPdfFile(file);
    setPdfInfo({ name: file.name, size: formatBytes(file.size) });
    setError(null);
    setIsSignedByUser(false); // ✅ Reset status saat upload PDF baru

    const fileReader = new FileReader();
    fileReader.onload = async (e) => {
      const typedArray = new Uint8Array(e.target.result);
      if (!window.pdfjsLib) return;

      try {
        const pdf = await window.pdfjsLib.getDocument(typedArray).promise;
        pdfDocRef.current = pdf;
        setTotalPages(pdf.numPages);
        setCurrentPage(1);
        setPdfPreview(true);
        await renderPage(1);
      } catch (err) {
        setError('Failed to load PDF preview');
        console.error(err);
      }
    };
    fileReader.readAsArrayBuffer(file);

    // Cek apakah PDF sudah ditandatangani (fallback regex)
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const response = await axios.post(`${API_URL}/check-signature`, formData);
      setSignatureStatus(response.data);
    } catch (err) {
      setSignatureStatus({ hasSig: false, error: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleCertUpload = async (file) => {
    const validExtensions = ['.p12', '.pfx'];
    if (!validExtensions.some(ext => file.name.toLowerCase().endsWith(ext))) {
      setError('Invalid certificate format. Please use .p12 or .pfx file');
      return;
    }

    setCertFile(file);
    setError(null);
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('certificate', file);
      formData.append('password', password);
      const response = await axios.post(`${API_URL}/parse-certificate`, formData);
      setCertInfo(response.data);
    } catch (err) {
      setCertInfo({ error: err.response?.data?.error || err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSignPdf = async () => {
    if (!pdfFile || !certFile) {
      setError('Please upload both PDF and certificate files');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('pdf', pdfFile);
      formData.append('certificate', certFile);
      formData.append('password', password);
      formData.append('reason', reason);
      formData.append('location', location);

      const response = await axios.post(`${API_URL}/sign-pdf`, formData, {
        responseType: 'blob',
        timeout: 30000
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', pdfFile.name.replace('.pdf', '_signed.pdf'));
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      alert('✅ PDF signed successfully! File downloaded.');
      setIsSignedByUser(true); // ✅ Tandai bahwa dokumen ditandatangani oleh user ini
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to sign PDF';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const goToPage = async (pageNum) => {
    if (pageNum < 1 || pageNum > totalPages) return;
    setCurrentPage(pageNum);
    await renderPage(pageNum);
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const toggleAccordion = (index) => {
    setActiveAccordion(activeAccordion === index ? null : index);
  };

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>🔐 PDF Digital Signature</h1>
          <p>Upload your PDF and P12 certificate to sign digitally (Adobe-compatible)</p>
          <a href="https://affandymurad.github.io" target="_blank" rel="noopener noreferrer" className="back-button">
            Back to Affandy Murad
          </a>
        </div>

        <div className="content">
          {/* PDF Upload Section */}
          <div className="section">
            <h2><span className="icon">📄</span> Upload PDF Document</h2>

            <div
              className="upload-area"
              onClick={() => document.getElementById('pdfInput').click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
              onDragLeave={(e) => e.currentTarget.classList.remove('dragover')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('dragover');
                if (e.dataTransfer.files.length) handlePdfUpload(e.dataTransfer.files[0]);
              }}
            >
              <p className="upload-icon">📄</p>
              <p className="upload-text">Click or drag & drop PDF file</p>
              <p className="upload-subtext">Maximum 10MB</p>
              <input
                id="pdfInput"
                type="file"
                accept=".pdf"
                onChange={(e) => e.target.files[0] && handlePdfUpload(e.target.files[0])}
                style={{ display: 'none' }}
              />
            </div>

            {pdfInfo && (
              <div className="file-info">
                <p><strong>File:</strong> {pdfInfo.name}</p>
                <p><strong>Size:</strong> {pdfInfo.size}</p>
              </div>
            )}

            {signatureStatus && (
              <div className={`status ${signatureStatus.hasSig ? 'signed' : 'unsigned'}`}>
                <span>{signatureStatus.hasSig ? '✔' : '⚠'}</span>
                <span>{signatureStatus.hasSig ? 'Document is digitally signed' : 'Document is not signed'}</span>
              </div>
            )}

            {signatureStatus?.hasSig && (
              <div className="signature-info">
                <h4>📋 Signature Information:</h4>
                {isSignedByUser && certInfo?.commonName ? (
                  <p><strong>Signer:</strong> {certInfo.commonName}</p>
                ) : (
                  <p><strong>Signer:</strong> {signatureStatus.signer || 'Unknown'}</p>
                )}
                <p><strong>Date:</strong> {signatureStatus.date}</p>
                {signatureStatus.reason && <p><strong>Reason:</strong> {signatureStatus.reason}</p>}
                {signatureStatus.location && <p><strong>Location:</strong> {signatureStatus.location}</p>}
                {isSignedByUser && (
                  <p className="info-note">Verified using your uploaded certificate.</p>
                )}
                {/* ✅ Sembunyikan notifikasi LTV jika dokumen sudah LTV-enabled */}
                {!signatureStatus.hasLTV && (
                  <div className="ltv-notice">
                    ℹ️ Tanda tangan ini valid saat ini. Untuk arsip jangka panjang, gunakan dokumen dengan LTV.
                  </div>
                )}
              </div>
            )}

            {/* Full PDF Preview with Navigation */}
            {pdfPreview && (
              <div className="pdf-preview">
                <br />
                <div className="preview-header">
                  <h4>📄 Document Preview</h4>
                  <div className="page-controls">
                    <button
                      className="btn-nav"
                      onClick={() => goToPage(currentPage - 1)}
                      disabled={currentPage <= 1}
                    >
                      ← Prev
                    </button>
                    <span className="page-info">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      className="btn-nav"
                      onClick={() => goToPage(currentPage + 1)}
                      disabled={currentPage >= totalPages}
                    >
                      Next →
                    </button>
                  </div>
                </div>
                <div className="canvas-container">
                  <canvas ref={canvasRef} />
                </div>
              </div>
            )}
          </div>

          {/* Certificate Upload Section */}
          <div className="section">
            <h2><span className="icon">🔑</span> Upload P12 Certificate</h2>

            <div
              className="upload-area"
              onClick={() => document.getElementById('certInput').click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
              onDragLeave={(e) => e.currentTarget.classList.remove('dragover')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('dragover');
                if (e.dataTransfer.files.length) handleCertUpload(e.dataTransfer.files[0]);
              }}
            >
              <p className="upload-icon">🔑</p>
              <p className="upload-text">Click or drag & drop certificate</p>
              <p className="upload-subtext">Format: .p12, .pfx</p>
              <input
                id="certInput"
                type="file"
                accept=".p12,.pfx"
                onChange={(e) => e.target.files[0] && handleCertUpload(e.target.files[0])}
                style={{ display: 'none' }}
              />
            </div>

            {certFile && (
              <div className="file-info">
                <p><strong>File:</strong> {certFile.name}</p>
                {certInfo && !certInfo.error && (
                  <div className="cert-details">
                    <p><strong>Common Name:</strong> {certInfo.commonName}</p>
                    {certInfo.organization && <p><strong>Organization:</strong> {certInfo.organization}</p>}
                    {certInfo.email && <p><strong>Email:</strong> {certInfo.email}</p>}
                    <p><strong>Valid:</strong> {new Date(certInfo.validFrom).toLocaleDateString()} - {new Date(certInfo.validTo).toLocaleDateString()}</p>
                  </div>
                )}
                {certInfo?.error && <p className="error-text">⚠️ {certInfo.error}</p>}
              </div>
            )}

            <div className="input-group">
              <label>Password (if protected):</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave empty if no password"
              />
            </div>

            <div className="input-group">
              <label>Signing Reason:</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g., Document approval"
              />
            </div>

            <div className="input-group">
              <label>Location:</label>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g., Jakarta, Indonesia"
              />
            </div>

            <button
              className="btn btn-primary"
              onClick={handleSignPdf}
              disabled={!pdfFile || !certFile || loading}
            >
              {loading ? '⏳ Processing...' : '🖊️ Sign Document'}
            </button>

            {error && (
              <div className="status invalid">
                <span>✗</span>
                <span>{error}</span>
              </div>
            )}

            {/* Accordion guides */}
            <div className="accordion">
              <div className="accordion-item">
                <div className="accordion-header" onClick={() => toggleAccordion(0)}>
                  <span>💻 Create P12 Certificate (Windows)</span>
                  <span>{activeAccordion === 0 ? '▲' : '▼'}</span>
                </div>
                {activeAccordion === 0 && (
                  <div className="accordion-content">
                    <ol>
                      <li>Install <a href="https://slproweb.com/products/Win32OpenSSL.html" target="_blank" rel="noopener noreferrer">OpenSSL for Windows</a></li>
                      <li>Open Command Prompt</li>
                      <li>Generate private key:<br /><code>openssl genrsa -out private.key 2048</code></li>
                      <li>Create certificate request:<br /><code>openssl req -new -key private.key -subj "/CN=Your Name/C=ID" -out request.csr</code></li>
                      <li>Generate self-signed certificate:<br /><code>openssl x509 -req -days 365 -in request.csr -signkey private.key -out certificate.crt</code></li>
                      <li>Create P12 bundle:<br /><code>openssl pkcs12 -export -out certificate.p12 -inkey private.key -in certificate.crt</code></li>
                    </ol>
                  </div>
                )}
              </div>

              <div className="accordion-item">
                <div className="accordion-header" onClick={() => toggleAccordion(1)}>
                  <span>🍎 Create P12 Certificate (Mac/Linux)</span>
                  <span>{activeAccordion === 1 ? '▲' : '▼'}</span>
                </div>
                {activeAccordion === 1 && (
                  <div className="accordion-content">
                    <ol>
                      <li>Open Terminal</li>
                      <li><code>openssl genrsa -out private.key 2048</code></li>
                      <li><code>openssl req -new -key private.key -subj "/CN=Your Name/C=ID" -out request.csr</code></li>
                      <li><code>openssl x509 -req -days 365 -in request.csr -signkey private.key -out certificate.crt</code></li>
                      <li><code>openssl pkcs12 -export -out certificate.p12 -inkey private.key -in certificate.crt</code></li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;