// ArkanCam — gesture-driven photo puzzle booth
// Built by Mohamed Arkan

import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

/* ==========================================================================
   CONFIG & CONSTANTS
   ========================================================================== */
const CONFIG = {
  // Vision & Performance
  LOAD_TIMEOUT_MS: 20000,
  DETECTION_FPS: 24, // Capped MediaPipe vision tick rate
  MIN_DETECTION_CONFIDENCE: 0.6,
  MIN_PRESENCE_CONFIDENCE: 0.6,
  MIN_TRACKING_CONFIDENCE: 0.6,
  NUM_HANDS: 2,

  // Gesture Controls
  PINCH_THRESHOLD: 0.055,
  FREEZE_HOLD_MS: 250,
  FIST_HOLD_FRAMES: 12,
  SNAP_DISTANCE_RATIO: 0.45,
  DISPLACE_ANIM_MS: 220,

  // Board & Framing
  FRAME_PADDING: 28,
  FRAME_GRACE_MS: 450,
  MIN_BOARD_SIZE_PX: 160,
  GRID_SIZE: 3,
  COUNTDOWN_SECONDS: 3,

  // Photo Booth Grain / Contrast Filter
  BOOTH_CONTRAST_ALPHA: 1.3,
  BOOTH_BRIGHTNESS_BETA: 10,
  BOOTH_NOISE_STD: 15,

  // Shatter FX (Optimized 4x4 = 16 fragments directly from source canvas)
  SHATTER_COLS: 4,
  SHATTER_ROWS: 4,
  SHATTER_DURATION_MS: 850,

  // Photo Strip Gallery
  STRIP_MAX_PHOTOS: 3,
  STRIP_FILE_BORDER: 24,
  STRIP_FILE_GAP: 16,
  STRIP_FILE_BG: "#ffffff",

  // Cyberpunk Terminal Palette
  COLOR_PRIMARY: "#4dff4d",
  COLOR_DIM: "#185a18",
  COLOR_ALERT: "#ff2a55",
  COLOR_WARN: "#ffcc00",
};

const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
};

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/* ==========================================================================
   DOM ELEMENTS & CANVASES
   ========================================================================== */
const stageEl = document.getElementById("stage");
const videoEl = document.getElementById("webcam");
const canvas = document.getElementById("sceneCanvas");
// alpha: false enables browser rendering optimization since mirrored video paints whole area
const ctx = canvas.getContext("2d", { alpha: false });

// Offscreen mirrored canvas to eliminate ctx.translate / scale(-1,1) per draw
const mirrorCanvas = document.createElement("canvas");
const mirrorCtx = mirrorCanvas.getContext("2d", { alpha: false });

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const loadingOverlay = document.getElementById("loadingOverlay");
const loaderText = document.getElementById("loaderText");
const loaderBarFill = document.getElementById("loaderBarFill");
const loaderRetry = document.getElementById("loaderRetry");
const errorBanner = document.getElementById("errorBanner");
const progressBadge = document.getElementById("progressBadge");
const progressText = document.getElementById("progressText");

const touchCaptureBtn = document.getElementById("touchCaptureBtn");
const solvedOverlay = document.getElementById("solvedOverlay");
const solvedSaveBtn = document.getElementById("solvedSaveBtn");
const solvedShuffleBtn = document.getElementById("solvedShuffleBtn");
const gestureToggleBtn = document.getElementById("gestureToggleBtn");
const gestureKey = document.getElementById("gestureKey");

const galleryStrip = document.getElementById("galleryStrip");
const galleryEmpty = document.getElementById("galleryEmpty");
const galleryCount = document.getElementById("galleryCount");
const downloadStripBtn = document.getElementById("downloadStripBtn");
const resetAllBtn = document.getElementById("resetAllBtn");
const stripCompleteMsg = document.getElementById("stripCompleteMsg");

// Debug Performance HUD
const debugOverlay = document.getElementById("debugOverlay");
const debugRenderFps = document.getElementById("debugRenderFps");
const debugVisionFps = document.getElementById("debugVisionFps");
const debugState = document.getElementById("debugState");
const debugLatency = document.getElementById("debugLatency");

const isDebug = new URLSearchParams(window.location.search).has("debug");
if (isDebug && debugOverlay) {
  debugOverlay.classList.remove("hidden");
}

/* ==========================================================================
   STATE
   ========================================================================== */
let appState = "tracking"; // 'tracking' | 'countdown' | 'puzzle' | 'shattering'

const puzzle = {
  boardBox: null,
  pieces: [],
  solved: false,
  tileW: 0,
  tileH: 0,
  fullBoothCanvas: null,
};

const countdown = {
  active: false,
  startedAt: 0,
};

const freezeGate = {
  holding: false,
  since: 0,
};

const lastSeenFrame = {
  box: null,
  at: 0,
};

const shatter = {
  active: false,
  startedAt: 0,
  fragments: [],
  sourceCanvas: null,
  pendingCanvas: null,
};

const galleryEntries = [];
let fistHoldCounter = 0;
let handLandmarker = null;

// Throttled detection state
let cachedLandmarks = [];
let lastDetectionTimestamp = 0;
const DETECTION_INTERVAL_MS = 1000 / CONFIG.DETECTION_FPS;

// Drag state for gesture pinch
const drag = {
  activeHand: null,
  piece: null,
  offsetX: 0,
  offsetY: 0,
};

// Pointer/touch drag state
let touchDragPiece = null;
let touchDragOffset = { x: 0, y: 0 };

/* ==========================================================================
   PERFORMANCE MONITORING
   ========================================================================== */
let renderFpsCount = 0;
let visionFpsCount = 0;
let lastFpsCalculation = performance.now();
let lastVisionLatency = 0;

function updateFpsMeter(now) {
  renderFpsCount++;
  if (now - lastFpsCalculation >= 1000) {
    const elapsed = now - lastFpsCalculation;
    const rFps = Math.round((renderFpsCount * 1000) / elapsed);
    const vFps = Math.round((visionFpsCount * 1000) / elapsed);
    renderFpsCount = 0;
    visionFpsCount = 0;
    lastFpsCalculation = now;

    if (isDebug && debugOverlay) {
      if (debugRenderFps) debugRenderFps.textContent = rFps;
      if (debugVisionFps) debugVisionFps.textContent = vFps;
      if (debugState) debugState.textContent = appState.toUpperCase();
      if (debugLatency) debugLatency.textContent = lastVisionLatency;
    }
  }
}

/* ==========================================================================
   PHOTO BOOTH FILTER (Applied strictly ONCE at capture time)
   ========================================================================== */
function gaussianNoise(std) {
  const u1 = Math.random() || 1e-6;
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * std;
}

function applyBoothEffect(imageData) {
  const d = imageData.data;
  const alpha = CONFIG.BOOTH_CONTRAST_ALPHA;
  const beta = CONFIG.BOOTH_BRIGHTNESS_BETA;
  const noiseStd = CONFIG.BOOTH_NOISE_STD;

  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let v = gray * alpha + beta + gaussianNoise(noiseStd);
    v = Math.max(0, Math.min(255, v));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return imageData;
}

/* ==========================================================================
   DATA VAULT & GALLERY
   ========================================================================== */
function addToGallery(snapshotCanvas) {
  if (galleryEntries.length >= CONFIG.STRIP_MAX_PHOTOS) return;

  galleryEntries.push({ canvas: snapshotCanvas, time: Date.now() });
  renderGalleryThumb(snapshotCanvas, galleryEntries.length);
  if (galleryCount) {
    galleryCount.textContent = `${galleryEntries.length} / ${CONFIG.STRIP_MAX_PHOTOS}`;
  }
  if (galleryEmpty) galleryEmpty.style.display = "none";

  if (galleryEntries.length >= CONFIG.STRIP_MAX_PHOTOS) {
    showStripComplete();
  }
  updateStripDownloadAvailability();
}

function isStripFull() {
  return galleryEntries.length >= CONFIG.STRIP_MAX_PHOTOS;
}

function showStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.add("visible");
  updateStripDownloadAvailability();
}

function hideStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.remove("visible");
}

function updateStripDownloadAvailability() {
  if (!downloadStripBtn) return;
  downloadStripBtn.disabled = galleryEntries.length === 0;
}

function downloadPhotoStrip() {
  if (galleryEntries.length === 0) return;

  const entries = galleryEntries;
  const targetW = entries[0].canvas.width;
  const scaledHeights = entries.map((entry) =>
    Math.round(entry.canvas.height * (targetW / entry.canvas.width))
  );

  const totalH =
    CONFIG.STRIP_FILE_BORDER * 2 +
    scaledHeights.reduce((sum, h) => sum + h, 0) +
    CONFIG.STRIP_FILE_GAP * (entries.length - 1);
  const totalW = targetW + CONFIG.STRIP_FILE_BORDER * 2;

  const stripCanvas = document.createElement("canvas");
  stripCanvas.width = totalW;
  stripCanvas.height = totalH;
  const stripCtx = stripCanvas.getContext("2d");

  stripCtx.fillStyle = CONFIG.STRIP_FILE_BG;
  stripCtx.fillRect(0, 0, totalW, totalH);

  let cursorY = CONFIG.STRIP_FILE_BORDER;
  entries.forEach((entry, i) => {
    const h = scaledHeights[i];
    stripCtx.drawImage(entry.canvas, CONFIG.STRIP_FILE_BORDER, cursorY, targetW, h);
    cursorY += h + CONFIG.STRIP_FILE_GAP;
  });

  stripCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `arkancam_strip_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

function renderGalleryThumb(snapshotCanvas, index) {
  const print = document.createElement("div");
  print.className = "print";

  const thumbCanvas = document.createElement("canvas");
  const THUMB_W = 180;
  const scale = THUMB_W / snapshotCanvas.width;
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = Math.round(snapshotCanvas.height * scale);
  thumbCanvas.getContext("2d").drawImage(snapshotCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);

  const label = document.createElement("div");
  label.className = "print-label";
  label.textContent = `#${String(index).padStart(2, "0")}`;

  print.appendChild(thumbCanvas);
  print.appendChild(label);
  galleryStrip.insertBefore(print, galleryStrip.firstChild);
}

function resetEverything() {
  galleryEntries.length = 0;
  galleryStrip.innerHTML = "";
  if (galleryCount) {
    galleryCount.textContent = `0 / ${CONFIG.STRIP_MAX_PHOTOS}`;
  }
  if (galleryEmpty) {
    galleryEmpty.style.display = "block";
    galleryStrip.appendChild(galleryEmpty);
  }
  hideStripComplete();
  updateStripDownloadAvailability();
  resetPuzzleOnly();
  if (statusText) statusText.textContent = "SYSTEM RESET COMPLETE";
}

function resetPuzzleOnly() {
  puzzle.boardBox = null;
  puzzle.pieces = [];
  puzzle.solved = false;
  puzzle.fullBoothCanvas = null;
  appState = "tracking";
  countdown.active = false;
  drag.activeHand = null;
  drag.piece = null;
  touchDragPiece = null;
  shatter.active = false;
  shatter.fragments = [];
  shatter.pendingCanvas = null;
  shatter.sourceCanvas = null;
  fistHoldCounter = 0;
  lastSeenFrame.box = null;
  lastSeenFrame.at = 0;
  updateProgressBadge();
  hideSolvedOverlay();
  updateTouchCaptureButton();
}

/* ==========================================================================
   CANVAS & VIEWPORT FIT
   ========================================================================== */
function fitCanvasToWindow() {
  if (!stageEl || !canvas.width || !canvas.height) return;
  const vw = stageEl.clientWidth;
  const vh = stageEl.clientHeight;
  const videoAspect = canvas.width / canvas.height;
  const containerAspect = vw / vh;

  let cssWidth, cssHeight;
  if (containerAspect > videoAspect) {
    cssWidth = vw;
    cssHeight = vw / videoAspect;
  } else {
    cssHeight = vh;
    cssWidth = vh * videoAspect;
  }

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

window.addEventListener("resize", fitCanvasToWindow);

/* ==========================================================================
   WEBCAM & MEDIAPIPE INITIALIZATION
   ========================================================================== */
async function initWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access is not supported by this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    },
    audio: false,
  });
  videoEl.srcObject = stream;

  await new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });

  canvas.width = videoEl.videoWidth || 1280;
  canvas.height = videoEl.videoHeight || 720;
  mirrorCanvas.width = canvas.width;
  mirrorCanvas.height = canvas.height;
  fitCanvasToWindow();
}

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function initHandLandmarker() {
  if (loaderText) loaderText.textContent = "CONNECTING TO VISION RUNTIME (WASM)...";
  if (loaderBarFill) loaderBarFill.style.width = "25%";

  const vision = await withTimeout(
    FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    ),
    CONFIG.LOAD_TIMEOUT_MS,
    "Timed out loading MediaPipe vision runtime (WASM). Check network connection."
  );

  if (loaderText) loaderText.textContent = "DOWNLOADING NEURAL HAND MODEL (~10MB)...";
  if (loaderBarFill) loaderBarFill.style.width = "65%";

  try {
    const handLandmarkerGpu = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "video",
        numHands: CONFIG.NUM_HANDS,
        minHandDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
        minHandPresenceConfidence: CONFIG.MIN_PRESENCE_CONFIDENCE,
        minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
      }),
      CONFIG.LOAD_TIMEOUT_MS,
      "Timed out downloading hand model on GPU."
    );
    if (loaderBarFill) loaderBarFill.style.width = "100%";
    return handLandmarkerGpu;
  } catch (gpuErr) {
    console.warn("[ArkanCam] GPU delegate failed, falling back to CPU...", gpuErr);
  }

  if (loaderText) loaderText.textContent = "INITIALIZING CPU RUNTIME FALLBACK...";
  const handLandmarkerCpu = await withTimeout(
    HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "CPU",
      },
      runningMode: "video",
      numHands: CONFIG.NUM_HANDS,
      minHandDetectionConfidence: CONFIG.MIN_DETECTION_CONFIDENCE,
      minHandPresenceConfidence: CONFIG.MIN_PRESENCE_CONFIDENCE,
      minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
    }),
    CONFIG.LOAD_TIMEOUT_MS,
    "Timed out initializing hand model on CPU."
  );

  if (loaderBarFill) loaderBarFill.style.width = "100%";
  return handLandmarkerCpu;
}

/* ==========================================================================
   FEEDBACK & HAPTICS
   ========================================================================== */
function triggerReadyFlash() {
  if (!stageEl) return;
  stageEl.classList.remove("ready-flash");
  void stageEl.offsetWidth; // force reflow
  stageEl.classList.add("ready-flash");
  setTimeout(() => {
    stageEl.classList.remove("ready-flash");
  }, 400);
}

function triggerSnapFeedback() {
  if (!stageEl) return;
  stageEl.classList.remove("snap-shake");
  void stageEl.offsetWidth; // force reflow
  stageEl.classList.add("snap-shake");

  if (typeof navigator.vibrate === "function") {
    try { navigator.vibrate(25); } catch (_) {}
  }

  setTimeout(() => {
    stageEl.classList.remove("snap-shake");
  }, 150);
}

/* ==========================================================================
   GEOMETRY & GESTURE UTILITIES
   ========================================================================== */
function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isPinching(landmarks) {
  return dist2D(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) < CONFIG.PINCH_THRESHOLD;
}

function isFist(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  let curled = 0;
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) < dist2D(landmarks[mcpIdx], wrist)) curled++;
  }
  return curled >= 4;
}

function toPixel(landmarkNorm) {
  return { x: landmarkNorm.x * canvas.width, y: landmarkNorm.y * canvas.height };
}

function mirrorLandmarkX(landmark) {
  return { x: 1 - landmark.x, y: landmark.y };
}

function computeHandFrame(indexTipA, indexTipB) {
  const a = toPixel(indexTipA);
  const b = toPixel(indexTipB);

  let minX = Math.min(a.x, b.x) - CONFIG.FRAME_PADDING;
  let maxX = Math.max(a.x, b.x) + CONFIG.FRAME_PADDING;
  let minY = Math.min(a.y, b.y) - CONFIG.FRAME_PADDING;
  let maxY = Math.max(a.y, b.y) + CONFIG.FRAME_PADDING;

  let width = maxX - minX;
  let height = maxY - minY;

  // Guarantee minimum dimension for comfortable touch targets
  if (width < CONFIG.MIN_BOARD_SIZE_PX) {
    const diff = (CONFIG.MIN_BOARD_SIZE_PX - width) / 2;
    minX -= diff;
    maxX += diff;
  }
  if (height < CONFIG.MIN_BOARD_SIZE_PX) {
    const diff = (CONFIG.MIN_BOARD_SIZE_PX - height) / 2;
    minY -= diff;
    maxY += diff;
  }

  const x = Math.max(0, minX);
  const y = Math.max(0, minY);
  const finalW = Math.min(canvas.width, maxX) - x;
  const finalH = Math.min(canvas.height, maxY) - y;

  return { x, y, width: finalW, height: finalH };
}

function createCenteredDefaultFrame() {
  const minDim = Math.min(canvas.width, canvas.height);
  const size = Math.max(CONFIG.MIN_BOARD_SIZE_PX, Math.round(minDim * 0.72));
  const x = Math.round((canvas.width - size) / 2);
  const y = Math.round((canvas.height - size) / 2);
  return { x, y, width: size, height: size };
}

/* ==========================================================================
   TOUCH & POINTER FALLBACK
   ========================================================================== */
function getCanvasPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

canvas.addEventListener("pointerdown", (e) => {
  if (appState !== "puzzle" || puzzle.solved) return;
  const pos = getCanvasPointerPos(e);
  const piece = findNearestPiece(pos.x, pos.y);
  if (piece) {
    touchDragPiece = piece;
    touchDragOffset.x = pos.x - piece.x;
    touchDragOffset.y = pos.y - piece.y;
    piece.dragging = true;
    piece.placed = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!touchDragPiece || appState !== "puzzle") return;
  const pos = getCanvasPointerPos(e);
  touchDragPiece.x = pos.x - touchDragOffset.x;
  touchDragPiece.y = pos.y - touchDragOffset.y;
});

function handlePieceDrop(piece) {
  if (!piece) return;
  piece.dragging = false;

  if (isNearOwnCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH)) {
    snapPieceToCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH);
    triggerSnapFeedback();
  } else {
    clampPieceToBoard(piece);
    const box = puzzle.boardBox;
    const cx = piece.x + piece.w / 2;
    const cy = piece.y + piece.h / 2;
    const dropCol = Math.min(
      CONFIG.GRID_SIZE - 1,
      Math.max(0, Math.floor((cx - box.x) / puzzle.tileW))
    );
    const dropRow = Math.min(
      CONFIG.GRID_SIZE - 1,
      Math.max(0, Math.floor((cy - box.y) / puzzle.tileH))
    );
    displaceCellOccupant(piece, dropRow, dropCol, box, puzzle.tileW, puzzle.tileH);
  }

  // Debounced check: ONLY check placed status on piece drop
  puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
  updateProgressBadge();

  if (puzzle.solved) {
    showSolvedOverlay();
  }
}

canvas.addEventListener("pointerup", (e) => {
  if (touchDragPiece) {
    const p = touchDragPiece;
    touchDragPiece = null;
    handlePieceDrop(p);
  }
});

canvas.addEventListener("pointercancel", () => {
  if (touchDragPiece) {
    const p = touchDragPiece;
    touchDragPiece = null;
    handlePieceDrop(p);
  }
});

// Touch capture button in tracking state
if (touchCaptureBtn) {
  touchCaptureBtn.addEventListener("click", () => {
    if (appState !== "tracking" || isStripFull()) return;
    const frameBox = (lastSeenFrame.box && (performance.now() - lastSeenFrame.at < 2000))
      ? lastSeenFrame.box
      : createCenteredDefaultFrame();
    startCountdown(frameBox);
  });
}

function updateTouchCaptureButton() {
  if (!touchCaptureBtn) return;
  if (appState === "tracking" && !isStripFull()) {
    touchCaptureBtn.classList.remove("hidden");
  } else {
    touchCaptureBtn.classList.add("hidden");
  }
}

// Gesture key toggle on mobile
if (gestureToggleBtn && gestureKey) {
  gestureToggleBtn.addEventListener("click", () => {
    gestureKey.classList.toggle("open");
  });
}

/* ==========================================================================
   SOLVED STATE OVERLAY (Interactive DOM modal)
   ========================================================================== */
function showSolvedOverlay() {
  if (solvedOverlay) solvedOverlay.classList.remove("hidden");
  if (statusText) statusText.textContent = "DECRYPTION COMPLETE — EXECUTE SAVE";
  if (statusDot) statusDot.className = "status-dot solved";
}

function hideSolvedOverlay() {
  if (solvedOverlay) solvedOverlay.classList.add("hidden");
}

if (solvedSaveBtn) {
  solvedSaveBtn.addEventListener("click", () => {
    handleFistReset();
  });
}

if (solvedShuffleBtn) {
  solvedShuffleBtn.addEventListener("click", () => {
    if (!puzzle.pieces || puzzle.pieces.length === 0) return;
    hideSolvedOverlay();
    shufflePiecesOnBoard();
  });
}

function shufflePiecesOnBoard() {
  const box = puzzle.boardBox;
  const tileW = puzzle.tileW;
  const tileH = puzzle.tileH;
  const slots = [];

  for (let row = 0; row < CONFIG.GRID_SIZE; row++) {
    for (let col = 0; col < CONFIG.GRID_SIZE; col++) {
      slots.push({ x: box.x + col * tileW, y: box.y + row * tileH });
    }
  }
  shuffle(slots);

  puzzle.pieces.forEach((piece, i) => {
    piece.x = slots[i].x;
    piece.y = slots[i].y;
    piece.placed = false;
    piece.dragging = false;
  });

  // Reconcile and snap initial matches if any
  puzzle.pieces.forEach((piece) => {
    if (isNearOwnCell(piece, box, tileW, tileH)) {
      snapPieceToCell(piece, box, tileW, tileH);
    }
  });

  puzzle.solved = reconcilePlacedState(box, tileW, tileH);
  updateProgressBadge();
}

/* ==========================================================================
   COUNTDOWN & CAPTURE
   ========================================================================== */
function startCountdown(frameBox) {
  puzzle.boardBox = { ...frameBox };
  appState = "countdown";
  countdown.active = true;
  countdown.startedAt = performance.now();
  updateTouchCaptureButton();
}

// 60FPS Smooth countdown drawing with circular progress ring
function drawCountdownOverlay(box) {
  const elapsed = (performance.now() - countdown.startedAt) / 1000;
  const remaining = Math.max(0, CONFIG.COUNTDOWN_SECONDS - elapsed);

  if (remaining <= 0) {
    finishCountdownAndCapture(box);
    return;
  }

  ctx.save();
  // Semi-transparent dark overlay (NO pixel reading/writing!)
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(box.x, box.y, box.width, box.height);

  // Outer target boundary
  ctx.strokeStyle = CONFIG.COLOR_PRIMARY;
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ringRadius = Math.min(box.width, box.height) * 0.25;
  const progressRatio = remaining / CONFIG.COUNTDOWN_SECONDS; // 1 -> 0

  // Circular background track
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(77, 255, 77, 0.2)";
  ctx.lineWidth = 6;
  ctx.stroke();

  // Circular animated progress arc
  ctx.beginPath();
  ctx.arc(
    cx,
    cy,
    ringRadius,
    -Math.PI / 2,
    -Math.PI / 2 + progressRatio * Math.PI * 2,
    false
  );
  ctx.strokeStyle = CONFIG.COLOR_PRIMARY;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.stroke();

  // Countdown number
  const n = Math.ceil(remaining);
  ctx.font = `bold ${Math.max(34, Math.round(ringRadius * 0.9))}px monospace`;
  ctx.fillStyle = CONFIG.COLOR_PRIMARY;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), cx, cy);

  ctx.restore();

  if (statusText) statusText.textContent = `CAPTURING SECTOR IN ${n}...`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function finishCountdownAndCapture(box) {
  countdown.active = false;

  // Use the pre-cached mirrored frame directly! Zero matrix transformations needed.
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(box.width));
  cropCanvas.height = Math.max(1, Math.round(box.height));
  const cropCtx = cropCanvas.getContext("2d");

  cropCtx.drawImage(
    mirrorCanvas,
    box.x, box.y, box.width, box.height,
    0, 0, cropCanvas.width, cropCanvas.height
  );

  // Apply booth contrast + grain strictly ONCE upon capture
  const fullImageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  applyBoothEffect(fullImageData);
  cropCtx.putImageData(fullImageData, 0, 0);

  puzzle.fullBoothCanvas = cropCanvas;

  const tileW = Math.floor(cropCanvas.width / CONFIG.GRID_SIZE);
  const tileH = Math.floor(cropCanvas.height / CONFIG.GRID_SIZE);
  const pieces = [];

  for (let row = 0; row < CONFIG.GRID_SIZE; row++) {
    for (let col = 0; col < CONFIG.GRID_SIZE; col++) {
      const sx = col * tileW;
      const sy = row * tileH;
      const w = col === CONFIG.GRID_SIZE - 1 ? cropCanvas.width - sx : tileW;
      const h = row === CONFIG.GRID_SIZE - 1 ? cropCanvas.height - sy : tileH;

      const pieceCanvas = document.createElement("canvas");
      pieceCanvas.width = w;
      pieceCanvas.height = h;
      pieceCanvas.getContext("2d").drawImage(cropCanvas, sx, sy, w, h, 0, 0, w, h);

      pieces.push({
        row, col,
        canvas: pieceCanvas,
        w, h,
        x: 0, y: 0,
        placed: false,
        dragging: false,
        displacing: false,
      });
    }
  }

  const slots = [];
  for (let row = 0; row < CONFIG.GRID_SIZE; row++) {
    for (let col = 0; col < CONFIG.GRID_SIZE; col++) {
      slots.push({ x: box.x + col * tileW, y: box.y + row * tileH });
    }
  }
  shuffle(slots);

  pieces.forEach((piece, i) => {
    piece.x = slots[i].x;
    piece.y = slots[i].y;
    if (isNearOwnCell(piece, box, tileW, tileH)) {
      snapPieceToCell(piece, box, tileW, tileH);
    }
  });

  puzzle.boardBox = box;
  puzzle.pieces = pieces;
  puzzle.tileW = tileW;
  puzzle.tileH = tileH;
  puzzle.solved = pieces.every((p) => p.placed);
  appState = "puzzle";
  fistHoldCounter = 0;
  updateProgressBadge();
  updateTouchCaptureButton();

  if (puzzle.solved) {
    showSolvedOverlay();
  }
}

/* ==========================================================================
   PUZZLE SNAP & DISPLACEMENT
   ========================================================================== */
function isNearOwnCell(piece, box, tileW, tileH) {
  const correctX = box.x + piece.col * tileW;
  const correctY = box.y + piece.row * tileH;
  const dx = piece.x - correctX;
  const dy = piece.y - correctY;
  const tolerance = Math.min(tileW, tileH) * CONFIG.SNAP_DISTANCE_RATIO;
  return Math.sqrt(dx * dx + dy * dy) < tolerance;
}

// Debounced: called only when pieces finish moving or snapping
function reconcilePlacedState(box, tileW, tileH) {
  if (!box || !puzzle.pieces.length) return false;
  for (const piece of puzzle.pieces) {
    if (piece.displacing || piece.dragging) continue;
    piece.placed = isNearOwnCell(piece, box, tileW, tileH);
  }
  return puzzle.pieces.every((p) => p.placed);
}

function snapPieceToCell(piece, box, tileW, tileH) {
  displaceCellOccupant(piece, piece.row, piece.col, box, tileW, tileH);
  piece.x = box.x + piece.col * tileW;
  piece.y = box.y + piece.row * tileH;
  piece.placed = true;
}

function displaceCellOccupant(piece, targetRow, targetCol, box, tileW, tileH) {
  const cellX = box.x + targetCol * tileW;
  const cellY = box.y + targetRow * tileH;

  const occupant = puzzle.pieces.find((p) => {
    if (p === piece || p.displacing) return false;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return (
      cx >= cellX && cx < cellX + tileW &&
      cy >= cellY && cy < cellY + tileH
    );
  });
  if (!occupant) return;

  if (occupant.row === targetRow && occupant.col === targetCol && occupant.placed) {
    return;
  }

  occupant.placed = false;

  const freeCells = [];
  for (let row = 0; row < CONFIG.GRID_SIZE; row++) {
    for (let col = 0; col < CONFIG.GRID_SIZE; col++) {
      if (row === targetRow && col === targetCol) continue;
      const cx0 = box.x + col * tileW;
      const cy0 = box.y + row * tileH;
      const taken = puzzle.pieces.some((p) => {
        if (p === occupant || p === piece || p.displacing) return false;
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        return cx >= cx0 && cx < cx0 + tileW && cy >= cy0 && cy < cy0 + tileH;
      });
      if (!taken) freeCells.push({ row, col });
    }
  }

  let targetSlot;
  if (freeCells.length > 0) {
    targetSlot = freeCells[Math.floor(Math.random() * freeCells.length)];
  } else {
    targetSlot = { row: occupant.row, col: occupant.col };
  }

  const jitterX = (Math.random() - 0.5) * tileW * 0.4;
  const jitterY = (Math.random() - 0.5) * tileH * 0.4;
  const targetX = box.x + targetSlot.col * tileW + jitterX;
  const targetY = box.y + targetSlot.row * tileH + jitterY;

  animateDisplacement(occupant, targetX, targetY, box);
}

function animateDisplacement(piece, targetX, targetY, box) {
  const startX = piece.x;
  const startY = piece.y;
  const startedAt = performance.now();

  piece.displacing = true;

  function step() {
    const t = Math.min(1, (performance.now() - startedAt) / CONFIG.DISPLACE_ANIM_MS);
    const eased = 1 - Math.pow(1 - t, 3);

    piece.x = startX + (targetX - startX) * eased;
    piece.y = startY + (targetY - startY) * eased;

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      piece.x = targetX;
      piece.y = targetY;
      piece.displacing = false;
      clampPieceToBoard(piece);
      // Reconcile once when displacement ends
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
      if (puzzle.solved) showSolvedOverlay();
    }
  }

  requestAnimationFrame(step);
}

function findNearestPiece(px, py) {
  let best = null;
  let bestDist = Infinity;
  for (const piece of puzzle.pieces) {
    if (piece.displacing) continue;
    const cx = piece.x + piece.w / 2;
    const cy = piece.y + piece.h / 2;
    const d = Math.hypot(px - cx, py - cy);
    if (d < Math.max(piece.w, piece.h) * 0.85 && d < bestDist) {
      best = piece;
      bestDist = d;
    }
  }
  return best;
}

function clampPieceToBoard(piece) {
  const box = puzzle.boardBox;
  if (!box) return;
  piece.x = Math.min(Math.max(piece.x, box.x), box.x + box.width - piece.w);
  piece.y = Math.min(Math.max(piece.y, box.y), box.y + box.height - piece.h);
}

function handleDragForHand(handLabel, pinching, indexPx) {
  if (pinching) {
    if (drag.activeHand === null) {
      const candidate = findNearestPiece(indexPx.x, indexPx.y);
      if (candidate) {
        drag.activeHand = handLabel;
        drag.piece = candidate;
        drag.offsetX = indexPx.x - candidate.x;
        drag.offsetY = indexPx.y - candidate.y;
        candidate.dragging = true;
        candidate.placed = false;
      }
    } else if (drag.activeHand === handLabel && drag.piece) {
      drag.piece.x = indexPx.x - drag.offsetX;
      drag.piece.y = indexPx.y - drag.offsetY;
    }
  } else {
    if (drag.activeHand === handLabel && drag.piece) {
      const piece = drag.piece;
      drag.activeHand = null;
      drag.piece = null;
      handlePieceDrop(piece);
    }
  }
}

/* ==========================================================================
   CANVAS RENDERING (Board, Pieces, Overlays)
   ========================================================================== */
function drawBoardAndPieces() {
  const box = puzzle.boardBox;
  if (!box) return;

  // Board background
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(box.x, box.y, box.width, box.height);

  // Dim grid lines
  ctx.strokeStyle = "rgba(77, 255, 77, 0.2)";
  ctx.lineWidth = 1;
  for (let i = 1; i < CONFIG.GRID_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(box.x + i * puzzle.tileW, box.y);
    ctx.lineTo(box.x + i * puzzle.tileW, box.y + box.height);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(box.x, box.y + i * puzzle.tileH);
    ctx.lineTo(box.x + box.width, box.y + i * puzzle.tileH);
    ctx.stroke();
  }
  ctx.restore();

  // Draw pieces (dragging pieces on top with glow)
  const sorted = [...puzzle.pieces].sort((a, b) => (a.dragging ? 1 : 0) - (b.dragging ? 1 : 0));

  for (const piece of sorted) {
    ctx.save();
    if (piece.dragging) {
      ctx.shadowColor = CONFIG.COLOR_PRIMARY;
      ctx.shadowBlur = 14;
    }
    ctx.drawImage(piece.canvas, piece.x, piece.y, piece.w, piece.h);
    ctx.strokeStyle = piece.placed ? CONFIG.COLOR_PRIMARY : "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = piece.dragging ? 3 : 1.5;
    ctx.strokeRect(piece.x, piece.y, piece.w, piece.h);
    ctx.restore();
  }

  // Board outline
  ctx.save();
  ctx.strokeStyle = puzzle.solved ? "#ffffff" : CONFIG.COLOR_PRIMARY;
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

function updateProgressBadge() {
  if (!progressBadge || !progressText) return;
  if (appState !== "puzzle") {
    progressBadge.classList.remove("visible", "solved");
    return;
  }
  const placedCount = puzzle.pieces.filter((p) => p.placed).length;
  progressText.textContent = `${placedCount} / ${puzzle.pieces.length} DECRYPTED`;
  progressBadge.classList.add("visible");
  progressBadge.classList.toggle("solved", puzzle.solved);
}

// Live frame targeting bracket overlay (NO pixel reading/writing!)
function drawLiveFrameOverlay(box) {
  ctx.save();
  // Semi-transparent dark overlay for high contrast
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(box.x, box.y, box.width, box.height);

  ctx.strokeStyle = CONFIG.COLOR_PRIMARY;
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // Tactical corner brackets
  const cornerLen = 20;
  ctx.lineWidth = 4;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.width, box.y, -1, 1],
    [box.x, box.y + box.height, 1, -1],
    [box.x + box.width, box.y + box.height, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + cornerLen * dy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + cornerLen * dx, cy);
    ctx.stroke();
  }
  ctx.restore();
}

function isPointInBoard(px, py, box) {
  if (!box) return false;
  return (
    px >= box.x &&
    px <= box.x + box.width &&
    py >= box.y &&
    py <= box.y + box.height
  );
}

function drawHandSkeleton(landmarksPx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(255,255,255,0.7)";
  ctx.shadowBlur = 8;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;

  for (const [iA, iB] of HAND_CONNECTIONS) {
    const a = landmarksPx[iA];
    const b = landmarksPx[iB];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.shadowBlur = 4;
  ctx.fillStyle = "#ffffff";
  for (const p of landmarksPx) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawHandSkeletonsOverBoard(handsLandmarks, box) {
  if (!box || !handsLandmarks || handsLandmarks.length === 0) return;

  for (const lm of handsLandmarks) {
    const landmarksPx = lm.map((pt) => toPixel(mirrorLandmarkX(pt)));
    const overBoard = landmarksPx.some((p) => isPointInBoard(p.x, p.y, box));
    if (overBoard) {
      drawHandSkeleton(landmarksPx);
    }
  }
}

/* ==========================================================================
   OPTIMIZED SHATTER EFFECT (4x4 = 16 fragments directly from source canvas)
   ========================================================================== */
function startShatter(sourceCanvas, box) {
  const cols = CONFIG.SHATTER_COLS;
  const rows = CONFIG.SHATTER_ROWS;
  const fragW = sourceCanvas.width / cols;
  const fragH = sourceCanvas.height / rows;
  const fragments = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = col * fragW;
      const sy = row * fragH;
      const cx = box.x + sx + fragW / 2;
      const cy = box.y + sy + fragH / 2;

      const boardCx = box.x + box.width / 2;
      const boardCy = box.y + box.height / 2;
      const dirX = cx - boardCx;
      const dirY = cy - boardCy;
      const dirLen = Math.max(1, Math.hypot(dirX, dirY));
      const speed = 100 + Math.random() * 150;

      fragments.push({
        sx, sy,
        sW: fragW,
        sH: fragH,
        x: cx,
        y: cy,
        w: fragW,
        h: fragH,
        vx: (dirX / dirLen) * speed + (Math.random() - 0.5) * 40,
        vy: (dirY / dirLen) * speed + (Math.random() - 0.5) * 40 - 50,
        rotation: 0,
        rotationSpeed: (Math.random() - 0.5) * 5,
        gravity: 240 + Math.random() * 60,
      });
    }
  }

  shatter.sourceCanvas = sourceCanvas;
  shatter.fragments = fragments;
  shatter.active = true;
  shatter.startedAt = performance.now();
  appState = "shattering";
  hideSolvedOverlay();
}

function updateAndDrawShatter() {
  const elapsedMs = performance.now() - shatter.startedAt;
  const t = Math.min(1, elapsedMs / CONFIG.SHATTER_DURATION_MS);

  if (t >= 1) {
    finishShatter();
    return;
  }

  const dt = 1 / 60;
  const fadeStart = 0.45;
  const source = shatter.sourceCanvas;

  ctx.save();
  for (const frag of shatter.fragments) {
    frag.x += frag.vx * dt;
    frag.y += frag.vy * dt;
    frag.vy += frag.gravity * dt;
    frag.rotation += frag.rotationSpeed * dt;

    const alpha = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (1 - fadeStart));
    const scale = 1 - t * 0.22;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(frag.x, frag.y);
    ctx.rotate(frag.rotation);
    ctx.scale(scale, scale);

    // Draw directly from the single source canvas (Zero extra canvas allocations!)
    if (source) {
      ctx.drawImage(
        source,
        frag.sx, frag.sy, frag.sW, frag.sH,
        -frag.w / 2, -frag.h / 2, frag.w, frag.h
      );
    }
    ctx.restore();
  }
  ctx.restore();
}

function finishShatter() {
  shatter.active = false;
  shatter.fragments = [];
  shatter.sourceCanvas = null;
  if (shatter.pendingCanvas) {
    addToGallery(shatter.pendingCanvas);
    if (statusText) statusText.textContent = "IMAGE ARCHIVED TO DATA VAULT";
    shatter.pendingCanvas = null;
  }
  resetPuzzleOnly();
}

function handleFistReset() {
  if (appState !== "puzzle") {
    if (statusText) statusText.textContent = "OPTICS RESET";
    resetPuzzleOnly();
    return;
  }

  const reallySolved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
  puzzle.solved = reallySolved;

  if (reallySolved && puzzle.fullBoothCanvas) {
    shatter.pendingCanvas = puzzle.fullBoothCanvas;
    startShatter(puzzle.fullBoothCanvas, puzzle.boardBox);
  } else {
    if (statusText) statusText.textContent = "SECTOR RESET";
    resetPuzzleOnly();
  }
}

/* ==========================================================================
   GAME STATE CONTROLLER (Called every 60FPS draw tick)
   ========================================================================== */
function processGameState(handsLandmarks) {
  if (appState === "shattering") {
    updateAndDrawShatter();
    if (statusText) statusText.textContent = "ENCRYPTING & ARCHIVING...";
    return;
  }

  const noHands = !handsLandmarks || handsLandmarks.length === 0;

  if (noHands) {
    if (statusDot) {
      statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot";
    }
    fistHoldCounter = 0;
    freezeGate.holding = false;

    if (drag.activeHand && drag.piece) {
      handlePieceDrop(drag.piece);
      drag.activeHand = null;
      drag.piece = null;
    }

    if (appState === "tracking") {
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < CONFIG.FRAME_GRACE_MS) {
        drawLiveFrameOverlay(lastSeenFrame.box);
      }
      if (statusText) {
        statusText.textContent = isStripFull()
          ? "VAULT FULL — DOWNLOAD OR PURGE DATA"
          : "AWAITING HAND GESTURES / TAP TO CAPTURE";
      }
      return;
    }

    if (appState === "countdown") {
      drawCountdownOverlay(puzzle.boardBox);
      return;
    }

    if (appState === "puzzle") {
      drawBoardAndPieces();
      if (statusText) {
        statusText.textContent = puzzle.solved
          ? "PUZZLE SOLVED — HOLD FIST OR TAP SAVE"
          : "SOLVE PUZZLE (PINCH OR TOUCH DRAG)";
      }
      return;
    }

    return;
  }

  if (statusDot) {
    statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot live";
  }

  // Fist gesture detection (save/purge)
  const anyFist = handsLandmarks.some((lm) => isFist(lm));
  const draggingNow = (drag.activeHand !== null && drag.piece !== null) || touchDragPiece !== null;

  if (anyFist && !draggingNow && appState !== "tracking") {
    fistHoldCounter++;
    if (fistHoldCounter >= CONFIG.FIST_HOLD_FRAMES) {
      fistHoldCounter = 0;
      handleFistReset();
      return;
    }
  } else {
    fistHoldCounter = 0;
  }

  // State: Tracking
  if (appState === "tracking") {
    if (isStripFull()) {
      if (statusText) statusText.textContent = "VAULT FULL — DOWNLOAD OR PURGE DATA";
      return;
    }

    if (handsLandmarks.length === 2) {
      const [handA, handB] = handsLandmarks;
      const indexA = mirrorLandmarkX(handA[LM.INDEX_TIP]);
      const indexB = mirrorLandmarkX(handB[LM.INDEX_TIP]);
      const frameBox = computeHandFrame(indexA, indexB);

      if (frameBox.width > 20 && frameBox.height > 20) {
        drawLiveFrameOverlay(frameBox);
        lastSeenFrame.box = frameBox;
        lastSeenFrame.at = performance.now();
      }

      const bothPinching = isPinching(handA) && isPinching(handB);
      if (bothPinching && frameBox.width > 40 && frameBox.height > 40) {
        if (!freezeGate.holding) {
          freezeGate.holding = true;
          freezeGate.since = performance.now();
        }
        if (statusDot) statusDot.className = "status-dot armed";
        if (statusText) statusText.textContent = "HOLD PINCH TO LOCK TARGET...";

        if (performance.now() - freezeGate.since > CONFIG.FREEZE_HOLD_MS) {
          freezeGate.holding = false;
          startCountdown(frameBox);
        }
      } else {
        freezeGate.holding = false;
        if (statusText) statusText.textContent = "TARGETING OPTICS ONLINE";
      }
    } else {
      freezeGate.holding = false;
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < CONFIG.FRAME_GRACE_MS) {
        drawLiveFrameOverlay(lastSeenFrame.box);
      }
      if (statusText) statusText.textContent = "TRACKING SENSORS ACTIVE";
    }
    return;
  }

  // State: Countdown
  if (appState === "countdown") {
    drawCountdownOverlay(puzzle.boardBox);
    return;
  }

  // State: Puzzle
  if (appState === "puzzle") {
    const labelsPresent = new Set();
    handsLandmarks.forEach((lm, i) => {
      const label = i === 0 ? "A" : "B";
      labelsPresent.add(label);
      const pinching = isPinching(lm);
      const indexPx = toPixel(mirrorLandmarkX(lm[LM.INDEX_TIP]));
      handleDragForHand(label, pinching, indexPx);
    });

    if (drag.activeHand && !labelsPresent.has(drag.activeHand) && drag.piece) {
      handlePieceDrop(drag.piece);
      drag.activeHand = null;
      drag.piece = null;
    }

    drawBoardAndPieces();
    drawHandSkeletonsOverBoard(handsLandmarks, puzzle.boardBox);

    if (statusText) {
      if (puzzle.solved) {
        statusText.textContent = fistHoldCounter > 0
          ? `SAVING DATA... HOLD FIST (${fistHoldCounter}/${CONFIG.FIST_HOLD_FRAMES})`
          : "PUZZLE SOLVED — HOLD FIST OR TAP SAVE";
      } else {
        statusText.textContent = "SOLVE PUZZLE (PINCH OR TOUCH DRAG)";
      }
    }
  }
}

/* ==========================================================================
   MAIN DUAL-TICK RENDER LOOP
   ========================================================================== */
function renderLoop(timestamp) {
  const now = performance.now();
  updateFpsMeter(now);

  if (videoEl.readyState >= 2) {
    // 1. Update mirror cache & draw video frame directly at 60FPS
    mirrorCtx.save();
    mirrorCtx.translate(mirrorCanvas.width, 0);
    mirrorCtx.scale(-1, 1);
    mirrorCtx.drawImage(videoEl, 0, 0, mirrorCanvas.width, mirrorCanvas.height);
    mirrorCtx.restore();

    ctx.drawImage(mirrorCanvas, 0, 0);

    // 2. Throttle MediaPipe hand detection to ~24FPS
    if (handLandmarker && (now - lastDetectionTimestamp >= DETECTION_INTERVAL_MS)) {
      lastDetectionTimestamp = now;
      visionFpsCount++;
      const vStart = performance.now();
      try {
        const result = handLandmarker.detectForVideo(videoEl, now);
        cachedLandmarks = result?.landmarks || [];
        lastVisionLatency = Math.round(performance.now() - vStart);
      } catch (err) {
        console.warn("[ArkanCam] HandLandmarker detection error:", err);
      }
    }

    // 3. Process game logic & animations at 60FPS using cached landmarks
    processGameState(cachedLandmarks);
  }

  requestAnimationFrame(renderLoop);
}

/* ==========================================================================
   BOOT & INITIALIZATION
   ========================================================================== */
function showError(message) {
  if (errorBanner) {
    errorBanner.textContent = message;
    errorBanner.style.display = "block";
  }
}

function showLoaderError(message) {
  if (loaderText) {
    loaderText.textContent = message;
    loaderText.style.color = "#ef6461";
  }
  if (loaderRetry) loaderRetry.classList.remove("hidden");
}

function resetLoaderUI() {
  if (loadingOverlay) loadingOverlay.classList.remove("hidden");
  if (loaderText) {
    loaderText.style.color = "";
    loaderText.textContent = "INITIALIZING SYSTEM HARDWARE...";
  }
  if (loaderBarFill) loaderBarFill.style.width = "10%";
  if (loaderRetry) loaderRetry.classList.add("hidden");
  if (errorBanner) errorBanner.style.display = "none";
}

async function boot() {
  resetLoaderUI();

  let settled = false;
  const watchdogMs = CONFIG.LOAD_TIMEOUT_MS * 2 + 5000;
  const watchdog = setTimeout(() => {
    if (!settled) {
      showLoaderError("Hardware initialization timed out. Hit retry or check internet.");
    }
  }, watchdogMs);

  try {
    if (!videoEl.srcObject) {
      if (loaderText) loaderText.textContent = "CONNECTING OPTICAL WEBCAM SENSORS...";
      await initWebcam();
    }

    handLandmarker = await initHandLandmarker();

    settled = true;
    clearTimeout(watchdog);

    if (loadingOverlay) loadingOverlay.classList.add("hidden");
    if (statusText) statusText.textContent = "SYS.OPTICS ONLINE";
    triggerReadyFlash();
    updateTouchCaptureButton();

    requestAnimationFrame(renderLoop);
  } catch (err) {
    settled = true;
    clearTimeout(watchdog);
    if (err && err.name === "NotAllowedError") {
      showLoaderError("Camera permission denied. Allow camera access and hit retry.");
    } else if (err && err.name === "NotFoundError") {
      showLoaderError("No camera device detected.");
    } else {
      showLoaderError((err && err.message) || "Error initializing ArkanCam.");
    }
  }
}

if (loaderRetry) {
  loaderRetry.addEventListener("click", () => {
    boot();
  });
}

if (downloadStripBtn) {
  downloadStripBtn.addEventListener("click", downloadPhotoStrip);
  updateStripDownloadAvailability();
}

if (resetAllBtn) {
  resetAllBtn.addEventListener("click", () => {
    const confirmed = window.confirm("Purge entire photo vault and restart?");
    if (confirmed) resetEverything();
  });
}

boot();
