import { ref, computed, onUnmounted, getCurrentInstance } from 'vue';

/**
 * 键盘避让（登录/注册/忘记密码等表单页用）：
 * 监听键盘高度变化（App/小程序/鸿蒙走 uni.onKeyboardHeightChange；H5 无此事件，
 * 用 visualViewport 缩小量估算），量取焦点编辑框的视口底边，
 * 当「底边 + 控件间距」压到键盘之下时对表单容器施加 translateY 上移，
 * 使编辑框底部（含控件间距）始终位于键盘上方；键盘收起即复位。
 * 键盘顶边 = 键盘未弹出时的视口快照 − 键盘高度（App 端键盘弹出后 windowHeight 会被压缩，不能现取现减）。
 *
 * 用法：
 *   const kb = useKeyboardAvoid();
 *   <view class="表单容器" :style="kb.style.value"> ... </view>  // 注意要 .value：kb 是普通对象，模板里 kb.style 是 ref 本身不会自动解包，
 *   // 不解包会把 ComputedRef 整个塞给 :style（鸿蒙端序列化循环引用直接挂死渲染管线）
 *   <input ... @focus="kb.focus(0)">  // 序号 = 该输入框所在 .ad-field 在页内的出现次序
 */
export function useKeyboardAvoid({ spacing = 14, fieldSelector = '.ad-field' } = {}) {
  const kbOffset = ref(0); // 容器当前需上移的距离（px），0 = 不动
  const style = computed(() => (kbOffset.value > 0 ? { transform: `translateY(-${kbOffset.value}px)` } : ''));

  let kbHeight = 0; // 键盘当前高度（px）
  // 键盘未弹出时的视口高快照：App/Harmony 端（adjustResize）键盘弹出后 windowHeight 已被压缩，
  // 若用压缩后的值再减键盘高度，键盘顶边被多减一次 → 上移量多出一个键盘高（页顶起近两倍）；
  // 且 80/320ms 量测与视口 resize 传播存在竞态，表现为"有时"顶过头。
  // 快照 - 键盘高在 resize/平移两种软键盘模式下都等于真实键盘顶边。
  let fullH = 0;
  let focusIndex = -1; // 当前聚焦的 .ad-field 序号
  let timers = [];
  const instance = getCurrentInstance();

  function windowHeight() {
    try {
      const info = uni.getWindowInfo ? uni.getWindowInfo() : uni.getSystemInfoSync();
      return info.windowHeight || 0;
    } catch (e) {
      return 0;
    }
  }

  // 只在键盘未弹出时刷新快照（键盘弹着时 windowHeight 可能已被压缩，取了就把错值存进去）；
  // 下次 focus（键盘已收起）会重新快照，旋转等真实窗口变化靠它自愈
  function snapshotViewport() {
    if (kbHeight <= 0) fullH = windowHeight();
  }
  snapshotViewport(); // 初始快照：兜底键盘高度事件先于 @focus 到达的场景

  function measure() {
    if (kbHeight <= 0 || focusIndex < 0) return;
    uni.createSelectorQuery().in(instance && instance.proxy)
      .selectAll(fieldSelector).boundingClientRect()
      .exec((res) => {
        const rect = res && res[0] && res[0][focusIndex];
        const wh = fullH || windowHeight();
        if (!rect || !wh) return;
        const keyboardTop = wh - kbHeight;
        // 容器已平移 kbOffset，rect.bottom 含位移；还原成布局底边再算抬升量（重复量测幂等，避免位移回环）
        const bottom = rect.bottom + kbOffset.value;
        const need = Math.ceil(bottom + spacing - keyboardTop);
        kbOffset.value = Math.max(0, need);
      });
  }

  // 键盘弹出/原生 adjustPosition 回滚仍有动画，延迟量两次取稳态
  function measureSoon() {
    timers.forEach(clearTimeout);
    timers = [setTimeout(measure, 80), setTimeout(measure, 320)];
  }

  /** input @focus 时调用：传入其所在 .ad-field 的序号；键盘已弹出（字段间切换）时立即重算 */
  function focus(i) {
    focusIndex = i;
    snapshotViewport(); // 键盘未弹时此刻视口必然是全高，取最准的快照
    if (kbHeight > 0) measure();
  }

  function onKbChange(height) {
    kbHeight = height || 0;
    if (kbHeight <= 0) {
      kbOffset.value = 0;
      focusIndex = -1;
      timers.forEach(clearTimeout);
      timers = [];
      return;
    }
    measureSoon();
  }

  const onKbEvent = (res) => onKbChange(res && res.height);
  if (typeof uni.onKeyboardHeightChange === 'function') {
    uni.onKeyboardHeightChange(onKbEvent);
  }

  // #ifdef H5
  // H5 端用 visualViewport 缩小量估算键盘高度；忽略 <100px 的变化（地址栏伸缩等非键盘视口抖动）
  const vv = window.visualViewport;
  let lastVvKb = 0;
  const onVvResize = () => {
    if (!vv || focusIndex < 0) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height));
    if (kb === lastVvKb || (kb > 0 && kb < 100)) return;
    lastVvKb = kb;
    onKbChange(kb);
  };
  if (vv) vv.addEventListener('resize', onVvResize);
  // #endif

  onUnmounted(() => {
    if (typeof uni.offKeyboardHeightChange === 'function') {
      uni.offKeyboardHeightChange(onKbEvent);
    }
    // #ifdef H5
    if (vv) vv.removeEventListener('resize', onVvResize);
    // #endif
    timers.forEach(clearTimeout);
  });

  return { kbOffset, style, focus };
}
