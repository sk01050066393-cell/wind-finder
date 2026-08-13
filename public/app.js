import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { GoogleAuthProvider, getAuth, signInAnonymously, signInWithPopup } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDYIg6PNDKxEMGXrVbooo_PhmflrkU1WJ4",
  authDomain: "wind-finder-2a53c.firebaseapp.com",
  projectId: "wind-finder-2a53c",
  storageBucket: "wind-finder-2a53c.firebasestorage.app",
  messagingSenderId: "382244128208",
  appId: "1:382244128208:web:df91c5ebecf4a4355e25d5",
};

const HAEUNDAE = { lat: 35.1601, lng: 129.1605 };
const ADMIN_EMAIL = "ojing-o09@naver.com";
const FALLBACK_ZONES = [
  { id: "marine-city", name: "마린시티 고층건물군", type: "circle", center: [129.1431, 35.1554], radius: 115, risk: 84 },
  { id: "haeundae-beach", name: "해운대 해변 진입부", type: "circle", center: [129.1605, 35.1592], radius: 90, risk: 72 },
  { id: "lct", name: "엘시티 주변", type: "circle", center: [129.1708, 35.1606], radius: 125, risk: 89 },
  { id: "centum", name: "센텀 고층건물군", type: "circle", center: [129.1294, 35.1691], radius: 105, risk: 66 },
];

const state = {
  map: null,
  geocoder: null,
  riskZones: [],
  riskOverlays: [],
  routePolyline: null,
  reportMarker: null,
  currentLocationMarker: null,
  currentLocationOverlay: null,
  reportPosition: null,
  reportClusterer: null,
  reportMarkers: [],
  forecastChart: null,
  forecast: [],
  currentUser: null,
  selectedPersona: null,
  photoDataUrl: "",
  editingReportId: null,
  editingReportUserId: null,
  editingReportPhotoDataUrl: "",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

const $ = (id) => document.getElementById(id);

function showToast(message, duration = 3200) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function isAdmin() {
  return state.currentUser?.email?.toLowerCase() === ADMIN_EMAIL;
}

function updateAdminButton() {
  const button = $("adminLoginButton");
  if (!button) return;
  button.textContent = isAdmin() ? "관리자 모드" : "관리자 로그인";
  button.classList.toggle("accent", isAdmin());
}

async function signInAsAdmin() {
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    state.currentUser = credential.user;
    updateAdminButton();
    showToast(isAdmin() ? "관리자 모드로 로그인했습니다." : "이 계정은 관리자로 등록되지 않았습니다.", 5000);
  } catch (error) {
    console.error(error);
    showToast("관리자 로그인에 실패했습니다.", 5000);
  }
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
  button.textContent = busy ? label : button.dataset.originalLabel;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function riskColor(risk) {
  if (risk >= 70) return "#ff4b55";
  if (risk >= 45) return "#ff9d3d";
  return "#41d691";
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `요청 실패 (${response.status})`);
  return body;
}

function initializeMap() {
  return new Promise((resolve, reject) => {
    if (!window.kakao?.maps) return reject(new Error("카카오 지도 SDK를 불러오지 못했습니다. JavaScript 키와 Web 플랫폼 도메인을 확인하세요."));
    window.kakao.maps.load(() => {
      state.map = new kakao.maps.Map($("map"), {
        center: new kakao.maps.LatLng(HAEUNDAE.lat, HAEUNDAE.lng),
        level: 5,
      });
      state.map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
      state.geocoder = new kakao.maps.services.Places();
      state.reportClusterer = new kakao.maps.MarkerClusterer({
        map: state.map,
        averageCenter: true,
        minLevel: 6,
        disableClickZoom: false,
        styles: [{
          width: "48px", height: "48px", color: "#04111d", textAlign: "center",
          fontWeight: "800", lineHeight: "48px", borderRadius: "50%",
          background: "linear-gradient(145deg,#45e5dc,#58a9ff)", boxShadow: "0 8px 25px rgba(0,0,0,.28)",
        }],
      });
      resolve();
    });
  });
}

async function loadRiskZones() {
  try {
    const payload = await fetchJson("/api/risk-zones");
    state.riskZones = payload.zones?.length ? payload.zones : FALLBACK_ZONES;
    $("windSpeed").textContent = `풍속 ${Number(payload.weather?.windSpeed || 0).toFixed(1)} m/s`;
    $("dataSource").textContent = payload.source?.label || "공공데이터 기반";
  } catch (error) {
    console.warn(error);
    state.riskZones = FALLBACK_ZONES;
    $("dataSource").textContent = "데모 위험구역";
    showToast("외부 데이터 응답이 없어 데모 위험구역을 표시합니다.");
  }
  const maxRisk = Math.max(...state.riskZones.map((zone) => zone.risk || 0));
  $("currentRisk").textContent = Math.round(maxRisk);
  drawRiskZones();
}

function zonePolygon(zone) {
  if (zone.type === "polygon" && Array.isArray(zone.coordinates)) {
    return turf.polygon([zone.coordinates]);
  }
  return turf.circle(zone.center, (zone.radius || 80) / 1000, { steps: 48, units: "kilometers" });
}

function drawRiskZones() {
  if (!state.map || !window.kakao?.maps) return;
  state.riskOverlays.forEach((overlay) => overlay.setMap(null));
  state.riskOverlays = [];
  state.riskZones.forEach((zone) => {
    const color = riskColor(zone.risk);
    let overlay;
    if (zone.type === "polygon" && Array.isArray(zone.coordinates)) {
      overlay = new kakao.maps.Polygon({
        path: zone.coordinates.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng)),
        strokeWeight: 2, strokeColor: color, strokeOpacity: 0.9,
        fillColor: color, fillOpacity: 0.28,
      });
    } else {
      overlay = new kakao.maps.Circle({
        center: new kakao.maps.LatLng(zone.center[1], zone.center[0]), radius: zone.radius || 80,
        strokeWeight: 2, strokeColor: color, strokeOpacity: 0.9,
        fillColor: color, fillOpacity: 0.28,
      });
    }
    overlay.setMap(state.map);
    kakao.maps.event.addListener(overlay, "click", () => openForecast(zone));
    state.riskOverlays.push(overlay);
  });
}

function getMapCenterCoordinate() {
  const center = state.map.getCenter();
  return { lat: center.getLat(), lng: center.getLng() };
}

async function openForecast(zone = null) {
  const point = zone?.center ? { lng: zone.center[0], lat: zone.center[1] } : state.map ? getMapCenterCoordinate() : HAEUNDAE;
  $("forecastTitle").textContent = zone ? `${zone.name} 24시간 위험 예측` : "지도 중심 24시간 위험 예측";
  openDialog("forecastDialog");
  try {
    const payload = await fetchJson(`/api/risk-forecast?lat=${point.lat}&lng=${point.lng}&baseRisk=${zone?.risk || 50}`);
    state.forecast = payload.forecast;
  } catch (error) {
    console.warn(error);
    state.forecast = makeFallbackForecast(zone?.risk || 55);
    showToast("예보 API 응답이 없어 데모 예측값을 표시합니다.");
  }
  renderRiskChart();
}

function makeFallbackForecast(baseRisk) {
  const now = new Date();
  return Array.from({ length: 24 }, (_, index) => {
    const time = new Date(now.getTime() + index * 3600000);
    const coastalPulse = 14 * Math.sin(((time.getHours() - 10) / 24) * Math.PI * 2);
    return { time: time.toISOString(), risk: Math.round(clamp(baseRisk + coastalPulse + (index % 4) * 2, 15, 95)), windSpeed: 4.2 };
  });
}

function renderRiskChart() {
  const peak = state.forecast.reduce((best, item) => item.risk > best.risk ? item : best, state.forecast[0]);
  $("peakRisk").textContent = Math.round(peak?.risk || 0);
  $("peakTime").textContent = peak ? `${new Date(peak.time).toLocaleString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 가장 위험` : "예측 없음";
  state.forecastChart?.destroy();
  const ctx = $("riskChart");
  state.forecastChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: state.forecast.map((item) => new Date(item.time).toLocaleTimeString("ko-KR", { hour: "2-digit" })),
      datasets: [{
        label: "빌딩풍 위험지수", data: state.forecast.map((item) => item.risk),
        borderColor: "#45e5dc", backgroundColor: "rgba(69,229,220,.12)", fill: true,
        tension: 0.32, pointRadius: 2, pointBackgroundColor: state.forecast.map((item) => riskColor(item.risk)),
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, grid: { color: "rgba(255,255,255,.08)" }, ticks: { color: "#aeb9c9" } },
        x: { grid: { display: false }, ticks: { color: "#aeb9c9", maxTicksLimit: 8 } },
      },
      plugins: { legend: { labels: { color: "#dbe3ed" } } },
    },
  });
}

async function enableRiskNotifications() {
  const dangerous = state.forecast.filter((item) => item.risk >= 70);
  if (!dangerous.length) return showToast("현재 24시간 예측에는 위험지수 70 이상인 시간이 없습니다.");
  if (!("Notification" in window)) return showToast("이 브라우저는 알림을 지원하지 않습니다.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return showToast("브라우저 알림 권한이 허용되지 않았습니다.");
  const first = dangerous[0];
  new Notification("풍파인더 빌딩풍 주의", {
    body: `${new Date(first.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}부터 위험지수 ${Math.round(first.risk)}가 예측됩니다.`,
  });
  showToast("고위험 시간대 알림을 발송했습니다.");
}

function parseCoordinate(text) {
  const match = text.trim().match(/^\s*(\d{2}\.\d+)\s*[, ]\s*(1\d{2}\.\d+)\s*$/);
  if (!match) return null;
  return { lat: Number(match[1]), lng: Number(match[2]), name: text.trim() };
}

function searchPlace(queryText) {
  const coordinate = parseCoordinate(queryText);
  if (coordinate) return Promise.resolve(coordinate);
  return new Promise((resolve, reject) => {
    state.geocoder.keywordSearch(queryText, (results, status) => {
      if (status !== kakao.maps.services.Status.OK || !results.length) return reject(new Error(`장소를 찾지 못했습니다: ${queryText}`));
      const place = results[0];
      resolve({ lat: Number(place.y), lng: Number(place.x), name: place.place_name });
    }, { location: new kakao.maps.LatLng(HAEUNDAE.lat, HAEUNDAE.lng), radius: 20000 });
  });
}

async function findSafeRoute() {
  const button = $("findRouteButton");
  const originText = $("originInput").value.trim();
  const destinationText = $("destinationInput").value.trim();
  if (!originText || !destinationText) return showToast("출발지와 목적지를 모두 입력하세요.");
  setBusy(button, true, "안전 경로 계산 중…");
  try {
    const [origin, destination] = await Promise.all([searchPlace(originText), searchPlace(destinationText)]);
    const payload = await fetchJson("/api/safe-route", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin, destination, riskZones: state.riskZones }),
    });
    drawRoute(payload.coordinates);
    const result = $("routeResult");
    result.innerHTML = `<b>${payload.avoided ? "위험구역 회피 경로" : "추천 경로"}</b><br>${(payload.distance / 1000).toFixed(1)} km · 약 ${Math.ceil(payload.duration / 60)}분<br>경유지 ${payload.waypoints.length}개 · 재탐색 ${payload.attempts}회${payload.warning ? `<br><span>${escapeHtml(payload.warning)}</span>` : ""}`;
    result.classList.remove("hidden");
    showToast(payload.avoided ? "빌딩풍 위험구역을 피한 경로를 표시했습니다." : "경로를 표시했습니다.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "경로를 계산하지 못했습니다.", 5000);
  } finally {
    setBusy(button, false);
  }
}

function drawRoute(coordinates) {
  state.routePolyline?.setMap(null);
  const path = coordinates.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
  state.routePolyline = new kakao.maps.Polyline({ path, strokeWeight: 7, strokeColor: "#2179ff", strokeOpacity: 0.92, strokeStyle: "solid" });
  state.routePolyline.setMap(state.map);
  const bounds = new kakao.maps.LatLngBounds();
  path.forEach((point) => bounds.extend(point));
  state.map.setBounds(bounds, 70, 70, 130, 70);
}

function locateForReport() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ position: getMapCenterCoordinate(), exact: false });
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ position: { lat: coords.latitude, lng: coords.longitude }, exact: true }),
      () => {
        showToast("현재 위치 권한이 없어 지도 중심을 제보 위치로 사용합니다.");
        resolve({ position: getMapCenterCoordinate(), exact: false });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

function showCurrentLocation(position) {
  const latLng = new kakao.maps.LatLng(position.lat, position.lng);
  if (!state.currentLocationMarker) {
    state.currentLocationMarker = new kakao.maps.Marker({ position: latLng, map: state.map, title: "내 현재 위치" });
  } else {
    state.currentLocationMarker.setPosition(latLng);
    state.currentLocationMarker.setMap(state.map);
  }
  if (!state.currentLocationOverlay) {
    const label = document.createElement("div");
    label.textContent = "내 현재 위치";
    label.style.cssText = "padding:5px 8px;border-radius:999px;background:#1769ff;color:#fff;font:700 12px system-ui;box-shadow:0 2px 10px #0004;white-space:nowrap;";
    state.currentLocationOverlay = new kakao.maps.CustomOverlay({ content: label, position: latLng, yAnchor: 2.4, map: state.map });
  } else {
    state.currentLocationOverlay.setPosition(latLng);
    state.currentLocationOverlay.setMap(state.map);
  }
}

function resetReportEditor() {
  state.editingReportId = null;
  state.editingReportUserId = null;
  state.editingReportPhotoDataUrl = "";
  state.photoDataUrl = "";
  $("reportForm").reset();
  $("reportPhoto").required = true;
  $("photoPreview").classList.add("hidden");
  document.querySelector("#reportDialog h2").textContent = "현장 위험 제보";
  $("submitReportButton").textContent = "제보 등록하기";
}

async function beginReport() {
  resetReportEditor();
  await refreshReportLocation();
  openDialog("reportDialog");
}

async function refreshReportLocation() {
  const location = await locateForReport();
  if (location.exact) {
    showCurrentLocation(location.position);
    showToast("현재 위치를 제보 위치로 설정했습니다.");
  }
  setReportMarker(location.position);
}

function setReportMarker(position) {
  state.reportPosition = position;
  const latLng = new kakao.maps.LatLng(position.lat, position.lng);
  if (!state.reportMarker) {
    state.reportMarker = new kakao.maps.Marker({ position: latLng, draggable: true, map: state.map });
    kakao.maps.event.addListener(state.reportMarker, "dragend", () => {
      const moved = state.reportMarker.getPosition();
      state.reportPosition = { lat: moved.getLat(), lng: moved.getLng() };
      updateCoordinateLabel();
    });
  } else {
    state.reportMarker.setPosition(latLng);
    state.reportMarker.setMap(state.map);
  }
  state.map.panTo(latLng);
  updateCoordinateLabel();
}

function updateCoordinateLabel() {
  $("reportCoordinates").textContent = `위도 ${state.reportPosition.lat.toFixed(6)} · 경도 ${state.reportPosition.lng.toFixed(6)}`;
}

async function compressImage(file, maxDataUrlLength = 295000) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const maxSide = 640;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/webp", quality);
  while (dataUrl.length > maxDataUrlLength && quality > 0.35) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/webp", quality);
  }
  if (dataUrl.length > maxDataUrlLength) {
    const smaller = document.createElement("canvas");
    smaller.width = Math.round(canvas.width * 0.72);
    smaller.height = Math.round(canvas.height * 0.72);
    smaller.getContext("2d", { alpha: false }).drawImage(canvas, 0, 0, smaller.width, smaller.height);
    dataUrl = smaller.toDataURL("image/webp", 0.62);
  }
  if (dataUrl.length > maxDataUrlLength) throw new Error("사진을 충분히 압축하지 못했습니다. 더 작은 사진을 선택하세요.");
  return dataUrl;
}

async function previewReportPhoto(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    state.photoDataUrl = await compressImage(file);
    $("photoPreview").src = state.photoDataUrl;
    $("photoPreview").classList.remove("hidden");
    showToast(`사진 압축 완료 (${Math.round(state.photoDataUrl.length / 1024)}KB)`);
  } catch (error) {
    state.photoDataUrl = "";
    event.target.value = "";
    showToast(error.message);
  }
}

async function submitReportLegacy(event) {
  event.preventDefault();
  const button = $("submitReportButton");
  const text = $("reportText").value.trim();
  if (!state.currentUser) return showToast("익명 로그인 연결을 기다려주세요.");
  if (!state.reportPosition || !state.photoDataUrl || !text) return showToast("위치, 사진, 제보 내용을 모두 확인하세요.");
  setBusy(button, true, "제보 저장 중…");
  try {
    await addDoc(collection(db, "reports"), {
      lat: state.reportPosition.lat,
      lng: state.reportPosition.lng,
      text,
      photoDataUrl: state.photoDataUrl,
      geohash: encodeGeohash(state.reportPosition.lat, state.reportPosition.lng, 9),
      userId: state.currentUser.uid,
      createdAt: serverTimestamp(),
    });
    $("reportForm").reset();
    $("photoPreview").classList.add("hidden");
    state.photoDataUrl = "";
    state.reportMarker?.setMap(null);
    closeDialog("reportDialog");
    showToast("현장 제보가 등록되었습니다.");
  } catch (error) {
    console.error(error);
    showToast(error.code === "permission-denied" ? "제보 데이터 형식이 보안 규칙과 맞지 않습니다." : "제보 저장에 실패했습니다.", 5000);
  } finally {
    setBusy(button, false);
  }
}

async function submitReport(event) {
  event.preventDefault();
  const button = $("submitReportButton");
  const text = $("reportText").value.trim();
  const photoDataUrl = state.photoDataUrl || state.editingReportPhotoDataUrl;
  if (!state.currentUser) return showToast("로그인 연결을 기다려 주세요.");
  if (!state.reportPosition || !photoDataUrl || !text) return showToast("위치, 사진, 제보 내용을 모두 확인하세요.");

  const editing = Boolean(state.editingReportId);
  setBusy(button, true, editing ? "수정 저장 중…" : "제보 등록 중…");
  try {
    const reportData = {
      lat: state.reportPosition.lat,
      lng: state.reportPosition.lng,
      text,
      photoDataUrl,
      geohash: encodeGeohash(state.reportPosition.lat, state.reportPosition.lng, 9),
      userId: editing ? state.editingReportUserId : state.currentUser.uid,
    };
    if (editing) await updateDoc(doc(db, "reports", state.editingReportId), { ...reportData, updatedAt: serverTimestamp() });
    else await addDoc(collection(db, "reports"), { ...reportData, createdAt: serverTimestamp() });
    resetReportEditor();
    state.reportMarker?.setMap(null);
    closeDialog("reportDialog");
    showToast(editing ? "제보가 수정되었습니다." : "현장 제보가 등록되었습니다.");
  } catch (error) {
    console.error(error);
    showToast(error.code === "permission-denied" ? "제보 수정 권한이 없습니다. Firebase 보안 규칙을 확인하세요." : "제보 저장에 실패했습니다.", 5000);
  } finally {
    setBusy(button, false);
  }
}

function subscribeReports() {
  const reportsQuery = query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(300));
  onSnapshot(reportsQuery, (snapshot) => {
    if (!state.reportClusterer || !state.map) return;
    state.reportClusterer.clear();
    state.reportMarkers = snapshot.docs.map((document) => {
      const report = { id: document.id, ...document.data() };
      const marker = new kakao.maps.Marker({ position: new kakao.maps.LatLng(report.lat, report.lng), title: report.text });
      kakao.maps.event.addListener(marker, "click", () => showReportDetail(report));
      return marker;
    });
    state.reportClusterer.addMarkers(state.reportMarkers);
  }, (error) => {
    console.error(error);
    showToast("현장 제보를 불러오지 못했습니다.");
  });
}

function showReportDetailLegacy(report) {
  $("detailPhoto").src = report.photoDataUrl;
  $("detailText").textContent = report.text;
  const date = report.createdAt?.toDate?.();
  $("detailTime").textContent = date ? date.toLocaleString("ko-KR") : "방금 전";
  openDialog("reportDetailDialog");
}

function openReportEditor(report) {
  state.editingReportId = report.id;
  state.editingReportUserId = report.userId;
  state.editingReportPhotoDataUrl = report.photoDataUrl || "";
  state.photoDataUrl = "";
  $("reportForm").reset();
  $("reportPhoto").required = false;
  $("reportText").value = report.text || "";
  $("photoPreview").src = state.editingReportPhotoDataUrl;
  $("photoPreview").classList.toggle("hidden", !state.editingReportPhotoDataUrl);
  document.querySelector("#reportDialog h2").textContent = "내 제보 수정";
  $("submitReportButton").textContent = "수정 저장하기";
  setReportMarker({ lat: report.lat, lng: report.lng });
  closeDialog("reportDetailDialog");
  openDialog("reportDialog");
}

function showReportDetail(report) {
  $("detailPhoto").src = report.photoDataUrl;
  $("detailText").textContent = report.text;
  const date = report.updatedAt?.toDate?.() || report.createdAt?.toDate?.();
  $("detailTime").textContent = date ? date.toLocaleString("ko-KR") : "방금 전";

  let editButton = $("editReportButton");
  if (!editButton) {
    editButton = document.createElement("button");
    editButton.id = "editReportButton";
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "내 제보 수정";
    $("detailTime").after(editButton);
  }
  const canEdit = isAdmin() || (report.userId && report.userId === state.currentUser?.uid);
  editButton.classList.toggle("hidden", !canEdit);
  editButton.onclick = canEdit ? () => openReportEditor(report) : null;
  openDialog("reportDetailDialog");
}

function encodeGeohash(latitude, longitude, precision = 9) {
  const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let latRange = [-90, 90];
  let lngRange = [-180, 180];
  let hash = "";
  let bit = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lngRange : latRange;
    const coordinate = even ? longitude : latitude;
    const midpoint = (range[0] + range[1]) / 2;
    if (coordinate >= midpoint) { value = (value << 1) + 1; range[0] = midpoint; }
    else { value <<= 1; range[1] = midpoint; }
    even = !even;
    if (++bit === 5) { hash += base32[value]; bit = 0; value = 0; }
  }
  return hash;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function bindUI() {
  document.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.dialogClose)));
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).classList.add("hidden")));
  document.querySelectorAll(".persona-card").forEach((button) => button.addEventListener("click", () => {
    state.selectedPersona = button.dataset.persona;
    sessionStorage.setItem("windFinderPersona", state.selectedPersona);
    closeDialog("onboardingDialog");
    if (state.selectedPersona === "C") $("routePanel").classList.remove("hidden");
    else openForecast();
  }));
  $("forecastButton").addEventListener("click", () => openForecast());
  $("notificationButton").addEventListener("click", enableRiskNotifications);
  $("routeButton").addEventListener("click", () => $("routePanel").classList.toggle("hidden"));
  $("findRouteButton").addEventListener("click", findSafeRoute);
  const adminButton = document.createElement("button");
  adminButton.id = "adminLoginButton";
  adminButton.type = "button";
  adminButton.className = "dock-button";
  adminButton.textContent = "관리자 로그인";
  adminButton.addEventListener("click", signInAsAdmin);
  document.querySelector(".action-dock").append(adminButton);
  $("reportButton").addEventListener("click", beginReport);
  const refreshLocationButton = document.createElement("button");
  refreshLocationButton.type = "button";
  refreshLocationButton.className = "secondary-button";
  refreshLocationButton.textContent = "내 현재 위치 다시 찾기";
  refreshLocationButton.addEventListener("click", refreshReportLocation);
  $("reportCoordinates").before(refreshLocationButton);
  $("reportPhoto").addEventListener("change", previewReportPhoto);
  $("reportForm").addEventListener("submit", submitReport);
  $("reportDialog").addEventListener("close", () => state.reportMarker?.setMap(null));
}

async function boot() {
  bindUI();
  let mapReady = false;
  try {
    await initializeMap();
    mapReady = true;
  } catch (error) {
    console.error(error);
    showToast(`${error.message} 카카오 개발자 콘솔의 플랫폼 도메인을 확인하세요.`, 7000);
  }
  await loadRiskZones();
  try {
    const credential = await signInAnonymously(auth);
    state.currentUser = credential.user;
    updateAdminButton();
    if (mapReady) subscribeReports();
  } catch (error) {
    console.error(error);
    showToast("Firebase 익명 로그인에 실패했습니다.", 5000);
  }
  state.selectedPersona = sessionStorage.getItem("windFinderPersona");
  if (!state.selectedPersona) openDialog("onboardingDialog");
}

boot();
