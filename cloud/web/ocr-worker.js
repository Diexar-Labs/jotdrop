import Tesseract from '/ocr/tesseract.esm.min.js';

// Owning the nested OCR worker here lets cancel/lock also stop initialization.
self.onmessage = async ({ data: image }) => {
  let worker;
  try {
    worker = await Tesseract.createWorker('eng+nld', 1, {
      workerPath: new URL('/ocr/worker.min.js', self.location.origin).href,
      workerBlobURL: false,
      corePath: new URL('/ocr', self.location.origin).href,
      langPath: new URL('/ocr', self.location.origin).href,
      cacheMethod: 'none',
      logger: ({ status, progress }) => self.postMessage({ status, progress }),
      errorHandler: () => self.postMessage({ error: true }),
    });
    const { data: { text } } = await worker.recognize(image);
    self.postMessage({ text });
  } catch { self.postMessage({ error: true }); }
  finally { if (worker) await worker.terminate(); }
};
