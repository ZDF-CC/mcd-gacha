/**
 * src/domain/cityLocator.js
 * ------------------------------------------------------------------
 * 把浏览器的经纬度定位，翻译成麦当劳 MCP 能接受的城市名。
 *
 * 为什么需要这一层：
 *   query-nearby-stores 只接受「城市名 + 位置关键词」，实测把经纬度
 *   （如 "31.19,121.32"）塞进 keyword 会直接报「没有查询到该地址」。
 *   所以浏览器拿到经纬度后，必须先知道「用户大概在哪个城市」。
 *
 * 为什么不用逆地理编码 API：
 *   高德/百度逆地理编码都要密钥，会破坏本项目「零依赖、clone 即跑」的特性。
 *   这里改用内置的市中心坐标表 + 球面距离找最近城市，够用且完全离线。
 *
 * 诚实说明精度：
 *   表里的坐标是各城市中心点，因此判断的是「离哪个城市中心最近」。
 *   在两城交界处可能选错，所以调用方要展示推断结果并允许用户手动改。
 *   本模块不做任何「一定准」的承诺。
 */

/**
 * 城市中心点坐标。[纬度, 经度]
 * 只用在中国大陆主要城市，与 mcdAdapter 的 KNOWN_CITIES 覆盖范围对齐。
 */
export const CITY_COORDS = [
  ['北京', 39.9, 116.41],
  ['上海', 31.23, 121.47],
  ['天津', 39.13, 117.2],
  ['重庆', 29.56, 106.55],
  ['广州', 23.13, 113.26],
  ['深圳', 22.54, 114.06],
  ['珠海', 22.27, 113.58],
  ['汕头', 23.35, 116.68],
  ['佛山', 23.02, 113.12],
  ['韶关', 24.81, 113.59],
  ['湛江', 21.27, 110.36],
  ['肇庆', 23.05, 112.47],
  ['江门', 22.58, 113.08],
  ['茂名', 21.66, 110.92],
  ['惠州', 23.11, 114.42],
  ['梅州', 24.29, 116.12],
  ['汕尾', 22.79, 115.38],
  ['河源', 23.75, 114.7],
  ['阳江', 21.86, 111.98],
  ['清远', 23.65, 113.03],
  ['东莞', 23.02, 113.75],
  ['中山', 22.52, 113.39],
  ['潮州', 23.66, 116.62],
  ['揭阳', 23.55, 116.37],
  ['云浮', 22.92, 112.05],
  ['南京', 32.06, 118.8],
  ['苏州', 31.3, 120.58],
  ['无锡', 31.49, 120.31],
  ['常州', 31.81, 119.97],
  ['南通', 32.02, 120.89],
  ['徐州', 34.27, 117.18],
  ['杭州', 30.27, 120.16],
  ['宁波', 29.87, 121.55],
  ['温州', 28.0, 120.7],
  ['嘉兴', 30.75, 120.76],
  ['合肥', 31.82, 117.23],
  ['福州', 26.07, 119.3],
  ['厦门', 24.48, 118.09],
  ['南昌', 28.68, 115.86],
  ['济南', 36.65, 117.12],
  ['青岛', 36.07, 120.38],
  ['郑州', 34.75, 113.63],
  ['武汉', 30.59, 114.31],
  ['长沙', 28.23, 112.94],
  ['石家庄', 38.04, 114.51],
  ['太原', 37.87, 112.55],
  ['沈阳', 41.8, 123.43],
  ['大连', 38.91, 121.61],
  ['长春', 43.82, 125.32],
  ['哈尔滨', 45.8, 126.53],
  ['成都', 30.57, 104.07],
  ['贵阳', 26.65, 106.63],
  ['昆明', 25.04, 102.72],
  ['南宁', 22.82, 108.32],
  ['桂林', 25.27, 110.29],
  ['海口', 20.04, 110.32],
  ['西安', 34.34, 108.94],
  ['兰州', 36.06, 103.83],
  ['西宁', 36.62, 101.78],
  ['银川', 38.49, 106.23],
  ['乌鲁木齐', 43.83, 87.62],
  ['呼和浩特', 40.84, 111.75],
  ['拉萨', 29.65, 91.14],
];

/** 超过这个距离就认为「附近没有覆盖到的大城市」，交给用户手填，不硬猜。 */
export const TOO_FAR_KM = 60;

const EARTH_RADIUS_KM = 6371;

/** 球面距离（km）。两点距离近，用 haversine 足够。 */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 找离给定坐标最近的城市。
 * @returns {{ok:boolean, city?:string, distanceKm?:number, address?:string, confidence?:string, message?:string}}
 */
export function nearestCity(lat, lng) {
  const la = toFiniteNumber(lat);
  const ln = toFiniteNumber(lng);
  if (la === null || ln === null) {
    return { ok: false, message: '没拿到有效的经纬度' };
  }
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) {
    return { ok: false, message: '经纬度超出合理范围' };
  }

  let best = null;
  for (const [city, cityLat, cityLng] of CITY_COORDS) {
    const km = distanceKm(la, ln, cityLat, cityLng);
    if (!best || km < best.distanceKm) best = { city, distanceKm: km };
  }

  if (!best) return { ok: false, message: '没有可用的城市坐标数据' };

  // 距离越远，推断越不可靠——老实告诉用户，别装作很确定
  const confidence =
    best.distanceKm <= 15 ? 'high' : best.distanceKm <= TOO_FAR_KM ? 'medium' : 'low';

  if (best.distanceKm > TOO_FAR_KM) {
    return {
      ok: true,
      city: best.city,
      distanceKm: round1(best.distanceKm),
      confidence: 'low',
      address: best.city,
      message: `附近没有查到更近的城市，最近的是${best.city}（约 ${round1(best.distanceKm)} 公里）。这个结果可能不准，建议手动填写城市名。`,
    };
  }

  return {
    ok: true,
    city: best.city,
    distanceKm: round1(best.distanceKm),
    confidence,
    // 直接当作地址填入——麦当劳 MCP 的 city 必须是不带后缀的城市名
    address: best.city,
    message:
      confidence === 'high'
        ? `已定位到${best.city}附近`
        : `已定位到${best.city}附近（约 ${round1(best.distanceKm)} 公里）`,
  };
}

/**
 * 严格转数字。
 * 不能用 `Number(x)` 了事——Number(null)、Number('')、Number([]) 都是 0，
 * 一旦前端漏传参数，就会被当成「纬度 0 经度 0」定位到几内亚湾去。
 * 所以这里只接受真正的数字，或非空且能解析成数字的字符串。
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
