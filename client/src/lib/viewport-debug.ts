// Add ?debugViewport to any URL to show what the phone reports about its screen: viewport sizes,
// safe-area insets, zoom and display mode. Screenshot it when a layout looks wrong on a device.
export function installViewportDebug(): void {
  if (!new URLSearchParams(window.location.search).has('debugViewport')) return;

  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
  const heights = ['100svh', '100dvh', '100lvh', '100vh'].map((unit) => {
    const element = document.createElement('div');
    element.style.cssText = `position:fixed;left:0;top:0;width:0;height:${unit};visibility:hidden;pointer-events:none;`;
    return { unit, element };
  });

  const panel = document.createElement('pre');
  panel.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:40%;transform:translateX(-50%);margin:0;padding:10px 12px;'
    + 'font:11px/1.45 ui-monospace,Menlo,monospace;color:#f4ead7;background:rgba(20,28,32,0.86);border-radius:10px;'
    + 'pointer-events:none;white-space:pre;';

  document.body.append(probe, ...heights.map((entry) => entry.element), panel);

  const render = () => {
    const insets = getComputedStyle(probe);
    const viewport = window.visualViewport;
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    panel.textContent = [
      `screen       ${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
      `window       ${window.innerWidth}×${window.innerHeight}`,
      `visual       ${viewport ? `${Math.round(viewport.width)}×${Math.round(viewport.height)} top ${Math.round(viewport.offsetTop)}` : 'n/a'}`,
      `zoom         ${viewport ? viewport.scale.toFixed(2) : 'n/a'}`,
      ...heights.map(({ unit, element }) => `${unit.padEnd(12)} ${Math.round(element.getBoundingClientRect().height)}`),
      `safe top     ${insets.paddingTop}`,
      `safe bottom  ${insets.paddingBottom}`,
      `safe sides   ${insets.paddingLeft} / ${insets.paddingRight}`,
      `standalone   ${standalone}`,
      `scrollY      ${Math.round(window.scrollY)}`,
    ].join('\n');
  };

  render();
  window.addEventListener('resize', render);
  window.addEventListener('scroll', render, { passive: true });
  window.visualViewport?.addEventListener('resize', render);
  window.visualViewport?.addEventListener('scroll', render);
  window.setInterval(render, 1000);
}
