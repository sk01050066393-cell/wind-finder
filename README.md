# 풍파인더

해운대 빌딩풍 위험구역, 24시간 위험 예측, 위험구역 회피 길찾기, Firebase 현장 제보를 한 화면에 제공하는 실행 가능한 웹 프로토타입입니다.

## 바로 실행하기

1. Node.js 20 이상을 설치합니다.
2. 이 폴더에서 `npm install`을 실행합니다.
3. `npm start`를 실행합니다.
4. 브라우저에서 `http://localhost:3000`을 엽니다.

카카오 지도 화면이 하얗게 나오거나 인증 오류가 뜨면 [카카오 개발자 콘솔](https://developers.kakao.com/)의 해당 앱에서 **플랫폼 > Web** 사이트 도메인에 아래 주소를 등록해야 합니다.

```text
http://localhost:3000
```

배포할 때에는 실제 HTTPS 도메인도 추가로 등록합니다. 브이월드 키도 도메인 제한이 설정되어 있다면 같은 도메인을 허용하고 `.env`의 `PUBLIC_ORIGIN`을 바꿉니다.

도메인을 등록했는데도 `disabled OPEN_MAP_AND_LOCAL service` 또는 HTTP 403 오류가 발생한다면, 같은 앱의 **제품 설정 > 카카오맵 > 활성화 설정**에서 지도/로컬 API 서비스를 켜야 합니다. 설정 후 브라우저에서 `Ctrl+Shift+R`로 강력 새로고침하세요.

## 파일 구조

- `index.html`: 카카오 지도, MarkerClusterer, Turf.js, Chart.js, 모달 UI
- `styles.css`: 반응형 전체 화면 지도 UI
- `app.js`: Firebase 익명 로그인/제보, 지도, 차트, 알림, 클러스터, 경로 표시
- `server.js`: API 키 보호 프록시, 기상·건물 데이터 처리, Turf 기반 회피 경로 계산
- `.env`: 로컬 인증키. Git에 커밋하면 안 됩니다.
- `.env.example`: 배포 환경변수 예시

## Firestore `reports` 문서 구조

```js
{
  lat: 35.16,
  lng: 129.16,
  text: "돌풍이 매우 강합니다.",
  photoDataUrl: "data:image/webp;base64,...",
  geohash: "wy7...",
  userId: "Firebase anonymous uid",
  createdAt: serverTimestamp()
}
```

사진은 최대 640px, 약 300KB 이하 데이터 URL로 압축합니다. Firebase Storage를 사용하지 않아 결제수단 없는 Spark 요금제를 유지할 수 있지만, Firestore 1GiB 무료 저장공간이므로 장기 운영에는 적합하지 않습니다.

## 안전 우회 알고리즘

1. `/v1/directions`로 기본 경로를 요청합니다.
2. 카카오 응답의 `roads[].vertexes`를 하나의 Turf `LineString`으로 합칩니다.
3. 위험 원/폴리곤과 `booleanIntersects`로 교차를 검사합니다.
4. 교차 지점의 경로 진행방향에 수직인 양쪽 후보를 구하고, 위험 폴리곤 밖이며 전체 위험구역과 거리가 먼 후보를 선택합니다.
5. 최대 5개 경유지를 카카오 `waypoints` 파라미터로 재요청합니다.
6. 여전히 교차하면 안전거리를 55%씩 늘려 최대 3회 재탐색합니다.
7. 최종 좌표, 거리, 시간, 남은 교차 위험구역을 반환합니다.

카카오 길찾기는 자동차 경로 API입니다. 라이더/보행자 화면에서는 **현장 판단을 돕는 참고 경로**로만 사용해야 하며, 보행자 전용 경로를 보장하지 않습니다.

## API 엔드포인트

- `GET /api/risk-zones`: 기상청+브이월드 기반 위험구역. 외부 API 실패 시 데모 구역 반환
- `GET /api/risk-forecast`: 24시간 위험 예측
- `POST /api/safe-route`: 위험구역 회피 경로
- `GET /api/directions`: 기본 카카오 경로 프록시
- `GET /api/buildings?bbox=minLng,minLat,maxLng,maxLat`: 브이월드 건물 피처
- `GET /api/building-register?...`: 건축물대장 표제부 프록시
- `GET /api/asos`: 부산 ASOS 시간자료 프록시
- `GET /api/health`: 서버 상태 확인

## 중요한 한계

- 현재 위험지수는 풍속, 건물 높이 추정치, 반경 내 건물 밀도를 결합한 **프로토타입 휴리스틱**입니다. CFD 시뮬레이션이나 공인 재난예보가 아닙니다.
- 브이월드 응답 속성에 높이가 없으면 층수×3.3m 또는 기본값을 사용합니다.
- 브라우저 Notification은 `localhost` 또는 HTTPS에서만 정상 작동합니다.
- `.env`의 REST/API 키는 절대로 프론트엔드 코드나 공개 Git 저장소에 넣지 마세요.
