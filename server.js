"use strict";

const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const turf = require("@turf/turf");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const KAKAO_DIRECTIONS_URL = "https://apis-navi.kakaomobility.com/v1/directions";
const VWORLD_URL = "https://api.vworld.kr/req/data";
const KMA_FORECAST_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const KMA_ASOS_URL = "https://apis.data.go.kr/1360000/AsosHourlyInfoService/getWthrDataList";
const BUILDING_REGISTER_URL = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "2mb" }));

for (const file of ["index.html", "app.js", "styles.css"]) {
  app.get(file === "index.html" ? "/" : `/${file}`, (_request, response) => response.sendFile(path.join(ROOT, file)));
}

function assertSecret(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`${name} 환경변수가 없습니다.`);
    error.status = 503;
    throw error;
  }
  return value;
}

function numberInRange(value, min, max, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`${name} 좌표가 올바르지 않습니다.`);
    error.status = 400;
    throw error;
  }
  return number;
}

function validatePoint(point, name) {
  if (!point || typeof point !== "object") {
    const error = new Error(`${name} 정보가 없습니다.`);
    error.status = 400;
    throw error;
  }
  return {
    lng: numberInRange(point.lng ?? point.x, -180, 180, `${name} 경도`),
    lat: numberInRange(point.lat ?? point.y, -90, 90, `${name} 위도`),
    name: String(point.name || name).slice(0, 50),
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const error = new Error(body?.msg || body?.message || `외부 API 오류 (${response.status})`);
      error.status = response.status;
      error.details = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function buildKakaoUrl(origin, destination, waypoints = []) {
  const url = new URL(KAKAO_DIRECTIONS_URL);
  url.searchParams.set("origin", `${origin.lng},${origin.lat},name=${origin.name}`);
  url.searchParams.set("destination", `${destination.lng},${destination.lat},name=${destination.name}`);
  if (waypoints.length) {
    url.searchParams.set("waypoints", waypoints.slice(0, 5).map((point, index) => `${point.lng},${point.lat},name=안전경유지${index + 1}`).join("|"));
  }
  url.searchParams.set("priority", "RECOMMEND");
  url.searchParams.set("summary", "false");
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("road_details", "false");
  return url;
}

async function requestKakaoRoute(origin, destination, waypoints = []) {
  const apiKey = assertSecret("KAKAO_REST_API_KEY");
  const body = await requestJson(buildKakaoUrl(origin, destination, waypoints), {
    headers: { Authorization: `KakaoAK ${apiKey}`, "Content-Type": "application/json" },
  });
  const route = body.routes?.[0];
  if (!route || route.result_code !== 0) {
    const error = new Error(route?.result_msg || "카카오에서 경로를 찾지 못했습니다.");
    error.status = 422;
    throw error;
  }
  const coordinates = [];
  for (const section of route.sections || []) {
    for (const road of section.roads || []) {
      const vertexes = road.vertexes || [];
      for (let index = 0; index < vertexes.length; index += 2) {
        const coordinate = [Number(vertexes[index]), Number(vertexes[index + 1])];
        const previous = coordinates[coordinates.length - 1];
        if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate);
      }
    }
  }
  if (coordinates.length < 2) throw Object.assign(new Error("카카오 경로 좌표가 비어 있습니다."), { status: 502 });
  return { raw: body, coordinates, distance: route.summary.distance, duration: route.summary.duration };
}

function normalizeZone(zone, index) {
  const risk = Math.max(0, Math.min(100, Number(zone.risk || 0)));
  if (zone.type === "polygon" && Array.isArray(zone.coordinates) && zone.coordinates.length >= 3) {
    const coordinates = zone.coordinates.map(([lng, lat]) => [Number(lng), Number(lat)]);
    if (coordinates[0][0] !== coordinates.at(-1)[0] || coordinates[0][1] !== coordinates.at(-1)[1]) coordinates.push(coordinates[0]);
    const polygon = turf.polygon([coordinates]);
    return { id: zone.id || `zone-${index}`, name: zone.name || `위험구역 ${index + 1}`, risk, polygon, center: turf.centroid(polygon) };
  }
  const center = Array.isArray(zone.center) ? zone.center.map(Number) : [Number(zone.lng), Number(zone.lat)];
  if (!center.every(Number.isFinite)) return null;
  const radius = Math.max(20, Math.min(500, Number(zone.radius || 80)));
  return {
    id: zone.id || `zone-${index}`, name: zone.name || `위험구역 ${index + 1}`, risk, radius,
    center: turf.point(center), polygon: turf.circle(center, radius / 1000, { steps: 48, units: "kilometers" }),
  };
}

function intersectingZones(coordinates, zones) {
  const line = turf.lineString(coordinates);
  return zones.filter((zone) => zone.risk >= 45 && turf.booleanIntersects(line, zone.polygon));
}

function zoneClearanceMeters(zone) {
  if (zone.radius) return zone.radius + 65;
  const center = zone.center.geometry.coordinates;
  const vertices = turf.coordAll(zone.polygon);
  return Math.min(500, Math.max(...vertices.map((vertex) => turf.distance(center, vertex, { units: "kilometers" }) * 1000)) + 65);
}

function candidateWaypoints(routeCoordinates, zone, expansion = 1) {
  const line = turf.lineString(routeCoordinates);
  const nearest = turf.nearestPointOnLine(line, zone.center, { units: "kilometers" });
  const index = Math.min(routeCoordinates.length - 2, Math.max(0, Number(nearest.properties.index || 0)));
  const before = turf.point(routeCoordinates[Math.max(0, index - 1)]);
  const after = turf.point(routeCoordinates[Math.min(routeCoordinates.length - 1, index + 1)]);
  const routeBearing = turf.bearing(before, after);
  const distance = zoneClearanceMeters(zone) * expansion / 1000;
  return [90, -90].map((offset) => {
    const point = turf.destination(zone.center, distance, routeBearing + offset, { units: "kilometers" });
    return { lng: point.geometry.coordinates[0], lat: point.geometry.coordinates[1] };
  });
}

function pointSafetyScore(point, zones, origin, destination) {
  const feature = turf.point([point.lng, point.lat]);
  if (zones.some((zone) => turf.booleanPointInPolygon(feature, zone.polygon))) return Number.NEGATIVE_INFINITY;
  const nearestDanger = Math.min(...zones.map((zone) => turf.distance(feature, zone.center, { units: "kilometers" })));
  const detour = turf.distance([origin.lng, origin.lat], feature, { units: "kilometers" }) + turf.distance(feature, [destination.lng, destination.lat], { units: "kilometers" });
  return nearestDanger * 3 - detour * 0.06;
}

function chooseWaypoints(routeCoordinates, dangerZones, allZones, origin, destination, expansion) {
  return dangerZones.slice(0, 5).map((zone) => candidateWaypoints(routeCoordinates, zone, expansion)
    .sort((a, b) => pointSafetyScore(b, allZones, origin, destination) - pointSafetyScore(a, allZones, origin, destination))[0])
    .filter(Boolean);
}

app.get("/api/directions", async (request, response, next) => {
  try {
    const origin = validatePoint({ lng: request.query.originLng, lat: request.query.originLat }, "출발지");
    const destination = validatePoint({ lng: request.query.destinationLng, lat: request.query.destinationLat }, "목적지");
    const result = await requestKakaoRoute(origin, destination);
    response.json(result);
  } catch (error) { next(error); }
});

app.post("/api/safe-route", async (request, response, next) => {
  try {
    const origin = validatePoint(request.body.origin, "출발지");
    const destination = validatePoint(request.body.destination, "목적지");
    const zones = (request.body.riskZones || []).slice(0, 80).map(normalizeZone).filter(Boolean);
    let route = await requestKakaoRoute(origin, destination);
    const originalIntersections = intersectingZones(route.coordinates, zones);
    let remaining = originalIntersections;
    let waypoints = [];
    let attempts = 1;

    for (let retry = 0; retry < 3 && remaining.length; retry += 1) {
      waypoints = chooseWaypoints(route.coordinates, remaining, zones, origin, destination, 1 + retry * 0.55);
      if (!waypoints.length) break;
      route = await requestKakaoRoute(origin, destination, waypoints);
      attempts += 1;
      remaining = intersectingZones(route.coordinates, zones);
    }

    const avoided = originalIntersections.length === 0 || remaining.length === 0;
    response.json({
      coordinates: route.coordinates,
      distance: route.distance,
      duration: route.duration,
      waypoints,
      attempts,
      avoided,
      originalIntersections: originalIntersections.map((zone) => ({ id: zone.id, name: zone.name, risk: zone.risk })),
      remainingIntersections: remaining.map((zone) => ({ id: zone.id, name: zone.name, risk: zone.risk })),
      warning: remaining.length ? "도로망 제약으로 일부 위험구역을 완전히 피하지 못했습니다. 현장 상황을 확인하세요." : "",
    });
  } catch (error) { next(error); }
});

function formatKstDate(date) {
  const kst = new Date(date.getTime() + 9 * 3600000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}${String(kst.getUTCDate()).padStart(2, "0")}`;
}

function forecastBaseTime(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000 - 45 * 60000);
  const hours = [2, 5, 8, 11, 14, 17, 20, 23];
  let hour = hours.filter((candidate) => candidate <= kst.getUTCHours()).at(-1);
  if (hour == null) {
    kst.setUTCDate(kst.getUTCDate() - 1);
    hour = 23;
  }
  return { date: formatKstDate(new Date(kst.getTime() - 9 * 3600000)), time: `${String(hour).padStart(2, "0")}00` };
}

async function fetchForecastItems() {
  const serviceKey = assertSecret("PUBLIC_DATA_SERVICE_KEY");
  const base = forecastBaseTime();
  const url = new URL(KMA_FORECAST_URL);
  Object.entries({
    serviceKey, pageNo: "1", numOfRows: "1000", dataType: "JSON",
    base_date: base.date, base_time: base.time,
    nx: process.env.KMA_NX || "99", ny: process.env.KMA_NY || "75",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const body = await requestJson(url);
  const resultCode = body.response?.header?.resultCode;
  if (resultCode !== "00") throw new Error(body.response?.header?.resultMsg || "기상청 예보 오류");
  return body.response.body.items.item || [];
}

function groupForecast(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    if (!grouped.has(key)) grouped.set(key, { date: item.fcstDate, time: item.fcstTime });
    grouped.get(key)[item.category] = Number(item.fcstValue);
  }
  return [...grouped.values()].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

function forecastToIso(item) {
  const year = Number(item.date.slice(0, 4));
  const month = Number(item.date.slice(4, 6));
  const day = Number(item.date.slice(6, 8));
  const hour = Number(item.time.slice(0, 2));
  return new Date(Date.UTC(year, month - 1, day, hour - 9)).toISOString();
}

async function fetchVworldBuildings(bbox = [129.115, 35.145, 129.19, 35.185]) {
  const key = assertSecret("VWORLD_API_KEY");
  const url = new URL(VWORLD_URL);
  Object.entries({
    service: "data", request: "GetFeature", data: process.env.VWORLD_DATASET || "LT_C_BLDG",
    key, domain: process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`,
    geomFilter: `BOX(${bbox.join(",")})`, format: "json", size: "1000", page: "1", crs: "EPSG:4326",
  }).forEach(([name, value]) => url.searchParams.set(name, value));
  const body = await requestJson(url);
  return body.response?.result?.featureCollection?.features || [];
}

function numericProperty(properties, names) {
  for (const name of names) {
    const number = Number(properties?.[name]);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function weatherSnapshot(grouped) {
  const now = grouped.find((item) => Number.isFinite(item.WSD)) || {};
  return { windSpeed: Number(now.WSD || 4.2), windDirection: Number(now.VEC || 180), temperature: Number(now.TMP || 22) };
}

function fallbackZones(windSpeed) {
  const boost = Math.round(Math.max(0, windSpeed - 3) * 3.2);
  return [
    { id: "marine-city", name: "마린시티 고층건물군", type: "circle", center: [129.1431, 35.1554], radius: 115, risk: Math.min(96, 74 + boost) },
    { id: "haeundae-beach", name: "해운대 해변 진입부", type: "circle", center: [129.1605, 35.1592], radius: 90, risk: Math.min(94, 62 + boost) },
    { id: "lct", name: "엘시티 주변", type: "circle", center: [129.1708, 35.1606], radius: 125, risk: Math.min(98, 79 + boost) },
    { id: "centum", name: "센텀 고층건물군", type: "circle", center: [129.1294, 35.1691], radius: 105, risk: Math.min(90, 56 + boost) },
  ];
}

function buildingRiskZones(features, weather) {
  const points = features.map((feature, index) => {
    try {
      const centroid = turf.centroid(feature).geometry.coordinates;
      const properties = feature.properties || {};
      const floors = numericProperty(properties, ["grndFlrCnt", "GRNDFLRCNT", "floors", "FLOOR"]);
      const height = numericProperty(properties, ["height", "HEIGHT", "heit", "HEIT", "bldgHeight"]) || floors * 3.3 || 12;
      return { index, centroid, height, properties };
    } catch { return null; }
  }).filter(Boolean);

  return points.map((building) => {
    const localDensity = points.filter((other) => turf.distance(building.centroid, other.centroid, { units: "kilometers" }) <= 0.14).length;
    const seaFactor = 7;
    const risk = Math.round(Math.min(98, 18 + weather.windSpeed * 5.2 + building.height * 0.32 + localDensity * 1.8 + seaFactor));
    return {
      id: `vworld-${building.index}`,
      name: building.properties.bld_nm || building.properties.BLD_NM || `건물군 ${building.index + 1}`,
      type: "circle", center: building.centroid,
      radius: Math.round(Math.max(40, Math.min(145, building.height * 1.7 + localDensity * 2))),
      risk, buildingHeight: Math.round(building.height), density: localDensity,
    };
  }).filter((zone) => zone.risk >= 45).sort((a, b) => b.risk - a.risk).slice(0, 22);
}

app.get("/api/risk-zones", async (_request, response) => {
  let grouped = [];
  let weather = { windSpeed: 4.2, windDirection: 180, temperature: 22 };
  let weatherLive = false;
  try {
    grouped = groupForecast(await fetchForecastItems());
    weather = weatherSnapshot(grouped);
    weatherLive = true;
  } catch (error) { console.warn("KMA forecast fallback:", error.message); }

  let zones;
  let buildingLive = false;
  try {
    const features = await fetchVworldBuildings();
    zones = buildingRiskZones(features, weather);
    buildingLive = zones.length > 0;
  } catch (error) { console.warn("VWorld fallback:", error.message); }
  if (!zones?.length) zones = fallbackZones(weather.windSpeed);
  response.json({
    weather, zones,
    source: {
      weatherLive, buildingLive,
      label: weatherLive && buildingLive ? "기상청·브이월드 실데이터" : weatherLive ? "기상청+건물 데모" : "데모 위험모델",
      caution: "위험지수는 의사결정 보조용 추정치이며 공인 재난정보가 아닙니다.",
    },
  });
});

app.get("/api/risk-forecast", async (request, response) => {
  const baseRisk = Math.max(10, Math.min(95, Number(request.query.baseRisk || 50)));
  try {
    const grouped = groupForecast(await fetchForecastItems()).filter((item) => Number.isFinite(item.WSD)).slice(0, 24);
    if (!grouped.length) throw new Error("예보 항목 없음");
    const forecast = grouped.map((item) => {
      const wind = Number(item.WSD || 0);
      const gustFactor = Math.max(0, wind - 3) * 5.5;
      const directionFactor = ["E", "W"].includes(cardinalDirection(item.VEC)) ? 8 : 3;
      return { time: forecastToIso(item), windSpeed: wind, windDirection: Number(item.VEC || 0), risk: Math.round(Math.min(98, baseRisk * 0.55 + gustFactor + directionFactor)) };
    });
    response.json({ forecast, source: "KMA_VILAGE_FCST" });
  } catch (error) {
    const now = new Date();
    const forecast = Array.from({ length: 24 }, (_, index) => {
      const time = new Date(now.getTime() + index * 3600000);
      return { time: time.toISOString(), windSpeed: 4.2, risk: Math.round(Math.max(10, Math.min(95, baseRisk + 14 * Math.sin(((time.getHours() - 10) / 24) * Math.PI * 2) + (index % 3) * 2))) };
    });
    response.json({ forecast, source: "FALLBACK_MODEL", warning: error.message });
  }
});

function cardinalDirection(degrees) {
  const normalized = ((Number(degrees || 0) % 360) + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(normalized / 45) % 8];
}

app.get("/api/buildings", async (request, response, next) => {
  try {
    const bbox = String(request.query.bbox || "129.115,35.145,129.19,35.185").split(",").map(Number);
    if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) throw Object.assign(new Error("bbox 형식은 minLng,minLat,maxLng,maxLat입니다."), { status: 400 });
    response.json({ features: await fetchVworldBuildings(bbox) });
  } catch (error) { next(error); }
});

app.get("/api/building-register", async (request, response, next) => {
  try {
    const serviceKey = assertSecret("PUBLIC_DATA_SERVICE_KEY");
    const required = ["sigunguCd", "bjdongCd", "bun", "ji"];
    if (required.some((name) => !request.query[name])) throw Object.assign(new Error("sigunguCd, bjdongCd, bun, ji가 필요합니다."), { status: 400 });
    const url = new URL(BUILDING_REGISTER_URL);
    Object.entries({ serviceKey, _type: "json", numOfRows: "20", pageNo: "1", ...Object.fromEntries(required.map((name) => [name, request.query[name]])) })
      .forEach(([name, value]) => url.searchParams.set(name, value));
    response.json(await requestJson(url));
  } catch (error) { next(error); }
});

app.get("/api/asos", async (request, response, next) => {
  try {
    const serviceKey = assertSecret("PUBLIC_DATA_SERVICE_KEY");
    const yesterday = new Date(Date.now() - 24 * 3600000);
    const date = formatKstDate(yesterday);
    const url = new URL(KMA_ASOS_URL);
    Object.entries({
      serviceKey, pageNo: "1", numOfRows: "24", dataType: "JSON", dataCd: "ASOS", dateCd: "HR",
      startDt: request.query.startDt || date, startHh: request.query.startHh || "00",
      endDt: request.query.endDt || date, endHh: request.query.endHh || "23",
      stnIds: request.query.stnIds || process.env.ASOS_STATION_ID || "159",
    }).forEach(([name, value]) => url.searchParams.set(name, value));
    response.json(await requestJson(url));
  } catch (error) { next(error); }
});

app.get("/api/health", (_request, response) => response.json({ ok: true, project: "wind-finder", time: new Date().toISOString() }));

app.use((error, _request, response, _next) => {
  console.error(error);
  const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  response.status(status).json({ error: "REQUEST_FAILED", message: error.message || "서버 오류가 발생했습니다.", details: process.env.NODE_ENV === "development" ? error.details : undefined });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`풍파인더 서버: http://localhost:${PORT}`));
}

module.exports = app;
