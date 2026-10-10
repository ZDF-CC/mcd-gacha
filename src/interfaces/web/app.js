/**
 * src/interfaces/web/app.js
 * ------------------------------------------------------------------
 * 网页端逻辑。原生 JS，无框架无构建——clone 完直接能跑。
 *
 * 状态很简单：一份 current 结果 + 一个 sessionId，全部由服务端持有，
 * 前端不存业务数据，刷新页面就重来一次（对抽签产品来说这反而合理）。
 */

const $ = (id) => document.getElementById(id);

const state = {
  capabilities: null,
  diet: 'none',
  avoid: new Set(),
  sessionId: null,
  current: null,
  busy: false,
  confirmed: false, // 用户是否已在确认页核对过内容，决定能否下单
  sound: false,     // 音效默认关闭
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

// ---------- 初始化 ----------

init();

async function init() {
  try {
    const caps = await fetch('/api/capabilities').then((r) => r.json());
    state.capabilities = caps;
    renderDietChips();
    renderAvoidChips();
  } catch {
    showError('无法连接本地服务，请确认已运行 npm start');
  }

  // 扭蛋机交互：拉杆是主入口，回车是键盘等价操作
  $('lever').addEventListener('click', spin);
  $('btn-respin').addEventListener('click', spin);
  $('sound-toggle').addEventListener('click', toggleSound);
  $('btn-back').addEventListener('click', () => {
    $('panel-confirm').hidden = true;
    $('panel-result').hidden = false;
  });
  $('btn-confirm').addEventListener('click', confirmOrder);
  $('btn-order').addEventListener('click', placeOrder);
  $('btn-locate').addEventListener('click', locateMe);

  // 键盘：回车即可扭，不必先点拉杆（拉杆本身是 button，天然可聚焦）
  $('address').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') spin();
  });

  // 音效必须在用户手势后初始化，否则浏览器会拦截 AudioContext
  document.addEventListener('pointerdown', initAudio, { once: true });
}

/**
 * 「用我的位置」：浏览器定位 → 后端翻译成城市名 → 填进地点框。
 *
 * 为什么不直接把经纬度交给麦当劳：实测 query-nearby-stores 只认城市名，
 * 传 "31.19,121.32" 会报「没有查询到该地址」。所以只能定位到城市这一级，
 * 然后提示用户补具体地标，让结果更准。
 *
 * 定位失败（拒绝授权 / 超时 / 非 HTTPS）时一律降级为手动输入，不阻断主流程。
 */
async function locateMe() {
  const btn = $('btn-locate');
  const input = $('address');
  const hint = $('address-hint');

  if (!navigator.geolocation) {
    setAddressHint('这个浏览器不支持定位，手动填写地点就行', 'err');
    return;
  }

  btn.disabled = true;
  btn.classList.add('busy');
  setAddressHint('正在获取你的位置…');

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        // 只要城市级精度，低精度更快更省电
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 600000, // 10 分钟内的缓存结果可直接用
      });
    });

    const result = await post('/api/locate', {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    });

    if (!result.ok) {
      setAddressHint(result.message ?? '定位失败，请手动填写地点', 'err');
      return;
    }

    input.value = result.address;
    setAddressHint(
      `${result.message}。在后面补上具体地标（地铁站、商场、公园都行），找到的门店会更近。`,
      result.confidence === 'high' ? 'ok' : 'warn'
    );
    input.focus();
  } catch (error) {
    // 1=用户拒绝授权 2=拿不到位置 3=超时
    const message =
      error?.code === 1
        ? '你关掉了定位授权，手动填写地点即可'
        : error?.code === 2
          ? '暂时拿不到位置信息，手动填写吧'
          : error?.code === 3
            ? '定位超时了，手动填写吧'
            : '定位失败，手动填写地点即可';
    setAddressHint(message, 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function setAddressHint(text, tone) {
  const hint = $('address-hint');
  hint.textContent = text;
  hint.classList.remove('locate-ok', 'locate-warn', 'locate-err');
  if (tone) hint.classList.add(`locate-${tone}`);
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function renderDietChips() {
  const group = $('diet-group');
  group.innerHTML = '';
  for (const goal of state.capabilities.dietGoals) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (goal.key === state.diet ? ' on' : '');
    chip.textContent = goal.label;
    chip.addEventListener('click', () => {
      state.diet = goal.key;
      renderDietChips();
    });
    group.appendChild(chip);
  }
}

function renderAvoidChips() {
  const group = $('avoid-group');
  group.innerHTML = '';
  for (const tag of state.capabilities.avoidTags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (state.avoid.has(tag.key) ? ' on' : '');
    chip.textContent = tag.label;
    chip.addEventListener('click', () => {
      if (state.avoid.has(tag.key)) state.avoid.delete(tag.key);
      else state.avoid.add(tag.key);
      renderAvoidChips();
    });
    group.appendChild(chip);
  }
}

// ---------- 扭蛋动作 ----------

/** 动画最短时长。让揭晓有一个「扭出来」的过程，而不是数据回来说有就有。 */
const MIN_SPIN_MS = state.reducedMotion ? 0 : 1400;

async function spin() {
  if (state.busy) return;
  const address = $('address').value.trim();
  if (!address) {
    showError('请先填写地点，比如「上海虹桥站」');
    $('address').focus();
    return;
  }

  clearError();
  setBusy(true);

  // 拉杆下压 + 机器启动
  playSound('lever');
  $('lever').classList.add('pulled');
  $('machine').classList.add('spinning');
  setMachineStatus('正在核对菜单和价格…', '真实在售数据，不是随便编的');

  const started = Date.now();

  try {
    const result = await postJson('/api/spin', {
      address,
      budget: Number($('budget').value) || 40,
      itemMax: Number($('itemMax').value) || 30,
      people: Number($('people').value) || 1,
      diet: state.diet,
      avoid: [...state.avoid],
      must: $('must').value,
    });

    // 保证动画至少转这么久；请求慢就让用户多等一会，但一定要看到胶囊落下
    const elapsed = Date.now() - started;
    if (elapsed < MIN_SPIN_MS) await sleep(MIN_SPIN_MS - elapsed);

    if (!result.ok) {
      $('machine').classList.remove('spinning');
      $('lever').classList.remove('pulled');
      setMachineStatus('没扭出来', '换个条件再试');
      playSound('fail');
      showError(
        ['这次没扭出来 😓', result.reason, ...(result.suggestAdjustments ?? []).map((t) => `· ${t}`)].join('\n')
      );
      $('panel-result').hidden = true;
      return;
    }

    // 胶囊落下
    setMachineStatus('咔哒！', '开出来了');
    playSound('reveal');

    state.current = result;
    state.sessionId = result.sessionId;
    // 换了搭配，之前核对过的内容就作废了，必须重新看一次才能下单
    state.confirmed = false;
    $('btn-order').disabled = true;
    $('panel-config').hidden = true;
    $('panel-result').hidden = false;
    $('panel-confirm').hidden = true;
    renderResult(result);
    $('panel-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('machine').classList.remove('spinning');
    $('lever').classList.remove('pulled');
    setMachineStatus('出错了', error.message.slice(0, 40));
    playSound('fail');
    showError(error.message);
  } finally {
    // 拉杆回弹
    $('lever').classList.remove('pulled');
    setBusy(false);
    $('machine').classList.remove('spinning');
  }
}

function setMachineStatus(status, tip) {
  $('machine-status').textContent = status;
  if (tip) $('machine-tip').textContent = tip;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 音效 ----------

// Web Audio 合成的短音效，零资源文件。
// 默认关闭，需用户手动开启——自动播放声音是招人烦的行为。
let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    audioCtx = null;
  }
}

function toggleSound() {
  initAudio();
  state.sound = !state.sound;
  $('sound-toggle').setAttribute('aria-pressed', String(state.sound));
  $('sound-icon').textContent = state.sound ? '🔊' : '🔇';
  $('sound-text').textContent = state.sound ? '音效开' : '音效关';
  if (state.sound) playSound('reveal');
}

function playSound(kind) {
  if (!state.sound || !audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // 拉杆：短促的机械「咔」；揭晓：上行的清脆音；失败：低沉两下
  const presets = {
    lever: [[440, 0, 0.05, 'square', 0.06]],
    reveal: [[660, 0, 0.07, 'sine', 0.12], [880, 0.07, 0.09, 'sine', 0.12], [1180, 0.16, 0.14, 'sine', 0.1]],
    fail: [[300, 0, 0.12, 'sawtooth', 0.07], [220, 0.13, 0.18, 'sawtooth', 0.07]],
  };

  for (const [freq, delay, dur, type, gain] of presets[kind] ?? []) {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = audioCtx.currentTime + delay;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}

async function rerollSlot(slot, button) {
  if (state.busy) return;
  setBusy(true, '重扭中…');
  button.disabled = true;
  try {
    const res = await postJson('/api/reroll', { sessionId: state.sessionId, slot });
    if (!res.ok) {
      showError(res.reason);
      return;
    }
    state.current = res.result;
    // 单件重抽后原确认作废
    state.confirmed = false;
    $('btn-order').disabled = true;
    renderResult(res.result, slot);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    setBusy(false);
  }
}

async function confirmOrder() {
  setBusy(true);
  try {
    const res = await postJson('/api/confirm', {
      sessionId: state.sessionId,
      people: Number($('people').value) || 1,
    });
    if (!res.ok) {
      showError(res.reason);
      return;
    }
    $('summary').textContent = res.summary;
    $('order-json').textContent = JSON.stringify(res.order, null, 2);
    $('panel-result').hidden = true;
    $('panel-confirm').hidden = false;
    $('order-result').hidden = true;
    $('order-error').hidden = true;
    // 看过订单结构才算「已核对」，此时才允许下单
    state.confirmed = true;
    $('btn-order').disabled = false;
    $('panel-confirm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

// ---------- 渲染 ----------

/**
 * 创建订单。这是唯一会动真实数据的动作，所以：
 *   - 按钮在 confirm 阶段禁用，必须先看过订单结构才允许点
 *   - 请求期间按钮禁用 + 后端并发锁，双重防重复提交
 *   - 失败时不做自动重试，提示用户核对订单（避免重复下单）
 */
async function placeOrder() {
  if (state.busy || !state.confirmed) {
    if (!state.confirmed) {
      alert('请先在上一页核对订单内容，再点确认下单');
    }
    return;
  }

  const btn = $('btn-order');
  if (!window.confirm('确认创建这笔真实订单？创建后无法自动撤销。')) return;

  setOrderBusy(true);
  try {
    const res = await postJson('/api/order', {
      sessionId: state.sessionId,
      people: Number($('people').value) || 1,
      confirmed: true,
    });

    $('order-error').hidden = true;
    $('order-result').hidden = false;
    const pay = res.created?.payUrl;
    $('order-info').innerHTML =
      `✅ 订单已创建 · 订单号 <b>${escapeHtml(res.created?.orderId ?? '-')}</b>` +
      ` · 状态 ${escapeHtml(res.created?.status ?? 'unknown')}` +
      (pay
        ? `<br /><a class="pay-link" href="${escapeHtml(pay)}" target="_blank" rel="noopener">打开支付链接</a>`
        : '<br />未取到支付链接，请到麦当劳官方渠道查看该订单。');
  } catch (error) {
    const el = $('order-error');
    el.textContent = `${error.message}\n（为避免重复下单，系统不会自动重试，请先到官方渠道核对是否已创建成功）`;
    el.hidden = false;
  } finally {
    setOrderBusy(false);
  }
}

function setOrderBusy(busy) {
  $('btn-order').disabled = busy;
  $('btn-order').textContent = busy ? '创建中…' : '确认下单';
}

function renderResult(result, freshSlot) {
  const yuan = (c) => (c / 100).toFixed(2);

  const dist = result.store.distance ? ` · ${result.store.distance}m` : '';
  const scene = result.sceneLabel ? ` · ${result.sceneLabel}` : '';
  $('store-line').innerHTML = `📍 <b>${escapeHtml(result.store.name)}</b>${escapeHtml(dist + scene)} · ` +
    `菜单 ${result.catalogStats.total} 样在售，忌口过滤后剩 ${result.catalogStats.afterAvoid} 样`;

  // 趣味组合名与时段由后端（领域层）生成，保证与 CLI 一致且不含功效声称
  const prefix = result.scenePrefix ? result.scenePrefix + '｜' : '';
  $('capsule-label').textContent = `今天我抽到了「${prefix}${result.funName}」`;

  $('stat-line').innerHTML = [
    `合计 <b>¥${yuan(result.totalCents)}</b>`,
    `预算 ¥${yuan(result.budgetCents)}（用 ${Math.round(result.usedRatio * 100)}%）`,
    result.coupon ? `券减 ¥${yuan(result.coupon.amount)}` : '暂无可用券',
    `实付约 <b>¥${yuan(result.afterCouponCents)}</b>`,
  ].join('');

  const box = $('items');
  box.innerHTML = '';
  for (const item of result.items) {
    const row = document.createElement('div');
    row.className = 'item' + (item.slot === freshSlot ? ' fresh' : '');
    row.innerHTML = `
      <div class="item-slot">${item.slot}</div>
      <div class="item-main">
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-reason">${escapeHtml(item.reason)}</div>
      </div>
      <div class="item-price">¥${yuan(item.priceCents)}</div>
      <button class="item-reroll" type="button">重扭</button>
    `;
    row.querySelector('.item-reroll').addEventListener('click', (e) => rerollSlot(item.slot, e.currentTarget));
    box.appendChild(row);
  }

  // 营养
  const n = result.nutrition;
  if (n.kcal != null) {
    $('nutri').hidden = false;
    $('nutri').innerHTML =
      `营养合计（约 ${n.covered}/${n.total} 项有数据）：` +
      `${n.kcal} kcal · 蛋白 ${n.protein ?? '—'}g · 脂肪 ${n.fat ?? '—'}g · 碳水 ${n.carb ?? '—'}g · 钠 ${n.sodium ?? '—'}g`;
  } else {
    $('nutri').hidden = true;
  }

  // 预警
  const warnings = [...(result.warnings ?? [])];
  if (result.catalogStats.filteredOut?.length) {
    const names = result.catalogStats.filteredOut.slice(0, 3).map((m) => m.name).join('、');
    warnings.push(`因忌口排除了 ${result.catalogStats.filteredOut.length} 样，例如：${names}`);
  }
  if (warnings.length) {
    $('warnings').hidden = false;
    $('warnings').innerHTML = warnings.map((w) => `<p>⚠ ${escapeHtml(w)}</p>`).join('');
  } else {
    $('warnings').hidden = true;
  }

  clearError();
}

function setBusy(busy) {
  state.busy = busy;
  // 请求期间锁定拉杆，避免连点产生并行抽取
  $('lever').disabled = busy;
  $('btn-confirm').disabled = busy;
}

function showError(message) {
  const el = $('config-error');
  el.textContent = message;
  el.hidden = false;
}

function clearError() {
  $('config-error').hidden = true;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
