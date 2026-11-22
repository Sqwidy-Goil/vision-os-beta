/* global Hands, Camera, drawConnectors, drawLandmarks, HAND_CONNECTIONS */

(() => {
  'use strict';

  const status = document.querySelector('#status');
  const statusDot = document.querySelector('.status-dot');
  const hint = document.querySelector('#gesture-hint');
  const cameraButton = document.querySelector('#camera-button');
  const uploadButton = document.querySelector('#upload-button');
  const fileInput = document.querySelector('#video-file');
  const cameraVideo = document.querySelector('#input-video');
  const handCanvas = document.querySelector('#hand-canvas');
  const handContext = handCanvas.getContext('2d');
  const screen = document.querySelector('#ar-screen');
  const screenBar = document.querySelector('#screen-bar');
  const resizeHandle = document.querySelector('#resize-handle');
  const closeScreen = document.querySelector('#close-screen');
  const uploadedVideo = document.querySelector('#uploaded-video');
  const emptyVideo = document.querySelector('#empty-video');
  const screenName = document.querySelector('#screen-name');
  const cursor = document.querySelector('#hand-cursor');
  const minSize = { width: 220, height: 160 };
  let objectUrl = null;
  let isPinching = false;
  let interaction = null;
  let twoHandResize = null;
  let screenState = { x: 0, y: 0, width: 0, height: 0 };

  function setStatus(message, mode = 'ready') {
    status.textContent = message;
    statusDot.className = `status-dot ${mode}`;
  }

  function setHint(message) { hint.textContent = message; }

  function clamp(value, low, high) { return Math.min(Math.max(value, low), high); }

  function initialiseScreen() {
    const width = Math.min(520, innerWidth * (innerWidth < 600 ? 0.78 : 0.62));
    const height = width * 0.64;
    screenState = { x: (innerWidth - width) / 2, y: (innerHeight - height) / 2, width, height };
    applyScreen();
  }

  function applyScreen() {
    const maxX = Math.max(0, innerWidth - screenState.width);
    const maxY = Math.max(0, innerHeight - screenState.height);
    screenState.x = clamp(screenState.x, 0, maxX);
    screenState.y = clamp(screenState.y, 0, maxY);
    screen.style.left = `${screenState.x}px`;
    screen.style.top = `${screenState.y}px`;
    screen.style.width = `${screenState.width}px`;
    screen.style.height = `${screenState.height}px`;
  }

  function showScreen() {
    if (screen.hidden) {
      screen.hidden = false;
      initialiseScreen();
    }
  }

  function bounds() {
    return { left: screenState.x, top: screenState.y, right: screenState.x + screenState.width, bottom: screenState.y + screenState.height };
  }

  function pointInScreen(point) {
    const box = bounds();
    return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  }

  function pointOnResizeHandle(point) {
    const box = bounds();
    return point.x >= box.right - 58 && point.x <= box.right + 12 && point.y >= box.bottom - 58 && point.y <= box.bottom + 12;
  }

  function beginInteraction(point, mode, source) {
    if (screen.hidden) return false;
    if (mode === 'resize') {
      interaction = { mode, source, startX: point.x, startY: point.y, width: screenState.width, height: screenState.height };
      setHint('Pincement actif : éloignez votre main pour agrandir la fenêtre.');
    } else {
      interaction = { mode: 'move', source, offsetX: point.x - screenState.x, offsetY: point.y - screenState.y };
      setHint('Pincement actif : déplacez la main pour poser l’écran.');
    }
    screen.classList.add('grabbed');
    return true;
  }

  function updateInteraction(point, source) {
    if (!interaction || interaction.source !== source) return;
    if (interaction.mode === 'move') {
      screenState.x = point.x - interaction.offsetX;
      screenState.y = point.y - interaction.offsetY;
    } else {
      screenState.width = clamp(interaction.width + point.x - interaction.startX, minSize.width, innerWidth * 0.94);
      screenState.height = clamp(interaction.height + point.y - interaction.startY, minSize.height, innerHeight * 0.82);
    }
    applyScreen();
  }

  function endInteraction(source) {
    if (!interaction || interaction.source !== source) return;
    interaction = null;
    screen.classList.remove('grabbed');
    setHint('Écran posé pour cette session. Pincez la barre pour le déplacer, ou le coin pour le redimensionner.');
  }

  function resizeFromTwoHands(first, second) {
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    if (!twoHandResize) {
      if (screen.hidden || !pointInScreen(first)) return;
      twoHandResize = { distance: Math.max(distance, 1), width: screenState.width, height: screenState.height };
      screen.classList.add('grabbed');
      setHint('Deux pincements actifs : écartez ou rapprochez les mains pour redimensionner.');
      return;
    }
    const scale = clamp(distance / twoHandResize.distance, 0.5, 2.4);
    screenState.width = clamp(twoHandResize.width * scale, minSize.width, innerWidth * 0.94);
    screenState.height = clamp(twoHandResize.height * scale, minSize.height, innerHeight * 0.82);
    applyScreen();
  }

  function endTwoHandResize() {
    if (!twoHandResize) return;
    twoHandResize = null;
    screen.classList.remove('grabbed');
    setHint('Écran redimensionné. Un pincement sur la barre permet de le déplacer.');
  }

  function openFilePicker() { fileInput.click(); }

  function loadVideo(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    uploadedVideo.src = objectUrl;
    uploadedVideo.load();
    uploadedVideo.play().catch(() => {});
    emptyVideo.hidden = true;
    screenName.textContent = file.name;
    showScreen();
    setStatus('Vidéo ouverte dans l’écran spatial', 'active');
    setHint('Pincez la barre supérieure pour déplacer l’écran, ou le coin inférieur droit pour le redimensionner.');
    event.target.value = '';
  }

  // Souris et tactile : alternative pratique pour tester sans caméra.
  function pointerPosition(event) { return { x: event.clientX, y: event.clientY }; }
  function startPointerMove(event) { event.preventDefault(); beginInteraction(pointerPosition(event), 'move', 'pointer'); screen.setPointerCapture(event.pointerId); }
  function startPointerResize(event) { event.preventDefault(); event.stopPropagation(); beginInteraction(pointerPosition(event), 'resize', 'pointer'); screen.setPointerCapture(event.pointerId); }
  function movePointer(event) { updateInteraction(pointerPosition(event), 'pointer'); }
  function endPointer() { endInteraction('pointer'); }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }
  function fingerExtended(landmarks, tip, pip) { return distance(landmarks[tip], landmarks[0]) > distance(landmarks[pip], landmarks[0]) * 1.16; }
  function handData(landmarks) {
    const point = { x: landmarks[8].x * innerWidth, y: landmarks[8].y * innerHeight };
    return {
      point,
      pinch: distance(landmarks[4], landmarks[8]) < 0.055,
      indexOpen: fingerExtended(landmarks, 8, 6)
    };
  }

  function showCursor(point, pinching) {
    cursor.style.left = `${point.x}px`;
    cursor.style.top = `${point.y}px`;
    cursor.classList.add('visible');
    cursor.classList.toggle('pinching', pinching);
  }

  // Affiche les landmarks MediaPipe et pilote l’écran avec les pincements.
  function onResults(results) {
    handContext.clearRect(0, 0, handCanvas.width, handCanvas.height);
    const landmarksList = results.multiHandLandmarks || [];
    landmarksList.forEach(landmarks => {
      drawConnectors(handContext, landmarks, HAND_CONNECTIONS, { color: '#45ddff', lineWidth: 3 });
      drawLandmarks(handContext, landmarks, { color: '#6affaa', lineWidth: 1, radius: 4 });
    });
    if (!landmarksList.length) {
      cursor.classList.remove('visible');
      if (isPinching) endInteraction('hand');
      isPinching = false;
      endTwoHandResize();
      setStatus('Caméra active — main non détectée', 'ready');
      return;
    }
    const hands = landmarksList.map(handData);
    const primary = hands[0];
    showCursor(primary.point, primary.pinch);
    const doublePinch = hands.length > 1 && hands[0].pinch && hands[1].pinch;
    if (doublePinch) {
      if (interaction) endInteraction('hand');
      resizeFromTwoHands(hands[0].point, hands[1].point);
      return;
    }
    endTwoHandResize();
    if (primary.pinch) {
      if (!isPinching) {
        if (pointOnResizeHandle(primary.point)) beginInteraction(primary.point, 'resize', 'hand');
        else if (pointInScreen(primary.point)) beginInteraction(primary.point, 'move', 'hand');
      }
      updateInteraction(primary.point, 'hand');
      isPinching = true;
    } else {
      if (isPinching) endInteraction('hand');
      isPinching = false;
      if (primary.indexOpen) setStatus('Index détecté — pincez l’écran pour le saisir', 'active');
      else setStatus('Main détectée — rapprochez pouce et index pour pincer', 'active');
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('Caméra indisponible dans ce navigateur', ''); return; }
    cameraButton.disabled = true;
    cameraButton.textContent = 'Connexion…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      cameraVideo.srcObject = stream;
      await cameraVideo.play();
      const hands = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
      hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.5 });
      hands.onResults(onResults);
      new Camera(cameraVideo, { onFrame: async () => hands.send({ image: cameraVideo }), width: 1280, height: 720 }).start();
      cameraButton.textContent = 'Caméra active';
      uploadButton.disabled = false;
      setStatus('Caméra active — importez une vidéo', 'active');
      setHint('Ajoutez une vidéo. Son écran restera posé pendant cette session de test.');
    } catch (error) {
      cameraButton.disabled = false;
      cameraButton.textContent = 'Réessayer la caméra';
      setStatus('Autorisation caméra refusée ou indisponible', '');
      setHint('La caméra nécessite HTTPS (ou localhost) et votre autorisation.');
    }
  }

  function onResize() {
    handCanvas.width = Math.max(1, innerWidth * Math.min(devicePixelRatio, 2));
    handCanvas.height = Math.max(1, innerHeight * Math.min(devicePixelRatio, 2));
    if (!screen.hidden) applyScreen();
  }

  cameraButton.addEventListener('click', startCamera);
  uploadButton.addEventListener('click', openFilePicker);
  fileInput.addEventListener('change', loadVideo);
  closeScreen.addEventListener('click', () => { screen.hidden = true; uploadedVideo.pause(); setStatus('Écran vidéo fermé', 'ready'); });
  screenBar.addEventListener('pointerdown', startPointerMove);
  resizeHandle.addEventListener('pointerdown', startPointerResize);
  screen.addEventListener('pointermove', movePointer);
  screen.addEventListener('pointerup', endPointer);
  screen.addEventListener('pointercancel', endPointer);
  addEventListener('resize', onResize);
  onResize();
})();
