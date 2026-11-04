/**
 * map.js — 高德地图轨迹视图
 *
 * 职责：
 *   1. 动态加载高德 JS API 2.0（不内置 Key，Key 由用户在界面里填）
 *   2. WGS84 → GCJ-02 坐标转换（GNSS 输出 WGS84，高德底图是 GCJ-02，不转会偏几百米）
 *   3. 轨迹折线 / 当前位置标记 / 精度圈 / 跟随 / 卫星图层
 *
 * 合规说明：按地图合规要求，高德属于必须由使用者自行申请 Key 的场景，
 * 本文件不携带任何可用密钥，Key 只能由用户在设置面板填入后存 localStorage。
 */

/* ============================================================
   1. 坐标转换（WGS84 ↔ GCJ-02）
   算法为公开的火星坐标偏移算法，国内地图 SDK 通用做法。
   ============================================================ */
const PI = Math.PI;
const AXIS = 6378245.0;              // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323;   // 偏心率平方

/** 是否在中国境外（境外不做偏移） */
export function outOfChina(lat, lon) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y
    + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y
    + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0 / 3.0;
  return ret;
}

/** WGS84 → GCJ-02，返回 [lat, lon] */
export function wgs84ToGcj02(lat, lon) {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return [lat, lon];
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lon + dLon];
}

/** GCJ-02 → WGS84（迭代反解，误差 < 1e-6 度，约 0.1 m） */
export function gcj02ToWgs84(lat, lon) {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return [lat, lon];
  if (outOfChina(lat, lon)) return [lat, lon];
  let wLat = lat;
  let wLon = lon;
  for (let i = 0; i < 6; i++) {
    const [gLat, gLon] = wgs84ToGcj02(wLat, wLon);
    wLat += lat - gLat;
    wLon += lon - gLon;
  }
  return [wLat, wLon];
}

/** 两点球面距离（米），用于轨迹里程与比例尺 */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = (d) => (d * PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ============================================================
   2. SDK 加载
   ============================================================ */
let sdkPromise = null;

/** 判断 Key 是否仍为占位符（未配置） */
export function isPlaceholderKey(key) {
  return !key || key.length < 16 || /placeholder|请|your|apply|YOUR_KEY/i.test(key);
}

/**
 * 加载高德 JS API 2.0。
 * @param {string} key 用户申请的高德 Web 端（JS API）Key
 * @param {string} [securityJsCode] 高德安全密钥（2.0 起多数能力需要）
 */
export function loadAMap(key, securityJsCode) {
  if (window.AMap && window.AMap.Map) return Promise.resolve(window.AMap);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    if (securityJsCode) {
      // 必须在 SDK 脚本加载之前设置
      window._AMapSecurityConfig = { securityJsCode };
    }
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    s.async = true;
    s.onload = () => {
      if (window.AMap && window.AMap.Map) resolve(window.AMap);
      else reject(new Error('SDK 已加载但 AMap 未就绪，通常是 Key 无效或未开通 Web 端服务'));
    };
    s.onerror = () => reject(new Error('高德 JS API 加载失败，请检查网络或 Key 是否正确'));
    document.head.appendChild(s);
  });

  // 失败后允许重试（换 Key 再试）
  sdkPromise.catch(() => { sdkPromise = null; });
  return sdkPromise;
}

/* ============================================================
   3. 轨迹地图
   ============================================================ */
const TRAIL_MAX = 4000;      // 折线最多保留点数
const PUSH_INTERVAL = 700;   // 折线重绘最小间隔（ms）

const PIN_SVG = (course) => {
  const rot = course == null ? 0 : course;
  return `<div style="position:relative;width:34px;height:34px">
    <div style="position:absolute;inset:0;border-radius:50%;background:rgba(255,176,32,.18);"></div>
    <div style="position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;
      border-radius:50%;background:#ffb020;border:2px solid #fff;box-shadow:0 0 8px rgba(0,0,0,.6)"></div>
    <div style="position:absolute;left:50%;top:50%;width:0;height:0;margin:-20px 0 0 -5px;
      border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:11px solid #ffd17a;
      transform-origin:5px 20px;transform:rotate(${rot}deg)"></div>
  </div>`;
};

export class TrackMap {
  constructor() {
    this.map = null;
    this.polyline = null;
    this.marker = null;
    this.circle = null;
    this.satLayer = null;
    this.points = [];
    this.markers = [];       // 分析用的问题标记（只读叠加，不参与实时轨迹）
    this.markerObjs = [];
    this.follow = true;
    this.satellite = false;
    this.lastPush = 0;
    this.destroyed = false;
    this.ready = false;
    this.key = '';
  }

  /**
   * 初始化地图。
   * @param {HTMLElement} el 容器（必须有确定尺寸）
   * @param {string} key 高德 Key
   * @param {string} [securityJsCode]
   */
  async init(el, key, securityJsCode) {
    this.destroyed = false;   // 允许销毁后重建（换 Key、切容器）
    const AMap = await loadAMap(key, securityJsCode);
    if (this.destroyed) return;
    this.key = key;
    this.map = new AMap.Map(el, {
      zoom: 17,
      viewMode: '2D',
      resizeEnable: true,
      mapStyle: 'amap://styles/darkblue',
      showLabel: true,
    });

    this.polyline = new AMap.Polyline({
      path: [],
      strokeColor: '#4ea8ff',
      strokeWeight: 5,
      strokeOpacity: 0.92,
      lineJoin: 'round',
      lineCap: 'round',
      showDir: true,
      borderWeight: 1,
      isOutline: true,
      outlineColor: 'rgba(78,168,255,0.25)',
    });
    this.map.add(this.polyline);

    this.circle = new AMap.Circle({
      center: [0, 0],
      radius: 8,
      strokeColor: '#ffb020',
      strokeWeight: 1,
      strokeOpacity: 0.5,
      fillColor: '#ffb020',
      fillOpacity: 0.1,
      visible: false,
    });
    this.map.add(this.circle);

    this.marker = new AMap.Marker({
      position: [0, 0],
      content: PIN_SVG(0),
      offset: new AMap.Pixel(-17, -17),
      zIndex: 200,
      visible: false,
    });
    this.map.add(this.marker);

    this.satLayer = new AMap.TileLayer.Satellite({ zIndex: 1 });

    this.ready = true;
    return this.map;
  }

  /** 卫星底图开关 */
  setSatellite(on) {
    this.satellite = !!on;
    if (!this.ready) return;
    if (on) this.map.addLayer(this.satLayer);
    else this.map.removeLayer(this.satLayer);
  }

  /** 跟随模式：开启后地图自动把当前位置收到视野中心 */
  setFollow(on) {
    this.follow = !!on;
    if (this.follow && this.marker && this.marker.getPosition()) {
      const p = this.marker.getPosition();
      this.map.setZoomAndCenter(Math.max(this.map.getZoom(), 17), [p.lng, p.lat], false, 300);
    }
  }

  /**
   * 更新轨迹。只对新增点做坐标转换，避免每次全量换算（4000 点 × 4Hz 会卡）。
   * @param {Array<{lat:number,lon:number}>} wgs 轨迹点（WGS84），与状态机里的是同一批对象引用
   * @param {{lat:number,lon:number,course:number|null,hdop:number|null}|null} current 当前定位
   */
  update(wgs, current) {
    if (!this.ready) return;

    let dirty = false;
    let start = 0;

    if (this._lastSrc) {
      const idx = wgs.lastIndexOf(this._lastSrc);
      if (idx >= 0) {
        start = idx + 1;
      } else {
        // 上次的尾点已经被挤出队列，只能整体重建
        this.points = [];
        dirty = true;
      }
    }

    for (let i = start; i < wgs.length; i++) {
      const [gLat, gLon] = wgs84ToGcj02(wgs[i].lat, wgs[i].lon);
      this.points.push([gLon, gLat]);
      if (this.points.length > TRAIL_MAX) this.points.shift();
      dirty = true;
    }
    if (wgs.length) this._lastSrc = wgs[wgs.length - 1];

    const now = performance.now();
    if (dirty && (now - this.lastPush > PUSH_INTERVAL || this.points.length < 3)) {
      this.lastPush = now;
      this.polyline.setPath(this.points);
    }

    if (current && current.lat != null && current.lon != null) {
      const [gLat, gLon] = wgs84ToGcj02(current.lat, current.lon);
      this.marker.setPosition([gLon, gLat]);
      if (current.course !== this._lastCourse) {
        this._lastCourse = current.course;
        this.marker.setContent(PIN_SVG(current.course));
      }
      this.marker.show();

      // 精度圈：无实测精度时用 HDOP × 5 m 粗估
      const radius = Math.max(6, (current.hdop && current.hdop < 50 ? current.hdop : 1.2) * 5);
      this.circle.setCenter([gLon, gLat]);
      this.circle.setRadius(radius);
      this.circle.show();

      if (this.follow) this.map.setCenter([gLon, gLat], false, 200);
    }
  }

  /** 视野包住整条轨迹 */
  fit() {
    if (!this.ready || !this.points.length) return;
    if (this.points.length === 1) {
      this.map.setZoomAndCenter(17, this.points[0]);
      return;
    }
    const path = this.points.slice();
    this.map.setFitView([new window.AMap.Polyline({ path })], false, [50, 50, 50, 50]);
  }

  /**
   * 叠加分析发现的问题点。
   * @param {Array<{lat:number,lon:number,level:string,label?:string}>} list WGS84
   */
  setMarkers(list) {
    this.markers = Array.isArray(list) ? list : [];
    if (!this.ready) return;
    for (const m of this.markerObjs) this.map.remove(m);
    this.markerObjs = [];
    for (const mk of this.markers) {
      if (!Number.isFinite(mk.lat) || !Number.isFinite(mk.lon)) continue;
      const color = mk.level === 'bad' ? '#ff5d5d' : mk.level === 'warn' ? '#ffb020' : '#4ea8ff';
      const c = new window.AMap.CircleMarker({
        center: [mk.lon, mk.lat],
        radius: 6,
        strokeColor: color,
        strokeWeight: 2,
        fillColor: color,
        fillOpacity: 0.28,
        zIndex: 150,
        bubble: true,
      });
      this.map.add(c);
      this.markerObjs.push(c);
    }
  }

  /** 把视野移到某个点（分析面板点问题条目时用） */
  focus(lat, lon, zoom = 17) {
    if (!this.ready || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const [gLat, gLon] = wgs84ToGcj02(lat, lon);
    this.follow = false;
    this.map.setZoomAndCenter(zoom, [gLon, gLat], false, 300);
  }

  /** 容器尺寸变化后必须调用，否则瓦片错位 */
  resize() {
    if (this.ready && this.map) this.map.resize();
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    if (this.map) {
      this.map.clearMap();
      this.map.destroy();
      this.map = null;
    }
    this.polyline = null;
    this.marker = null;
    this.circle = null;
    this.satLayer = null;
    this.points = [];
    this.markers = [];
    this.markerObjs = [];
  }
}

/* ============================================================
   4. 静态底图轨迹（没有 JS API Key 时的兜底）
   ------------------------------------------------------------
   走本地服务 /api/staticmap，高德「Web服务」类型的 Key 只留在后台。
   底图是一张图，轨迹和当前位置用 canvas 叠在上面。
   代价：不能拖动缩放、没有卫星图；位置变化时重取底图。
   ============================================================ */

const TILE = 256;
// 静态地图接口的 zoom 用的是 512px 瓦片规格：同样 zoom 下像素密度是标准瓦片的两倍。
// 实测 zoom=16 时 0.001° 经度对应 93.0px，而 256px 规格只有 46.6px。
const TILE_STATIC = 512;

/** 经纬度 → 世界像素坐标（Web 墨卡托，与高德瓦片一致） */
function worldPx(lon, lat, zoom, tile = TILE) {
  const world = tile * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * world;
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * PI) / 180)));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * PI)) * world;
  return [x, y];
}

export class StaticTrackMap {
  constructor() {
    this.el = null;
    this.img = null;
    this.canvas = null;
    this.ctx = null;
    this.gcj = [];            // GCJ-02 轨迹点 [{lat,lon}]
    this.cur = null;          // 当前定位（WGS84）
    this.follow = true;
    this.satellite = false;
    this.supportsSatellite = false;
    this.ready = false;
    this.zoom = 16;
    this.center = null;       // [lon, lat]（GCJ-02）
    this.size = [0, 0];
    this._seq = 0;
    this._lastFetch = -1e9;   // 别用 0，页面刚加载时 performance.now() 还很小，会被节流误挡
    this._fetched = false;
    this._loading = false;
    this._lastSrc = null;
    this.markers = [];         // [{lat,lon,level,label}]，WGS84
    this.showTrack = true;
  }

  async init(el) {
    this.el = el;
    this.ready = false;
    el.innerHTML = '';

    this.img = document.createElement('img');
    this.img.className = 'map-static-base';
    this.img.alt = '';
    this.img.draggable = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-static-overlay';

    el.appendChild(this.img);
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.resize();
    this.ready = true;
    return this;
  }

  setSatellite() { /* 静态底图不支持卫星图 */ }
  setFollow(on) { this.follow = !!on; if (on) this.refreshBase(true); }

  /** 容器尺寸变化 或 首次渲染 */
  resize() {
    if (!this.el) return;
    const r = this.el.getBoundingClientRect();
    const w = Math.max(64, Math.round(r.width));
    const h = Math.max(64, Math.round(r.height));
    this.size = [w, h];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(true);
    this.refreshBase(true);
  }

  /** 更新轨迹（入参是 WGS84，内部转 GCJ-02，只转新增点） */
  update(wgs, current) {
    if (!this.ready) return;
    this.cur = current || this.cur;

    let start = 0;
    if (this._lastSrc) {
      const idx = wgs.lastIndexOf(this._lastSrc);
      if (idx >= 0) start = idx + 1;
      else { this.gcj = []; this.draw(); }
    }
    for (let i = start; i < wgs.length; i++) {
      const [gLat, gLon] = wgs84ToGcj02(wgs[i].lat, wgs[i].lon);
      this.gcj.push({ lat: gLat, lon: gLon });
      if (this.gcj.length > TRAIL_MAX) this.gcj.shift();
    }
    if (wgs.length) this._lastSrc = wgs[wgs.length - 1];

    if (this.follow && current && current.lat != null) {
      const [gLat, gLon] = wgs84ToGcj02(current.lat, current.lon);
      // 当前位置跑出视野 30% 之后再重取底图，避免 1Hz 刷屏
      if (!this.center || !this._inside(gLon, gLat, 0.3)) {
        this.center = [gLon, gLat];
        this.refreshBase();
      }
    }
    this.draw();
  }

  _inside(lon, lat, margin) {
    if (!this.center || !this.size[0]) return false;
    const [cx, cy] = worldPx(this.center[0], this.center[1], this.zoom, TILE_STATIC);
    const [x, y] = worldPx(lon, lat, this.zoom, TILE_STATIC);
    const dx = Math.abs(x - cx) / (this.size[0] / 2);
    const dy = Math.abs(y - cy) / (this.size[1] / 2);
    return dx < margin && dy < margin;
  }

  /** 视野包住整条轨迹 */
  fit() {
    if (!this.gcj.length) return;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of this.gcj) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    // 先按 18 级算像素跨度，再反推合适层级
    const [x0, y1] = worldPx(minLon, minLat, 18, TILE_STATIC);
    const [x1, y0] = worldPx(maxLon, maxLat, 18, TILE_STATIC);
    const spanX = Math.max(1, Math.abs(x1 - x0));
    const spanY = Math.max(1, Math.abs(y1 - y0));
    // 留 10% 边距。给太小会贴着边框，给太大（0.8）向下取整后会白白退一级，图缩得很小
    const need = Math.max(spanX / (this.size[0] * 0.9), spanY / (this.size[1] * 0.9));
    let z = 18 - Math.log2(Math.max(need, 1e-6));
    // 必须取整，而且只能向下取：高德静态地图对小数 zoom 直接返回 20003 UNKNOWN_ERROR；
    // 向上取整又会让刚算好的视野放不下，轨迹会被截到画面外。
    this.zoom = Math.max(4, Math.min(17, Math.floor(z)));
    this.center = [centerLon, centerLat];
    this.refreshBase(true);
    this.draw();
  }

  /** 重新请求底图 */
  refreshBase(force) {
    if (!this.ready || !this.size[0]) return;
    if (!this.center) return;
    // 兜底：任何路径把 zoom 写成小数都会让静态地图接口报错，这里统一抹平
    this.zoom = Math.max(3, Math.min(17, Math.round(this.zoom)));
    const now = performance.now();
    // 已经取过至少一次才做节流，否则首次请求可能被时间戳误挡
    if (!force && this._fetched && now - this._lastFetch < 1200) return;
    if (this._loading && !force) return;

    this._lastFetch = now;
    this._fetched = true;
    this._loading = true;
    const seq = ++this._seq;
    // 宽高必须用同一个缩放系数，否则长宽比被截断改变，object-fit 会裁切导致轨迹与底图错位。
    // 上限 1024 是高德静态地图的尺寸天花板。
    const k = Math.min(2, 1024 / Math.max(this.size[0], this.size[1]));
    const w = Math.max(64, Math.round(this.size[0] * k));
    const h = Math.max(64, Math.round(this.size[1] * k));
    // 高德的 location 参数是「经度,纬度」，别写反（写反会飘到境外变成空白图）
    const url = `/api/staticmap?location=${this.center[0].toFixed(6)},${this.center[1].toFixed(6)}`
      + `&zoom=${this.zoom}&size=${w}*${h}&scale=1`;

    const probe = new Image();
    probe.onload = () => {
      if (seq !== this._seq) return;      // 有更新的请求，丢弃
      this.img.src = probe.src;
      this.img.dataset.w = w;
      this.img.dataset.h = h;
      this._loading = false;
      this.draw();
    };
    probe.onerror = () => { this._loading = false; };
    probe.src = url;
  }

  /**
   * 叠加问题标记（分析面板用）。接受 WGS84，内部转 GCJ-02。
   * @param {Array<{lat:number,lon:number,level:string,label?:string}>} list
   */
  setMarkers(list) {
    this.markers = Array.isArray(list) ? list : [];
    this.draw(true);
  }

  /** 视野移到指定点（分析面板点问题条目时用） */
  focus(lat, lon, zoom = 17) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const [gLat, gLon] = wgs84ToGcj02(lat, lon);
    this.zoom = Math.max(12, Math.min(17, Math.round(zoom)));
    this.center = [gLon, gLat];
    this.follow = false;
    this.refreshBase(true);
    this.draw(true);
  }

  /** 把轨迹画在底图上 */
  draw(force) {
    if (!this.ctx || !this.size[0]) return;
    const now = performance.now();
    // 合帧：1Hz 的数据 + 地图拖动时会被连续调用，80ms 内不重复重绘
    if (!force && this._lastDraw && now - this._lastDraw < 80) return;
    this._lastDraw = now;

    const [w, h] = this.size;
    const imgW = Number(this.img.dataset.w) || w;
    const imgH = Number(this.img.dataset.h) || h;
    const sx = w / imgW;
    const sy = h / imgH;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);
    if (!this.center) return;

    const [cx, cy] = worldPx(this.center[0], this.center[1], this.zoom, TILE_STATIC);
    const toPx = (lon, lat) => {
      const [x, y] = worldPx(lon, lat, this.zoom, TILE_STATIC);
      return [(x - cx) * sx + w / 2, (y - cy) * sy + h / 2];
    };

    /* ---- 轨迹 ---- */
    if (this.gcj.length && this.showTrack) {
      ctx.beginPath();
      let started = false;
      for (const p of this.gcj) {
        const [px, py] = toPx(p.lon, p.lat);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(78,168,255,0.28)';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = '#4ea8ff';
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }

    /* ---- 问题标记 ---- */
    if (this.markers.length) {
      for (const mk of this.markers) {
        if (!Number.isFinite(mk.lat) || !Number.isFinite(mk.lon)) continue;
        const [gLat, gLon] = wgs84ToGcj02(mk.lat, mk.lon);
        const [px, py] = toPx(gLon, gLat);
        const color = mk.level === 'bad' ? '#ff5d5d' : mk.level === 'warn' ? '#ffb020' : '#4ea8ff';
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, PI * 2);
        ctx.fillStyle = color + '44';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }

    /* ---- 当前位置 ---- */
    if (this.cur && this.cur.lat != null) {
      const [gLat, gLon] = wgs84ToGcj02(this.cur.lat, this.cur.lon);
      const [px, py] = toPx(gLon, gLat);
      const radius = Math.max(6, (this.cur.hdop && this.cur.hdop < 50 ? this.cur.hdop : 1.2) * 5);
      // 每像素米数：赤道周长 / (瓦片宽 × 2^zoom)，再乘纬度余弦。静态底图是 512px 瓦片，所以要除以 2。
      const metersPerPx = 156543.03392 * (TILE / TILE_STATIC)
        * Math.cos((gLat * PI) / 180) / Math.pow(2, this.zoom);
      const rPx = Math.max(4, radius / metersPerPx);

      ctx.beginPath();
      ctx.arc(px, py, rPx, 0, PI * 2);
      ctx.fillStyle = 'rgba(255,176,32,0.13)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,176,32,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 航向箭头 + 圆点
      const course = this.cur.course;
      if (course != null) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate((course * PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.lineTo(-5, -9);
        ctx.lineTo(5, -9);
        ctx.closePath();
        ctx.fillStyle = '#ffd17a';
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(px, py, 5.5, 0, PI * 2);
      ctx.fillStyle = '#ffb020';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }

  destroy() {
    this.ready = false;
    if (this.el) this.el.innerHTML = '';
    this.img = null;
    this.canvas = null;
    this.ctx = null;
    this.gcj = [];
    this._lastSrc = null;
    this.markers = [];
    this._seq++;
  }
}
