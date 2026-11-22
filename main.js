/* global Hands, Camera, drawConnectors, drawLandmarks, HAND_CONNECTIONS */

(() => {
  'use strict';

  const status = document.querySelector('#status');
  const statusDot = document.querySelector('.status-dot');
  const hint = document.querySelector('#gesture-hint');
  const cameraButton = document.querySelector('#camera-button');
  const motionButton = document.querySelector('#motion-button');
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
  const anchorLabel = document.querySelector('#anchor-label');
  const cursor = document.querySelector('#hand-cursor');
  const minSize = { width: 220, height: 160 };
  let objectUrl = null;
  let isPinching = false;
  let interaction = null;
  let twoHandResize = null;
  let screenState = { x: 0, y: 0, width: 0, height: 0 };
  let motionEnabled = false;
  let latestOrientation = null;
  let orientationAnchor = null;

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
    placeOrientationAnchor();
  }

  function applyScreen() {
    // Lorsqu'il est ancré, le panneau peut partiellement sortir du champ :
    // c'est ce qui lui permet de réapparaître au même cap après une rotation.
    const margin = orientationAnchor && !interaction && !twoHandResize ? 56 : 0;
    const minX = orientationAnchor && !interaction && !twoHandResize ? -screenState.width + margin : 0;
    const minY = orientationAnchor && !interaction && !twoHandResize ? -screenState.height + margin : 0;
    const maxX = orientationAnchor && !interaction && !twoHandResize ? innerWidth - margin : Math.max(0, innerWidth - screenState.width);
    const maxY = orientationAnchor && !interaction && !twoHandResize ? innerHeight - margin : Math.max(0, innerHeight - screenState.height);
    screenState.x = clamp(screenState.x, minX, maxX);
    screenState.y = clamp(screenState.y, minY, maxY);
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
    orientationAnchor = null;
    anchorLabel.textContent = 'MANIPULATION';
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
    placeOrientationAnchor();
    setHint('Écran posé pour cette session. Pincez la barre pour le déplacer, ou le coin pour le redimensionner.');
  }

  function resizeFromTwoHands(first, second) {
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    if (!twoHandResize) {
      if (screen.hidden || !pointInScreen(first)) return;
      orientationAnchor = null;
      anchorLabel.textContent = 'REDIMENSIONNEMENT';
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
    placeOrientationAnchor();
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

  // L'environnement est le bon choix pour un effet de passthrough : pas de miroir selfie.
  async function requestRearCamera() {
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { exact: 'environment' } }, audio: false });
    } catch (error) {
      // Certains navigateurs nomment la caméra sans exposer facingMode. On tente alors
      // uniquement un périphérique explicitement identifié comme caméra arrière.
      if (!['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const rear = devices.find(device => device.kind === 'videoinput' && /back|rear|environment|arrière|arriere/i.test(device.label));
      if (!rear) throw new Error('rear-camera-unavailable');
      return navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: rear.deviceId } }, audio: false });
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('Caméra indisponible dans ce navigateur', ''); return; }
    cameraButton.disabled = true;
    cameraButton.textContent = 'Connexion…';
    try {
      const stream = await requestRearCamera();
      cameraVideo.srcObject = stream;
      await cameraVideo.play();
      const hands = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
      hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.5 });
      hands.onResults(onResults);
      new Camera(cameraVideo, { onFrame: async () => hands.send({ image: cameraVideo }), width: 1280, height: 720 }).start();
      cameraButton.textContent = 'Caméra active';
      motionButton.disabled = false;
      uploadButton.disabled = false;
      setStatus('Caméra arrière active — importez une vidéo', 'active');
      setHint('Ajoutez une vidéo. La main et son curseur passent devant l’écran virtuel.');
    } catch (error) {
      cameraButton.disabled = false;
      cameraButton.textContent = 'Réessayer la caméra';
      setStatus(error.message === 'rear-camera-unavailable' ? 'Caméra arrière introuvable' : 'Autorisation caméra refusée ou indisponible', '');
      setHint('Une caméra arrière nécessite HTTPS (ou localhost) et votre autorisation.');
    }
  }

  function onResize() {
    handCanvas.width = Math.max(1, innerWidth * Math.min(devicePixelRatio, 2));
    handCanvas.height = Math.max(1, innerHeight * Math.min(devicePixelRatio, 2));
    if (!screen.hidden) applyScreen();
  }

  function angleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
  }

  function placeOrientationAnchor() {
    if (!motionEnabled || !latestOrientation || screen.hidden) return;
    orientationAnchor = {
      heading: latestOrientation.heading,
      pitch: latestOrientation.pitch,
      x: screenState.x,
      y: screenState.y
    };
    anchorLabel.textContent = 'ANCRAGE ORIENTATION';
  }

  function updateOrientationAnchor() {
    if (!orientationAnchor || !latestOrientation || interaction || twoHandResize || screen.hidden) return;
    // Le panneau se déplace dans le sens opposé au téléphone : quand vous revenez
    // au même cap, il revient au même point du décor caméra.
    const horizontal = angleDelta(latestOrientation.heading, orientationAnchor.heading);
    const vertical = orientationAnchor.pitch - latestOrientation.pitch;
    screenState.x = orientationAnchor.x + horizontal * 11;
    screenState.y = orientationAnchor.y + vertical * 9;
    applyScreen();
  }

  async function enableMotionAnchor() {
    if (!window.DeviceOrientationEvent) {
      setStatus('Capteurs de mouvement indisponibles', '');
      return;
    }
    try {
      if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await window.DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') throw new Error('motion-permission-denied');
      }
      motionEnabled = true;
      motionButton.classList.add('active');
      motionButton.textContent = '⌖ Réancrer';
      setStatus('Ancrage d’orientation actif', 'active');
      setHint('Visez l’endroit choisi, puis touchez « Réancrer ». L’écran suivra votre rotation et reviendra au même cap.');
      placeOrientationAnchor();
    } catch (error) {
      setStatus('Mouvement non autorisé', '');
      setHint('Sur iPhone, acceptez l’accès aux mouvements pour activer l’ancrage d’orientation.');
    }
  }

  // Le navigateur fournit une orientation, pas une position 3D. Cela donne un
  // ancrage directionnel (rotation), utile pour ce prototype Web sur iPhone.
  function onDeviceOrientation(event) {
    const heading = Number.isFinite(event.webkitCompassHeading) ? event.webkitCompassHeading : event.alpha;
    if (!Number.isFinite(heading) || !Number.isFinite(event.beta)) return;
    latestOrientation = { heading: (heading + 360) % 360, pitch: event.beta };
    const yaw = clamp((event.gamma || 0) * 0.13 - 3, -8, 2);
    const pitch = clamp(1 - (event.beta || 0) * 0.06, -4, 6);
    screen.style.setProperty('--yaw', `${yaw}deg`);
    screen.style.setProperty('--pitch', `${pitch}deg`);
    updateOrientationAnchor();
  }

  cameraButton.addEventListener('click', startCamera);
  motionButton.addEventListener('click', enableMotionAnchor);
  uploadButton.addEventListener('click', openFilePicker);
  fileInput.addEventListener('change', loadVideo);
  closeScreen.addEventListener('click', () => { screen.hidden = true; uploadedVideo.pause(); setStatus('Écran vidéo fermé', 'ready'); });
  screenBar.addEventListener('pointerdown', startPointerMove);
  resizeHandle.addEventListener('pointerdown', startPointerResize);
  screen.addEventListener('pointermove', movePointer);
  screen.addEventListener('pointerup', endPointer);
  screen.addEventListener('pointercancel', endPointer);
  addEventListener('resize', onResize);
  addEventListener('deviceorientation', onDeviceOrientation, true);
  onResize();
})();
