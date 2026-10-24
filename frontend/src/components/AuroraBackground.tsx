/**
 * 极光流云背景：固定铺满视口的纯装饰层
 * - 4 个径向渐变光团缓慢漂移（纯 transform 动画，交给 GPU 合成）
 * - 细点阵 + 噪点增加质感，不拦截任何鼠标事件
 * - 降级动效由 global.css 的 prefers-reduced-motion 处理
 */
export default function AuroraBackground() {
  return (
    <div className="aurora-bg" aria-hidden="true">
      <div className="aurora-bg__blob aurora-bg__blob--blue" />
      <div className="aurora-bg__blob aurora-bg__blob--cyan" />
      <div className="aurora-bg__blob aurora-bg__blob--violet" />
      <div className="aurora-bg__blob aurora-bg__blob--pink" />
      <div className="aurora-bg__grid" />
      <div className="aurora-bg__noise" />
    </div>
  );
}
