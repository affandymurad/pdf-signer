import React, { useState, useCallback, useRef, useEffect } from 'react';
import axios from 'axios';
import QRCode from 'qrcode';
import './App.css';

// const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const API_URL = process.env.REACT_APP_API_URL || '/.netlify/functions';

function App() {
  const [pdfFile, setPdfFile] = useState(null);
  const [certFile, setCertFile] = useState(null);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('Document approval');
  const [location, setLocation] = useState('Digital Signature');

  const [pdfInfo, setPdfInfo] = useState(null);
  const [certInfo, setCertInfo] = useState(null);
  const [signatureStatus, setSignatureStatus] = useState(null);
  const [isSignedByUser, setIsSignedByUser] = useState(false);

  const [pdfPreview, setPdfPreview] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const canvasRef = useRef(null);
  const pdfDocRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeAccordion, setActiveAccordion] = useState(null);

  const [signatureMode, setSignatureMode] = useState('digitalOnly'); // 'digitalOnly' | 'visual'
  const [visualSignature, setVisualSignature] = useState(null); // { type, value, font } | { type: 'draw', dataUrl } | { type: 'upload', url, file }
  const [overlaySignature, setOverlaySignature] = useState(null); // { content, page, x, y, width, height }
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const drawCanvasRef = useRef(null);

  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState(null); // 'se', 'sw', 'ne', 'nw'

  // === Load PDF.js ===
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
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);


  // ✅ TAMBAH useEffect baru dengan touch + mouse support
  useEffect(() => {
    if (drawCanvasRef.current && signatureMode === 'visual' && visualSignature?.type === 'draw') {
      const canvas = drawCanvasRef.current;
      const ctx = canvas.getContext('2d');

      // Clear dan set background
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Set drawing style
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      let isDrawing = false;
      let lastX = 0;
      let lastY = 0;

      // ✅ Fungsi universal untuk mendapatkan posisi (mouse/touch/stylus)
      const getPosition = (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        // Touch/stylus event
        if (e.touches && e.touches.length > 0) {
          return {
            x: (e.touches[0].clientX - rect.left) * scaleX,
            y: (e.touches[0].clientY - rect.top) * scaleY
          };
        }
        // Mouse event
        return {
          x: (e.clientX - rect.left) * scaleX,
          y: (e.clientY - rect.top) * scaleY
        };
      };

      const start = (e) => {
        e.preventDefault(); // ✅ Prevent scrolling on touch
        isDrawing = true;
        const pos = getPosition(e);
        lastX = pos.x;
        lastY = pos.y;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
      };

      const draw = (e) => {
        if (!isDrawing) return;
        e.preventDefault(); // ✅ Prevent scrolling while drawing
        const pos = getPosition(e);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        lastX = pos.x;
        lastY = pos.y;
      };

      const stop = (e) => {
        if (isDrawing) {
          e.preventDefault();
          ctx.closePath();
          isDrawing = false;
        }
      };

      // ✅ Mouse events
      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', draw);
      canvas.addEventListener('mouseup', stop);
      canvas.addEventListener('mouseleave', stop);

      // ✅ Touch events (untuk finger)
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', draw, { passive: false });
      canvas.addEventListener('touchend', stop, { passive: false });
      canvas.addEventListener('touchcancel', stop, { passive: false });

      return () => {
        // Cleanup mouse
        canvas.removeEventListener('mousedown', start);
        canvas.removeEventListener('mousemove', draw);
        canvas.removeEventListener('mouseup', stop);
        canvas.removeEventListener('mouseleave', stop);

        // Cleanup touch
        canvas.removeEventListener('touchstart', start);
        canvas.removeEventListener('touchmove', draw);
        canvas.removeEventListener('touchend', stop);
        canvas.removeEventListener('touchcancel', stop);
      };
    }
  }, [signatureMode, visualSignature?.type]);

  // === Render PDF page ===
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

  // === Handle PDF upload ===
  const handlePdfUpload = async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setError('Please upload a valid PDF file');
      return;
    }
    setPdfFile(file);
    setPdfInfo({ name: file.name, size: formatBytes(file.size) });
    setError(null);
    setIsSignedByUser(false);

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

  // === Handle cert upload ===
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

  // === Convert text to image ===
  const textToImage = (text, font = 'Dancing Script') => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Set font dulu sebelum measure
      ctx.font = `bold 48px "${font}", cursive`;
      ctx.fillStyle = 'black';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const textToRender = text || 'John Doe';
      const metrics = ctx.measureText(textToRender);

      // Ukuran canvas berdasarkan text
      const padding = 20;
      canvas.width = metrics.width + (padding * 2);
      canvas.height = 80;

      // Clear dan set background transparan
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Render ulang dengan setting yang sama
      ctx.font = `bold 48px "${font}", cursive`;
      ctx.fillStyle = 'black';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      // Draw text di tengah vertikal
      ctx.fillText(textToRender, padding, canvas.height / 2);

      resolve(canvas.toDataURL('image/png'));
    });
  };

  // === Generate signature image ===
  const generateSignatureImage = async () => {
    if (!visualSignature) return null;

    if (visualSignature.type === 'text') {
      return await textToImage(visualSignature.value, visualSignature.font);
    } else if (visualSignature.type === 'qr') {
      // ✅ Generate QR Code
      if (!visualSignature.value) return null;
      try {
        const qrDataUrl = await QRCode.toDataURL(visualSignature.value, {
          width: 200,
          margin: 1,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        return qrDataUrl;
      } catch (err) {
        console.error('QR generation error:', err);
        return null;
      }
    } else if (visualSignature.type === 'draw') {
      return visualSignature.dataUrl;
    } else if (visualSignature.type === 'upload') {
      if (visualSignature.file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(visualSignature.file);
        });
      } else if (visualSignature.url) {
        try {
          const response = await fetch(visualSignature.url);
          const blob = await response.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (err) {
          console.error('Failed to convert image:', err);
          return null;
        }
      }
    }
    return null;
  };

  // ❌ HAPUS atau BIARKAN handleDragStart yang lama
  const handleDragStart = (e) => {
    e.dataTransfer.effectAllowed = 'copy';
  };

  // ✅ TAMBAH fungsi baru ini
  const handlePreviewTouchStart = async (e, type) => {
    // ✅ iOS: Stop propagation first
    e.preventDefault();
    e.stopPropagation();

    if (!canvasRef.current) return;

    const touch = e.touches[0];
    const canvasRect = canvasRef.current.getBoundingClientRect();

    // ✅ iOS: Use pageX/pageY instead of clientX/clientY for better accuracy
    const touchX = touch.pageX || touch.clientX;
    const touchY = touch.pageY || touch.clientY;

    // Generate signature image
    const imageUrl = await generateSignatureImage();
    if (!imageUrl) return;

    const img = new Image();
    img.src = imageUrl;
    img.onload = () => {
      const maxWidth = 200;
      const maxHeight = 100;
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = (maxWidth / width) * height;
        width = maxWidth;
      }
      if (height > maxHeight) {
        width = (maxHeight / height) * width;
        height = maxHeight;
      }

      const scaleX = canvasRef.current.width / canvasRect.width;
      const scaleY = canvasRef.current.height / canvasRect.height;

      // ✅ iOS: Use touchX/touchY calculated above
      const x = (touchX - canvasRect.left) * scaleX - (width / 2);
      const y = (touchY - canvasRect.top) * scaleY - (height / 2);

      setOverlaySignature({
        content: imageUrl,
        page: currentPage,
        x: Math.max(0, Math.min(x, canvasRef.current.width - width)),
        y: Math.max(0, Math.min(y, canvasRef.current.height - height)),
        width: width,
        height: height,
      });
    };
  };

  const handleCanvasDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };


  // Update handleCanvasDrop - perbaiki positioning
  const handleCanvasDrop = async (e) => {
    e.preventDefault();
    if (signatureMode !== 'visual' || !visualSignature) return;

    const canvasEl = canvasRef.current;
    if (!canvasEl) return;

    const rect = canvasEl.getBoundingClientRect();

    // Koordinat mouse relatif ke canvas
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Scale factor canvas
    const scaleX = canvasEl.width / rect.width;
    const scaleY = canvasEl.height / rect.height;

    // Koordinat dalam PDF coordinate space
    const x = mouseX * scaleX;
    const y = mouseY * scaleY;

    const imageUrl = await generateSignatureImage();
    if (!imageUrl) return;

    const img = new Image();
    img.src = imageUrl;
    img.onload = () => {
      // Ukuran signature proporsional
      const maxWidth = 200;
      const maxHeight = 100;
      let width = img.width;
      let height = img.height;

      // Scale down jika terlalu besar
      if (width > maxWidth) {
        height = (maxWidth / width) * height;
        width = maxWidth;
      }
      if (height > maxHeight) {
        width = (maxHeight / height) * width;
        height = maxHeight;
      }

      setOverlaySignature({
        content: imageUrl,
        page: currentPage,
        x: x - (width / 2), // Center pada posisi drop
        y: y - (height / 2),
        width: width,
        height: height,
      });
    };
  };

  // ✅ TAMBAH fungsi baru ini
  const handleCanvasTouchMove = async (e) => {
    if (!overlaySignature || !isDragging) return;
    e.preventDefault();

    const touch = e.touches[0];
    const rect = canvasRef.current.getBoundingClientRect();
    const canvasWidth = canvasRef.current.width;
    const canvasHeight = canvasRef.current.height;

    // ✅ iOS: Use pageX/pageY
    const touchX = touch.pageX || touch.clientX;
    const touchY = touch.pageY || touch.clientY;

    const mouseX = ((touchX - rect.left) / rect.width) * canvasWidth;
    const mouseY = ((touchY - rect.top) / rect.height) * canvasHeight;

    const newX = mouseX - dragOffset.x;
    const newY = mouseY - dragOffset.y;

    const maxX = canvasWidth - overlaySignature.width;
    const maxY = canvasHeight - overlaySignature.height;

    setOverlaySignature((prev) => ({
      ...prev,
      x: Math.max(0, Math.min(newX, maxX)),
      y: Math.max(0, Math.min(newY, maxY))
    }));
  };

  // Update startDrag - perbaiki untuk overlay
  const startDrag = (e) => {
    if (!overlaySignature) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);

    const rect = canvasRef.current.getBoundingClientRect();
    const canvasWidth = canvasRef.current.width;
    const canvasHeight = canvasRef.current.height;

    // ✅ iOS: Use pageX/pageY for better accuracy
    let clientX, clientY;
    if (e.touches) {
      clientX = e.touches[0].pageX || e.touches[0].clientX;
      clientY = e.touches[0].pageY || e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const mouseX = ((clientX - rect.left) / rect.width) * canvasWidth;
    const mouseY = ((clientY - rect.top) / rect.height) * canvasHeight;

    setDragOffset({
      x: mouseX - overlaySignature.x,
      y: mouseY - overlaySignature.y
    });
  };

  const stopDrag = () => setIsDragging(false);

  const startResize = (e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    setResizeHandle(handle);
  };

  const handleResize = useCallback((e) => {
    if (!isResizing || !overlaySignature || !canvasRef.current) return;
    e.preventDefault();

    const rect = canvasRef.current.getBoundingClientRect();
    const canvasWidth = canvasRef.current.width;
    const canvasHeight = canvasRef.current.height;

    // ✅ iOS: Use pageX for better accuracy
    let clientX;
    if (e.touches) {
      clientX = e.touches[0].pageX || e.touches[0].clientX;
    } else {
      clientX = e.clientX;
    }
    const mouseX = ((clientX - rect.left) / rect.width) * canvasWidth;

    const aspectRatio = overlaySignature.width / overlaySignature.height;
    let newWidth = overlaySignature.width;
    let newHeight = overlaySignature.height;
    let newX = overlaySignature.x;
    let newY = overlaySignature.y;

    switch (resizeHandle) {
      case 'se':
        newWidth = mouseX - overlaySignature.x;
        newHeight = newWidth / aspectRatio;
        break;
      case 'sw':
        newWidth = overlaySignature.x + overlaySignature.width - mouseX;
        newHeight = newWidth / aspectRatio;
        newX = mouseX;
        break;
      case 'ne':
        newWidth = mouseX - overlaySignature.x;
        newHeight = newWidth / aspectRatio;
        newY = overlaySignature.y + overlaySignature.height - newHeight;
        break;
      case 'nw':
        newWidth = overlaySignature.x + overlaySignature.width - mouseX;
        newHeight = newWidth / aspectRatio;
        newX = mouseX;
        newY = overlaySignature.y + overlaySignature.height - newHeight;
        break;
      default:
        break;
    }

    if (newWidth < 50 || newHeight < 25) return;
    if (newWidth > 400 || newHeight > 200) return;
    if (newX < 0 || newY < 0) return;
    if (newX + newWidth > canvasWidth || newY + newHeight > canvasHeight) return;

    setOverlaySignature({
      ...overlaySignature,
      x: newX,
      y: newY,
      width: newWidth,
      height: newHeight,
    });
  }, [isResizing, resizeHandle, overlaySignature]);

  const stopResize = () => {
    setIsResizing(false);
    setResizeHandle(null);
  };

  // Pindahkan handleDrag ke useCallback
  const handleDrag = useCallback((e) => {
    if (!isDragging || !overlaySignature || !canvasRef.current) return;
    e.preventDefault();

    const rect = canvasRef.current.getBoundingClientRect();
    const canvasWidth = canvasRef.current.width;
    const canvasHeight = canvasRef.current.height;

    // ✅ iOS: Use pageX/pageY for better accuracy
    let clientX, clientY;
    if (e.touches) {
      clientX = e.touches[0].pageX || e.touches[0].clientX;
      clientY = e.touches[0].pageY || e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const mouseX = ((clientX - rect.left) / rect.width) * canvasWidth;
    const mouseY = ((clientY - rect.top) / rect.height) * canvasHeight;

    const newX = mouseX - dragOffset.x;
    const newY = mouseY - dragOffset.y;

    const maxX = canvasWidth - overlaySignature.width;
    const maxY = canvasHeight - overlaySignature.height;

    setOverlaySignature((prev) => ({
      ...prev,
      x: Math.max(0, Math.min(newX, maxX)),
      y: Math.max(0, Math.min(newY, maxY))
    }));
  }, [isDragging, dragOffset, overlaySignature]);

  // Update useEffect untuk drag global
  useEffect(() => {
    const handleMove = (e) => {
      if (isDragging) {
        handleDrag(e);
      } else if (isResizing) {
        handleResize(e);
      }
    };

    const handleEnd = () => {
      if (isDragging) {
        stopDrag();
      } else if (isResizing) {
        stopResize();
      }
    };

    if (isDragging || isResizing) {
      // Mouse events
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleEnd);

      // ✅ Touch events
      document.addEventListener('touchmove', handleMove, { passive: false });
      document.addEventListener('touchend', handleEnd);
      document.addEventListener('touchcancel', handleEnd);
    }

    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
    };
  }, [isDragging, isResizing, handleDrag, handleResize]);

  // === Sign PDF ===
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

      if (overlaySignature) {
        // ✅ Kirim data overlay dengan koordinat yang sudah benar
        const overlayData = {
          content: overlaySignature.content,
          page: overlaySignature.page,
          x: overlaySignature.x,
          y: overlaySignature.y,
          width: overlaySignature.width,
          height: overlaySignature.height,
        };
        console.log('Sending signature overlay:', overlayData);
        formData.append('signatureOverlay', JSON.stringify(overlayData));
      }

      const response = await axios.post(`${API_URL}/sign-pdf`, formData, {
        responseType: 'blob',
        timeout: 30000,
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
      setIsSignedByUser(true);
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to sign PDF';
      setError(errorMsg);
      console.error('Signing error:', err);
    } finally {
      setLoading(false);
    }
  };

  // === Navigation & helpers ===
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

  // === RENDER ===
  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>🔐 PDF Digital Signature</h1>
          <p>Upload your PDF and P12 certificate to sign digitally (Adobe-compatible)</p>
          <a
            href="https://affandymurad.github.io"
            target="_blank"
            rel="noopener noreferrer"
            className="back-button"
          >
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
                {isSignedByUser && <p className="info-note">Verified using your uploaded certificate.</p>}
                {!signatureStatus.hasLTV && (
                  <div className="ltv-notice">
                    ℹ️ Tanda tangan ini valid saat ini. Untuk arsip jangka panjang, gunakan dokumen dengan LTV.
                  </div>
                )}
              </div>
            )}

            {/* PDF Preview with Overlay */}
            {pdfPreview && (
              <div className="pdf-preview">
                <br />
                <div className="preview-header">
                  <h4>📄 Document Preview</h4>
                  <div className="page-controls">
                    <button className="btn-nav" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1}>
                      ← Prev
                    </button>
                    <span className="page-info">Page {currentPage} of {totalPages}</span>
                    <button className="btn-nav" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages}>
                      Next →
                    </button>
                  </div>
                </div>
                {/* Update canvas container - tambahkan wrapper dengan position relative */}
                <div className="canvas-container">
                  <div style={{ position: 'relative', display: 'inline-block' }}>
                    <canvas
                      ref={canvasRef}
                      onDrop={handleCanvasDrop}
                      onDragOver={handleCanvasDragOver}
                      onTouchMove={handleCanvasTouchMove}
                    />
                    {overlaySignature && overlaySignature.page === currentPage && (
                      <div
                        className="signature-overlay"
                        style={{
                          position: 'absolute',
                          left: `${(overlaySignature.x / canvasRef.current.width) * 100}%`,
                          top: `${(overlaySignature.y / canvasRef.current.height) * 100}%`,
                          width: `${(overlaySignature.width / canvasRef.current.width) * 100}%`,
                          height: `${(overlaySignature.height / canvasRef.current.height) * 100}%`,
                          pointerEvents: 'all',
                          zIndex: 10,
                          cursor: isDragging ? 'grabbing' : 'grab',
                          transform: 'none', // Hapus transform
                        }}
                        onMouseDown={startDrag}
                        onTouchStart={startDrag}
                      >
                        <img
                          src={overlaySignature.content}
                          alt="Signature"
                          style={{
                            width: '100%',
                            height: '100%',
                            pointerEvents: 'none',
                            display: 'block',
                          }}
                        />

                        {/* Resize Handles */}
                        <div
                          className="resize-handle resize-se"
                          onMouseDown={(e) => startResize(e, 'se')}
                          onTouchStart={(e) => startResize(e, 'se')}
                        />
                        <div
                          className="resize-handle resize-sw"
                          onMouseDown={(e) => startResize(e, 'sw')}
                          onTouchStart={(e) => startResize(e, 'sw')}
                        />
                        <div
                          className="resize-handle resize-ne"
                          onMouseDown={(e) => startResize(e, 'ne')}
                          onTouchStart={(e) => startResize(e, 'ne')}
                        />
                        <div
                          className="resize-handle resize-nw"
                          onMouseDown={(e) => startResize(e, 'nw')}
                          onTouchStart={(e) => startResize(e, 'nw')}
                        />

                        <button
                          className="overlay-remove-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOverlaySignature(null);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Certificate Upload Section — With Visual Signature Panel */}
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

            {/* ✅ Signature Mode Selector */}
            <div className="input-group">
              <label>Signature Method:</label>
              <div className="radio-group">
                <label>
                  <input
                    type="radio"
                    name="signatureMode"
                    checked={signatureMode === 'digitalOnly'}
                    onChange={() => {
                      setSignatureMode('digitalOnly');
                      setVisualSignature(null);
                      setOverlaySignature(null);
                    }}
                  />
                  Digital signature only
                </label>
                <label>
                  <input
                    type="radio"
                    name="signatureMode"
                    checked={signatureMode === 'visual'}
                    onChange={() => setSignatureMode('visual')}
                  />
                  Add signature appearance
                </label>
              </div>
            </div>

            {/* ✅ Visual Signature Panel */}
            {signatureMode === 'visual' && (
              <div className="visual-signature-panel">
                <h4>✍️ Choose Signature Method:</h4>
                <p className="instruction-text">Drag preview to PDF to add signature <br />For the best experience, it is recommended to use a large-screen device in landscape mode.
                  If signing via smartphone or tablet, after generating your signature, simply tap once—the marker will appear in the PDF preview box for you to customize.</p>
                {/* Radio Button Selector */}
                <div className="signature-type-selector">
                  <label>
                    <input
                      type="radio"
                      name="signatureType"
                      checked={visualSignature?.type === 'text'}
                      onChange={() => {
                        setVisualSignature({ type: 'text', value: '', font: 'Dancing Script' });
                        setOverlaySignature(null);
                      }}
                    />
                    Text
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="signatureType"
                      checked={visualSignature?.type === 'qr'}
                      onChange={() => {
                        setVisualSignature({ type: 'qr', value: '' });
                        setOverlaySignature(null);
                      }}
                    />
                    QR Code
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="signatureType"
                      checked={visualSignature?.type === 'draw'}
                      onChange={() => {
                        setVisualSignature({ type: 'draw', dataUrl: null });
                        setOverlaySignature(null);
                        if (drawCanvasRef.current) {
                          const ctx = drawCanvasRef.current.getContext('2d');
                          ctx.fillStyle = 'white';
                          ctx.fillRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
                        }
                      }}
                    />
                    Draw
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="signatureType"
                      checked={visualSignature?.type === 'upload'}
                      onChange={() => {
                        setVisualSignature({ type: 'upload', file: null, url: null });
                        setOverlaySignature(null);
                      }}
                    />
                    Upload
                  </label>
                </div>

                {/* Text Option */}
                {visualSignature?.type === 'text' && (
                  <div className="signature-option">
                    <label>Teks Tanda Tangan:</label>
                    <input
                      type="text"
                      placeholder="Your Name or Initial"
                      value={visualSignature.value || ''}
                      onChange={(e) =>
                        setVisualSignature({
                          ...visualSignature,
                          value: e.target.value,
                        })
                      }
                    />
                    <select
                      value={visualSignature.font || 'Dancing Script'}
                      onChange={(e) =>
                        setVisualSignature({
                          ...visualSignature,
                          font: e.target.value,
                        })
                      }
                    >
                      <option value="Dancing Script">Dancing Script</option>
                      <option value="Great Vibes">Great Vibes</option>
                      <option value="Sacramento">Sacramento</option>
                      <option value="Allura">Allura</option>
                    </select>
                    {visualSignature.value && (
                      <div
                        className="text-preview draggable-preview"
                        style={{ fontFamily: visualSignature.font, fontSize: '24px' }}
                        draggable="true"
                        onDragStart={handleDragStart}
                        onTouchStart={(e) => handlePreviewTouchStart(e, 'text')}
                      >
                        {visualSignature.value}
                      </div>
                    )}
                  </div>
                )}

                {/* QR Code Option */}
                {visualSignature?.type === 'qr' && (
                  <div className="signature-option">
                    <label>QR Code Content:</label>
                    <textarea
                      placeholder="Enter text, URL, or data for QR code (max 500 chars)"
                      value={visualSignature.value || ''}
                      maxLength={500}
                      rows={3}
                      onChange={(e) =>
                        setVisualSignature({
                          ...visualSignature,
                          value: e.target.value,
                        })
                      }
                      style={{
                        width: '100%',
                        padding: '10px',
                        border: '2px solid #e9ecef',
                        borderRadius: '6px',
                        fontSize: '1em',
                        fontFamily: 'monospace',
                        resize: 'vertical'
                      }}
                    />
                    <div style={{
                      marginTop: '5px',
                      fontSize: '0.85em',
                      color: visualSignature.value?.length > 400 ? '#dc3545' : '#6c757d',
                      textAlign: 'right'
                    }}>
                      {visualSignature.value?.length || 0} / 500 characters
                    </div>
                    {visualSignature.value && (
                      <div
                        className="text-preview draggable-preview"
                        style={{
                          marginTop: '15px',
                          padding: '10px',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '10px'
                        }}
                        draggable="true"
                        onDragStart={handleDragStart}
                        onTouchStart={(e) => handlePreviewTouchStart(e, 'qr')}
                      >
                        <img
                          src={(() => {
                            // Generate QR untuk preview
                            const canvas = document.createElement('canvas');
                            QRCode.toCanvas(canvas, visualSignature.value, {
                              width: 150,
                              margin: 1
                            });
                            return canvas.toDataURL();
                          })()}
                          alt="QR Preview"
                          style={{ width: '150px', height: '150px' }}
                        />
                        <span style={{ fontSize: '0.8em', color: '#6c757d' }}>
                          Drag to PDF
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Draw Option */}
                {visualSignature?.type === 'draw' && (
                  <div className="signature-option">
                    <label>Draw with Mouse:</label>
                    <div className="draw-canvas-wrapper">
                      <canvas
                        ref={drawCanvasRef}
                        width={400}
                        height={120}
                      />
                      <div className="draw-canvas-buttons">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            if (drawCanvasRef.current) {
                              const dataUrl = drawCanvasRef.current.toDataURL('image/png');
                              setVisualSignature({ ...visualSignature, dataUrl });
                            }
                          }}
                        >
                          ✓ Save Drawing
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-secondary"
                          onClick={() => {
                            if (drawCanvasRef.current) {
                              const ctx = drawCanvasRef.current.getContext('2d');
                              ctx.fillStyle = 'white';
                              ctx.fillRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
                            }
                          }}
                        >
                          🗑️ Clear
                        </button>
                      </div>
                    </div>
                    {visualSignature.dataUrl && (
                      <div style={{ marginTop: '10px', textAlign: 'center' }}>
                        <img
                          src={visualSignature.dataUrl}
                          alt="Signature Preview"
                          className="draggable-preview"
                          style={{ maxHeight: '80px', border: '1px solid #ddd', cursor: 'grab' }}
                          draggable="true"
                          onDragStart={handleDragStart}
                          onTouchStart={(e) => handlePreviewTouchStart(e, 'draw')}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Upload Option */}
                {visualSignature?.type === 'upload' && (
                  <div className="signature-option">
                    <label>Upload Image (PNG/JPG):</label>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/jpg"
                      onChange={(e) => {
                        const file = e.target.files[0];
                        if (file) {
                          // ✅ Validasi ukuran file (max 2MB)
                          if (file.size > 2 * 1024 * 1024) {
                            alert('File too large. Maximum 2MB');
                            return;
                          }

                          // ✅ Validasi tipe file
                          if (!file.type.startsWith('image/')) {
                            alert('File must be an image (PNG/JPG)');
                            return;
                          }

                          const url = URL.createObjectURL(file);
                          setVisualSignature({
                            type: 'upload',
                            file: file,  // ✅ Simpan file object
                            url: url
                          });
                        }
                      }}
                    />
                    {visualSignature.url && (
                      <div style={{ marginTop: '10px', textAlign: 'center' }}>
                        <img
                          src={visualSignature.url}
                          alt="Signature"
                          className="draggable-preview"
                          style={{ maxHeight: '60px', cursor: 'grab' }}
                          draggable="true"
                          onDragStart={handleDragStart}
                          onTouchStart={(e) => handlePreviewTouchStart(e, 'upload')}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Reset Visual */}
                <button
                  type="button"
                  className="btn btn-reset"
                  onClick={() => {
                    setVisualSignature(null);
                    setOverlaySignature(null);
                    if (drawCanvasRef.current) {
                      const ctx = drawCanvasRef.current.getContext('2d');
                      ctx.fillStyle = 'white';
                      ctx.fillRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
                    }
                  }}
                  style={{ marginTop: '15px' }}
                >
                  Reset Signature
                </button>
              </div>
            )}

            <button
              className="btn btn-primary"
              onClick={handleSignPdf}
              disabled={
                !pdfFile ||
                !certFile ||
                loading ||
                (signatureMode === 'visual' && (!visualSignature || !overlaySignature))
              }
            >
              {loading ? '⏳ Processing...' : '🖊️ Sign Document'}
            </button>

            {error && (
              <div className="status invalid">
                <span>✗</span>
                <span>{error}</span>
              </div>
            )}

            {/* Accordion */}
            {/* Accordion */}
            <div className="accordion">
              {/* Warning Box - Displayed above accordion */}
              <div className="certificate-warning-box" style={{
                backgroundColor: '#fff3cd',
                border: '1px solid #ffc107',
                borderRadius: '8px',
                padding: '15px',
                marginBottom: '15px',
                fontSize: '0.95em'
              }}>
                <h4 style={{ color: '#856404', margin: '0 0 10px 0', fontSize: '1em' }}>
                  ⚠️ About Self-Signed Certificates
                </h4>
                <p style={{ margin: '5px 0', color: '#856404' }}>
                  <strong>Certificates created with OpenSSL (self-signed) will NOT be trusted by Adobe Reader.</strong>
                </p>
                <p style={{ margin: '5px 0', color: '#856404' }}>
                  Signed PDFs will display the message: <em>"At least one signature is invalid"</em>
                </p>
                <p style={{ margin: '5px 0', color: '#856404' }}>
                  <strong>Why?</strong> Self-signed certificates are not issued by a trusted Certificate Authority (CA).
                </p>
                <div style={{
                  marginTop: '12px',
                  paddingTop: '12px',
                  borderTop: '1px solid #ffc107'
                }}>
                  <p style={{ margin: '5px 0', color: '#856404', fontWeight: 'bold' }}>
                    ✅ For valid signatures in Adobe Reader:
                  </p>
                  <ul style={{ margin: '8px 0', paddingLeft: '20px', color: '#856404' }}>
                    <li>Use certificates from trusted CAs (paid: DigiCert, GlobalSign, Sectigo)</li>
                    <li>Or request from your IT/organization for registered internal CA</li>
                  </ul>
                  <p style={{ margin: '8px 0 0 0', color: '#856404', fontSize: '0.9em' }}>
                    <strong>Note:</strong> Self-signed certificates can be used for testing or internal use,
                    but each user must manually trust the certificate in Adobe Reader.
                  </p>
                </div>
              </div>

              <div className="accordion-item">
                <div className="accordion-header" onClick={() => toggleAccordion(0)}>
                  <span>💻 Create Self-Signed Certificate (Windows)</span>
                  <span>{activeAccordion === 0 ? '▲' : '▼'}</span>
                </div>
                {activeAccordion === 0 && (
                  <div className="accordion-content">
                    <div style={{
                      backgroundColor: '#f8d7da',
                      border: '1px solid #f5c2c7',
                      borderRadius: '6px',
                      padding: '12px',
                      marginBottom: '15px',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '0', color: '#842029' }}>
                        <strong>⚠️ WARNING:</strong> This certificate is for testing/development only.
                        Adobe Reader will show "invalid signature" because no CA verifies it.
                      </p>
                    </div>

                    <h4 style={{ marginTop: '10px', marginBottom: '10px' }}>Method 1: Simple (No CRL/OCSP)</h4>
                    <ol>
                      <li>
                        Install <a href="https://slproweb.com/products/Win32OpenSSL.html" target="_blank" rel="noopener noreferrer">OpenSSL for Windows</a>
                      </li>
                      <li>Open Command Prompt (Run as Administrator)</li>
                      <li>
                        Generate private key:<br />
                        <code>openssl genrsa -out private.key 2048</code>
                      </li>
                      <li>
                        Create certificate request (replace "Your Name" with your name):<br />
                        <code>openssl req -new -key private.key -subj "/CN=Your Name/O=Your Organization/C=US" -out request.csr</code>
                      </li>
                      <li>
                        Generate self-signed certificate (valid for 1 year):<br />
                        <code>openssl x509 -req -days 365 -in request.csr -signkey private.key -out certificate.crt</code>
                      </li>
                      <li>
                        Create P12 bundle (you'll be asked for a password, remember it):<br />
                        <code>openssl pkcs12 -export -out certificate.p12 -inkey private.key -in certificate.crt -name "My Self-Signed Cert"</code>
                      </li>
                    </ol>

                    <h4 style={{ marginTop: '20px', marginBottom: '10px' }}>Method 2: Enhanced (With Extensions)</h4>
                    <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '10px' }}>
                      This method adds extensions to reduce verification warnings (CRL/OCSP addresses won't work but will be present).
                    </p>
                    <ol>
                      <li>
                        Create a config file <code>cert.conf</code> with this content:<br />
                        <textarea readOnly style={{
                          width: '100%',
                          height: '180px',
                          fontFamily: 'monospace',
                          fontSize: '0.85em',
                          marginTop: '5px',
                          padding: '10px',
                          border: '1px solid #ddd',
                          borderRadius: '4px'
                        }} value={`[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca

[req_distinguished_name]

[v3_ca]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, nonRepudiation
extendedKeyUsage = emailProtection
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
crlDistributionPoints = URI:http://localhost/crl.pem
authorityInfoAccess = OCSP;URI:http://localhost/ocsp`} />
                      </li>
                      <li>
                        Generate private key:<br />
                        <code>openssl genrsa -out private.key 2048</code>
                      </li>
                      <li>
                        Create self-signed certificate with extensions:<br />
                        <code>openssl req -new -x509 -key private.key -out certificate.crt -days 365 -subj "/CN=Your Name/O=Your Organization/C=US" -config cert.conf</code>
                      </li>
                      <li>
                        Create P12 bundle:<br />
                        <code>openssl pkcs12 -export -out certificate.p12 -inkey private.key -in certificate.crt -name "Enhanced Self-Signed"</code>
                      </li>
                    </ol>

                    <div style={{
                      marginTop: '15px',
                      padding: '10px',
                      backgroundColor: '#fff3cd',
                      borderRadius: '6px',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '5px 0', color: '#856404' }}>
                        <strong>📝 Note about CRL/OCSP warnings:</strong>
                      </p>
                      <p style={{ margin: '5px 0', color: '#856404' }}>
                        Self-signed certificates will always show CRL/OCSP warnings on verification sites like verifysignature.eu because:
                      </p>
                      <ul style={{ margin: '5px 0', paddingLeft: '20px', color: '#856404' }}>
                        <li>No actual CRL (Certificate Revocation List) server exists</li>
                        <li>No actual OCSP (Online Certificate Status Protocol) responder exists</li>
                        <li>These services require a real Certificate Authority infrastructure</li>
                      </ul>
                      <p style={{ margin: '5px 0', color: '#856404' }}>
                        <strong>This is expected behavior for self-signed certificates.</strong> Our TSA and LTV features still work for timestamp validation.
                      </p>
                    </div>

                    <div style={{
                      marginTop: '15px',
                      padding: '10px',
                      backgroundColor: '#e7f3ff',
                      borderLeft: '3px solid #0066cc',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '5px 0' }}>
                        <strong>💡 Manual Trust Tips (to make signature valid on your computer):</strong>
                      </p>
                      <ol style={{ margin: '5px 0', paddingLeft: '20px' }}>
                        <li>Open the signed PDF in Adobe Reader</li>
                        <li>Click signature → "Signature Properties"</li>
                        <li>Click "Show Signer's Certificate"</li>
                        <li>Click "Trust" tab → Check "Use this certificate as a trusted root"</li>
                        <li>Apply → Signature will become valid on your computer</li>
                      </ol>
                      <p style={{ margin: '5px 0', fontSize: '0.85em', color: '#666' }}>
                        ⚠️ This must be done on every computer that opens the PDF
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="accordion-item">
                <div className="accordion-header" onClick={() => toggleAccordion(1)}>
                  <span>🍎 Create Self-Signed Certificate (Mac/Linux)</span>
                  <span>{activeAccordion === 1 ? '▲' : '▼'}</span>
                </div>
                {activeAccordion === 1 && (
                  <div className="accordion-content">
                    <div style={{
                      backgroundColor: '#f8d7da',
                      border: '1px solid #f5c2c7',
                      borderRadius: '6px',
                      padding: '12px',
                      marginBottom: '15px',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '0', color: '#842029' }}>
                        <strong>⚠️ WARNING:</strong> This certificate is for testing/development only.
                        Adobe Reader will show "invalid signature" because no CA verifies it.
                      </p>
                    </div>

                    <h4 style={{ marginTop: '10px', marginBottom: '10px' }}>Method 1: Simple (No CRL/OCSP)</h4>
                    <ol>
                      <li>Open Terminal</li>
                      <li>
                        Generate private key:<br />
                        <code>openssl genrsa -out private.key 2048</code>
                      </li>
                      <li>
                        Create certificate request (replace "Your Name" with your name):<br />
                        <code>openssl req -new -key private.key -subj "/CN=Your Name/O=Your Organization/C=US" -out request.csr</code>
                      </li>
                      <li>
                        Generate self-signed certificate (valid for 1 year):<br />
                        <code>openssl x509 -req -days 365 -in request.csr -signkey private.key -out certificate.crt</code>
                      </li>
                      <li>
                        Create P12 bundle (you'll be asked for a password, remember it):<br />
                        <code>openssl pkcs12 -export -out certificate.p12 -inkey private.key -in certificate.crt -name "My Self-Signed Cert"</code>
                      </li>
                    </ol>

                    <h4 style={{ marginTop: '20px', marginBottom: '10px' }}>Method 2: Enhanced (With Extensions)</h4>
                    <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '10px' }}>
                      This method adds extensions to reduce verification warnings (CRL/OCSP addresses won't work but will be present).
                    </p>
                    <ol>
                      <li>
                        Create a config file <code>cert.conf</code>:<br />
                        <code style={{ fontSize: '0.85em' }}>cat &gt; cert.conf &lt;&lt;EOF<br />
                          [req]<br />
                          distinguished_name = req_distinguished_name<br />
                          x509_extensions = v3_ca<br />
                          <br />
                          [req_distinguished_name]<br />
                          <br />
                          [v3_ca]<br />
                          basicConstraints = CA:FALSE<br />
                          keyUsage = digitalSignature, nonRepudiation<br />
                          extendedKeyUsage = emailProtection<br />
                          subjectKeyIdentifier = hash<br />
                          authorityKeyIdentifier = keyid:always<br />
                          crlDistributionPoints = URI:http://localhost/crl.pem<br />
                          authorityInfoAccess = OCSP;URI:http://localhost/ocsp<br />
                          EOF</code>
                      </li>
                      <li>
                        Generate private key:<br />
                        <code>openssl genrsa -out private.key 2048</code>
                      </li>
                      <li>
                        Create self-signed certificate with extensions:<br />
                        <code>openssl req -new -x509 -key private.key -out certificate.crt -days 365 -subj "/CN=Your Name/O=Your Organization/C=US" -config cert.conf</code>
                      </li>
                      <li>
                        Create P12 bundle:<br />
                        <code>openssl pkcs12 -export -out certificate.p12 -inkey private.key -in certificate.crt -name "Enhanced Self-Signed"</code>
                      </li>
                    </ol>

                    <div style={{
                      marginTop: '15px',
                      padding: '10px',
                      backgroundColor: '#fff3cd',
                      borderRadius: '6px',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '5px 0', color: '#856404' }}>
                        <strong>📝 Note about CRL/OCSP warnings:</strong>
                      </p>
                      <p style={{ margin: '5px 0', color: '#856404' }}>
                        Self-signed certificates will always show CRL/OCSP warnings on verification sites like verifysignature.eu because:
                      </p>
                      <ul style={{ margin: '5px 0', paddingLeft: '20px', color: '#856404' }}>
                        <li>No actual CRL (Certificate Revocation List) server exists</li>
                        <li>No actual OCSP (Online Certificate Status Protocol) responder exists</li>
                        <li>These services require a real Certificate Authority infrastructure</li>
                      </ul>
                      <p style={{ margin: '5px 0', color: '#856404' }}>
                        <strong>This is expected behavior for self-signed certificates.</strong> Our TSA and LTV features still work for timestamp validation.
                      </p>
                    </div>

                    <div style={{
                      marginTop: '15px',
                      padding: '10px',
                      backgroundColor: '#e7f3ff',
                      borderLeft: '3px solid #0066cc',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '5px 0' }}>
                        <strong>💡 Manual Trust Tips (to make signature valid on your computer):</strong>
                      </p>
                      <ol style={{ margin: '5px 0', paddingLeft: '20px' }}>
                        <li>Open the signed PDF in Adobe Reader</li>
                        <li>Click signature → "Signature Properties"</li>
                        <li>Click "Show Signer's Certificate"</li>
                        <li>Click "Trust" tab → Check "Use this certificate as a trusted root"</li>
                        <li>Apply → Signature will become valid on your computer</li>
                      </ol>
                      <p style={{ margin: '5px 0', fontSize: '0.85em', color: '#666' }}>
                        ⚠️ This must be done on every computer that opens the PDF
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Additional: Info for Production Use */}
              <div className="accordion-item">
                <div className="accordion-header" onClick={() => toggleAccordion(2)}>
                  <span>🏢 For Production/Professional Use</span>
                  <span>{activeAccordion === 2 ? '▲' : '▼'}</span>
                </div>
                {activeAccordion === 2 && (
                  <div className="accordion-content">
                    <div style={{
                      backgroundColor: '#d1e7dd',
                      border: '1px solid #badbcc',
                      borderRadius: '6px',
                      padding: '12px',
                      marginBottom: '15px'
                    }}>
                      <p style={{ margin: '0', color: '#0f5132', fontWeight: 'bold' }}>
                        ✅ For signatures that are immediately valid on all computers
                      </p>
                    </div>

                    <h4 style={{ marginTop: '15px', color: '#333' }}>Option 1: Commercial Certificate Authority</h4>
                    <p>Use certificates from globally trusted CAs:</p>
                    <ul>
                      <li>
                        <strong>DigiCert</strong> - <a href="https://www.digicert.com/signing/document-signing-certificates" target="_blank" rel="noopener noreferrer">Document Signing Certificate</a>
                        <br /><small>Starting ~$200/year, trusted worldwide</small>
                      </li>
                      <li>
                        <strong>GlobalSign</strong> - <a href="https://www.globalsign.com/en/digital-signatures" target="_blank" rel="noopener noreferrer">Digital Signatures</a>
                        <br /><small>Starting ~$200/year, international coverage</small>
                      </li>
                      <li>
                        <strong>Sectigo (Comodo)</strong> - <a href="https://sectigo.com/ssl-certificates-tls/code-signing" target="_blank" rel="noopener noreferrer">Document Signing</a>
                        <br /><small>Starting ~$150/year, widely accepted</small>
                      </li>
                    </ul>

                    <h4 style={{ marginTop: '20px', color: '#333' }}>Option 2: Organization Certificate Authority</h4>
                    <p>If your organization/company has an IT department:</p>
                    <ul>
                      <li>Request a certificate from your internal company CA</li>
                      <li>CA must be registered in Adobe Approved Trust List (AATL)</li>
                      <li>Usually free for employees, valid throughout the organization</li>
                    </ul>

                    <h4 style={{ marginTop: '20px', color: '#333' }}>Option 3: Government-Issued Digital Certificate</h4>
                    <p>For United States:</p>
                    <ul>
                      <li>
                        <strong>IdenTrust</strong> - Federal PKI Bridge
                        <br /><small>Government-approved digital certificates</small>
                      </li>
                      <li>
                        <strong>Entrust</strong> - Federal PKI
                        <br /><small>Approved for federal and state government use</small>
                      </li>
                    </ul>
                    <p style={{ marginTop: '10px' }}>For other countries:</p>
                    <ul>
                      <li><strong>EU:</strong> eIDAS compliant providers (European Digital Identity)</li>
                      <li><strong>India:</strong> eMudhra, Capricorn CA</li>
                      <li><strong>Indonesia:</strong> BSrE (Kominfo), Mekari Sign, Privy, VIDA</li>
                      <li><strong>Singapore:</strong> Netrust, DSTA</li>
                    </ul>

                    <div style={{
                      marginTop: '20px',
                      padding: '12px',
                      backgroundColor: '#fff3cd',
                      border: '1px solid #ffc107',
                      borderRadius: '6px',
                      fontSize: '0.9em'
                    }}>
                      <p style={{ margin: '0', color: '#856404' }}>
                        <strong>💡 Recommendations:</strong>
                      </p>
                      <ul style={{ margin: '5px 0', paddingLeft: '20px', color: '#856404' }}>
                        <li><strong>Testing/Development:</strong> Use self-signed certificate</li>
                        <li><strong>Internal Organization:</strong> Request from IT department</li>
                        <li><strong>External/Customer-facing:</strong> Use commercial CA (DigiCert, GlobalSign, etc.)</li>
                        <li><strong>Legal Documents:</strong> Use government-approved providers in your country</li>
                      </ul>
                    </div>
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